#![allow(
    clippy::unwrap_used,
    reason = "fixture setup and assertions fail the test immediately on an unexpected protocol result"
)]
use herdr_protocol::hc::{
    Error,
    documents::{Document, Documents, MAX_DOCUMENT_BYTES},
    events::{self, DocumentKey, Notification, Snapshot},
    generated::{self, Request, Response},
    session::{Action, MAX_EARLY_CHANNELS, Session, StreamItem},
    wire::{Decoder, Frame, INITIAL_CREDIT, Kind, MAX_PAYLOAD_BYTES},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn hello() -> Value {
    json!({"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"0.1.16","framed":true,"core":{"id":"core-a","name":"test"},"methods":generated::METHODS,"features":[]}})
}
fn line(value: &Value) -> Vec<u8> {
    format!("{value}\n").into_bytes()
}
fn ready() -> Session {
    let mut session = Session::default();
    assert!(matches!(
        session.receive(&line(&hello())).unwrap().as_slice(),
        [Action::Ready(_)]
    ));
    session
}
fn frame(channel: u32, kind: Kind, bytes: &[u8]) -> Vec<u8> {
    Frame {
        channel,
        kind,
        payload: bytes.to_vec(),
    }
    .encode()
    .unwrap()
}
fn reply(id: u64, result: Value) -> Vec<u8> {
    frame(
        0,
        Kind::Data,
        json!({"jsonrpc":"2.0","id":id,"result":result})
            .to_string()
            .as_bytes(),
    )
}
fn terminal(address: &str) -> Value {
    json!({"address":address,"labels":{},"argv":["sh"],"cwd":"/tmp","state":"live","created_ms":1,"screen":"exact","cols":80,"rows":24})
}
fn attachment(session: &mut Session, channel: u32) -> u64 {
    let (id, _) = session
        .request(Request::terminal_attach(generated::TerminalAttachParams {
            terminal: "t1".into(),
            cols: 80,
            rows: 24,
            ..Default::default()
        }))
        .unwrap();
    session
        .receive(&reply(
            id,
            json!({"channel":channel,"terminal":terminal("t1")}),
        ))
        .unwrap();
    session.claim_channel(channel).unwrap();
    id
}

#[test]
fn core_frames_pin_the_nine_byte_header_and_every_control_kind() {
    let fixtures = [
        (
            Kind::Data,
            b"abc".as_slice(),
            vec![7, 0, 0, 0, 0, 3, 0, 0, 0, 97, 98, 99],
        ),
        (
            Kind::Credit,
            &[16, 0, 0, 0],
            vec![7, 0, 0, 0, 1, 4, 0, 0, 0, 16, 0, 0, 0],
        ),
        (Kind::Close, &[], vec![7, 0, 0, 0, 2, 0, 0, 0, 0]),
        (
            Kind::Resize,
            &[80, 0, 24, 0],
            vec![7, 0, 0, 0, 3, 4, 0, 0, 0, 80, 0, 24, 0],
        ),
        (Kind::Focus, &[1], vec![7, 0, 0, 0, 4, 1, 0, 0, 0, 1]),
        (
            Kind::Facts,
            b"{}",
            vec![7, 0, 0, 0, 5, 2, 0, 0, 0, 123, 125],
        ),
    ];
    for (kind, payload, wire) in fixtures {
        assert_eq!(frame(7, kind, payload), wire);
        for split in 0..=wire.len() {
            let mut decoder = Decoder::default();
            let mut decoded = decoder.push(&wire[..split]).unwrap();
            decoded.extend(decoder.push(&wire[split..]).unwrap());
            assert_eq!(
                decoded,
                [Frame {
                    channel: 7,
                    kind,
                    payload: payload.to_vec()
                }]
            );
            decoder.end().unwrap();
        }
    }
}

#[test]
fn malicious_lengths_and_truncated_headers_have_typed_bounded_outcomes() {
    // 16 MiB + 1 is rejected from the header, without receiving a payload.
    assert_eq!(
        Decoder::default().push(&[1, 0, 0, 0, 0, 1, 0, 0, 1]),
        Err(Error::FrameTooLarge(MAX_PAYLOAD_BYTES + 1))
    );
    assert!(matches!(
        Decoder::default().push(&[1, 0, 0, 0, 1, 3, 0, 0, 0]),
        Err(Error::InvalidFrame(_))
    ));
    assert!(matches!(
        Decoder::default().push(&[1, 0, 0, 0, 99, 0, 0, 0, 0]),
        Err(Error::InvalidFrame(_))
    ));
    for partial in [&[1, 0, 0][..], &[1, 0, 0, 0, 0, 3, 0, 0, 0, 97][..]] {
        let mut decoder = Decoder::default();
        assert!(decoder.push(partial).unwrap().is_empty());
        assert!(matches!(decoder.end(), Err(Error::InvalidFrame(_))));
    }
}

#[test]
fn hello_validates_generation_capabilities_and_switches_modes_at_the_newline() {
    for split in 0..=line(&hello()).len() {
        let mut session = Session::default();
        let bytes = line(&hello());
        let mut output = session.receive(&bytes[..split]).unwrap();
        output.extend(session.receive(&bytes[split..]).unwrap());
        assert!(matches!(output.as_slice(), [Action::Ready(_)]));
    }
    for (property, value) in [
        ("generation", json!(2)),
        ("framed", json!(false)),
        ("methods", json!([])),
    ] {
        let mut response = hello();
        response["result"][property] = value;
        let error = Session::default().receive(&line(&response)).unwrap_err();
        assert!(matches!(
            error,
            Error::UnsupportedGeneration(2) | Error::FramingNotNegotiated | Error::MissingMethod(_)
        ));
    }
    let mut session = Session::default();
    let mut combined = line(&hello());
    combined.extend(reply(999, json!({})));
    assert!(matches!(
        session.receive(&combined).unwrap().as_slice(),
        [Action::Ready(_)]
    ));
    let request: Value = serde_json::from_slice(&Session::hello_request()).unwrap();
    assert_eq!(request["params"], json!({"generation":1,"framed":true}));
}

#[test]
fn simultaneous_rpc_replies_are_correlated_and_late_replies_cannot_alias_new_calls() {
    let mut session = ready();
    let (first, _) = session
        .request(Request::doc_get(generated::DocGetParams {
            name: "a".into(),
            on: None,
        }))
        .unwrap();
    let (second, _) = session
        .request(Request::doc_get(generated::DocGetParams {
            name: "b".into(),
            on: None,
        }))
        .unwrap();
    let result = session
        .receive(&reply(second, json!({"value":{"b":true},"version":2})))
        .unwrap();
    assert!(
        matches!(result.as_slice(),[Action::Reply {id,result:Ok(Response::DocGet(v))}] if *id==second&&v.version==2)
    );
    session.cancel(first).unwrap();
    let (third, _) = session
        .request(Request::doc_get(generated::DocGetParams {
            name: "c".into(),
            on: None,
        }))
        .unwrap();
    assert!(third > second);
    assert!(
        session
            .receive(&reply(first, json!({"value":null,"version":1})))
            .unwrap()
            .is_empty()
    );
    assert!(
        matches!(session.receive(&reply(third,json!({"value":null,"version":3}))).unwrap().as_slice(),[Action::Reply {id,..}] if *id==third)
    );
}

#[test]
fn output_before_attach_reply_is_retained_and_credit_follows_consumption() {
    let mut session = ready();
    let (id, _) = session
        .request(Request::terminal_attach(generated::TerminalAttachParams {
            terminal: "t1".into(),
            cols: 80,
            rows: 24,
            ..Default::default()
        }))
        .unwrap();
    session
        .receive(&frame(5, Kind::Data, b"first paint"))
        .unwrap();
    session
        .receive(&reply(id, json!({"channel":5,"terminal":terminal("t1")})))
        .unwrap();
    assert!(
        session.consumed(5, 1).is_err(),
        "unclaimed/undelivered bytes cannot be acknowledged"
    );
    session.claim_channel(5).unwrap();
    assert_eq!(
        session.take_channel(5).unwrap(),
        [StreamItem::Data(b"first paint".to_vec())]
    );
    assert_eq!(
        session.consumed(5, 11).unwrap(),
        Some(frame(5, Kind::Credit, &11_u32.to_le_bytes()))
    );
    assert!(session.consumed(5, 1).is_err(), "a byte is credited once");
    let bulk = vec![0; INITIAL_CREDIT];
    session.receive(&frame(5, Kind::Data, &bulk)).unwrap();
    assert_eq!(
        session.receive(&frame(5, Kind::Data, b"x")),
        Err(Error::CreditExceeded(5))
    );
}

#[test]
fn canceled_and_unclaimed_attachments_are_detached_without_killing_the_program() {
    let mut session = ready();
    let request = || {
        Request::terminal_attach(generated::TerminalAttachParams {
            terminal: "t1".into(),
            cols: 80,
            rows: 24,
            ..Default::default()
        })
    };
    let (id, _) = session.request(request()).unwrap();
    session.cancel(id).unwrap();
    assert_eq!(
        session
            .receive(&reply(id, json!({"channel":9,"terminal":terminal("t1")})))
            .unwrap(),
        [Action::Send(frame(9, Kind::Close, &[]))]
    );
    let (id, _) = session.request(request()).unwrap();
    session
        .receive(&reply(id, json!({"channel":10,"terminal":terminal("t1")})))
        .unwrap();
    assert_eq!(session.cancel(id).unwrap(), [frame(10, Kind::Close, &[])]);
    let claimed = attachment(&mut session, 11);
    assert!(session.cancel(claimed).unwrap().is_empty());
    assert!(
        session
            .channel_frame(11, Kind::Data, b"typed".to_vec())
            .is_ok()
    );
}

#[test]
fn pre_reply_channel_buffering_is_bounded_and_reserved_channels_are_rejected() {
    let mut session = ready();
    session
        .request(Request::events_subscribe(
            generated::EventsSubscribeParams::default(),
        ))
        .unwrap();
    for channel in 1..=u32::try_from(MAX_EARLY_CHANNELS).unwrap() {
        session.receive(&frame(channel, Kind::Data, b"x")).unwrap();
    }
    assert!(matches!(
        session.receive(&frame(99, Kind::Data, b"x")),
        Err(Error::Limit(_))
    ));
    let mut session = ready();
    let (id, _) = session
        .request(Request::events_subscribe(
            generated::EventsSubscribeParams::default(),
        ))
        .unwrap();
    assert!(
        session
            .receive(&reply(id, json!({"channel":0,"seq":1,"terminals":[]})))
            .is_err()
    );
}

fn snapshot(seq: u64, records: Vec<Value>) -> Snapshot {
    Snapshot::new(serde_json::from_value(json!({"seq":seq,"terminals":records})).unwrap()).unwrap()
}
fn event(seq: u64, kind: &str, address: &str, data: Value) -> Notification {
    Notification::Event(
        serde_json::from_value(json!({"seq":seq,"type":kind,"terminal":address,"data":data}))
            .unwrap(),
    )
}

#[test]
fn events_preserve_reported_status_parentage_and_missed_snapshot_fences() {
    let mut parent = terminal("t1");
    parent["reported"] = json!(true);
    parent["status"] = json!({"state":"working","app":"claude","session_id":"actual-session"});
    let mut child = terminal("t2");
    child["parent"] = json!("t1");
    let mut state = snapshot(10, vec![parent, child]);
    assert_eq!(
        events::reported_status(state.terminal("t1").unwrap())
            .unwrap()
            .state,
        "working"
    );
    assert!(events::reported_status(state.terminal("t2").unwrap()).is_none());
    assert_eq!(state.terminal("t2").unwrap().parent.as_deref(), Some("t1"));
    state
        .apply(event(
            11,
            "status",
            "t1",
            json!({"status":{"state":"blocked"},"records":{},"reported":true}),
        ))
        .unwrap();
    state
        .apply(event(
            10,
            "status",
            "t1",
            json!({"status":null,"records":{},"reported":false}),
        ))
        .unwrap();
    assert_eq!(
        events::reported_status(state.terminal("t1").unwrap())
            .unwrap()
            .state,
        "blocked"
    );
    let changed = state
        .apply(Notification::Missed {
            seq: 20,
            terminals: vec![serde_json::from_value(terminal("t3")).unwrap()],
        })
        .unwrap();
    assert!(changed.refetch_documents && changed.terminals);
    state
        .apply(event(19, "created", "t4", terminal("t4")))
        .unwrap();
    assert_eq!(state.terminals().len(), 1);
    assert_eq!(state.terminals()[0].address, "t3");
    assert_eq!(
        snapshot(0, vec![]).seq(),
        0,
        "a new connection starts a fresh sequence epoch"
    );
}

#[test]
fn kept_terminal_loss_and_restart_do_not_fabricate_a_finished_program_or_status() {
    let mut state = snapshot(1, vec![terminal("t1")]);
    state
        .apply(event(
            2,
            "lost",
            "t1",
            json!({"reason":"holder_lost","exit_code":null,"signal":null,"finished_ms":null}),
        ))
        .unwrap();
    assert_eq!(state.terminal("t1").unwrap().state, "live");
    assert!(state.terminal("t1").unwrap().pid.is_none());
    let changed = state
        .apply(event(3, "restarted", "t1", terminal("t1")))
        .unwrap();
    assert_eq!(changed.restarted, ["t1"]);
    assert!(events::reported_status(state.terminal("t1").unwrap()).is_none());
}

#[test]
fn fragmented_event_jsonl_distinguishes_documents_and_terminal_changes() {
    let bytes = line(
        &json!({"jsonrpc":"2.0","method":"event","params":{"seq":2,"type":"doc","machine":"remote","data":{"name":"herdr-app","version":3}}}),
    );
    let mut decoder = events::Decoder::default();
    let mut state = snapshot(1, vec![]);
    let mut messages = Vec::new();
    for byte in &bytes {
        messages.extend(decoder.push(&[*byte]).unwrap());
    }
    let changed = state.apply(messages.remove(0)).unwrap();
    assert_eq!(
        changed.documents,
        [(
            DocumentKey {
                machine: Some("remote".into()),
                name: "herdr-app".into()
            },
            3
        )]
    );
    assert!(!changed.terminals);
    assert!(decoder.push(b"not JSON\n").is_err());
}

#[test]
fn document_versions_and_unknown_desktop_mod_fields_survive_round_trips() {
    let key = DocumentKey {
        machine: None,
        name: "herdr-app".into(),
    };
    let value = json!({"spaces":[],"future":{"flags":[1,2]},"mods":{"example":{"opaque":"keep"}}});
    let base = Document {
        version: 7,
        value: value.clone(),
    };
    let write = base.write(&key, value.clone()).unwrap();
    assert_eq!(write.version, 7);
    assert_eq!(write.value, value);
    let mut documents = Documents::default();
    documents.invalidate(key.clone(), 9).unwrap();
    assert!(!documents.apply(key.clone(), base.clone()).unwrap());
    assert!(
        documents
            .apply(
                key.clone(),
                Document {
                    version: 9,
                    value: value.clone()
                }
            )
            .unwrap()
    );
    assert!(
        !documents
            .acknowledge(key.clone(), &base, value.clone(), 8)
            .unwrap()
    );
    assert_eq!(documents.get(&key).unwrap().version, 9);
    assert_eq!(documents.get(&key).unwrap().value, value);
    assert!(
        base.write(&key, json!("x".repeat(MAX_DOCUMENT_BYTES)))
            .is_err()
    );
}

#[test]
fn core_projection_uses_shared_layouts_without_inventing_status_or_transcript_binding() {
    use herdr_protocol::{
        control::HerdrAgentStatus,
        hc::projection::{self, View},
    };
    let mut parent = terminal("t1");
    parent["reported"] = json!(true);
    parent["status"] =
        json!({"state":"working","app":"claude-code","session_id":"not-an-authoritative-binding"});
    let mut child = terminal("t2");
    child["parent"] = json!("t1");
    let state = snapshot(2, vec![parent, child, terminal("t3")]);
    let key = DocumentKey {
        machine: None,
        name: "herdr-app".into(),
    };
    let document = json!({"spaces":[{"id":"space-a","name":"Desktop work","tabs":[{"id":"tab-a","name":"Pair","root":{"id":"root","type":"row","children":[{"id":"pane-a","type":"block","content":{"terminal":"t1"}},{"id":"pane-b","type":"block","content":{"terminal":"t2"}},{"id":"mod","type":"block","content":{"mod":"example","props":{"private":"preserve"}}}]}}]}],"future":"keep"});
    let mut documents = Documents::default();
    documents
        .apply(
            key.clone(),
            Document {
                value: document.clone(),
                version: 3,
            },
        )
        .unwrap();
    let projection = projection::project("0.1.16", &state, &documents, &View::default()).unwrap();
    let desktop = projection
        .snapshot
        .workspaces
        .iter()
        .find(|w| w.label == "Desktop work")
        .unwrap();
    assert_eq!(desktop.pane_count, 2.0);
    assert_eq!(
        projection
            .snapshot
            .tabs
            .iter()
            .find(|t| t.label == "Pair")
            .unwrap()
            .pane_count,
        2.0
    );
    assert_eq!(
        projection.snapshot.agents.len(),
        3,
        "unplaced terminals remain usable"
    );
    let parent = projection
        .snapshot
        .agents
        .iter()
        .find(|a| a.terminal_id == "t1")
        .unwrap();
    assert_eq!(parent.agent_status, HerdrAgentStatus::Working);
    assert!(parent.agent_session.is_none());
    let child = projection
        .snapshot
        .agents
        .iter()
        .find(|a| a.terminal_id == "t2")
        .unwrap();
    assert_eq!(child.agent_status, HerdrAgentStatus::Unknown);
    assert_eq!(
        child.state_labels.as_ref().unwrap()[projection::PARENT_LABEL],
        "t1"
    );
    assert_eq!(
        documents.get(&key).unwrap().value,
        document,
        "projection cannot rewrite desktop data or private focus"
    );
    assert_eq!(
        projection::project("0.1.16", &state, &Documents::default(), &View::default())
            .unwrap()
            .snapshot
            .panes
            .len(),
        3
    );
}

#[test]
fn remote_documents_qualify_terminal_addresses_relative_to_their_own_core() {
    use herdr_protocol::hc::projection::{self, View};
    let state = snapshot(1, vec![terminal("remote/t1"), terminal("remote/remote/t2")]);
    let key = DocumentKey {
        machine: Some("remote".into()),
        name: "herdr-app".into(),
    };
    let mut documents = Documents::default();
    documents.apply(key,Document {version:1,value:json!({"spaces":[{"id":"s","name":"Remote desktop","tabs":[{"id":"t","name":"Nested","root":{"id":"root","type":"row","children":[{"id":"a","type":"block","content":{"terminal":"t1"}},{"id":"b","type":"block","content":{"terminal":"remote/t2"}}]}}]}]})}).unwrap();
    let projected = projection::project("0.1.16", &state, &documents, &View::default()).unwrap();
    assert_eq!(projected.snapshot.workspaces.len(), 1);
    assert_eq!(projected.snapshot.panes[1].terminal_id, "remote/remote/t2");
}

#[test]
fn rpc_models_follow_the_pinned_schema_and_keep_unknown_reply_fields() {
    let schema: Value = serde_json::from_str(include_str!("../schema/hc.openrpc.json")).unwrap();
    let expected: Vec<_> = schema["methods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap())
        .collect();
    assert_eq!(generated::METHODS, expected);
    let params = generated::TerminalSendParams {
        terminal: "t1".into(),
        text: "hello".into(),
        r#if: Some("idle".into()),
        ..Default::default()
    };
    let value = Request::terminal_send(params).params().unwrap();
    assert_eq!(value, json!({"terminal":"t1","text":"hello","if":"idle"}));
    let result = generated::DocGetResult {
        value: json!({}),
        version: u64::MAX,
        extra: BTreeMap::from([("future".into(), json!(true))]),
    };
    assert_eq!(serde_json::to_value(&result).unwrap()["future"], true);
    assert!(
        serde_json::from_value::<generated::AttachResult>(
            json!({"channel":u64::from(u32::MAX)+1,"terminal":terminal("t1")})
        )
        .is_err()
    );
}

#[test]
fn cancellation_tombstone_eviction_still_detaches_very_late_channels() {
    let mut session = ready();
    let mut oldest = 0;
    for index in 0..300 {
        let (id, _) = session
            .request(Request::terminal_attach(generated::TerminalAttachParams {
                terminal: "t1".into(),
                cols: 80,
                rows: 24,
                ..Default::default()
            }))
            .unwrap();
        if index == 0 {
            oldest = id;
        }
        session.cancel(id).unwrap();
    }
    let actions = session
        .receive(&reply(
            oldest,
            json!({"channel":999,"terminal":terminal("t1")}),
        ))
        .unwrap();
    assert!(
        matches!(actions.as_slice(),[Action::Send(bytes)] if bytes==&frame(999,Kind::Close,&[]))
    );
}

#[test]
fn stream_metadata_and_rpc_queues_have_aggregate_memory_bounds() {
    let mut session = ready();
    attachment(&mut session, 9);
    let byte = frame(9, Kind::Data, b"x");
    for _ in 0..4096 {
        session.receive(&byte).unwrap();
    }
    assert_eq!(
        session.take_channel(9).unwrap(),
        vec![StreamItem::Data(vec![b'x'; 4096])]
    );
    assert!(session.consumed(9, 4096).unwrap().is_some());
    let mut session = ready();
    let request = Request::file_write(generated::FileWriteParams {
        path: "/tmp/example".into(),
        data: "x".repeat(herdr_protocol::hc::session::MAX_PENDING_BYTES),
        ..Default::default()
    });
    assert!(matches!(
        session.request(request),
        Err(Error::Limit("pending RPC bytes"))
    ));
    let mut large = terminal("t1");
    large["labels"] = json!({"large":"x".repeat(events::MAX_SNAPSHOT_BYTES)});
    assert!(matches!(
        Snapshot::new(serde_json::from_value(json!({"seq":1,"terminals":[large]})).unwrap()),
        Err(Error::Limit("terminal snapshot bytes"))
    ));
}
