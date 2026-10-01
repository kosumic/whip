use super::*;

#[test]
fn real_ssh_bridge_is_shared_per_host_and_last_agent_cleanup_closes_both_ports()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let owner = Arc::new(ReverseControl::default());
        let a_args = owner.prepare(fixture.ssh.clone(), info("a", "pane-a"), agent(HerdrAgentKind::Codex)).await?;
        let remote_port = owner.bridge.lock().as_ref().ok_or("bridge missing")?.remote_port;
        let local_port = fixture.local_port(remote_port).ok_or("forward missing")?;
        let b_args = owner.prepare(fixture.ssh.clone(), info("b", "pane-b"), agent(HerdrAgentKind::OpenCode)).await?;
        assert_eq!(owner.bridge.lock().as_ref().ok_or("bridge missing")?.remote_port, remote_port);
        let token_a = config_token(&a_args)?;
        let token_b = config_token(&b_args)?;
        assert_ne!(token_a, token_b);
        let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":http::LATEST_PROTOCOL}});
        assert_eq!(wire(remote_port, "a", &token_a, "POST", &init, "").await?.status, 200);
        assert_eq!(wire(remote_port, "b", &token_b, "POST", &init, "").await?.status, 200);
        let listed = wire(remote_port, "b", &token_b, "POST", &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), "").await?;
        assert_eq!(listed.body["result"]["tools"].as_array().map(Vec::len), Some(tools::ACTIONS.len() + device::NAMES.len()));
        owner.close_session("a");
        assert_eq!(owner.list().len(), 1);
        let ping = json!({"jsonrpc":"2.0","id":3,"method":"ping"});
        assert_eq!(wire(remote_port, "a", &token_a, "POST", &ping, "").await?.status, 404);
        assert_eq!(wire(remote_port, "b", &token_b, "POST", &ping, "").await?.status, 200);
        let deleted = wire(remote_port, "b", &token_b, "DELETE", &Value::Null, "").await?;
        assert_eq!(deleted.status, 200);
        assert!(owner.list().is_empty());
        assert!(owner.bridge.lock().is_none());
        for port in [remote_port, local_port] {
            port_closes(port).await?;
        }
        Ok(())
    })
}

#[test]
fn ssh_reconnect_preserves_initialized_mcp_session_and_cancels_inflight_commands()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let owner = Arc::new(ReverseControl::default());
        let launch = owner.prepare(fixture.ssh.clone(), info("a", "pane-a"), agent(HerdrAgentKind::Codex)).await?;
        assert_eq!(owner.terminal_state("terminal-pane-a", true), ReverseControlState::Recovering);
        let token = config_token(&launch)?;
        let (epoch, port, local_port) = owner.bridge.lock().as_ref()
            .map(|bridge| (bridge.epoch, bridge.remote_port, bridge.local_port)).ok_or("bridge missing")?;
        let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":http::LATEST_PROTOCOL}});
        assert_eq!(wire(port, "a", &token, "POST", &init, "").await?.status, 200);
        assert_eq!(owner.terminal_state("terminal-pane-a", true), ReverseControlState::Connected);
        let pending = owner.start_action("a", json!(2), &json!({"params":{"name":"device.shizuku_exec","arguments":{"argv":["/system/bin/id"]}}}))
            .map_err(|error| error.to_string())?;
        fixture.ssh.disconnect().await;
        let deadline = Instant::now() + Duration::from_secs(2);
        while !owner.needs_resume() {
            if Instant::now() >= deadline { return Err("MCP did not suspend after transport loss".into()) }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        port_closes(port).await?;
        assert_eq!(owner.list().len(), 1);
        assert_eq!(owner.terminal_state("terminal-pane-a", true), ReverseControlState::Recovering);
        let failed = tokio::time::timeout(Duration::from_secs(2), pending).await??;
        assert_eq!(failed["structuredContent"]["error"]["code"], "device_unavailable");
        assert!(owner.pending.lock().is_empty());
        assert!(owner.steps.lock().is_empty());
        let refused = owner.start_action("a", json!(4), &json!({"params":{"name":"device.shizuku_status","arguments":{}}})).err().ok_or("offline call dispatched")?;
        assert_eq!(refused["structuredContent"]["error"]["code"], "device_unavailable");
        let replacement = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
        owner.resume(replacement.ssh.clone()).await?;
        assert!(!owner.needs_resume());
        assert_eq!(owner.terminal_state("terminal-pane-a", true), ReverseControlState::Connected);
        // The initialized client keeps its original URL, token and session id;
        // no initialize request or replacement agent launch occurs here.
        let listed = wire(port, "a", &token, "POST", &json!({"jsonrpc":"2.0","id":5,"method":"tools/list"}), "").await?;
        assert_eq!(listed.status, 200);
        assert!(listed.body["result"]["tools"].as_array().is_some_and(|tools| tools.iter().any(|tool| tool["name"] == "device.shizuku_exec")));
        let caller_token = token.clone();
        let caller = tokio::spawn(async move {
            wire(port, "a", &caller_token, "POST", &json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"device.shizuku_status","arguments":{}}}), "").await
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        let step = loop {
            if let Some(step) = owner.steps.lock().keys().next().cloned() { break step; }
            if Instant::now() >= deadline { return Err("Restored MCP did not dispatch a native call".into()) }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        owner.reply("a", &step, &json!({"ok":true,"value":{"status":"ready","authorized":true,"backend":"shizuku","uid":2000,"server_version":13}}).to_string());
        let completed = caller.await??;
        assert_eq!(completed.status, 200);
        assert_eq!(completed.body["result"]["structuredContent"]["value"]["uid"], 2000);
        assert!(owner.steps.lock().is_empty());
        owner.suspend_bridge(Some((epoch, 0))); // Delayed old transport callback.
        assert!(!owner.needs_resume());
        assert_eq!(wire(port, "a", &token, "POST", &json!({"jsonrpc":"2.0","id":6,"method":"ping"}), "").await?.status, 200);
        owner.shutdown();
        assert!(owner.list().is_empty());
        assert_eq!(owner.terminal_state("terminal-pane-a", false), ReverseControlState::Off);
        assert_eq!(owner.terminal_state("terminal-pane-a", true), ReverseControlState::RestartRequired);
        port_closes(port).await?;
        port_closes(local_port).await?;
        Ok(())
    })
}

#[test]
fn failed_mcp_forward_restore_keeps_authorization_for_retry_but_close_revokes_it()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let owner = Arc::new(ReverseControl::default());
        owner
            .prepare(
                fixture.ssh.clone(),
                info("a", "pane-a"),
                agent(HerdrAgentKind::Codex),
            )
            .await?;
        let port = owner
            .bridge
            .lock()
            .as_ref()
            .ok_or("bridge missing")?
            .remote_port;
        owner.suspend();
        port_closes(port).await?;
        let blocked = crate::ssh::ReverseForwardFixture::new(false, Duration::ZERO).await?;
        assert!(owner.resume(blocked.ssh.clone()).await.is_err());
        assert_eq!(owner.list().len(), 1);
        assert!(owner.needs_resume());
        let replacement = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
        owner.resume(replacement.ssh.clone()).await?;
        owner.close_terminal("terminal-pane-a");
        assert!(owner.list().is_empty());
        port_closes(port).await?;
        owner.resume(replacement.ssh.clone()).await?;
        assert!(owner.bridge.lock().is_none());
        Ok(())
    })
}

