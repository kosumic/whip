use super::*;
use crate::agent_sessions::tests::SESSION;
use crate::agent_sessions::{AgentTranscriptState, AgentTranscriptStatus, BoundAgentChat};
use crate::herdr_connection::HerdrConnection;
use crate::ssh::ReverseForwardFixture;
use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;
const WAIT: Duration = Duration::from_secs(25);

#[test]
fn nested_remote_shell_arguments_preserve_quotes_backslashes_and_newlines() -> TestResult {
    let value = r#"quotes ' and \\ and \' and " and $HOME and `uname`
next line"#;
    let inner = format!("printf '%s' {}", shell_quote(value));
    let outer = format!("sh -c {}", shell_quote(&inner));
    let shell = std::env::var("WHIP_TEST_REMOTE_SHELL").unwrap_or_else(|_| "bash".into());
    let output = std::process::Command::new(shell)
        .args(["-c", &outer])
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, value.as_bytes());
    Ok(())
}

struct LiveSession {
    manager: AgentSessionManager,
    binding: BoundAgentChat,
    remote: ReverseForwardFixture,
    path: PathBuf,
    initial: String,
    _directory: tempfile::TempDir,
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        self.manager.disconnected(true, "test finished");
    }
}

fn user_line(text: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":text}})
    )
}

fn append(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)?
        .write_all(bytes)
}

