use super::*;
use crate::host_runtime::{
    HostTerminalGeometry, SshShellRuntime, register_connected_test_runtime,
    terminal_delivery_test_guard,
};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

pub(crate) fn shell_fixture(id: &str) -> TestResult<(Arc<HostRuntime>, Arc<PinnedTerminal>)> {
    let runtime = register_connected_test_runtime(id);
    runtime.inner.state.lock().ssh_shells.insert(
        "shell".into(),
        SshShellRuntime {
            directory: super::super::shell_directory::ShellDirectory::default(),
            desired_open: true,
            state: HostTerminalState::Attached,
            geometry: HostTerminalGeometry::normalized(80, 24, 0, 0),
            dispatched_geometry: None,
            operation_epoch: 42,
            reconnect_attempt: 0,
            retry_running: false,
        },
    );
    let pinned = PinnedTerminal::pin(TerminalTarget {
        runtime_id: id.into(),
        runtime_incarnation: 1,
        connection_generation: 1,
        terminal_id: "shell".into(),
        pane_id: None,
    })?;
    Ok((runtime, pinned))
}

pub(crate) fn shell_fixture_with_ssh(
    id: &str,
    ssh: Arc<crate::ssh::SshSession>,
) -> TestResult<Arc<PinnedTerminal>> {
    let (runtime, pinned) = shell_fixture(id)?;
    runtime.inner.herdr.install(1, ssh);
    Ok(pinned)
}

#[test]
fn ssh_terminal_identity_survives_focus_but_rejects_replacement_and_reconnect() -> TestResult {
    let _guard = terminal_delivery_test_guard();
    let (runtime, pinned) = shell_fixture("terminal-voice-identity")?;
    {
        let mut state = runtime.inner.state.lock();
        let shell = state.ssh_shells["shell"].clone();
        state.ssh_shells.insert("another-shell".into(), shell);
    }
    pinned.check()?;
    observe_output(&runtime.inner, "another-shell", 42, b"wrong terminal");
    observe_output(&runtime.inner, "shell", 43, b"wrong incarnation");
    observe_output(&runtime.inner, "shell", 42, b"right output");
    assert_eq!(pinned.output.lock().text(), "right output");
    runtime
        .inner
        .state
        .lock()
        .ssh_shells
        .get_mut("shell")
        .ok_or("no shell")?
        .operation_epoch += 1;
    assert!(pinned.check().is_err());
    let (runtime, pinned) = shell_fixture("terminal-voice-reconnect")?;
    runtime.inner.state.lock().generation += 1;
    assert!(pinned.check().is_err());
    let (_, pinned) = shell_fixture("terminal-voice-runtime")?;
    let _replacement = register_connected_test_runtime("terminal-voice-runtime");
    assert!(pinned.check().is_err());
    Ok(())
}

#[test]
fn herdr_terminal_follows_identity_and_rejects_coding_agent_takeover() -> TestResult {
    let _guard = terminal_delivery_test_guard();
    let runtime = register_connected_test_runtime("terminal-voice-pane");
    let mut snapshot = super::super::tests::agent_chat_snapshot(None, None);
    let install = |snapshot| {
        let mut state = runtime.inner.state.lock();
        let token = state.host_state.begin_sync(1);
        state.host_state.complete_sync(token, snapshot, 1);
    };
    install(snapshot.clone());
    let target = TerminalTarget {
        runtime_id: runtime.inner.id.clone(),
        runtime_incarnation: 1,
        connection_generation: 1,
        terminal_id: snapshot.panes[0].terminal_id.clone(),
        pane_id: Some(snapshot.panes[0].pane_id.clone()),
    };
    let pinned = PinnedTerminal::pin(target)?;
    snapshot.panes[0].focused = false;
    snapshot.panes[1].focused = true;
    install(snapshot.clone());
    pinned.check()?;
    snapshot.panes[0].agent = Some("codex".into());
    install(snapshot);
    assert!(pinned.check().is_err());
    Ok(())
}

#[test]
fn terminal_output_strips_split_controls_and_bounds_unicode_without_guessing_completion() {
    let mut output = TextTail::default();
    output.observe(b"hello\x1b[3");
    output.observe(b"1m world\x1b[0m\x1b]52;c;private clipboard");
    output.observe(b"\x07\x1bPprivate device payload\x1b\\\n");
    output.observe("日本語 👋".as_bytes());
    assert_eq!(output.text(), "hello world\n日本語 👋");
    output.observe(&vec![b'x'; MAX_OUTPUT * 2]);
    assert_eq!(output.text(), "x".repeat(MAX_OUTPUT));
}

#[test]
fn separate_exec_quotes_reported_cwd_and_never_claims_interactive_environment() -> TestResult {
    let _guard = terminal_delivery_test_guard();
    let (runtime, pinned) = shell_fixture("terminal-voice-cwd")?;
    assert!(pinned.context()?["cwd"].is_null());
    runtime
        .inner
        .state
        .lock()
        .ssh_shells
        .get_mut("shell")
        .ok_or("no shell")?
        .directory
        .observe(b"\x1b]7;file://host/a%20b%27c\x07");
    let context = pinned.context()?;
    assert_eq!(context["cwd"], "/a b'c");
    assert_eq!(context["execution_context"], "separate_ssh_exec");
    Ok(())
}

#[test]
fn terminal_commands_return_real_stdout_stderr_and_nonzero_status() -> TestResult {
    let _guard = terminal_delivery_test_guard();
    crate::runtime()?.block_on(async {
        let fixture = crate::ssh::ReverseForwardFixture::with_commands(
            true,
            Duration::ZERO,
            Some(std::collections::BTreeMap::new()),
        )
        .await?;
        let (runtime, pinned) = shell_fixture("terminal-voice-exec")?;
        runtime.inner.herdr.install(1, fixture.shared_ssh());
        let directory = tempfile::tempdir()?;
        let cwd = directory.path().join("space and 'quote");
        std::fs::create_dir(&cwd)?;
        let uri = url::Url::from_directory_path(&cwd).map_err(|()| "invalid cwd")?;
        runtime
            .inner
            .state
            .lock()
            .ssh_shells
            .get_mut("shell")
            .ok_or("no shell")?
            .directory
            .observe(format!("\x1b]7;{uri}\x07").as_bytes());
        let result = pinned
            .execute("pwd", Duration::from_secs(5), Arc::new(|_, _| {}))
            .await;
        assert_eq!(result["stdout"], format!("{}\n", cwd.display()));
        let result = pinned
            .execute(
                "printf '\x1b[31mdisk\x1b[0m'; printf failure >&2; exit 7",
                Duration::from_secs(5),
                Arc::new(|_, _| {}),
            )
            .await;
        assert_eq!(result["stdout"], "disk");
        assert_eq!(result["stderr"], "failure");
        assert_eq!(result["exit_status"], 7);
        assert_eq!(result["completion"], "finished");
        fixture.respond_next_exec(b"partial output", b"", None);
        let result = pinned
            .execute(
                "uncertain command",
                Duration::from_secs(5),
                Arc::new(|_, _| {}),
            )
            .await;
        assert_eq!(result["error"], "outcome_unknown");
        assert_eq!(result["completion"], "unknown");
        assert_eq!(result["stdout"], "partial output");
        Ok(())
    })
}