#[test]
fn a_host_that_refuses_reverse_forwarding_receives_no_mcp_authorization()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = crate::ssh::ReverseForwardFixture::new(false, Duration::ZERO).await?;
        let owner = Arc::new(ReverseControl::default());
        let result = owner
            .prepare(
                fixture.ssh.clone(),
                info("a", "pane-a"),
                agent(HerdrAgentKind::OpenCode),
            )
            .await;
        assert!(result.is_err());
        assert!(owner.list().is_empty());
        assert!(owner.bridge.lock().is_none());
        Ok(())
    })
}

fn agent(kind: HerdrAgentKind) -> AgentLaunch {
    AgentLaunch { kind, args: vec![] }
}

fn opencode_config(command: &str) -> Result<Value, Box<dyn Error>> {
    let argv = shlex::split(command).ok_or("invalid shell command")?;
    assert_eq!(argv[0], "env");
    assert_eq!(argv[2], "opencode");
    Ok(serde_json::from_str(
        argv[1]
            .strip_prefix("OPENCODE_CONFIG_CONTENT=")
            .ok_or("inline config missing")?,
    )?)
}

pub(crate) fn config_token(launch: &HerdrTabLaunch) -> Result<String, Box<dyn Error>> {
    if let HerdrTabLaunch::Command { command } = launch {
        let config = opencode_config(command)?;
        return Ok(config["mcp"]["whip"]["headers"]["Authorization"]
            .as_str()
            .and_then(|header| header.strip_prefix("Bearer "))
            .ok_or("bearer token missing")?
            .to_owned());
    }
    let HerdrTabLaunch::Agent { args, .. } = launch else {
        return Err("agent launch missing".into());
    };
    let encoded = args
        .iter()
        .find_map(|arg| arg.strip_prefix("mcp_servers.whip.http_headers={Authorization="))
        .and_then(|arg| arg.strip_suffix('}'))
        .ok_or("authorization override missing")?;
    let authorization: String = serde_json::from_str(encoded)?;
    Ok(authorization
        .strip_prefix("Bearer ")
        .ok_or("bearer token missing")?
        .to_owned())
}

pub(crate) async fn port_closes(port: u16) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(2);
    while TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
        if Instant::now() >= deadline {
            return Err("browser transport listener still open".into());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Ok(())
}

use std::error::Error;
use std::io;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const TOKEN_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

pub(crate) fn recovery_owner(path: &std::path::Path) -> Arc<ReverseControl> {
    Arc::new(ReverseControl {
        recovery: Mutex::new(recovery::Recovery::at(path.to_owned())),
        ..ReverseControl::default()
    })
}

pub(crate) fn bridge_port(owner: &ReverseControl) -> Result<u16, Box<dyn Error>> {
    owner
        .bridge
        .lock()
        .as_ref()
        .map(|bridge| bridge.remote_port)
        .ok_or_else(|| "bridge missing".into())
}

pub(crate) fn recovery_pane() -> HerdrPaneInfo {
    HerdrPaneInfo {
        pane_id: "pane-a".into(),
        terminal_id: "terminal-pane-a".into(),
        workspace_id: "workspace".into(),
        tab_id: "tab".into(),
        focused: false,
        cwd: None,
        foreground_cwd: None,
        label: None,
        agent: Some("codex".into()),
        title: None,
        terminal_title: None,
        terminal_title_stripped: None,
        display_agent: None,
        agent_status: crate::herdr_api::HerdrAgentStatus::Idle,
        state_labels: None,
        tokens: None,
        agent_session: Some(crate::herdr_api::HerdrAgentSessionInfo {
            source: "integration".into(),
            agent: "codex".into(),
            kind: crate::herdr_api::HerdrAgentSessionKind::Id,
            value: "conversation-a".into(),
        }),
        scroll: None,
        revision: 0.0,
    }
}

async fn saved_launch(path: &std::path::Path) -> Result<(u16, String), Box<dyn Error>> {
    let fixture = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
    let owner = recovery_owner(path);
    owner.reconcile(&[]); // First fresh snapshot lazily opens the host's recovery store.
    let launch = owner
        .prepare(
            fixture.ssh.clone(),
            info(TOKEN_A, "pane-a"),
            agent(HerdrAgentKind::Codex),
        )
        .await?;
    let port = owner
        .bridge
        .lock()
        .as_ref()
        .ok_or("bridge missing")?
        .remote_port;
    let token = config_token(&launch)?;
    let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":http::LATEST_PROTOCOL}});
    assert_eq!(
        wire(port, TOKEN_A, &token, "POST", &init, "").await?.status,
        200
    );
    owner.reconcile(&[recovery_pane()]);
    let record = std::fs::read_to_string(path)?;
    assert!(!record.contains(&token));
    owner.suspend();
    port_closes(port).await?;
    drop(owner); // Process death retains recovery; explicit shutdown revokes it.
    Ok((port, token))
}

#[test]
fn process_restart_lazily_restores_original_mcp_endpoint_and_native_tools()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("host.json");
        let (port, token) = saved_launch(&path).await?;
        let owner = recovery_owner(&path);
        assert!(owner.list().is_empty());
        assert!(!owner.needs_resume());
        let mut pane = recovery_pane();
        pane.agent_session = None;
        owner.reconcile(&[pane]);
        assert!(owner.list().is_empty()); // Metadata delay must not grant old access.
        assert!(owner.recovering_terminal("terminal-pane-a"));
        owner.reconcile(&[recovery_pane()]);
        assert!(owner.needs_resume());
        assert!(!owner.connected_terminal("terminal-pane-a"));
        let occupied = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
        let replacement = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
        assert!(owner.resume(replacement.ssh.clone()).await.is_err());
        assert!(owner.needs_resume());
        assert!(owner.authenticate(TOKEN_A, &token).is_some());
        drop(occupied);
        owner.resume(replacement.ssh.clone()).await?;
        assert!(owner.connected_terminal("terminal-pane-a"));
        assert!(!owner.needs_resume());
        let listed = wire(port, TOKEN_A, &token, "POST", &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), "").await?;
        assert_eq!(listed.status, 200); // No new initialize or agent launch.
        let caller = tokio::spawn(async move {
            wire(port, TOKEN_A, &token, "POST", &json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"device.battery","arguments":{}}}), "").await
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        let step = loop {
            if let Some(step) = owner.steps.lock().keys().next().cloned() { break step; }
            if Instant::now() >= deadline { return Err("Restored battery call did not dispatch".into()) }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        owner.reply(TOKEN_A, &step, &json!({"ok":true,"value":{"level":0.75,"state":"unplugged","low_power_mode":false}}).to_string());
        let result = caller.await??;
        assert_eq!(result.body["result"]["structuredContent"]["value"]["level"], 0.75);
        owner.shutdown();
        assert!(!path.exists());
        port_closes(port).await?;
        Ok(())
    })
}

