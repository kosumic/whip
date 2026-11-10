#![cfg(feature = "host")]
use herdr_protocol::hc::{
    documents::{APP_DOCUMENT, Document},
    events::{DocumentKey, Event, Notification},
};
use serde_json::{Value, json};
use std::{
    io::{BufReader, Write},
    os::unix::net::UnixListener,
    thread,
};
use whip_notify::{
    core::{
        Core, service,
        watcher::{Watcher, follow},
    },
    host::{Registration, Store, deliver, renew_lease},
    *,
};

fn terminal(address: &str, state: Option<&str>) -> Value {
    json!({"address":address,"labels":{},"argv":["codex"],"cwd":"/tmp","state":"live",
        "created_ms":1,"screen":"exact","cols":80,"rows":24,"reported":state.is_some(),
        "status":state.map(|state| json!({"state":state,"app":"codex","title":"Review changes"}))})
}
fn watcher(state: Option<&str>) -> Watcher {
    Watcher::new(
        serde_json::from_value(json!({"seq":10,"terminals":[terminal("t1",state)]})).unwrap(),
    )
    .unwrap()
}
fn event(seq: u64, kind: &str, data: Value) -> Notification {
    Notification::Event(Event {
        seq,
        kind: kind.into(),
        terminal: Some("t1".into()),
        machine: None,
        data,
    })
}
fn status(seq: u64, state: Option<&str>) -> Notification {
    event(
        seq,
        "status",
        json!({"reported":true,"records":{},"status":state.map(|state|json!({"state":state,"app":"codex","title":"Review changes"}))}),
    )
}

#[test]
fn snapshots_focus_turns_and_duplicate_statuses_cannot_replay_pushes() {
    let mut watcher = watcher(Some("done"));
    let apply = |watcher: &mut Watcher, notification| {
        watcher
            .apply(notification, "/tmp/core.sock", "thinker")
            .unwrap()
    };
    assert!(apply(&mut watcher, status(11, Some("idle"))).is_none());
    assert!(apply(&mut watcher, status(12, Some("working"))).is_none());
    let done = apply(&mut watcher, status(13, Some("idle"))).unwrap();
    assert_eq!(done.event.status, "done");
    assert_eq!(done.event.session, "/tmp/core.sock");
    assert_eq!(done.preview.title, "codex finished");
    assert_eq!(done.preview.body, "thinker · Review changes");
    assert!(apply(&mut watcher, status(13, Some("working"))).is_none());
    assert!(
        apply(
            &mut watcher,
            event(14, "turn", json!({"turn":1,"state":"idle"}))
        )
        .is_none()
    );
    assert!(
        apply(
            &mut watcher,
            event(
                15,
                "labels",
                json!({"labels":{"herdr.seen":"1","herdr.pinned":"1"}})
            )
        )
        .is_none()
    );
    assert!(apply(&mut watcher, status(16, Some("idle"))).is_none());
    assert_eq!(
        apply(&mut watcher, status(17, Some("blocked")))
            .unwrap()
            .event
            .status,
        "blocked"
    );
    assert!(apply(&mut watcher, status(18, Some("error"))).is_none());
    assert!(
        apply(
            &mut watcher,
            Notification::Missed {
                seq: 25,
                terminals: vec![serde_json::from_value(terminal("t1", Some("done"))).unwrap()]
            }
        )
        .is_none()
    );
    assert!(apply(&mut watcher, status(26, Some("done"))).is_none());
    assert!(apply(&mut watcher, status(27, Some("working"))).is_none());
    assert!(
        apply(&mut watcher, status(28, None)).is_none(),
        "program exit isn't completion"
    );
    assert!(
        apply(
            &mut watcher,
            event(29, "restarted", terminal("t1", Some("done")))
        )
        .is_none()
    );
}

