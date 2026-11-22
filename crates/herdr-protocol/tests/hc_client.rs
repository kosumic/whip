#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "fixture setup and assertions fail the test immediately on an unexpected protocol result"
)]
use herdr_protocol::{
    control::HerdrControlRequest as Command,
    hc::{
        self, Error,
        client::{CallError, Client, Transport},
        edits::{Change, Edit},
        events::DocumentKey,
        generated::{self, Request, Response},
        projection::{PaneLocation, SpaceLocation, TabLocation, View},
        wire::Kind,
    },
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    future::Future,
    sync::Mutex,
    task::{Context, Poll, Waker},
};

type Failure = CallError<String>;
struct Fake {
    replies: Mutex<VecDeque<(&'static str, Result<Value, Failure>)>>,
    calls: Mutex<Vec<Request>>,
    streams: Mutex<Vec<StreamWrite>>,
}
type StreamWrite = (u32, Option<Kind>, Vec<u8>);
impl Fake {
    fn new(replies: Vec<(&'static str, Result<Value, Failure>)>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            calls: Mutex::new(Vec::new()),
            streams: Mutex::new(Vec::new()),
        }
    }
}
impl Transport for Fake {
    type Failure = String;
    fn rpc(&self, request: Request) -> impl Future<Output = Result<Response, Failure>> + Send {
        self.calls.lock().unwrap().push(request.clone());
        let (method, reply) = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected RPC");
        assert_eq!(request.method(), method);
        std::future::ready(reply.and_then(|value| request.decode(value).map_err(Into::into)))
    }
    fn stream_send(&self, channel: u32, kind: Kind, bytes: Vec<u8>) -> Result<(), Failure> {
        self.streams
            .lock()
            .unwrap()
            .push((channel, Some(kind), bytes));
        Ok(())
    }
    fn stream_close(&self, channel: u32) -> Result<(), Failure> {
        self.streams
            .lock()
            .unwrap()
            .push((channel, None, Vec::new()));
        Ok(())
    }
}
fn complete<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("fake I/O should complete immediately"),
    }
}
fn terminal() -> Value {
    json!({"address":"t1","labels":{},"argv":["sh"],"cwd":"/tmp","state":"live","created_ms":1,"screen":"exact","cols":80,"rows":24})
}
fn client() -> Client {
    Client::new(serde_json::from_value(json!({"generation":1,"version":"0.1.16","framed":true,"core":{"id":"core-a","name":"test"},"methods":generated::METHODS,"features":[]})).unwrap(),serde_json::from_value(json!({"seq":1,"terminals":[terminal()],"channel":7})).unwrap()).unwrap()
}
fn prime(value: Value, version: u64) -> Vec<(&'static str, Result<Value, Failure>)> {
    vec![
        (
            "terminal.list",
            Ok(json!({"terminals":[terminal()],"machines":[],"hidden_finished":0})),
        ),
        ("doc.get", Ok(json!({"value":value,"version":version}))),
    ]
}
fn layout() -> Value {
    json!({"future":{"keep":true},"spaces":[{"id":"s","name":"Space","unknown":9,"tabs":[{"id":"t","name":"Tab","root":{"id":"p","type":"block","size":{"weight":3},"content":{"terminal":"t1"},"future":"preserve"}}]}]})
}