#[test]
fn recovery_rejects_replaced_agents_and_keeps_explicit_revocation_across_restart()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let directory = tempfile::tempdir()?;
        let original = directory.path().join("original.json");
        saved_launch(&original).await?;
        let mut different_conversation = recovery_pane();
        different_conversation
            .agent_session
            .as_mut()
            .ok_or("missing identity")?
            .value = "replacement".into();
        let mut different_terminal = recovery_pane();
        different_terminal.terminal_id = "replacement".into();
        let mut different_agent = recovery_pane();
        different_agent.agent = Some("opencode".into());
        for panes in [
            vec![],
            vec![different_conversation],
            vec![different_terminal],
            vec![different_agent],
        ] {
            let path = directory.path().join("replaced.json");
            std::fs::copy(&original, &path)?;
            let owner = recovery_owner(&path);
            owner.reconcile(&panes);
            assert!(owner.list().is_empty());
            assert!(!owner.needs_resume());
            assert!(!path.exists());
        }
        let owner = recovery_owner(&original);
        owner.close_terminal("terminal-pane-a"); // Disable before even loading a snapshot.
        assert!(!original.exists());
        let reopened = recovery_owner(&original);
        reopened.reconcile(&[recovery_pane()]);
        assert!(reopened.list().is_empty());
        assert!(!reopened.needs_resume());
        Ok(())
    })
}

#[test]
fn launching_before_first_snapshot_preserves_the_saved_port_without_granting_saved_access()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("host.json");
        let (port, token) = saved_launch(&path).await?;
        let owner = recovery_owner(&path);
        let replacement = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
        owner
            .prepare(
                replacement.ssh.clone(),
                info(TOKEN_B, "pane-b"),
                agent(HerdrAgentKind::Codex),
            )
            .await?;
        assert_eq!(
            owner
                .bridge
                .lock()
                .as_ref()
                .ok_or("bridge missing")?
                .remote_port,
            port
        );
        let ping = json!({"jsonrpc":"2.0","id":1,"method":"ping"});
        assert_eq!(
            wire(port, TOKEN_A, &token, "POST", &ping, "").await?.status,
            404
        );
        let mut new_pane = recovery_pane();
        new_pane.pane_id = "pane-b".into();
        new_pane.terminal_id = "terminal-pane-b".into();
        owner.reconcile(&[recovery_pane(), new_pane]);
        assert_eq!(
            wire(port, TOKEN_A, &token, "POST", &ping, "").await?.status,
            200
        );
        owner.shutdown();
        assert!(!path.exists());
        Ok(())
    })
}

fn info(id: &str, pane: &str) -> ReverseControlSession {
    ReverseControlSession {
        runtime_id: "host".to_owned(),
        session_id: id.to_owned(),
        pane_id: pane.to_owned(),
        terminal_id: format!("terminal-{pane}"),
    }
}

fn insert(owner: &ReverseControl, id: &str, pane: &str) {
    owner.sessions.lock().insert(
        id.to_owned(),
        Session {
            info: info(id, pane),
            agent: HerdrAgentKind::Codex,
            token_hash: token_hash(if id == "a" { TOKEN_A } else { TOKEN_B }),
            started: Instant::now(),
            observed_agent: false,
            conversation: None,
            protocol: None,
        },
    );
}

#[test]
fn only_explicit_supported_agent_launches_are_authorized() -> Result<(), Box<dyn Error>> {
    assert!(agent_launch(HerdrTabLaunch::Shell).is_err());
    assert!(
        agent_launch(HerdrTabLaunch::Command {
            command: "codex".to_owned()
        })
        .is_err()
    );
    assert!(
        agent_launch(HerdrTabLaunch::Agent {
            kind: HerdrAgentKind::Claude,
            args: vec![]
        })
        .is_err()
    );
    for kind in [HerdrAgentKind::Codex, HerdrAgentKind::OpenCode] {
        let launch = agent_launch(HerdrTabLaunch::Agent {
            kind,
            args: vec!["--model=test".to_owned()],
        })?;
        assert_eq!(launch.kind, kind);
        assert_eq!(launch.args, vec!["--model=test"]);
        for argument in ["bad\0arg", "bad\narg"] {
            assert!(
                agent_launch(HerdrTabLaunch::Agent {
                    kind,
                    args: vec![argument.to_owned()]
                })
                .is_err()
            );
        }
    }
    Ok(())
}

#[test]
fn opencode_v1_and_v2_launches_scope_config_and_preserve_literal_arguments()
-> Result<(), Box<dyn Error>> {
    use std::os::unix::fs::PermissionsExt;
    // Execute the generated command through a real shell. The fake CLI reports
    // its environment and argv, catching escaping bugs at the shell boundary.
    let directory = tempfile::tempdir()?;
    let executable = directory.path().join("opencode");
    std::fs::write(
        &executable,
        "#!/bin/sh\nprintf '%s\\0' \"$OPENCODE_CONFIG_CONTENT\" \"$@\"\n",
    )?;
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))?;
    let args = vec![
        "--prompt".to_owned(),
        "quotes ' \"; $(exit 99) `exit 99` \\ and spaces".to_owned(),
    ];
    for version in ["1.18.31", "v2.0.19"] {
        let mut launch = AgentLaunch {
            kind: HerdrAgentKind::OpenCode,
            args: args.clone(),
        };
        launch.set_opencode_version(version)?;
        let HerdrTabLaunch::Command { command } =
            configured_launch(launch, "session-a", 12345, TOKEN_A)?
        else {
            return Err("OpenCode command missing".into());
        };
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", directory.path().display()),
            )
            .output()?;
        assert!(output.status.success());
        let fields = std::str::from_utf8(&output.stdout)?
            .split_terminator('\0')
            .collect::<Vec<_>>();
        let config: Value = serde_json::from_str(fields[0])?;
        assert_eq!(
            config,
            json!({"mcp": {"whip": {
                "type": "remote", "url": "http://127.0.0.1:12345/mcp/session-a",
                "enabled": true, "oauth": false, "timeout": MCP_TOOL_TIMEOUT.as_millis(),
                "headers": {"Authorization": format!("Bearer {TOKEN_A}")},
            }}})
        );
        let expected = if version.starts_with("v2") {
            std::iter::once(OPENCODE_STANDALONE_ARG)
                .chain(args.iter().map(String::as_str))
                .collect::<Vec<_>>()
        } else {
            args.iter().map(String::as_str).collect()
        };
        assert_eq!(&fields[1..], expected);
    }
    let mut launch = agent(HerdrAgentKind::OpenCode);
    launch.set_opencode_version("2.0.19")?;
    launch.set_opencode_version("2.0.19")?;
    assert_eq!(launch.args, vec![OPENCODE_STANDALONE_ARG]);
    assert!(launch.set_opencode_version("3.0.0").is_err());
    for args in [
        vec!["attach"],
        vec!["--server=http://localhost:4096"],
        vec!["run", "--attach", "http://localhost:4096"],
    ] {
        assert!(
            agent_launch(HerdrTabLaunch::Agent {
                kind: HerdrAgentKind::OpenCode,
                args: args.into_iter().map(str::to_owned).collect()
            })
            .is_err()
        );
    }
    Ok(())
}