async fn wait_for(mut ready: impl FnMut() -> bool) -> TestResult {
    tokio::time::timeout(WAIT, async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    Ok(())
}

impl LiveSession {
    async fn new() -> TestResult<Self> {
        let directory = tempfile::tempdir()?;
        let home = directory.path().join("home with 'quotes' and $dollars");
        let sessions = home.join(".codex/sessions/2026/11/01");
        std::fs::create_dir_all(&sessions)?;
        let path = sessions.join(format!("rollout-2026-11-01T10-20-30-{SESSION}.jsonl"));
        let initial = format!(
            "{}\n{}",
            serde_json::json!({"type":"session_meta","payload":{"id":SESSION}}),
            user_line("initial")
        );
        std::fs::write(&path, &initial)?;
        let shell = std::env::var("WHIP_TEST_REMOTE_SHELL").unwrap_or_else(|_| "bash".into());
        let environment = BTreeMap::from([
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("WHIP_TEST_REMOTE_SHELL".into(), shell),
        ]);
        let remote =
            ReverseForwardFixture::with_commands(true, Duration::ZERO, Some(environment)).await?;
        let connection =
            HerdrConnection::new("live-poll-test".into(), String::new(), None, None, true);
        let _ = connection.install(1, remote.ssh.clone());
        let manager = AgentSessionManager::new(path.to_string_lossy().into_owned(), 1, connection);
        manager.connected();
        let binding = manager.bind_codex("terminal".into(), SESSION.into())?;
        manager.start_restored(&binding.binding_token, None)?;
        let session = Self {
            manager,
            binding,
            remote,
            path,
            initial,
            _directory: directory,
        };
        session.wait_live(1).await?;
        Ok(session)
    }

    fn state(&self) -> AgentTranscriptState {
        self.manager.state(&self.binding.transcript_key).unwrap()
    }

    async fn wait_live(&self, messages: usize) -> TestResult {
        wait_for(|| {
            let state = self.state();
            state.status == AgentTranscriptStatus::Live && state.messages.len() == messages
        })
        .await?;
        assert_eq!(self.state().session_id, SESSION);
        assert!(self.state().error.is_none());
        Ok(())
    }

    fn reverted_path(&self) -> PathBuf {
        self.path.parent().unwrap().join(format!(
            "rollout-2026-11-01T10-21-30-{SESSION}_22222222-2222-4222-8222-222222222222.jsonl"
        ))
    }
}

#[test]
fn live_appends_survive_failed_polls_and_follow_rollout_replacement() -> TestResult {
    crate::runtime()?.block_on(async {
        let session = LiveSession::new().await?;
        let history = session.state().messages;
        let attempts = session.remote.session_attempts();
        session.remote.reject_session_channels(1);
        // The next accepted poll returns malformed metadata instead of a command
        // failure, exercising both observation failures on a real SSH transport.
        session
            .remote
            .respond_next_exec(b"invalid metadata\n", b"", Some(0));
        tokio::time::timeout(WAIT, session.remote.wait_for_session_attempts(attempts + 1)).await?;
        append(
            &session.path,
            user_line("after channel rejection").as_bytes(),
        )?;
        session.wait_live(2).await?;
        tokio::time::timeout(WAIT, session.remote.wait_for_session_attempts(attempts + 2)).await?;
        append(
            &session.path,
            user_line("after malformed metadata").as_bytes(),
        )?;
        session.wait_live(3).await?;
        assert_eq!(session.state().messages[..history.len()], history);

        // Successful polling after backoff must still detect a reverted sibling.
        let reverted = session.reverted_path();
        std::fs::write(&reverted, &session.initial)?;
        session.wait_live(1).await?;
        assert_eq!(session.state().messages, history);

        // A real stream failure requires a rebind. Preserve complete history and
        // replay an unfinished line across rejected discovery exec requests.
        let line = user_line("after stream recovery");
        let split = line.len() / 2;
        append(&reverted, &line.as_bytes()[..split])?;
        wait_for(|| {
            let mut state = session.manager.inner.state.lock();
            let core = state
                .sessions
                .get_mut(&session.binding.transcript_key)
                .unwrap()
                .core
                .file()
                .unwrap();
            let caught_up = core.received_offset() == (session.initial.len() + split) as u64;
            drop(state);
            caught_up
        })
        .await?;
        session
            .remote
            .respond_next_exec(b"", b"injected discovery stderr", Some(17));
        session.remote.reject_next_exec();
        session.remote.close_tails().await;
        wait_for(|| session.state().status == AgentTranscriptStatus::Stale).await?;
        assert_eq!(session.state().messages, history);
        append(&reverted, &line.as_bytes()[split..])?;
        session.wait_live(2).await?;
        assert_eq!(session.state().messages[..history.len()], history);
        assert!(session.remote.ssh.is_alive());
        Ok(())
    })
}

#[test]
fn confirmed_missing_source_discovers_its_replacement() -> TestResult {
    crate::runtime()?.block_on(async {
        let session = LiveSession::new().await?;
        let before = session.state().messages;
        let replacement = format!("{}{}", session.initial, user_line("replacement"));
        std::fs::write(session.reverted_path(), replacement)?;
        std::fs::remove_file(&session.path)?;
        session.wait_live(2).await?;
        assert_eq!(session.state().messages[..before.len()], before);
        Ok(())
    })
}

#[test]
fn exec_failures_preserve_exit_details_without_nested_user_errors() -> TestResult {
    crate::runtime()?.block_on(async {
        let session = LiveSession::new().await?;
        let stderr = format!("{} original-error-end", "remote detail ".repeat(200));
        session
            .remote
            .respond_next_exec(b"", stderr.as_bytes(), Some(17));
        let error = execute(&session.manager.inner.connection, "ignored".into())
            .await
            .err()
            .unwrap();
        let details = error.to_string();
        assert!(details.contains("17"));
        assert!(details.contains(&stderr));
        let error = diagnostics::read_error(
            &session.manager.inner,
            &session.binding.transcript_key,
            1,
            diagnostics::ReadPhase::DiscoveryExec,
            error,
        )
        .to_string();
        assert_eq!(error.matches("agent transcript read failed").count(), 1);
        assert!(error.contains("retrying automatically"));
        assert!(!error.contains(&stderr));

        // EOF without an exit status cannot be treated as successful discovery.
        session.remote.respond_next_exec(b"", b"", None);
        assert!(
            execute(&session.manager.inner.connection, "ignored".into())
                .await
                .is_err()
        );
        assert!(session.remote.ssh.is_alive());
        Ok(())
    })
}
