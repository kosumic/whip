//! Opt-in contract test against an attached, uniquely named disposable Herdr.
//! No real model agent is launched: the isolated shell's PATH contains a fixture.
use super::*;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;
const CLEARED: &[&str] = &[
    "HERDR_SOCKET_PATH",
    "HERDR_CLIENT_SOCKET_PATH",
    "HERDR_SESSION",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "HERDR_PANE_ID",
];

struct Session {
    directory: tempfile::TempDir,
    name: String,
    outer: Option<String>,
    launched: bool,
}

impl Session {
    fn command(&self) -> Command {
        let mut command = Command::new("herdr");
        for key in CLEARED {
            command.env_remove(key);
        }
        command
            .env("HERDR_SESSION", &self.name)
            .env(
                "HERDR_CONFIG_PATH",
                self.directory.path().join("config.toml"),
            )
            .env("XDG_CONFIG_HOME", self.directory.path().join("config"))
            .env("XDG_STATE_HOME", self.directory.path().join("state"))
            .env("XDG_RUNTIME_DIR", self.directory.path().join("runtime"));
        command
    }

    fn cli(&self, args: &[&str]) -> TestResult<Value> {
        output_json(self.command().args(args))
    }

    fn cleanup(&mut self) -> TestResult {
        let mut exit_error = None;
        if self.launched {
            let sessions = self.cli(&["session", "list", "--json"])?;
            if sessions["sessions"].as_array().is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item["name"] == self.name && item["running"] == true)
            }) {
                self.cli(&["session", "stop", &self.name, "--json"])?;
            }
            self.cli(&["session", "delete", &self.name, "--json"])?;
            self.launched = false;
            if let Some(pane) = self.outer.as_deref() {
                exit_error = output_json(Command::new("herdr").args([
                    "pane",
                    "wait-output",
                    pane,
                    "--match",
                    "WHIP_HERDR_EXITED",
                    "--timeout",
                    "5000",
                ]))
                .err();
            }
        }
        if let Some(pane) = self.outer.as_deref() {
            output_json(Command::new("herdr").args(["pane", "close", pane]))?;
            self.outer = None;
        }
        exit_error.map_or(Ok(()), Err)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            eprintln!("Herdr test cleanup failed for {}: {error}", self.name);
        }
    }
}

fn output_json(command: &mut Command) -> TestResult<Value> {
    let output = command.output()?;
    if !output.status.success() {
        return Err(format!(
            "Herdr test command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    // Successful pane run/close and other write-only CLI commands are quiet.
    if output.stdout.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "Invalid JSON from {command:?}: {error}; stdout={}; stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .into()
    })
}

fn field(value: &Value, name: &str) -> TestResult<String> {
    value[name]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("missing {name}: {value}").into())
}

async fn exchange(socket: &Path, call: Call) -> Result<Value, HerdrControlError> {
    let operation = async {
        let mut stream = tokio::net::UnixStream::connect(socket)
            .await
            .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?;
        let mut bytes = serde_json::to_vec(
            &json!({"id":"whip-contract","method":call.method,"params":call.params}),
        )
        .map_err(|error| invalid(error.to_string()))?;
        bytes.push(b'\n');
        stream
            .write_all(&bytes)
            .await
            .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?;
        let mut response = Vec::new();
        BufReader::new(stream)
            .read_until(b'\n', &mut response)
            .await
            .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?;
        if response.is_empty() {
            return Err(HerdrControlError::TransportDisconnected(
                "Herdr closed the test socket".into(),
            ));
        }
        crate::herdr_api::parse_json_response(&response)
    };
    tokio::time::timeout(Duration::from_millis(call.timeout_ms), operation)
        .await
        .map_err(|_| HerdrControlError::RequestTimeout("Herdr test request timed out".into()))?
}

async fn request(socket: &Path, value: Value) -> Result<Value, HerdrControlError> {
    Request::parse(value)?
        .run(22, |call| exchange(socket, call))
        .await
}