#[test]
fn cleanup_tracks_the_authorized_agent_kind_and_terminal() -> Result<(), Box<dyn Error>> {
    let owner = ReverseControl::default();
    insert(&owner, "a", "pane-a");
    owner
        .sessions
        .lock()
        .get_mut("a")
        .ok_or("session missing")?
        .agent = HerdrAgentKind::OpenCode;
    let mut pane = recovery_pane();
    pane.agent = None;
    pane.agent_session = None;
    owner.reconcile(&[pane.clone()]);
    assert_eq!(owner.list().len(), 1); // Waiting for first agent observation.
    pane.agent = Some("opencode".into());
    owner.reconcile(&[pane.clone()]);
    assert_eq!(owner.list().len(), 1);
    pane.agent = Some("codex".into());
    owner.reconcile(&[pane.clone()]);
    assert!(owner.list().is_empty());
    insert(&owner, "a", "pane-a");
    pane.terminal_id = "replacement-terminal".into();
    owner.reconcile(&[pane]);
    assert!(owner.list().is_empty());
    Ok(())
}

#[test]
fn replies_and_cleanup_are_scoped_to_the_authorized_session() -> Result<(), Box<dyn Error>> {
    let owner = ReverseControl::default();
    insert(&owner, "a", "pane-a");
    insert(&owner, "b", "pane-b");
    let (response, receiver) = oneshot::channel();
    owner.pending.lock().insert(
        "request-a".to_owned(),
        Pending {
            session: "a".to_owned(),
            rpc_id: json!(1),
            response,
        },
    );
    owner.reply("b", "request-a", "{}");
    assert!(owner.pending.lock().contains_key("request-a"));
    owner.close_terminal("terminal-pane-a");
    assert_eq!(owner.list().len(), 1);
    assert_eq!(owner.list()[0].session_id, "b");
    assert!(owner.pending.lock().is_empty());
    let result = crate::runtime()?.block_on(receiver)?;
    assert_eq!(result["isError"], true);
    owner.shutdown();
    assert!(owner.list().is_empty());
    Ok(())
}

#[test]
fn tool_surface_is_compact_and_includes_page_eval_without_native_execution() {
    let catalog = tools::tools();
    let tools = catalog.as_array().unwrap_or_else(|| panic!("tool catalog"));
    assert_eq!(tools.len(), tools::ACTIONS.len() + device::NAMES.len());
    assert!(tools.iter().any(|tool| tool["name"] == "browser.eval"));
    for tool in tools {
        let name = tool["name"].as_str().unwrap_or_default();
        assert!(name.starts_with("browser.") || device::NAMES.contains(&name));
        assert_ne!(name, "browser.execute_js");
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
    }
}

#[test]
fn session_tokens_are_unpredictable_and_unique() -> Result<(), Box<dyn Error>> {
    let first = random_token()?;
    assert_eq!(first.len(), 64);
    assert_ne!(first, random_token()?);
    let owner = ReverseControl::default();
    insert(&owner, "a", "pane-a");
    assert!(owner.authenticate("a", TOKEN_A).is_some());
    assert!(owner.authenticate("a", TOKEN_B).is_none());
    assert!(owner.authenticate("b", TOKEN_A).is_none());
    assert!(owner.authenticate("a", "").is_none());
    Ok(())
}

#[test]
fn launch_configuration_uses_http_with_no_remote_process_or_files() -> Result<(), Box<dyn Error>> {
    let launch = configured_launch(
        AgentLaunch {
            kind: HerdrAgentKind::Codex,
            args: vec!["resume".to_owned(), "--last".to_owned()],
        },
        "agent-a",
        12345,
        TOKEN_A,
    )?;
    let HerdrTabLaunch::Agent { kind, args } = launch else {
        return Err("agent launch missing".into());
    };
    assert_eq!(kind, HerdrAgentKind::Codex);
    assert_eq!(
        args,
        vec![
            "-c",
            "mcp_servers.whip.url=\"http://127.0.0.1:12345/mcp/agent-a\"",
            "-c",
            &format!("mcp_servers.whip.http_headers={{Authorization=\"Bearer {TOKEN_A}\"}}"),
            "-c",
            "mcp_servers.whip.required=true",
            "-c",
            "mcp_servers.whip.tool_timeout_sec=125",
            "resume",
            "--last",
        ]
    );
    Ok(())
}

struct Fixture {
    owner: Arc<ReverseControl>,
    _server: http::Server,
    port: u16,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.owner.shutdown();
    }
}
impl Fixture {
    async fn new() -> Result<Self, Box<dyn Error>> {
        let owner = Arc::new(ReverseControl::default());
        insert(&owner, "a", "pane-a");
        insert(&owner, "b", "pane-b");
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let server = http::serve(
            listener,
            Arc::downgrade(&owner),
            format!("127.0.0.1:{port}"),
            0,
        )?;
        Ok(Self {
            owner,
            _server: server,
            port,
        })
    }

    async fn initialize(&self, id: &str, token: &str) -> io::Result<WireResponse> {
        wire(self.port, id, token, "POST", &json!({
            "jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"protocolVersion":http::LATEST_PROTOCOL,"capabilities":{},"clientInfo":{"name":"test","version":"1"}}
        }), "").await
    }
}

pub(crate) struct WireResponse {
    pub(crate) status: u16,
    headers: HashMap<String, String>,
    body: Value,
}
pub(crate) async fn wire(
    port: u16,
    session: &str,
    token: &str,
    method: &str,
    message: &Value,
    extra_headers: &str,
) -> io::Result<WireResponse> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    let body = message.to_string();
    let session_header = if message["method"] == "initialize" {
        String::new()
    } else {
        format!("Mcp-Session-Id: {session}\r\n")
    };
    let request = format!(
        "{method} /mcp/{session} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n{session_header}Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n{extra_headers}\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response)).await??;
    decode_response(&response)
}

fn decode_response(response: &[u8]) -> io::Result<WireResponse> {
    let response = std::str::from_utf8(response).map_err(io::Error::other)?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| io::Error::other("HTTP header missing"))?;
    let mut lines = headers.lines();
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| io::Error::other("HTTP status missing"))?
        .parse()
        .map_err(io::Error::other)?;
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let body = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(body).map_err(io::Error::other)?
    };
    Ok(WireResponse {
        status,
        headers,
        body,
    })
}

async fn pending_requests(
    owner: &ReverseControl,
    count: usize,
) -> io::Result<HashMap<String, String>> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let calls: HashMap<_, _> = owner
            .pending
            .lock()
            .iter()
            .map(|(request, call)| (call.session.clone(), request.clone()))
            .collect();
        if calls.len() == count {
            return Ok(calls);
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other("browser requests not delivered"));
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[test]
fn http_mcp_initializes_notifies_discovers_and_rejects_bad_auth_or_origin()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = Fixture::new().await?;
        let initialized = fixture.initialize("a", TOKEN_A).await?;
        assert_eq!(initialized.status, 200);
        assert_eq!(initialized.headers.get("mcp-session-id").map(String::as_str), Some("a"));
        assert_eq!(initialized.body["result"]["protocolVersion"], http::LATEST_PROTOCOL);
        assert_eq!(initialized.body["result"]["serverInfo"]["name"], "whip");
        let notification = wire(fixture.port, "a", TOKEN_A, "POST", &json!({"jsonrpc":"2.0","method":"notifications/initialized"}), "").await?;
        assert_eq!(notification.status, 202);
        assert!(notification.body.is_null());
        let catalog = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"});
        let listed = wire(fixture.port, "a", TOKEN_A, "POST", &catalog, "").await?;
        assert_eq!(listed.status, 200);
        assert_eq!(listed.body["result"]["tools"].as_array().map(Vec::len), Some(tools::ACTIONS.len() + device::NAMES.len()));
        assert_eq!(wire(fixture.port, "a", TOKEN_B, "POST", &catalog, "").await?.status, 401);
        assert_eq!(wire(fixture.port, "missing", TOKEN_A, "POST", &catalog, "").await?.status, 404);
        assert_eq!(wire(fixture.port, "a", TOKEN_A, "POST", &catalog, "Origin: https://evil.example\r\n").await?.status, 403);
        assert_eq!(wire(fixture.port, "a", TOKEN_A, "POST", &catalog, "Mcp-Protocol-Version: unsupported\r\n").await?.status, 400);
        assert_eq!(wire(fixture.port, "a", TOKEN_A, "POST", &json!([]), "").await?.status, 400);
        assert_eq!(wire(fixture.port, "a", TOKEN_A, "GET", &Value::Null, "").await?.status, 405);
        assert_eq!(wire(fixture.port, "b", TOKEN_B, "POST", &catalog, "").await?.status, 400);
        let unknown = wire(fixture.port, "a", TOKEN_A, "POST", &json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser.execute_js"}}), "").await?;
        assert_eq!(unknown.body["result"]["isError"], true);
        Ok(())
    })
}