#[test]
fn raw_input_preserves_bytes_without_submitting_and_focus_is_private() {
    let client = client();
    let mut replies = prime(Value::Null, 0);
    replies.push((
        "terminal.attach",
        Ok(json!({"channel":9,"terminal":terminal()})),
    ));
    let io = Fake::new(replies);
    let mut view = View::default();
    complete(client.refresh(&io)).unwrap();
    let p = client.projection(&view).unwrap();
    let id = p.snapshot.panes[0].pane_id.clone();
    complete(client.control(
        &io,
        Command::PaneFocus {
            pane_id: id.clone(),
        },
        &mut view,
        "focus",
    ))
    .unwrap();
    complete(client.control(
        &io,
        Command::PaneZoom {
            pane_id: id.clone(),
        },
        &mut view,
        "zoom",
    ))
    .unwrap();
    assert_eq!(io.calls.lock().unwrap().len(), 2);
    complete(client.control(
        &io,
        Command::PaneSendText {
            pane_id: id,
            text: "exact\u{1b}[A".into(),
        },
        &mut view,
        "input",
    ))
    .unwrap();
    assert_eq!(
        *io.streams.lock().unwrap(),
        vec![
            (9, Some(Kind::Data), b"exact\x1b[A".to_vec()),
            (9, None, Vec::new())
        ]
    );
    assert!(
        io.calls
            .lock()
            .unwrap()
            .iter()
            .all(|r| !matches!(r, Request::TerminalSend(_)))
    );
}

#[test]
fn desktop_edit_rebases_only_a_confirmed_conflict_and_retains_other_writers() {
    let client = client();
    let mut updated = layout();
    updated["other-client"] = json!({"mod":[1,2,3]});
    let conflict = CallError::Protocol(Error::Rpc(hc::RpcError {
        code: -32000,
        message: "conflict".into(),
        data: Some(hc::RpcErrorData {
            kind: "conflict".into(),
            hint: None,
            extra: std::collections::BTreeMap::default(),
        }),
    }));
    let mut replies = prime(layout(), 4);
    replies.extend([
        ("doc.set", Err(conflict)),
        ("doc.get", Ok(json!({"value":updated,"version":5}))),
        ("doc.set", Ok(json!({"version":6}))),
    ]);
    let io = Fake::new(replies);
    let mut view = View::default();
    complete(client.refresh(&io)).unwrap();
    let id = client.projection(&view).unwrap().snapshot.tabs[0]
        .tab_id
        .clone();
    complete(client.control(
        &io,
        Command::TabRename {
            tab_id: id,
            label: "New title".into(),
        },
        &mut view,
        "rename",
    ))
    .unwrap();
    let calls = io.calls.lock().unwrap();
    let Request::DocSet(last) = calls.last().unwrap() else {
        panic!("expected CAS write");
    };
    assert_eq!(last.version, 5);
    assert_eq!(last.value["other-client"], updated["other-client"]);
    assert_eq!(last.value["spaces"][0]["tabs"][0]["name"], "New title");
    assert_eq!(last.value["future"], layout()["future"]);
    drop(calls);
}

#[test]
fn lost_mutation_acknowledgement_is_not_replayed() {
    let client = client();
    let mut replies = prime(layout(), 4);
    replies.push((
        "doc.set",
        Err(CallError::Transport("connection lost after write".into())),
    ));
    let io = Fake::new(replies);
    let mut view = View::default();
    complete(client.refresh(&io)).unwrap();
    let id = client.projection(&view).unwrap().snapshot.tabs[0]
        .tab_id
        .clone();
    assert!(matches!(
        complete(client.control(
            &io,
            Command::TabRename {
                tab_id: id,
                label: "New".into()
            },
            &mut view,
            "rename"
        )),
        Err(CallError::Transport(_))
    ));
    assert_eq!(
        io.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|r| matches!(r, Request::DocSet(_)))
            .count(),
        1
    );
}

#[test]
fn acknowledged_create_survives_a_lost_document_write_as_a_partial_result() {
    let client = client();
    let mut replies = prime(Value::Null, 0);
    let mut new = terminal();
    new["address"] = json!("t2");
    replies.extend([
        ("terminal.run", Ok(new)),
        (
            "doc.set",
            Err(CallError::Transport("unknown write outcome".into())),
        ),
    ]);
    let io = Fake::new(replies);
    let mut view = View::default();
    let error = complete(client.control(
        &io,
        Command::WorkspaceCreate {
            label: Some("New".into()),
            cwd: None,
        },
        &mut view,
        "create",
    ))
    .unwrap_err();
    assert!(matches!(error,CallError::Partial {completed,..} if completed==vec!["t2"]));
    assert!(
        client
            .projection(&view)
            .unwrap()
            .snapshot
            .panes
            .iter()
            .any(|p| p.terminal_id == "t2")
    );
    assert_eq!(
        io.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|r| matches!(r, Request::TerminalRun(_)))
            .count(),
        1
    );
}