fn prepare() -> TestResult<Session> {
    if std::env::var("HERDR_ENV").as_deref() != Ok("1") {
        return Err("Run inside Herdr (HERDR_ENV=1)".into());
    }
    let directory = tempfile::Builder::new()
        .prefix("whip-herdr-")
        .tempdir_in("/var/tmp")?;
    let name = format!(
        "whip-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis()
    );
    let mut session = Session {
        directory,
        name,
        outer: None,
        launched: false,
    };
    for child in ["bin", "config", "state", "runtime"] {
        std::fs::create_dir(session.directory.path().join(child))?;
    }
    std::fs::set_permissions(
        session.directory.path().join("runtime"),
        std::fs::Permissions::from_mode(0o700),
    )?;
    std::fs::write(
        session.directory.path().join("config.toml"),
        "onboarding = false\n[experimental]\nallow_nested = true\n[terminal]\ndefault_shell = \"/bin/sh\"\nshell_mode = \"non_login\"\n",
    )?;
    let binary = Command::new("sh")
        .args(["-c", "command -v herdr"])
        .output()?;
    let binary = String::from_utf8(binary.stdout)?.trim().to_owned();
    if binary.is_empty() {
        return Err("herdr executable missing".into());
    }
    let quoted_binary = shlex::try_quote(&binary)?;
    // A process-local hint and custom reports let Herdr recognize a fake agent.
    // Only this isolated shell receives the fixture PATH; real agents cannot run.
    let fixture = format!(
        r#"#!/bin/sh
export HERDR_AGENT=claude
report() {{ {quoted_binary} pane report-agent "$HERDR_PANE_ID" --source custom:whip-contract --agent claude --state "$1" >/dev/null; }}
printf 'WHIP_FAKE_READY\n'
report idle
while IFS= read -r prompt; do
  printf '%s\n' "$prompt" >> "$WHIP_TEST_PROMPTS"
  case "$prompt" in
    stall) continue ;;
    block) report blocked; continue ;;
    hold) report working; continue ;;
  esac
  report working
  printf '\033[31mWHIP_REPLY %s\033[0m\n' "$prompt"
  report idle
done
"#
    );
    let fixture_path = session.directory.path().join("bin/claude");
    std::fs::write(&fixture_path, fixture)?;
    std::fs::set_permissions(fixture_path, std::fs::Permissions::from_mode(0o755))?;
    let checked = session.command().args(["config", "check"]).output()?;
    if !checked.status.success() {
        return Err(String::from_utf8_lossy(&checked.stderr).into_owned().into());
    }
    let layout = output_json(Command::new("herdr").args(["pane", "layout", "--current"]))?;
    let direction = if layout["result"]["layout"]["area"]["width"]
        .as_u64()
        .unwrap_or(0)
        >= 160
    {
        "right"
    } else {
        "down"
    };
    let cwd = session
        .directory
        .path()
        .to_str()
        .ok_or("non-UTF8 test path")?;
    let outer = output_json(Command::new("herdr").args([
        "pane",
        "split",
        "--current",
        "--direction",
        direction,
        "--cwd",
        cwd,
        "--no-focus",
    ]))?;
    session.outer = Some(field(&outer["result"]["pane"], "pane_id")?);
    let mut launch = vec!["env".to_owned()];
    for key in CLEARED {
        launch.extend(["-u".into(), (*key).into()]);
    }
    for (key, path) in [
        ("HERDR_CONFIG_PATH", "config.toml"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_STATE_HOME", "state"),
        ("XDG_RUNTIME_DIR", "runtime"),
        ("WHIP_TEST_PROMPTS", "prompts"),
    ] {
        launch.push(format!(
            "{key}={}",
            session.directory.path().join(path).display()
        ));
    }
    launch.push(format!(
        "PATH={}:{}",
        session.directory.path().join("bin").display(),
        std::env::var("PATH")?
    ));
    launch.extend([binary, "--session".into(), session.name.clone()]);
    let launch = format!(
        "{}; printf '\\nWHIP_%s_EXITED\\n' HERDR",
        shlex::try_join(launch.iter().map(String::as_str))?
    );
    // Admission can be ambiguous; cleanup must inspect our unique session even
    // when the launch command's acknowledgement is lost.
    session.launched = true;
    output_json(Command::new("herdr").args([
        "pane",
        "run",
        session.outer.as_deref().ok_or("missing outer pane")?,
        &launch,
    ]))?;
    Ok(session)
}