#[test]
fn projected_targets_survive_encryption_and_obey_per_device_leases() {
    let mut watcher = watcher(Some("working"));
    watcher.documents.apply(DocumentKey { machine:None,name:APP_DOCUMENT.into() }, Document { version:1,
        value:json!({"spaces":[{"id":"repo","name":"Project","tabs":[{"id":"review","name":"Review tab","root":{"id":"pane-a","type":"block","content":{"terminal":"t1"}}}]}]}) }).unwrap();
    let update = watcher
        .apply(status(11, Some("blocked")), "/tmp/core.sock", "master")
        .unwrap()
        .unwrap();
    let expected = herdr_protocol::hc::projection::project(
        "test",
        &watcher.snapshot,
        &watcher.documents,
        &Default::default(),
    )
    .unwrap();
    assert_eq!(update.event.pane_id, expected.snapshot.agents[0].pane_id);
    assert_eq!(
        update.event.workspace_id,
        expected.snapshot.agents[0].workspace_id
    );
    assert!(
        update.event.pane_id.contains("pane-a"),
        "uses desktop pane instead of a synthetic fallback"
    );
    let root = tempfile::tempdir().unwrap();
    let store = Store {
        config: root.path().join("config"),
        state: root.path().join("state"),
    };
    let host = store.identity().unwrap();
    let device = generate_key().unwrap();
    let active = "active-device-12345";
    let offline = "offline-device-1234";
    for (id, session) in [
        (active, "/tmp/core.sock"),
        (offline, "/tmp/core.sock"),
        ("different-core-1234", "/tmp/other.sock"),
    ] {
        store
            .register(Registration {
                device_id: id.into(),
                public_key: device.public_key.clone(),
                relay_url: "https://notify.example.com".into(),
                route_token: "x".repeat(32),
                session: session.into(),
                end_to_end_encrypted: true,
            })
            .unwrap();
    }
    renew_lease(&store.state, active).unwrap();
    assert_eq!(
        deliver(&store, &update.event, &|registration, envelope| {
            assert_eq!(registration.device_id, offline);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            let decrypted = decrypt(&device, &host.public_key, offline, envelope, now)?;
            assert_eq!(decrypted, update.event);
            Ok(())
        })
        .unwrap(),
        1
    );
}

#[test]
fn real_socket_subscription_resets_on_reconnect_and_delivers_only_fresh_events() {
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("core.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let server = thread::spawn(move || {
        for baseline in ["idle", "done"] {
            let (mut events, _) = listener.accept().unwrap();
            let request: Value = serde_json::from_slice(
                &whip_notify::core::line(&mut BufReader::new(events.try_clone().unwrap())).unwrap(),
            )
            .unwrap();
            assert_eq!(request["method"], "events.subscribe");
            writeln!(events,"{}",json!({"jsonrpc":"2.0","id":1,"result":{"seq":10,"terminals":[terminal("t1",Some(baseline))]}})).unwrap();
            let (mut docs, _) = listener.accept().unwrap();
            let request: Value = serde_json::from_slice(
                &whip_notify::core::line(&mut BufReader::new(docs.try_clone().unwrap())).unwrap(),
            )
            .unwrap();
            assert_eq!(request["method"], "doc.get");
            writeln!(
                docs,
                "{}",
                json!({"jsonrpc":"2.0","id":1,"result":{"version":0,"value":null}})
            )
            .unwrap();
            for (seq, state) in [(11, "working"), (12, "blocked"), (13, "error")] {
                let Notification::Event(event) = status(seq, Some(state)) else {
                    unreachable!()
                };
                writeln!(
                    events,
                    "{}",
                    json!({"jsonrpc":"2.0","method":"event","params":event})
                )
                .unwrap();
            }
        }
    });
    let core = Core::new(socket.to_str().unwrap().into()).unwrap();
    let mut updates = Vec::new();
    for _ in 0..2 {
        assert!(
            follow(&core, &mut |update| {
                updates.push(update);
                Ok(())
            })
            .is_err()
        );
    }
    server.join().unwrap();
    assert_eq!(updates.len(), 2);
    assert!(
        updates
            .iter()
            .all(|update| update.event.status == "blocked")
    );
}

#[test]
fn user_service_configuration_preserves_arguments_and_excludes_unselected_environment() {
    let core = Core::new("/tmp/core $other%name's.sock".into()).unwrap();
    let unit = service::unit(
        &core,
        "/home/person with spaces/whip-notify",
        &[("HOME".into(), "/home/person with spaces".into())],
    )
    .unwrap();
    if cfg!(target_os = "linux") {
        assert!(unit.contains("$$other%%name's.sock"));
        assert!(unit.contains("UMask=0077"));
        assert!(unit.contains("Restart=always"));
    } else {
        assert!(unit.contains("<key>KeepAlive</key><true/>"));
    }
    assert!(!unit.contains("HERDR_SOCKET_PATH"));
    assert!(service::unit(&core, "/tmp/bad\nExecStart=other", &[]).is_err());
    assert!(Core::new("relative.sock".into()).is_err());
}