#[test]
fn rapid_tab_creates_and_late_document_echoes_need_no_snapshot_or_refetch() {
    use hc::events::{Event, Notification};
    let client = client();
    let mut replies = prime(layout(), 4);
    for (address, version) in [("t2", 5), ("t3", 6)] {
        let mut new = terminal();
        new["address"] = json!(address);
        replies.extend([
            ("terminal.run", Ok(new)),
            ("doc.set", Ok(json!({"version":version}))),
        ]);
    }
    let io = Fake::new(replies);
    let mut view = View::default();
    complete(client.refresh(&io)).unwrap();
    let before = client.projection(&view).unwrap().snapshot;
    let workspace = before.workspaces[0].workspace_id.clone();
    for (nonce, version) in [("create-1", 5), ("create-2", 6)] {
        let result = complete(client.control(
            &io,
            Command::TabCreate {
                workspace_id: workspace.clone(),
                label: None,
            },
            &mut view,
            nonce,
        ))
        .unwrap();
        let herdr_protocol::control::HerdrControlResult::TabCreated { tab, root_pane } = result
        else {
            panic!("expected tab creation")
        };
        assert!(
            client
                .projection(&view)
                .unwrap()
                .snapshot
                .layouts
                .iter()
                .any(|layout| layout.tab_id == tab.tab_id
                    && layout.panes[0].pane_id == root_pane.pane_id)
        );
        client
            .apply_notifications(vec![Notification::Event(Event {
                seq: version,
                kind: "doc".into(),
                terminal: None,
                machine: None,
                data: json!({"name":"herdr-app", "version":version}),
            })])
            .unwrap();
        assert!(!client.needs_refresh());
    }
    // A delayed older echo must not invalidate the newer acknowledged document.
    client
        .apply_notifications(vec![Notification::Event(Event {
            seq: 7,
            kind: "doc".into(),
            terminal: None,
            machine: None,
            data: json!({"name":"herdr-app", "version":5}),
        })])
        .unwrap();
    assert!(!client.needs_refresh());
    let after = client.projection(&view).unwrap().snapshot;
    assert_eq!(after.tabs.len(), 3);
    assert_eq!(after.panes[0].terminal_id, before.panes[0].terminal_id);
    assert_eq!(
        io.calls
            .lock()
            .unwrap()
            .iter()
            .map(Request::method)
            .collect::<Vec<_>>(),
        [
            "terminal.list",
            "doc.get",
            "terminal.run",
            "doc.set",
            "terminal.run",
            "doc.set"
        ]
    );
}

