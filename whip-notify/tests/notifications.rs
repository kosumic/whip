use std::{
    fs::{self, File},
    os::unix::fs::{PermissionsExt, symlink},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use whip_notify::{host::*, *};

fn event() -> NotificationEvent {
    NotificationEvent {
        pane_id: "w1:p2".into(),
        workspace_id: "w1".into(),
        session: "/tmp/herdr-test.sock".into(),
        status: "blocked".into(),
        title: Some("Private agent title".into()),
    }
}
fn header(host: &KeyPair, device: &KeyPair, id: &str) -> Header {
    Header {
        version: VERSION,
        host_id: key_id(&host.public_key),
        device_id: id.into(),
        key_id: key_id(&device.public_key),
        event_id: uuid::Uuid::new_v4().to_string(),
        issued_at: 1000,
    }
}
fn store(root: &std::path::Path) -> Store {
    Store {
        config: root.join("config"),
        state: root.join("state"),
    }
}
fn registration(id: &str, key: &KeyPair) -> Registration {
    Registration {
        device_id: id.into(),
        public_key: key.public_key.clone(),
        relay_url: "https://notify.example.com".into(),
        route_token: "x".repeat(64),
        session: event().session,
        end_to_end_encrypted: true,
    }
}

#[test]
fn plaintext_previews_are_selected_per_registration_and_keep_authenticated_routing() {
    let host = generate_key().unwrap();
    let device = generate_key().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut registration = registration(&id, &device);
    let envelope = encrypt(
        &host,
        &device.public_key,
        header(&host, &device, &id),
        &event(),
    )
    .unwrap();
    let hook = serde_json::json!({"event":"pane_agent_status_changed","data":{
        "pane_id":"w1:p2","workspace_id":"w1","agent_status":"blocked","agent":"codex"
    }})
    .to_string();
    let context = serde_json::json!({"focused_pane_id":"w1:p2","tab_label":"Checkout"}).to_string();
    let preview = notification_preview(&event(), &hook, &context, "mini").unwrap();
    assert_eq!(preview.title, "Checkout · codex needs you");
    assert_eq!(preview.body, "mini · Private agent title");
    let encrypted = serde_json::to_value(registration.push_request(&envelope, &preview)).unwrap();
    assert!(encrypted.get("preview").is_none());
    registration.end_to_end_encrypted = false;
    let readable = serde_json::to_value(registration.push_request(&envelope, &preview)).unwrap();
    assert_eq!(readable["preview"]["title"], preview.title);
    assert_eq!(readable["preview"]["body"], preview.body);
    assert_eq!(readable["ciphertext"], encrypted["ciphertext"]);
    let mut old_registration = serde_json::to_value(&registration).unwrap();
    old_registration
        .as_object_mut()
        .unwrap()
        .remove("end_to_end_encrypted");
    assert!(
        serde_json::from_value::<Registration>(old_registration)
            .unwrap()
            .end_to_end_encrypted
    );
}

#[test]
fn preview_fallbacks_ignore_other_panes_and_bound_unicode_text() {
    let mut event = event();
    event.title = None;
    event.status = "done".into();
    let hook = serde_json::json!({"event":"pane_agent_status_changed","data":{
        "pane_id":event.pane_id,"workspace_id":event.workspace_id,"agent_status":"done"
    }})
    .to_string();
    let wrong_context = serde_json::json!({"focused_pane_id":"other","tab_label":"Wrong tab","focused_pane_agent":"Wrong agent"}).to_string();
    let preview = notification_preview(&event, &hook, &wrong_context, "mini").unwrap();
    assert_eq!(preview.title, "Agent finished");
    assert_eq!(preview.body, "mini · Agent is done");
    event.title = Some("🦀".repeat(200));
    let context =
        serde_json::json!({"focused_pane_id":"w1:p2","tab_label":"🦀".repeat(200)}).to_string();
    let preview = notification_preview(&event, &hook, &context, &"🦀".repeat(200)).unwrap();
    assert!(preview.title.len() <= PREVIEW_TITLE_BYTES);
    assert!(preview.body.len() <= PREVIEW_BODY_BYTES);
}

#[test]
fn preview_uses_hostname_and_status_without_internal_ids() {
    let mut event = event();
    event.pane_id = "w1:p1".into();
    let hook = include_str!("fixtures/herdr-0.9.5-blocked.json");
    let context = serde_json::json!({
        "focused_pane_id": event.pane_id,
        "tab_id": "t1",
        "tab_label": " \n ",
    })
    .to_string();
    for title in [None, Some(" \n ".into())] {
        event.title = title;
        let preview = notification_preview(&event, hook, &context, " mini\n").unwrap();
        assert_eq!(preview.title, "codex needs you");
        assert_eq!(preview.body, "mini · Agent is blocked");
    }
    let preview = notification_preview(&event, hook, &context, "").unwrap();
    assert_eq!(preview.body, "Agent is blocked");
}

#[test]
fn notifications_from_hpke_0_6_1_remain_readable() {
    #[derive(serde::Deserialize)]
    struct Fixture {
        host: KeyPair,
        device: KeyPair,
        device_id: String,
        envelope: Envelope,
        event: NotificationEvent,
    }

    let fixture: Fixture =
        serde_json::from_str(include_str!("fixtures/hpke-auth-0.6.1.json")).unwrap();
    assert_eq!(
        decrypt(
            &fixture.device,
            &fixture.host.public_key,
            &fixture.device_id,
            &fixture.envelope,
            fixture.envelope.header.issued_at,
        )
        .unwrap(),
        fixture.event
    );
}

#[test]
fn authenticated_roundtrip_padding_and_replay_survive_restart() {
    let host = generate_key().unwrap();
    let device = generate_key().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let msg = encrypt(
        &host,
        &device.public_key,
        header(&host, &device, &id),
        &event(),
    )
    .unwrap();
    assert_eq!(msg.ciphertext.len(), 1387);
    assert_eq!(
        decrypt(&device, &host.public_key, &id, &msg, 1000).unwrap(),
        event()
    );
    let mut ledger = ReplayLedger::default();
    ledger.accept(&msg.header, 1000).unwrap();
    let mut restored: ReplayLedger =
        serde_json::from_str(&serde_json::to_string(&ledger).unwrap()).unwrap();
    assert!(restored.accept(&msg.header, 1001).is_err());
    assert!(!serde_json::to_string(&msg).unwrap().contains("Private"));
}
#[test]
fn tampering_wrong_keys_forged_hosts_substitution_and_expiry_are_rejected() {
    let host = generate_key().unwrap();
    let device = generate_key().unwrap();
    let attacker = generate_key().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let msg = encrypt(
        &host,
        &device.public_key,
        header(&host, &device, &id),
        &event(),
    )
    .unwrap();
    assert!(decrypt(&attacker, &host.public_key, &id, &msg, 1000).is_err());
    assert!(decrypt(&device, &attacker.public_key, &id, &msg, 1000).is_err());
    assert!(
        decrypt(
            &device,
            &host.public_key,
            &uuid::Uuid::new_v4().to_string(),
            &msg,
            1000
        )
        .is_err()
    );
    assert!(
        decrypt(
            &device,
            &host.public_key,
            &id,
            &msg,
            1000 + MAX_AGE_SECONDS + 1
        )
        .is_err()
    );
    assert!(decrypt(&device, &host.public_key, &id, &msg, 699).is_err());
    let mut forged = encrypt(
        &attacker,
        &device.public_key,
        header(&attacker, &device, &id),
        &event(),
    )
    .unwrap();
    forged.header.host_id = msg.header.host_id.clone();
    assert!(decrypt(&device, &host.public_key, &id, &forged, 1000).is_err());
    for field in 0..7 {
        let mut changed = msg.clone();
        match field {
            0 => changed.header.event_id = uuid::Uuid::new_v4().to_string(),
            1 => changed.header.issued_at += 1,
            2 => changed.header.version += 1,
            3 => changed.header.device_id = uuid::Uuid::new_v4().to_string(),
            4 => changed.ciphertext.replace_range(
                0..1,
                if &changed.ciphertext[..1] == "A" {
                    "B"
                } else {
                    "A"
                },
            ),
            5 => changed
                .enc
                .replace_range(0..1, if &changed.enc[..1] == "A" { "B" } else { "A" }),
            _ => changed.header.key_id = "x".repeat(43),
        }
        assert!(
            decrypt(&device, &host.public_key, &id, &changed, 1000).is_err(),
            "field {field}"
        );
    }
}
#[test]
fn leases_fresh_expired_missing_corrupt_future_unsafe_and_exact_boundary() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path();
    let id = uuid::Uuid::new_v4().to_string();
    let now = SystemTime::now();
    assert!(!lease_valid(state, &id, || now));
    renew_lease(state, &id).unwrap();
    let path = state.join("leases").join(&id);
    let file = File::open(&path).unwrap();
    file.set_modified(now).unwrap();
    assert!(lease_valid(state, &id, || now));
    assert!(lease_valid(state, &id, || now + Duration::from_secs(9)));
    assert!(!lease_valid(state, &id, || now + LEASE_TTL));
    assert!(!lease_valid(state, &id, || now - Duration::from_secs(1)));
    assert!(!lease_valid(state, &id, || now + Duration::from_secs(11)));
    fs::write(&path, "corrupt").unwrap();
    assert!(!lease_valid(state, &id, || now));
    renew_lease(state, &id).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(!lease_valid(state, &id, SystemTime::now));
    fs::remove_file(&path).unwrap();
    symlink("/etc/passwd", &path).unwrap();
    assert!(!lease_valid(state, &id, || now));
    for bad in [
        "../etc/passwd",
        "",
        "/tmp/surprise",
        "a/b",
        "a;touch /tmp/owned",
    ] {
        assert!(renew_lease(state, bad).is_err());
    }
}
#[test]
fn structured_hook_filters_status_and_parses_context() {
    // Captured from a real Herdr 0.9.5 hook. Subscription names are dotted,
    // but HERDR_PLUGIN_EVENT_JSON uses the snake_case wire event name.
    let mut hook: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/herdr-0.9.5-blocked.json")).unwrap();
    for status in ["blocked", "done", "working", "idle", "unknown"] {
        hook["data"]["agent_status"] = serde_json::json!(status);
        let json = hook.to_string();
        assert_eq!(
            parse_event(&json, "{\"workspace_id\":\"w1\"}", "/tmp/socket")
                .unwrap()
                .is_some(),
            matches!(status, "blocked" | "done")
        );
    }
    assert!(parse_event("garbage", "{}", "/tmp/socket").is_err());
    assert!(parse_event("{}", "garbage", "/tmp/socket").is_err());
}
#[test]
fn per_device_delivery_registration_rotation_and_revocation() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(temp.path());
    let device1 = generate_key().unwrap();
    let device2 = generate_key().unwrap();
    let id1 = uuid::Uuid::new_v4().to_string();
    let id2 = uuid::Uuid::new_v4().to_string();
    s.register(registration(&id1, &device1)).unwrap();
    s.register(registration(&id2, &device2)).unwrap();
    renew_lease(&s.state, &id1).unwrap();
    let sent = Mutex::new(Vec::new());
    assert_eq!(
        deliver(&s, &event(), &|d, e| {
            sent.lock().unwrap().push((d.device_id.clone(), e.clone()));
            Ok(())
        })
        .unwrap(),
        1
    );
    let sent = sent.into_inner().unwrap();
    assert_eq!(sent[0].0, id2);
    let host = s.identity().unwrap();
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert_eq!(
        decrypt(&device2, &host.public_key, &id2, &sent[0].1, now).unwrap(),
        event()
    );
    let rotated = generate_key().unwrap();
    s.register(registration(&id2, &rotated)).unwrap();
    assert_eq!(s.registrations().unwrap().len(), 2);
    assert!(decrypt(&rotated, &host.public_key, &id2, &sent[0].1, now).is_err());
    s.unregister(&id2).unwrap();
    assert_eq!(s.registrations().unwrap().len(), 1);
    assert_eq!(
        deliver(&s, &event(), &|_, _| panic!("revoked device sent")).unwrap(),
        0
    );
}
#[test]
fn concurrent_atomic_renewals_hooks_and_network_errors() {
    let temp = tempfile::tempdir().unwrap();
    let s = Arc::new(store(temp.path()));
    let key = generate_key().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    s.register(registration(&id, &key)).unwrap();
    s.identity().unwrap();
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let s = s.clone();
            let id = id.clone();
            scope.spawn(move || {
                for _ in 0..5 {
                    renew_lease(&s.state, &id).unwrap();
                    assert!(lease_valid(&s.state, &id, SystemTime::now));
                }
            });
        }
        for _ in 0..4 {
            let s = s.clone();
            scope.spawn(move || {
                deliver(&s, &event(), &|_, _| Ok(())).unwrap();
            });
        }
    });
    fs::remove_file(s.state.join("leases").join(id)).unwrap();
    assert!(deliver(&s, &event(), &|_, _| Err("network unavailable".into())).is_err());
    let mut other_session = event();
    other_session.session = "/tmp/other.sock".into();
    assert_eq!(
        deliver(&s, &other_session, &|_, _| panic!("cross-session delivery")).unwrap(),
        0
    );
}
#[test]
fn real_hook_binary_ignores_non_alerting_events_and_lease_command_uses_host_mtime() {
    let tmp = tempfile::tempdir().unwrap();
    let s = store(tmp.path());
    let key = generate_key().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    s.register(registration(&id, &key)).unwrap();
    let run = |args: &[&str], json: &str| {
        std::process::Command::new(env!("CARGO_BIN_EXE_whip-notify"))
            .args(args)
            .env("HERDR_PLUGIN_CONFIG_DIR", &s.config)
            .env("HERDR_PLUGIN_STATE_DIR", &s.state)
            .env("HERDR_SOCKET_PATH", &event().session)
            .env("HERDR_PLUGIN_EVENT_JSON", json)
            .output()
            .unwrap()
    };
    assert!(run(&["lease", "renew", &id], "").status.success());
    assert!(lease_valid(&s.state, &id, SystemTime::now));
    let hook = |status| {
        serde_json::json!({"event":"pane_agent_status_changed","data":{"pane_id":"w1:p2","workspace_id":"w1","agent_status":status}}).to_string()
    };
    assert!(run(&["hook"], &hook("working")).status.success());
    assert!(run(&["hook"], &hook("blocked")).status.success()); // Lease prevents any network request.
    assert!(run(&["hook"], &hook("done")).status.success());
    assert!(
        !run(&["lease", "renew", "../../../tmp/invalid"], "")
            .status
            .success()
    );
}

#[test]
fn cli_registration_over_stdin_and_idempotent_revocation() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let temp = tempfile::tempdir().unwrap();
    let s = store(temp.path());
    let device = generate_key().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut command = Command::new(env!("CARGO_BIN_EXE_whip-notify"));
    command
        .env("HERDR_PLUGIN_CONFIG_DIR", &s.config)
        .env("HERDR_PLUGIN_STATE_DIR", &s.state);
    let mut child = command
        .arg("register")
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&registration(&id, &device)).unwrap())
        .unwrap();
    assert!(child.wait().unwrap().success());
    assert_eq!(s.registrations().unwrap().len(), 1);
    for _ in 0..2 {
        assert!(
            Command::new(env!("CARGO_BIN_EXE_whip-notify"))
                .env("HERDR_PLUGIN_CONFIG_DIR", &s.config)
                .env("HERDR_PLUGIN_STATE_DIR", &s.state)
                .args(["unregister", &id])
                .status()
                .unwrap()
                .success()
        );
    }
    assert!(s.registrations().unwrap().is_empty());
}