#[test]
fn http_script_instructions_are_executable_and_scoped_to_each_launch() -> Result<(), Box<dyn Error>>
{
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir()?;
    let executable = directory.path().join("curl");
    std::fs::write(&executable, "#!/bin/sh\nprintf '%s\\0' \"$@\"\n")?;
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))?;
    crate::runtime()?.block_on(async {
        let fixture = Fixture::new().await?;
        for (session, token, other_token, requested, negotiated) in [
            ("a", TOKEN_A, TOKEN_B, "2025-03-26", "2025-03-26"),
            (
                "b",
                TOKEN_B,
                TOKEN_A,
                "future-version",
                http::LATEST_PROTOCOL,
            ),
        ] {
            let initialized = wire(
                fixture.port,
                session,
                token,
                "POST",
                &json!({
                    "jsonrpc":"2.0", "id":1, "method":"initialize",
                    "params":{"protocolVersion":requested}
                }),
                "",
            )
            .await?;
            let instructions = initialized.body["result"]["instructions"]
                .as_str()
                .ok_or("server instructions missing")?;
            let script = tools::script_instructions(
                &format!("127.0.0.1:{}", fixture.port),
                session,
                token,
                negotiated,
            )?;
            assert!(instructions.contains(&script));
            assert!(!instructions.contains(other_token));
            assert_eq!(
                initialized.headers.get("cache-control").map(String::as_str),
                Some("no-store")
            );

            let command = instructions
                .split_once("```sh\n")
                .and_then(|(_, remaining)| remaining.split_once("\n```"))
                .map(|(command, _)| command)
                .ok_or("curl example missing")?;
            let output = std::process::Command::new("/bin/sh")
                .args(["-c", command])
                .env(
                    "PATH",
                    format!("{}:/usr/bin:/bin", directory.path().display()),
                )
                .output()?;
            assert!(output.status.success());
            let args = std::str::from_utf8(&output.stdout)?
                .split_terminator('\0')
                .collect::<Vec<_>>();
            assert!(
                args.contains(&format!("http://127.0.0.1:{}/mcp/{session}", fixture.port).as_str())
            );
            for header in [
                format!("Authorization: Bearer {token}"),
                format!("Mcp-Session-Id: {session}"),
                format!("MCP-Protocol-Version: {negotiated}"),
                "Content-Type: application/json".to_owned(),
                "Accept: application/json, text/event-stream".to_owned(),
            ] {
                assert!(
                    args.windows(2)
                        .any(|pair| pair == ["--header", header.as_str()])
                );
            }
            let body = args
                .windows(2)
                .find(|pair| pair[0] == "--data-binary")
                .map(|pair| pair[1])
                .ok_or("request body missing")?;
            assert_eq!(
                serde_json::from_str::<Value>(body)?,
                json!({
                    "jsonrpc":"2.0", "id":1, "method":"tools/call",
                    "params":{"name":tools::SCRIPT_DISCOVERY_TOOL, "arguments":{}}
                })
            );

            let catalog = json!({"jsonrpc":"2.0", "id":2, "method":"tools/list"});
            let listed = wire(fixture.port, session, token, "POST", &catalog, "").await?;
            let description = listed.body["result"]["tools"]
                .as_array()
                .and_then(|catalog| {
                    catalog
                        .iter()
                        .find(|tool| tool["name"] == tools::SCRIPT_DISCOVERY_TOOL)
                })
                .and_then(|tool| tool["description"].as_str())
                .ok_or("discovery description missing")?;
            assert!(description.contains(&script));
            assert!(!listed.body.to_string().contains(other_token));
            assert_eq!(
                listed.headers.get("cache-control").map(String::as_str),
                Some("no-store")
            );
            let rejected = wire(fixture.port, session, other_token, "POST", &catalog, "").await?;
            assert_eq!(rejected.status, 401);
            assert!(rejected.body.is_null());
            fixture.owner.close_session(session);
            let revoked = wire(fixture.port, session, token, "POST", &catalog, "").await?;
            assert_eq!(revoked.status, 404);
            assert!(revoked.body.is_null());
        }
        Ok(())
    })
}

#[test]
fn http_agents_share_a_listener_but_same_rpc_ids_and_replies_are_isolated()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = Fixture::new().await?;
        fixture.initialize("a", TOKEN_A).await?;
        fixture.initialize("b", TOKEN_B).await?;
        let call = json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"browser.snapshot"}});
        let port = fixture.port;
        let a_call = call.clone();
        let a = tokio::spawn(async move { wire(port, "a", TOKEN_A, "POST", &a_call, "").await });
        let b = tokio::spawn(async move { wire(port, "b", TOKEN_B, "POST", &call, "").await });
        let pending = pending_requests(&fixture.owner, 2).await?;
        assert_ne!(pending.get("a"), pending.get("b"));
        let request_a = pending.get("a").ok_or("missing a")?;
        fixture.owner.reply("b", request_a, "{}");
        assert_eq!(fixture.owner.pending.lock().len(), 2);
        drive_snapshot(&fixture.owner,"b","page-b").await?;
        drive_snapshot(&fixture.owner,"a","page-a").await?;
        assert_eq!(a.await??.body["result"]["structuredContent"]["title"], "page-a");
        assert_eq!(b.await??.body["result"]["structuredContent"]["title"], "page-b");
        assert!(fixture.owner.pending.lock().is_empty());
        assert_eq!(wire(port, "a", TOKEN_A, "DELETE", &Value::Null, "").await?.status, 200);
        let ping = json!({"jsonrpc":"2.0","id":8,"method":"ping"});
        assert_eq!(wire(port, "a", TOKEN_A, "POST", &ping, "").await?.status, 404);
        assert_eq!(wire(port, "b", TOKEN_B, "POST", &ping, "").await?.status, 200);
        assert_eq!(fixture.owner.list().len(), 1);
        Ok(())
    })
}

