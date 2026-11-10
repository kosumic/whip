//! Explicit opt-in smoke against a real Core; all processes and data are isolated.
#![cfg(feature = "host")]
use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf, process::Command, sync::mpsc, time::Duration};
use whip_notify::{
    Result,
    core::{Core, watcher::follow},
    host::Store,
};

struct Server {
    binary: PathBuf,
    environment: BTreeMap<&'static str, PathBuf>,
    _root: tempfile::TempDir,
}
impl Server {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.binary);
        command
            .envs(&self.environment)
            .env("HC_SESSION", "whip-push-test");
        command
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.command().args(["server", "stop"]).output();
    }
}

#[test]
#[ignore = "requires WHIP_HC_TEST_BINARY; starts only an isolated Core and synthetic OSC reporter"]
fn real_core_status_stream_maps_desktop_targets_without_provider_hooks() -> Result<()> {
    let root = tempfile::tempdir()?;
    let mut environment = BTreeMap::new();
    for (key, path) in [
        ("HOME", root.path().join("home")),
        ("XDG_CONFIG_HOME", root.path().join("config")),
        ("XDG_STATE_HOME", root.path().join("state")),
        ("XDG_RUNTIME_DIR", root.path().join("run")),
        ("HC_SOCKET", root.path().join("core.sock")),
    ] {
        if key != "HC_SOCKET" {
            std::fs::create_dir_all(&path)?;
        }
        environment.insert(key, path);
    }
    let server = Server {
        binary: std::env::var_os("WHIP_HC_TEST_BINARY")
            .ok_or("set WHIP_HC_TEST_BINARY")?
            .into(),
        environment,
        _root: root,
    };
    let output = server
        .command()
        .args(["server", "start", "--json"])
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut core = Core::new(
        server.environment["HC_SOCKET"]
            .to_str()
            .ok_or("invalid path")?
            .into(),
    )?;
    core.store = Store {
        config: server._root.path().join("notify-config"),
        state: server._root.path().join("notify-state"),
    };
    let reply=core.rpc("terminal.run",json!({"argv":["/bin/sh","-c",r#"printf '\033]7501;state=idle:app=codex\033\\'; while IFS= read -r state; do printf '\033]7501;state=%s:app=codex\033\\' "$state"; done"#],"no_parent":true,"no_notify":true,"wait":false}))?;
    let address = reply["address"]
        .as_str()
        .ok_or("terminal.run has no terminal address")?
        .to_owned();
    let document = json!({"spaces":[{"id":"repo","name":"Repo","tabs":[{"id":"task","name":"Task","root":{"id":"pane","type":"block","content":{"terminal":address}}}]}]});
    core.rpc(
        "doc.set",
        json!({"name":"herdr-app","version":0,"value":document}),
    )?;
    let socket = core.socket.clone();
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        follow(&core, &mut |update| {
            tx.send(update).map_err(|_| "test receiver closed")?;
            Err("test received event".into())
        })
    });
    // Repeat status changes until observed, so subscription timing cannot make this flaky.
    let control = Core::new(socket.clone())?;
    let mut update = None;
    for _ in 0..30 {
        control.rpc(
            "terminal.send",
            json!({"terminal":address,"text":"working\n","force":true}),
        )?;
        std::thread::sleep(Duration::from_millis(50));
        control.rpc(
            "terminal.send",
            json!({"terminal":address,"text":"blocked\n","force":true}),
        )?;
        if let Ok(received) = rx.recv_timeout(Duration::from_millis(150)) {
            update = Some(received);
            break;
        }
    }
    let update = update.ok_or("watcher did not receive a real Core status transition")?;
    assert!(worker.join().map_err(|_| "watcher panicked")?.is_err());
    assert_eq!(update.event.status, "blocked");
    assert_eq!(update.event.session, socket);
    assert!(update.event.pane_id.contains("pane"));
    assert!(update.event.workspace_id.contains("repo"));
    Ok(())
}
