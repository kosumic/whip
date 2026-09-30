use super::*;

#[test]
fn real_ssh_bridge_is_shared_per_host_and_last_agent_cleanup_closes_both_ports()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let owner = Arc::new(ReverseControl::default());
        let a_args = owner.prepare(fixture.ssh.clone(), info("a", "pane-a"), agent(HerdrAgentKind::Codex)).await?;
        let remote_port = owner.bridge.lock().as_ref().ok_or("bridge missing")?.forward.port;
        let local_port = fixture.local_port(remote_port).ok_or("forward missing")?;
        let b_args = owner.prepare(fixture.ssh.clone(), info("b", "pane-b"), agent(HerdrAgentKind::OpenCode)).await?;
        assert_eq!(owner.bridge.lock().as_ref().ok_or("bridge missing")?.forward.port, remote_port);
        let token_a = config_token(&a_args)?;
        let token_b = config_token(&b_args)?;
        assert_ne!(token_a, token_b);
        let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":http::LATEST_PROTOCOL}});
        assert_eq!(wire(remote_port, "a", &token_a, "POST", &init, "").await?.status, 200);
        assert_eq!(wire(remote_port, "b", &token_b, "POST", &init, "").await?.status, 200);
        let listed = wire(remote_port, "b", &token_b, "POST", &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), "").await?;
        assert_eq!(listed.body["result"]["tools"].as_array().map(Vec::len), Some(tools::ACTIONS.len()));
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
fn ssh_transport_loss_revokes_http_mcp_sessions_and_late_bridge_callbacks_are_harmless()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let owner = Arc::new(ReverseControl::default());
        owner
            .prepare(
                fixture.ssh.clone(),
                info("a", "pane-a"),
                agent(HerdrAgentKind::OpenCode),
            )
            .await?;
        let (epoch, port) = {
            let bridge = owner.bridge.lock();
            let bridge = bridge.as_ref().ok_or("bridge missing")?;
            (bridge.epoch, bridge.forward.port)
        };
        fixture.ssh.disconnect().await;
        let deadline = Instant::now() + Duration::from_secs(2);
        while !owner.list().is_empty() {
            if Instant::now() >= deadline {
                return Err("MCP sessions survived transport loss".into());
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        port_closes(port).await?;
        let replacement = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
        owner
            .prepare(
                replacement.ssh.clone(),
                info("b", "pane-b"),
                agent(HerdrAgentKind::OpenCode),
            )
            .await?;
        owner.shutdown_bridge(epoch);
        assert_eq!(owner.list().len(), 1);
        assert_eq!(owner.list()[0].session_id, "b");
        owner.shutdown();
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

fn config_token(launch: &HerdrTabLaunch) -> Result<String, Box<dyn Error>> {
    if let HerdrTabLaunch::Command { command } = launch {
        let config = opencode_config(command)?;
        return Ok(config["mcp"]["whip_browser"]["headers"]["Authorization"]
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
        .find_map(|arg| arg.strip_prefix("mcp_servers.whip_browser.http_headers={Authorization="))
        .and_then(|arg| arg.strip_suffix('}'))
        .ok_or("authorization override missing")?;
    let authorization: String = serde_json::from_str(encoded)?;
    Ok(authorization
        .strip_prefix("Bearer ")
        .ok_or("bearer token missing")?
        .to_owned())
}

async fn port_closes(port: u16) -> Result<(), Box<dyn Error>> {
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
            json!({"mcp": {"whip_browser": {
                "type": "remote", "url": "http://127.0.0.1:12345/mcp/session-a",
                "enabled": true, "oauth": false, "timeout": 25_000,
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
    let mut pane = HerdrPaneInfo {
        pane_id: "pane-a".into(),
        terminal_id: "terminal-pane-a".into(),
        workspace_id: "workspace".into(),
        tab_id: "tab".into(),
        focused: false,
        cwd: None,
        foreground_cwd: None,
        label: None,
        agent: None,
        title: None,
        terminal_title: None,
        terminal_title_stripped: None,
        display_agent: None,
        agent_status: crate::herdr_api::HerdrAgentStatus::Idle,
        state_labels: None,
        tokens: None,
        agent_session: None,
        scroll: None,
        revision: 0.0,
    };
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
    assert_eq!(tools.len(), tools::ACTIONS.len());
    assert!(tools.iter().any(|tool| tool["name"] == "browser.eval"));
    for tool in tools {
        let name = tool["name"].as_str().unwrap_or_default();
        assert!(name.starts_with("browser."));
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
            "mcp_servers.whip_browser.url=\"http://127.0.0.1:12345/mcp/agent-a\"",
            "-c",
            &format!(
                "mcp_servers.whip_browser.http_headers={{Authorization=\"Bearer {TOKEN_A}\"}}"
            ),
            "-c",
            "mcp_servers.whip_browser.required=true",
            "-c",
            "mcp_servers.whip_browser.tool_timeout_sec=25",
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

struct WireResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: Value,
}
async fn wire(
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
        let notification = wire(fixture.port, "a", TOKEN_A, "POST", &json!({"jsonrpc":"2.0","method":"notifications/initialized"}), "").await?;
        assert_eq!(notification.status, 202);
        assert!(notification.body.is_null());
        let catalog = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"});
        let listed = wire(fixture.port, "a", TOKEN_A, "POST", &catalog, "").await?;
        assert_eq!(listed.status, 200);
        assert_eq!(listed.body["result"]["tools"].as_array().map(Vec::len), Some(tools::ACTIONS.len()));
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