#[test]
fn http_cancellation_is_scoped_to_a_launch_and_closing_the_host_settles_other_calls()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = Fixture::new().await?;
        fixture.initialize("a", TOKEN_A).await?;
        fixture.initialize("b", TOKEN_B).await?;
        let call = json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"browser.snapshot"}});
        let port = fixture.port;
        let a_call = call.clone();
        let a = tokio::spawn(async move { wire(port, "a", TOKEN_A, "POST", &a_call, "").await });
        let b = tokio::spawn(async move { wire(port, "b", TOKEN_B, "POST", &call, "").await });
        pending_requests(&fixture.owner, 2).await?;
        let cancelled = wire(port, "a", TOKEN_A, "POST", &json!({
            "jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}
        }), "").await?;
        assert_eq!(cancelled.status, 202);
        let a = a.await??;
        assert_eq!(a.body["result"]["isError"], true);
        assert_eq!(a.body["result"]["structuredContent"]["error"]["message"], "Browser action cancelled");
        assert_eq!(fixture.owner.pending.lock().len(), 1);
        fixture.owner.shutdown();
        let b = b.await??;
        assert_eq!(b.body["result"]["isError"], true);
        assert_eq!(b.body["result"]["structuredContent"]["error"]["message"], "Browser session closed");
        assert!(fixture.owner.list().is_empty());
        assert!(fixture.owner.pending.lock().is_empty());
        Ok(())
    })
}

#[test]
fn http_bodies_are_bounded_and_unknown_protocols_negotiate_a_supported_version()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = Fixture::new().await?;
        let negotiated = wire(fixture.port, "a", TOKEN_A, "POST", &json!({
            "jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"future-version"}
        }), "").await?;
        assert_eq!(negotiated.body["result"]["protocolVersion"], http::LATEST_PROTOCOL);
        let oversized = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser.type","arguments":{"text":"x".repeat(1024 * 1024)}}});
        assert_eq!(wire(fixture.port, "a", TOKEN_A, "POST", &oversized, "").await?.status, 413);
        assert!(fixture.owner.pending.lock().is_empty());
        Ok(())
    })
}

#[test]
fn stopping_the_http_server_closes_its_loopback_listener() -> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = Fixture::new().await?;
        let port = fixture.port;
        fixture.initialize("a", TOKEN_A).await?;
        drop(fixture);
        let deadline = Instant::now() + Duration::from_secs(2);
        while TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            if Instant::now() > deadline {
                return Err("MCP listener still open".into());
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        Ok(())
    })
}

async fn next_step(owner: &ReverseControl, session: &str) -> Result<String, Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(request) = owner
            .steps
            .lock()
            .iter()
            .find(|(_, step)| step.session == session)
            .map(|(request, _)| request.clone())
        {
            return Ok(request);
        }
        if Instant::now() >= deadline {
            return Err("native step was not dispatched".into());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
async fn drive_snapshot(
    owner: &ReverseControl,
    session: &str,
    title: &str,
) -> Result<(), Box<dyn Error>> {
    let tab = format!("{session}-tab-1");
    let replies = [
        json!({"tab_id":tab,"tabs":[{"tab_id":tab,"url":"https://example.test/","title":title,"selected":true}]}),
        json!({"id":"doc","identity":format!("{tab}-0"),"url":"https://example.test/","public_url":"https://example.test/","ready":true}),
        json!({"ok":true,"value":{"url":"https://example.test/","title":title,"generation":"doc:0","elements":[]}}),
    ];
    for value in replies {
        let step = next_step(owner, session).await?;
        owner.reply(
            session,
            &step,
            &json!({"ok":true,"value":value}).to_string(),
        );
    }
    Ok(())
}

#[test]
fn malformed_actions_and_cross_session_tabs_do_not_reach_the_native_bridge()
-> Result<(), Box<dyn Error>> {
    let owner = Arc::new(ReverseControl::default());
    insert(&owner, "a", "pane-a");
    for (name, args, code) in [
        ("browser.eval", json!({"js":42}), "invalid_argument"),
        (
            "browser.click",
            json!({"target":{"role":"button"},"ref":"ref"}),
            "invalid_argument",
        ),
        (
            "browser.snapshot",
            json!({"tab_id":"b-tab-1"}),
            "unauthorized",
        ),
    ] {
        let result = owner
            .start_action(
                "a",
                json!(1),
                &json!({"params":{"name":name,"arguments":args}}),
            )
            .err()
            .ok_or("unexpected action dispatch")?;
        assert_eq!(result["structuredContent"]["error"]["code"], code);
    }
    assert!(owner.pending.lock().is_empty());
    assert!(owner.steps.lock().is_empty());
    owner.shutdown();
    Ok(())
}
#[test]
fn native_steps_reject_wrong_session_oversized_and_malformed_replies() -> Result<(), Box<dyn Error>>
{
    crate::runtime()?.block_on(async {
        let owner = Arc::new(ReverseControl::default());
        insert(&owner, "a", "pane-a");
        for bad in ["invalid".to_owned(), "x".repeat(MAX_RESPONSE + 1)] {
            let receiver = owner
                .start_action(
                    "a",
                    json!(1),
                    &json!({"params":{"name":"browser.snapshot"}}),
                )
                .map_err(|_| "start failed")?;
            let step = next_step(&owner, "a").await?;
            owner.reply("b", &step, &json!({"ok":true,"value":{}}).to_string());
            assert!(owner.steps.lock().contains_key(&step));
            owner.reply("a", &step, &bad);
            let result = receiver.await?;
            assert_eq!(result["isError"], true);
            assert!(matches!(
                result["structuredContent"]["error"]["code"].as_str(),
                Some("invalid_result" | "result_too_large")
            ));
        }
        assert!(owner.pending.lock().is_empty());
        assert!(owner.steps.lock().is_empty());
        owner.shutdown();
        Ok(())
    })
}
#[test]
fn cancellation_cleans_native_steps_and_ignores_late_callbacks() -> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let owner = Arc::new(ReverseControl::default());
        insert(&owner, "a", "pane-a");
        let receiver = owner
            .start_action(
                "a",
                json!(1),
                &json!({"params":{"name":"browser.eval","arguments":{"js":"new Promise(()=>{})"}}}),
            )
            .map_err(|_| "start failed")?;
        let step = next_step(&owner, "a").await?;
        let root = owner
            .steps
            .lock()
            .get(&step)
            .ok_or("step missing")?
            .parent
            .clone();
        owner.cancel_request(&root, "Browser action cancelled");
        assert_eq!(
            receiver.await?["structuredContent"]["error"]["code"],
            "cancelled"
        );
        owner.reply("a", &step, &json!({"ok":true,"value":{}}).to_string());
        assert!(owner.pending.lock().is_empty());
        assert!(owner.steps.lock().is_empty());
        assert!(owner.tasks.lock().is_empty());
        owner.shutdown();
        Ok(())
    })
}