#[test]
fn external_document_revisions_and_missed_events_still_refresh_authoritatively() {
    use hc::events::{Event, Notification};
    let client = client();
    let mut external = layout();
    external["spaces"][0]["tabs"][0]["name"] = json!("Other client");
    let mut replies = prime(layout(), 4);
    replies.push(("doc.get", Ok(json!({"value":external,"version":8}))));
    replies.extend(prime(Value::Null, 9));
    let io = Fake::new(replies);
    assert!(
        client
            .projection_if_current(&View::default())
            .unwrap()
            .is_none()
    );
    complete(client.refresh(&io)).unwrap();
    client
        .apply_notifications(vec![Notification::Event(Event {
            seq: 2,
            kind: "doc".into(),
            terminal: None,
            machine: None,
            data: json!({"name":"herdr-app", "version":8}),
        })])
        .unwrap();
    assert!(client.needs_refresh());
    assert!(
        client
            .projection_if_current(&View::default())
            .unwrap()
            .is_none()
    );
    complete(client.refresh(&io)).unwrap();
    assert_eq!(
        client.projection(&View::default()).unwrap().snapshot.tabs[0].label,
        "Other client"
    );
    // Out-of-order events are ignored by the sequenced model.
    client
        .apply_notifications(vec![Notification::Event(Event {
            seq: 1,
            kind: "doc".into(),
            terminal: None,
            machine: None,
            data: json!({"name":"herdr-app", "version":99}),
        })])
        .unwrap();
    assert!(!client.needs_refresh());
    client
        .apply_notifications(vec![Notification::Missed {
            seq: 10,
            terminals: vec![serde_json::from_value(terminal()).unwrap()],
        }])
        .unwrap();
    assert!(client.needs_refresh());
    complete(client.refresh(&io)).unwrap();
    assert!(!client.needs_refresh());
    assert_ne!(
        client.projection(&View::default()).unwrap().snapshot.tabs[0].label,
        "Other client"
    );
    assert!(io.replies.lock().unwrap().is_empty());
}

#[test]
fn split_and_rename_preserve_opaque_nodes_and_reject_ambiguous_ids() {
    let space = SpaceLocation {
        key: DocumentKey {
            machine: None,
            name: "herdr-app".into(),
        },
        space: "s".into(),
        virtual_space: false,
    };
    let tab = TabLocation {
        space: space.clone(),
        tab: "t".into(),
        virtual_tab: false,
    };
    let pane = PaneLocation {
        tab,
        node: "p".into(),
        terminal: "t1".into(),
    };
    let split = Edit {
        key: space.key.clone(),
        change: Change::Split {
            pane: pane.clone(),
            container: "split".into(),
            new_node: hc::edits::terminal_node("new", "t2"),
            row: true,
        },
    };
    let value = split.apply(&layout()).unwrap();
    assert_eq!(
        value.pointer("/spaces/0/tabs/0/root/size"),
        Some(&json!({"weight":3}))
    );
    assert_eq!(
        value.pointer("/spaces/0/tabs/0/root/children/0/future"),
        Some(&json!("preserve"))
    );
    assert_eq!(value["future"], layout()["future"]);
    let rename = Edit {
        key: space.key,
        change: Change::RenamePane {
            pane,
            name: Some("Pane title".into()),
        },
    };
    let renamed = rename.apply(&value).unwrap();
    assert_eq!(
        renamed.pointer("/spaces/0/tabs/0/root/children/0/title"),
        Some(&json!("Pane title"))
    );
    let mut duplicated = value;
    duplicated["spaces"][0]["tabs"][0]["root"]["children"][1]["id"] = json!("p");
    assert!(matches!(
        rename.apply(&duplicated),
        Err(Error::DocumentConflict)
    ));
}

#[test]
fn endpoint_replies_are_delimited_and_non_posix_commands_have_explicit_limits() {
    let parsed=hc::endpoint::parse_discovery(b"banner\nwhip-hc-endpoint-v1\0work\0/run/user/123/herdr-core/work.sock\x001\0/home/user/.local/bin/hc\0").unwrap().unwrap();
    assert_eq!(parsed.session, "work");
    assert!(parsed.installed);
    assert_eq!(parsed.command, "/home/user/.local/bin/hc");
    assert!(
        hc::endpoint::parse_discovery(b"whip-hc-endpoint-v1\0work\0relative.sock\x001\0hc\0")
            .is_err()
    );
    assert!(hc::endpoint::connect_command("C:\\bin\\hc.exe", "work", false).is_ok());
    assert!(hc::endpoint::connect_command("hc; echo bad", "work", false).is_err());
    assert!(hc::endpoint::discover_command("hc", "../other", None).is_err());
    assert!(
        hc::endpoint::connect_command("hc", "work", true)
            .unwrap()
            .contains("connect --session 'work'")
    );
}