#[test]
#[ignore = "requires installed Herdr and permission to create an isolated named session; no paid agents"]
fn disposable_herdr_contract() -> TestResult {
    let mut session = prepare()?;
    let runtime = crate::runtime()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let panes = loop {
        if let Ok(panes) = session.cli(&["pane", "list"]) {
            break panes;
        }
        if std::time::Instant::now() >= deadline {
            return Err("Disposable session did not become ready; inspect its outer pane".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let root = field(&panes["result"]["panes"][0], "pane_id")?;
    let sessions = session.cli(&["session", "list", "--json"])?;
    let owned = sessions["sessions"]
        .as_array()
        .ok_or("missing session list")?
        .iter()
        .find(|item| item["name"] == session.name)
        .ok_or("owned named session missing")?;
    let socket = PathBuf::from(field(owned, "socket_path")?);
    let cwd = session
        .directory
        .path()
        .to_str()
        .ok_or("non-UTF8 test cwd")?;
    eprintln!(
        "Testing installed Herdr in {}, socket {}",
        session.name,
        socket.display()
    );
    runtime.block_on(async {
        let before = request(&socket, json!({"action":"session_snapshot"})).await?;
        assert_eq!(before["snapshot"]["protocol"], 22);
        let split = request(&socket, json!({"action":"pane_split","pane_id":root,"direction":"right","cwd":cwd})).await?;
        let pane = field(&split["pane"], "pane_id")?;
        let after = request(&socket, json!({"action":"session_snapshot"})).await?;
        assert_eq!(before["snapshot"]["focused_pane_id"], after["snapshot"]["focused_pane_id"]);
        assert_eq!(split["pane"]["cwd"], cwd);
        let created = request(&socket, json!({"action":"workspace_create","cwd":cwd,"label":"background"})).await?;
        let workspace = field(&created["workspace"], "workspace_id")?;
        let tab = request(&socket, json!({"action":"tab_create","workspace_id":workspace,"cwd":cwd,"label":"background"})).await?;
        assert_eq!(tab["root_pane"]["cwd"], cwd);
        let after = request(&socket, json!({"action":"session_snapshot"})).await?;
        assert_eq!(before["snapshot"]["focused_pane_id"], after["snapshot"]["focused_pane_id"]);
        let started = request(&socket, json!({"action":"agent_start","name":"whip-fixture","kind":"claude","pane_id":pane,"args":[],"timeout_ms":15_000})).await?;
        assert_eq!(started["ready"], true);
        let settled = request(&socket, json!({"action":"agent_wait","target":"whip-fixture","timeout_ms":1000})).await?;
        assert_eq!(settled["agent"]["agent_status"], "idle");
        let prompted = request(&socket, json!({"action":"agent_prompt","target":"whip-fixture","text":"one prompt","wait":{"timeout_ms":3000}})).await?;
        assert_eq!(prompted["completion"], "lifecycle_wait_satisfied");
        let read = request(&socket, json!({"action":"agent_read","target":"whip-fixture"})).await?;
        assert_eq!(read["read"]["source"], "recent_unwrapped");
        assert!(read["read"]["text"].as_str().ok_or("missing read text")?.contains("WHIP_REPLY one prompt"));
        assert!(!read["read"]["text"].as_str().ok_or("missing read text")?.contains('\u{1b}'));
        let styled = request(&socket, json!({"action":"agent_read","target":"whip-fixture","format":"ansi"})).await?;
        assert!(styled["read"]["text"].as_str().ok_or("missing ANSI read text")?.contains('\u{1b}'));
        let stalled = request(&socket, json!({"action":"agent_prompt","target":"whip-fixture","text":"stall","wait":{"timeout_ms":7000}})).await;
        assert!(matches!(stalled, Err(HerdrControlError::ProtocolError(ref code, _)) if code == "agent_prompt_stalled"), "{stalled:?}");
        let blocked = request(&socket, json!({"action":"agent_prompt","target":"whip-fixture","text":"block","wait":{"timeout_ms":3000}})).await?;
        assert_eq!(blocked["agent"]["agent_status"], "blocked");
        let log_before = std::fs::read_to_string(session.directory.path().join("prompts"))?;
        let rejected = request(&socket, json!({"action":"agent_prompt","target":"whip-fixture","text":"must not submit","wait":{}})).await;
        assert!(matches!(rejected, Err(HerdrControlError::ProtocolError(ref code, _)) if code == "agent_blocked"), "{rejected:?}");
        assert_eq!(log_before, std::fs::read_to_string(session.directory.path().join("prompts"))?);
        request(&socket, json!({"action":"agent_send_keys","target":"whip-fixture","keys":["ctrl+u"]})).await?;
        request(&socket, json!({"action":"pane_close","pane_id":pane})).await?;
        let stale = request(&socket, json!({"action":"agent_get","target":"whip-fixture"})).await;
        assert!(matches!(stale, Err(HerdrControlError::ProtocolError(_, _))), "{stale:?}");
        // A stopped owned session must surface a connection error, never fallback.
        session.cli(&["session", "stop", &session.name, "--json"])?;
        let disconnected = request(&socket, json!({"action":"ping"})).await;
        assert!(matches!(disconnected, Err(HerdrControlError::TransportDisconnected(_))), "{disconnected:?}");
        Ok::<(), Box<dyn std::error::Error>>(())
    })?;
    session.cleanup()?;
    let remaining = session.cli(&["session", "list", "--json"])?;
    assert!(
        !remaining["sessions"]
            .as_array()
            .ok_or("missing sessions")?
            .iter()
            .any(|item| item["name"] == session.name)
    );
    Ok(())
}