#[test]
fn device_arguments_are_validated_before_native_dispatch() -> Result<(), Box<dyn Error>> {
    let owner = Arc::new(ReverseControl::default());
    insert(&owner, "a", "pane-a");
    for (name, args, code) in [
        (
            "device.location",
            json!({"background":true}),
            "invalid_argument",
        ),
        (
            "device.battery",
            json!({"tab_id":"a-tab-1"}),
            "invalid_argument",
        ),
        ("device.info", json!([]), "invalid_argument"),
        (
            "device.haptic",
            json!({"style":"forever"}),
            "invalid_argument",
        ),
        ("device.haptic", json!({}), "invalid_argument"),
        (
            "device.clipboard_read",
            json!({"max_chars":0}),
            "invalid_argument",
        ),
        (
            "device.clipboard_write",
            json!({"text":"x".repeat(16385)}),
            "invalid_argument",
        ),
        (
            "device.notify",
            json!({"title":"  ","body":""}),
            "invalid_argument",
        ),
        (
            "device.notify",
            json!({"title":"Done","body":"","hostId":"other"}),
            "invalid_argument",
        ),
        (
            "device.speak",
            json!({"text":"hello","rate":3}),
            "invalid_argument",
        ),
        (
            "device.speak",
            json!({"text":"hello","language":"en; shell"}),
            "invalid_argument",
        ),
        (
            "device.stop_speaking",
            json!({"session_id":"b"}),
            "invalid_argument",
        ),
        (
            "device.sensor_snapshot",
            json!({"sensor":"camera"}),
            "invalid_argument",
        ),
        ("device.shell", json!({}), "unknown_action"),
    ] {
        let error = owner
            .start_action(
                "a",
                json!(1),
                &json!({"params":{"name":name,"arguments":args}}),
            )
            .err()
            .ok_or("unexpected native dispatch")?;
        assert_eq!(error["structuredContent"]["error"]["code"], code);
    }
    assert!(owner.pending.lock().is_empty());
    assert!(owner.steps.lock().is_empty());
    Ok(())
}

#[test]
fn additional_device_tools_have_typed_defaults_and_bounded_results() -> Result<(), Box<dyn Error>> {
    for (name, args, native, expected) in [
        (
            "device.clipboard_read",
            json!({"max_chars":3}),
            json!({"text":"a😀","truncated":true}),
            json!({"text":"a😀","truncated":true}),
        ),
        (
            "device.clipboard_write",
            json!({"text":""}),
            json!({"written":true}),
            json!({"written":true}),
        ),
        (
            "device.notify",
            json!({"title":"Done","body":""}),
            json!({"notification_id":"notification-1"}),
            json!({"notification_id":"notification-1"}),
        ),
        (
            "device.speak",
            json!({"text":"Hello"}),
            json!({"started":true}),
            json!({"started":true}),
        ),
        (
            "device.stop_speaking",
            json!({}),
            json!({"stopped":false}),
            json!({"stopped":false}),
        ),
        (
            "device.network",
            json!({}),
            json!({"connected":true,"connection_type":"wifi","internet_reachable":null,"is_expensive":false,"low_data_mode":true,"ssid":"must not leak"}),
            json!({"connected":true,"connection_type":"wifi","internet_reachable":null,"is_expensive":false,"low_data_mode":true}),
        ),
        (
            "device.sensor_snapshot",
            json!({"sensor":"accelerometer"}),
            json!({"sensor":"accelerometer","unit":"m/s2","timestamp_ms":1234,"reading":{"x":0,"y":0,"z":9.80665,"extra":"must not leak"}}),
            json!({"sensor":"accelerometer","unit":"m/s2","timestamp_ms":1234.0,"reading":{"x":0.0,"y":0.0,"z":9.80665}}),
        ),
        (
            "device.sensor_snapshot",
            json!({"sensor":"barometer"}),
            json!({"sensor":"barometer","unit":"hPa","timestamp_ms":1234,"reading":{"pressure":1013.25}}),
            json!({"sensor":"barometer","unit":"hPa","timestamp_ms":1234.0,"reading":{"pressure":1013.25}}),
        ),
    ] {
        let action = device::DeviceAction::parse(name, &args)?;
        assert_eq!(action.wire().0, name);
        let result = action.result(native)?;
        assert_eq!(result["structuredContent"]["value"], expected);
    }
    let speech = device::DeviceAction::parse("device.speak", &json!({"text":"Hello"}))?;
    assert_eq!(speech.wire().1["rate"], 1.0);
    let clipboard = device::DeviceAction::parse("device.clipboard_read", &json!({}))?;
    assert_eq!(clipboard.wire().1["max_chars"], 16384);
    Ok(())
}

#[test]
fn privileged_commands_reject_invalid_arguments_before_dispatch_and_validate_identity()
-> Result<(), Box<dyn Error>> {
    let owner = Arc::new(ReverseControl::default());
    insert(&owner, "a", "pane-a");
    for arguments in [
        json!({"argv":[]}),
        json!({"argv":["id"]}),
        json!({"argv":["/system/bin/id", "bad\0arg"]}),
        json!({"argv":["/system/bin/id"],"timeout_ms":15001}),
        json!({"argv":["/system/bin/id"],"max_output_bytes":8193}),
        json!({"argv":["/system/bin/id"],"command":"unexpected"}),
        json!({"argv":["/system/bin/id", "界".repeat(3000)]}),
    ] {
        let error = owner
            .start_action(
                "a",
                json!(1),
                &json!({"params":{"name":"device.shizuku_exec","arguments":arguments}}),
            )
            .err()
            .ok_or("invalid command reached the native bridge")?;
        assert_eq!(
            error["structuredContent"]["error"]["code"],
            "invalid_argument"
        );
    }
    assert!(owner.steps.lock().is_empty());
    let action = device::DeviceAction::parse(
        "device.shizuku_exec",
        &json!({"argv":["/system/bin/printf", "%s", "$(id)"]}),
    )?;
    assert_eq!(
        action.wire().1,
        json!({"argv":["/system/bin/printf", "%s", "$(id)"],"timeout_ms":10000,"max_output_bytes":8192})
    );
    let result = json!({"uid":2000,"exit_code":7,"stdout":"out","stderr":"err","truncated":false,"timed_out":false});
    assert_eq!(
        action.result(result.clone())?["structuredContent"]["value"],
        result
    );
    for invalid in [
        json!({"uid":10000,"exit_code":0,"stdout":"","stderr":"","truncated":false,"timed_out":false}),
        json!({"uid":2000,"exit_code":0,"stdout":"","stderr":"","truncated":false,"timed_out":true}),
        json!({"uid":2000,"exit_code":0,"stdout":"x".repeat(8193),"stderr":"","truncated":false,"timed_out":false}),
    ] {
        assert!(action.result(invalid).is_err());
    }
    let timeout = json!({"uid":0,"exit_code":null,"stdout":"","stderr":"","truncated":false,"timed_out":true});
    assert_eq!(
        action.result(timeout.clone())?["structuredContent"]["value"],
        timeout
    );
    let status = device::DeviceAction::parse("device.shizuku_status", &json!({}))?;
    assert!(status.result(json!({"status":"ready","authorized":false,"backend":"shizuku","uid":2000,"server_version":13})).is_err());
    assert!(status.result(json!({"status":"ready","authorized":true,"backend":"shizuku","uid":10000,"server_version":13})).is_err());
    let missing = json!({"status":"unavailable","authorized":false,"backend":null,"uid":null,"server_version":null});
    assert_eq!(
        status.result(missing.clone())?["structuredContent"]["value"],
        missing
    );
    Ok(())
}

#[test]
fn privileged_commands_use_the_existing_session_boundary_and_cancel_on_close()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let owner = Arc::new(ReverseControl::default());
        insert(&owner, "a", "pane-a");
        insert(&owner, "b", "pane-b");
        let request = json!({"params":{"name":"device.shizuku_exec","arguments":{"argv":["/system/bin/id"]}}});
        let receiver = owner.start_action("a", json!(1), &request).map_err(|_| "dispatch failed")?;
        let step = next_step(&owner, "a").await?;
        owner.reply("b", &step, &json!({"ok":true,"value":{}}).to_string());
        assert!(owner.steps.lock().contains_key(&step));
        owner.reply("a", &step, &json!({"ok":false,"error":{"code":"permission_denied","message":"Pair in More"}}).to_string());
        assert_eq!(receiver.await?["structuredContent"]["error"]["code"], "permission_denied");
        let receiver = owner.start_action("a", json!(2), &request).map_err(|_| "dispatch failed")?;
        let step = next_step(&owner, "a").await?;
        owner.close_session("a");
        assert_eq!(receiver.await?["structuredContent"]["error"]["code"], "session_closed");
        owner.reply("a", &step, &json!({"ok":true,"value":{}}).to_string());
        assert!(owner.steps.lock().is_empty());
        assert!(owner.list().iter().any(|session| session.session_id == "b"));
        owner.shutdown();
        Ok(())
    })
}

#[test]
fn sensor_and_network_results_reject_wrong_units_wrong_sensor_and_inconsistent_connectivity()
-> Result<(), Box<dyn Error>> {
    for (name, args, native) in [
        (
            "device.sensor_snapshot",
            json!({"sensor":"accelerometer"}),
            json!({"sensor":"accelerometer","unit":"g","timestamp_ms":1234,"reading":{"x":0,"y":0,"z":1}}),
        ),
        (
            "device.sensor_snapshot",
            json!({"sensor":"gyroscope"}),
            json!({"sensor":"magnetometer","unit":"uT","timestamp_ms":1234,"reading":{"x":0,"y":0,"z":1}}),
        ),
        (
            "device.sensor_snapshot",
            json!({"sensor":"barometer"}),
            json!({"sensor":"barometer","unit":"hPa","timestamp_ms":1234,"reading":{"pressure":-1}}),
        ),
        (
            "device.network",
            json!({}),
            json!({"connected":false,"connection_type":"offline","internet_reachable":true,"is_expensive":false,"low_data_mode":null}),
        ),
        (
            "device.clipboard_read",
            json!({"max_chars":1}),
            json!({"text":"too much","truncated":false}),
        ),
    ] {
        let action = device::DeviceAction::parse(name, &args)?;
        let result = action
            .result(native)
            .err()
            .ok_or("unexpected valid device result")?;
        assert_eq!(result.code, browser::model::ErrorCode::InvalidResult);
    }
    Ok(())
}

#[test]
fn motion_results_preserve_expo_fields_and_validate_orientation_and_timestamps()
-> Result<(), Box<dyn Error>> {
    let action = device::DeviceAction::parse("device.motion", &json!({}))?;
    assert_eq!(action.wire(), ("device.motion", json!({})));
    assert!(device::DeviceAction::parse("device.motion", &json!({"continuous":true})).is_err());
    let native = json!({
        "timestamp_ms":1234, "interval_ms":100, "orientation":90,
        "acceleration":null,
        "accelerationIncludingGravity":{"x":0,"y":0,"z":-9.8,"timestamp":10,"extra":"private"},
        "rotation":{"alpha":0.1,"beta":0.2,"gamma":0.3,"timestamp":10},
        "rotationRate":null, "device_id":"private"
    });
    let result = action.result(native.clone())?;
    let value = &result["structuredContent"]["value"];
    assert_eq!(value["orientation"], 90);
    assert_eq!(value["rotation"]["alpha"], 0.1);
    assert!(value["acceleration"].is_null());
    assert!(value["rotationRate"].is_null());
    assert!(value.get("device_id").is_none());
    assert!(value["accelerationIncludingGravity"].get("extra").is_none());
    assert_eq!(value["units"]["rotationRate"], "deg/s");
    for (field, invalid) in [
        ("orientation", json!(45)),
        ("interval_ms", json!(-1)),
        ("timestamp_ms", json!(0)),
        ("rotation", json!(null)),
    ] {
        let mut value = native.clone();
        value[field] = invalid;
        assert!(action.result(value).is_err());
    }
    let mut invalid = native;
    invalid["rotation"]["timestamp"] = json!(-1);
    assert!(action.result(invalid).is_err());
    Ok(())
}

#[test]
fn device_calls_need_no_tabs_and_keep_session_isolation_and_cancellation()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let owner = Arc::new(ReverseControl::default());
        insert(&owner, "a", "pane-a");
        let receiver = owner.start_action("a", json!(7), &json!({"params":{"name":"device.battery"}}))
            .map_err(|_| "start failed")?;
        let step = next_step(&owner, "a").await?;
        owner.reply("b", &step, &json!({"ok":true,"value":{"level":0.1,"state":"unknown","low_power_mode":false}}).to_string());
        assert!(owner.steps.lock().contains_key(&step));
        owner.reply("a", &step, &json!({"ok":true,"value":{"level":0.75,"state":"charging","low_power_mode":true,"device_id":"must not leak"}}).to_string());
        let result = receiver.await?;
        assert_eq!(result["structuredContent"]["kind"], "device.battery");
        assert_eq!(result["structuredContent"]["value"], json!({"level":0.75,"state":"charging","low_power_mode":true}));
        assert!(owner.browser_sessions.lock().is_empty());

        let receiver = owner.start_action("a", json!(8), &json!({"params":{"name":"device.location"}}))
            .map_err(|_| "start failed")?;
        let step = next_step(&owner, "a").await?;
        let root = owner.steps.lock().get(&step).ok_or("step missing")?.parent.clone();
        owner.cancel_request(&root, "Device action cancelled");
        assert_eq!(receiver.await?["structuredContent"]["error"]["code"], "cancelled");
        owner.reply("a", &step, &json!({"ok":true,"value":{}}).to_string());
        assert!(owner.pending.lock().is_empty());
        assert!(owner.steps.lock().is_empty());
        assert!(owner.tasks.lock().is_empty());
        owner.shutdown();
        Ok(())
    })
}

#[test]
fn device_results_reject_invalid_fixes_and_preserve_permission_errors() -> Result<(), Box<dyn Error>>
{
    crate::runtime()?.block_on(async {
        let owner = Arc::new(ReverseControl::default());
        insert(&owner, "a", "pane-a");
        for (reply, code) in [
            (json!({"ok":true,"value":{"latitude":91,"longitude":0,"accuracy_m":10,"timestamp_ms":1000}}), "invalid_result"),
            (json!({"ok":true,"value":{"latitude":45,"longitude":0,"accuracy_m":-1,"timestamp_ms":1000}}), "invalid_result"),
            (json!({"ok":false,"error":{"code":"permission_denied","message":"Location permission was denied"}}), "permission_denied"),
        ] {
            let receiver = owner.start_action("a", json!(1), &json!({"params":{"name":"device.location"}}))
                .map_err(|_| "start failed")?;
            let step = next_step(&owner, "a").await?;
            owner.reply("a", &step, &reply.to_string());
            assert_eq!(receiver.await?["structuredContent"]["error"]["code"], code);
        }
        owner.shutdown();
        Ok(())
    })
}
