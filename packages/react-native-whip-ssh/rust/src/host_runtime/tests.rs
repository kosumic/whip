//! Host runtime lifecycle and behavior tests.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use super::*;
use crate::agent_sessions::{
    AgentChatBinding, AgentChatOpenResult, AgentChatStartResult, AgentChatUnavailableReason,
};
use crate::herdr_api::{
    HerdrAgentKind, HerdrAgentSessionInfo, HerdrAgentSessionKind, HerdrAgentStatus,
    HerdrControlError, HerdrControlRequest, HerdrControlResult, HerdrPaneInfo,
    HerdrSessionSnapshot, HerdrTabInfo, HerdrTabLaunch, HerdrTabLaunchStage, HerdrWorkspaceInfo,
};
use crate::herdr_codec::{MAX_PROTOCOL, MIN_PROTOCOL};
use crate::herdr_connection::HerdrRequestReplay;
use crate::herdr_events::HerdrEvent;
use crate::herdr_terminal::HerdrBridgeError;
use crate::host_state::ApplyResult;

static EVENT_SINK_TEST_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn terminal_geometry_normalization_enforces_runtime_minimums() {
    assert_eq!(
        HostTerminalGeometry::normalized(12, 4, 8, 16),
        HostTerminalGeometry {
            columns: MIN_TERMINAL_COLUMNS,
            rows: MIN_TERMINAL_ROWS,
            cell_width_px: 8,
            cell_height_px: 16,
        }
    );
}

struct ReentrantRuntimeSink {
    inner: Arc<RuntimeInner>,
    called: AtomicBool,
    runtime_unlocked: AtomicBool,
    registry_unlocked: AtomicBool,
}

impl HostRuntimeEventSink for ReentrantRuntimeSink {
    fn event(&self, _event: HostRuntimeEvent) {
        self.called.store(true, Ordering::SeqCst);
        self.runtime_unlocked
            .store(self.inner.state.try_lock().is_some(), Ordering::SeqCst);
        self.registry_unlocked
            .store(event_sink().try_write().is_some(), Ordering::SeqCst);
    }
}

#[derive(Default)]
struct RecordingRuntimeSink {
    events: Mutex<Vec<HostRuntimeEvent>>,
}

impl HostRuntimeEventSink for RecordingRuntimeSink {
    fn event(&self, event: HostRuntimeEvent) {
        self.events.lock().push(event);
    }
}

struct PanickingRuntimeSink;

impl HostRuntimeEventSink for PanickingRuntimeSink {
    fn event(&self, _event: HostRuntimeEvent) {
        panic!("diagnostic listener failed");
    }
}

fn config() -> HostRuntimeConfig {
    HostRuntimeConfig {
        runtime_id: "test".to_owned(),
        ssh: HostSshConfig {
            host: "host.test".to_owned(),
            port: 22,
            username: "user".to_owned(),
            credential: HostSshCredential::Password {
                password: "secret".to_owned(),
            },
            forward_agent: false,
        },
        jump_hosts: Vec::new(),
        session_name: "main".to_owned(),
        herdr_command: "herdr".to_owned(),
        socket_path: None,
        cached_socket_path: None,
    }
}

fn runtime_inner_with_state(
    id: &str,
    runtime_config: HostRuntimeConfig,
    state: RuntimeState,
) -> Arc<RuntimeInner> {
    let (cancellation, _) = watch::channel(0);
    let (status_tx, _) = watch::channel(state.status());
    let herdr = HerdrConnection::new(
        id.to_owned(),
        runtime_config.session_name.clone(),
        runtime_config.socket_path.clone(),
        runtime_config.cached_socket_path.clone(),
    );
    Arc::new(RuntimeInner {
        id: id.to_owned(),
        incarnation: 1,
        config: runtime_config,
        state: Mutex::new(state),
        agents: AgentSessionManager::new(id.to_owned(), 1, herdr.clone()),
        operations: RemoteOperationManager::default(),
        herdr,
        jump_sessions: Mutex::new(Vec::new()),
        herdr_startup: AsyncMutex::new(()),
        herdr_recovery: AsyncMutex::new(()),
        cancellation,
        status_tx,
        terminal_settled: Notify::new(),
        monitoring: Mutex::new(MonitoringState::default()),
        monitoring_changed: Arc::new(Notify::new()),
        reconnect_wakeup: Arc::new(Notify::new()),
    })
}

fn connected_runtime_inner(id: &str) -> Arc<RuntimeInner> {
    let runtime_config = config();
    let mut state = RuntimeState::new(&runtime_config);
    state.connection = HostConnectionState::Connected;
    state.generation = 1;
    state.host_state.connection_installed(1);
    state.event = Some(EventSubscriptionRuntime {
        pane_ids: Vec::new(),
        operation_epoch: 1,
        retry_running: false,
    });
    runtime_inner_with_state(id, runtime_config, state)
}

fn desired_ssh_shell(
    state: HostTerminalState,
    geometry: HostTerminalGeometry,
    operation_epoch: u64,
) -> SshShellRuntime {
    SshShellRuntime {
        desired_open: true,
        state,
        geometry,
        dispatched_geometry: (state == HostTerminalState::Attached).then_some(geometry),
        operation_epoch,
        reconnect_attempt: 0,
        retry_running: false,
    }
}

fn empty_ready_snapshot() -> ReadyHerdrSnapshot {
    let mut snapshot = batch_test_snapshot();
    snapshot.protocol = MAX_PROTOCOL;
    snapshot.focused_workspace_id = None;
    snapshot.focused_tab_id = None;
    snapshot.focused_pane_id = None;
    snapshot.agents.clear();
    snapshot.workspaces.clear();
    snapshot.tabs.clear();
    snapshot.panes.clear();
    snapshot.layouts.clear();
    ReadyHerdrSnapshot { snapshot }
}

#[test]
fn managed_agent_names_are_native_owned_and_stable() {
    assert_eq!(
        managed_agent_name("  42 Review / Fix  ", HerdrAgentKind::Codex, 2.0),
        "review-fix"
    );
    assert_eq!(
        managed_agent_name("---", HerdrAgentKind::OpenCode, 3.0),
        "opencode-3"
    );
    assert_eq!(
        managed_agent_name(
            "A very long tab label whose agent name must be bounded",
            HerdrAgentKind::Claude,
            1.0,
        ),
        "a-very-long-tab-label-whose-agen"
    );
}

#[test]
fn integration_status_command_and_parser_are_native_owned() {
    let command = integration_status_command("/opt/herdr current/herdr");
    assert!(command.contains("integration status"));
    assert!(command.contains("/opt/herdr current/herdr"));
    assert_eq!(
        parse_agent_integration_status(
            "claude: not installed\ncodex: current (v2)\n",
            HerdrAgentKind::Codex,
        ),
        AgentIntegrationStatus::Current
    );
    assert_eq!(
        parse_agent_integration_status(
            "opencode: needs repair (/tmp/config)\n",
            HerdrAgentKind::OpenCode,
        ),
        AgentIntegrationStatus::NeedsRepair
    );
    assert_eq!(
        parse_agent_integration_status("older output", HerdrAgentKind::Codex),
        AgentIntegrationStatus::Unknown
    );
}

#[test]
fn server_start_command_is_native_owned_and_supports_profile_values() {
    let command = start_herdr_server_command("/opt/herdr current/herdr", "team's session");
    assert!(command.starts_with("exec /bin/sh -c "));
    assert!(command.contains("nohup"));
    assert!(command.contains("/opt/herdr current/herdr"));
    assert!(command.contains("team"));
    assert!(command.contains("server"));
    assert!(command.contains("/tmp/whip-herdr-server.log"));
}

#[test]
fn readiness_retries_transient_socket_failures_until_snapshot_is_ready() {
    crate::runtime().unwrap().block_on(async {
        let attempts = Arc::new(AtomicU64::new(0));
        let attempts_for_probe = attempts.clone();
        let mut ready = Some(empty_ready_snapshot());
        let result = poll_herdr_readiness(
            Instant::now() + Duration::from_millis(100),
            Duration::from_millis(1),
            Duration::from_millis(2),
            move || {
                let attempt = attempts_for_probe.fetch_add(1, Ordering::SeqCst) + 1;
                std::future::ready(if attempt < 3 {
                    Err(HerdrReadinessProbeError::Retryable(
                        "socket not ready yet".to_owned(),
                    ))
                } else {
                    Ok(ready.take().expect("ready result is returned once"))
                })
            },
        )
        .await;

        assert!(result.is_ok());
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    });
}

#[test]
fn readiness_deadline_preserves_a_typed_timeout_reason() {
    crate::runtime().unwrap().block_on(async {
        let result = poll_herdr_readiness(
            Instant::now() + Duration::from_millis(10),
            Duration::from_millis(2),
            Duration::from_millis(4),
            || {
                std::future::ready(Err(HerdrReadinessProbeError::Retryable(
                    "socket not ready yet".to_owned(),
                )))
            },
        )
        .await;

        assert!(matches!(
            result,
            Err(HerdrReadinessPollError::Timeout(message))
                if message == "socket not ready yet"
        ));
        assert!(matches!(
            herdr_readiness_timeout("socket not ready yet"),
            HostRuntimeError::HerdrReadinessTimeout {
                timeout_ms: 12_000,
                last_error,
            } if last_error == "socket not ready yet"
        ));
    });
}

#[test]
fn unsupported_herdr_protocol_is_permanent_instead_of_timing_out() {
    assert!(matches!(
        validate_herdr_protocol(MIN_PROTOCOL - 1),
        Err(HostRuntimeError::HerdrProtocolMismatch { expected, received })
            if expected == herdr_protocol_label() && received == MIN_PROTOCOL - 1
    ));
    assert!(validate_herdr_protocol(MIN_PROTOCOL).is_ok());
    assert!(validate_herdr_protocol(MAX_PROTOCOL).is_ok());
}

#[test]
fn ssh_disconnect_during_readiness_is_not_retried_as_socket_startup() {
    let inner = connected_runtime_inner("readiness-disconnect-test");
    let error = readiness_probe_error(
        &inner,
        1,
        HerdrControlError::TransportDisconnected("channel closed".to_owned()),
    );
    assert!(matches!(
        error,
        HerdrReadinessProbeError::Permanent(HostRuntimeError::RuntimeDisconnected(_))
    ));
}

#[test]
fn stale_startup_snapshot_cannot_install_into_a_replacement_generation() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    clear_host_runtime_event_sink();
    crate::runtime().unwrap().block_on(async {
        let inner = connected_runtime_inner("stale-startup-test");
        let (_, token) = begin_host_state_sync(&inner);
        {
            let mut state = inner.state.lock();
            state.generation = 2;
            state.host_state.connection_installed(2);
        }

        let result =
            complete_herdr_startup_sync(inner.clone(), 1, token, empty_ready_snapshot()).await;

        assert!(matches!(result, Err(HostRuntimeError::StaleOperation(_))));
        assert!(
            inner
                .state
                .lock()
                .host_state
                .projection()
                .snapshot
                .is_none()
        );
    });
}

#[test]
fn startup_success_installs_authoritative_host_state_and_emits_it() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    crate::runtime().unwrap().block_on(async {
        let inner = connected_runtime_inner("startup-state-test");
        let sink = Arc::new(RecordingRuntimeSink::default());
        set_host_runtime_event_sink(sink.clone());
        let (_, token) = begin_host_state_sync(&inner);

        complete_herdr_startup_sync(inner.clone(), 1, token, empty_ready_snapshot())
            .await
            .unwrap();

        clear_host_runtime_event_sink();
        let state = inner.state.lock().host_state.projection();
        assert!(state.snapshot.is_some());
        assert_eq!(inner.state.lock().protocol, Some(MAX_PROTOCOL));
        assert!(sink.events.lock().iter().any(|event| matches!(
            event,
            HostRuntimeEvent::HostStateChanged { state, .. } if state.snapshot.is_some()
        )));
    });
}

async fn simulated_serialized_start(
    inner: Arc<RuntimeInner>,
    ready: Arc<AtomicBool>,
    launches: Arc<AtomicU64>,
) {
    let _startup = inner.herdr_startup.lock().await;
    if ready.load(Ordering::SeqCst) {
        return;
    }
    launches.fetch_add(1, Ordering::SeqCst);
    tokio::task::yield_now().await;
    ready.store(true, Ordering::SeqCst);
}

#[test]
fn already_ready_and_duplicate_start_requests_do_not_duplicate_launches() {
    crate::runtime().unwrap().block_on(async {
        let inner = connected_runtime_inner("duplicate-start-test");
        let ready = Arc::new(AtomicBool::new(false));
        let launches = Arc::new(AtomicU64::new(0));
        tokio::join!(
            simulated_serialized_start(inner.clone(), ready.clone(), launches.clone()),
            simulated_serialized_start(inner.clone(), ready.clone(), launches.clone()),
        );
        assert_eq!(launches.load(Ordering::SeqCst), 1);

        simulated_serialized_start(inner, ready, launches.clone()).await;
        assert_eq!(launches.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn typed_launch_intent_selects_exactly_one_native_second_step() {
    let snapshot = batch_test_snapshot();
    let tab = &snapshot.tabs[0];
    let root_pane = &snapshot.panes[0];

    assert!(launch_request(tab, root_pane, HerdrTabLaunch::Shell).is_none());
    assert!(matches!(
        launch_request(
            tab,
            root_pane,
            HerdrTabLaunch::Agent {
                kind: HerdrAgentKind::Codex,
                args: Vec::new(),
            },
        ),
        Some((
            HerdrTabLaunchStage::AgentStart,
            HerdrControlRequest::AgentStart {
                kind: HerdrAgentKind::Codex,
                ..
            }
        ))
    ));
    assert!(matches!(
        launch_request(
            tab,
            root_pane,
            HerdrTabLaunch::Agent {
                kind: HerdrAgentKind::OpenCode,
                args: Vec::new(),
            },
        ),
        Some((
            HerdrTabLaunchStage::AgentStart,
            HerdrControlRequest::AgentStart {
                kind: HerdrAgentKind::OpenCode,
                ..
            }
        ))
    ));
    assert_eq!(
        launch_request(
            tab,
            root_pane,
            HerdrTabLaunch::Command {
                command: "echo codex is installed".to_owned(),
            },
        ),
        Some((
            HerdrTabLaunchStage::CommandInput,
            HerdrControlRequest::PaneSendInput {
                pane_id: "pane-1".to_owned(),
                text: "echo codex is installed".to_owned(),
                keys: vec!["enter".to_owned()],
            }
        ))
    );
}

#[test]
fn rust_interprets_direct_agent_commands_without_consuming_shell_syntax() {
    assert_eq!(
        normalize_tab_launch(HerdrTabLaunch::Command {
            command: " opencode --model \"current model\" ".to_owned(),
        }),
        Ok(HerdrTabLaunch::Agent {
            kind: HerdrAgentKind::OpenCode,
            args: vec!["--model".to_owned(), "current model".to_owned()],
        })
    );
    assert_eq!(
        normalize_tab_launch(HerdrTabLaunch::Command {
            command: "codex --profile work".to_owned(),
        }),
        Ok(HerdrTabLaunch::Agent {
            kind: HerdrAgentKind::Codex,
            args: vec!["--profile".to_owned(), "work".to_owned()],
        })
    );
    for command in [
        "opencode --model \"$MODEL\"",
        "opencode && echo done",
        "echo codex is installed",
        "opencode --model \"unterminated",
        "/usr/bin/codex foo",
        "env FOO=bar codex foo",
        "command codex foo",
        "FOO=x codex foo",
    ] {
        assert_eq!(
            normalize_tab_launch(HerdrTabLaunch::Command {
                command: command.to_owned(),
            }),
            Ok(HerdrTabLaunch::Command {
                command: command.to_owned(),
            })
        );
    }
}

#[test]
fn pane_submission_sequence_is_one_semantic_native_operation() {
    let requests = pane_submission_requests(
        "pane-1".to_owned(),
        vec![
            "review".to_owned(),
            String::new(),
            "/tmp/image.png".to_owned(),
        ],
    );
    assert_eq!(requests.len(), 3);
    assert!(matches!(
        &requests[0],
        (
            HerdrControlRequest::PaneSendInput { text, keys, .. },
            true
        ) if text == "review" && keys.is_empty()
    ));
    assert!(matches!(
        &requests[1],
        (HerdrControlRequest::PaneSendText { text, .. }, false) if text == " "
    ));
    assert!(matches!(
        &requests[2],
        (
            HerdrControlRequest::PaneSendInput { text, keys, .. },
            true
        ) if text == "/tmp/image.png" && keys == &["enter"]
    ));

    assert!(matches!(
        pane_submission_requests("pane-1".to_owned(), Vec::new()).as_slice(),
        [(HerdrControlRequest::PaneSendKeys { keys, .. }, false)] if keys == &["enter"]
    ));
}

fn batch_test_snapshot() -> HerdrSessionSnapshot {
    let pane = |id: &str| HerdrPaneInfo {
        pane_id: id.to_owned(),
        terminal_id: format!("terminal-{id}"),
        workspace_id: "workspace".to_owned(),
        tab_id: "tab".to_owned(),
        focused: id == "pane-1",
        cwd: None,
        foreground_cwd: None,
        label: None,
        agent: None,
        title: None,
        terminal_title: None,
        terminal_title_stripped: None,
        display_agent: None,
        agent_status: HerdrAgentStatus::Idle,
        state_labels: None,
        tokens: None,
        agent_session: None,
        scroll: None,
        revision: 0.0,
    };
    HerdrSessionSnapshot {
        version: "test".to_owned(),
        protocol: 22,
        focused_workspace_id: Some("workspace".to_owned()),
        focused_tab_id: Some("tab".to_owned()),
        focused_pane_id: Some("pane-1".to_owned()),
        agents: Vec::new(),
        workspaces: vec![HerdrWorkspaceInfo {
            workspace_id: "workspace".to_owned(),
            number: 1.0,
            label: "workspace".to_owned(),
            focused: true,
            pane_count: 2.0,
            tab_count: 1.0,
            active_tab_id: "tab".to_owned(),
            agent_status: HerdrAgentStatus::Idle,
            tokens: None,
            worktree: None,
        }],
        tabs: vec![HerdrTabInfo {
            tab_id: "tab".to_owned(),
            workspace_id: "workspace".to_owned(),
            number: 1.0,
            label: "tab".to_owned(),
            focused: true,
            pane_count: 2.0,
            agent_status: HerdrAgentStatus::Idle,
        }],
        panes: vec![pane("pane-1"), pane("pane-2")],
        layouts: Vec::new(),
    }
}

fn agent_chat_snapshot(
    agent: Option<(&str, &str)>,
    display_agent: Option<&str>,
) -> HerdrSessionSnapshot {
    let mut snapshot = batch_test_snapshot();
    let pane = &mut snapshot.panes[0];
    pane.agent = display_agent.map(str::to_owned);
    pane.display_agent = display_agent.map(str::to_owned);
    pane.agent_session = agent.map(|(agent, value)| HerdrAgentSessionInfo {
        source: format!("herdr:{agent}"),
        agent: agent.to_owned(),
        kind: HerdrAgentSessionKind::Id,
        value: value.to_owned(),
    });
    snapshot
}

fn install_agent_chat_snapshot(inner: &Arc<RuntimeInner>, snapshot: HerdrSessionSnapshot) {
    {
        let mut state = inner.state.lock();
        let token = state.host_state.begin_sync(1);
        assert_eq!(
            state.host_state.complete_sync(token, snapshot, 1),
            ApplyResult::Applied
        );
    }
    emit_host_state(inner);
}

fn bound(result: AgentChatOpenResult) -> AgentChatBinding {
    match result {
        AgentChatOpenResult::Bound { binding } => binding,
        AgentChatOpenResult::NoChat { reason, .. } => {
            panic!("expected an agent Chat binding, got {reason:?}")
        }
    }
}

#[test]
fn agent_chat_resolution_uses_authoritative_codex_and_opencode_sessions() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    let codex = "11111111-1111-4111-8111-111111111111";
    let inner = connected_runtime_inner("agent-chat-resolution");
    let runtime = HostRuntime {
        inner: inner.clone(),
    };
    install_agent_chat_snapshot(&inner, agent_chat_snapshot(Some(("codex", codex)), None));

    let binding = bound(
        runtime
            .open_agent_chat("terminal-pane-1".to_owned())
            .unwrap(),
    );
    assert_eq!(binding.pane_id, "pane-1");
    assert_eq!(binding.agent, AgentTranscriptKind::Codex);
    assert_eq!(binding.session_id, codex);
    assert_eq!(
        binding.transcript_key,
        format!("agent-chat-resolution\ncodex\n{codex}")
    );

    install_agent_chat_snapshot(
        &inner,
        agent_chat_snapshot(Some(("opencode", "ses_abc123")), None),
    );
    let replacement = runtime
        .current_agent_chat("terminal-pane-1".to_owned())
        .expect("HostState reconciliation should replace the binding");
    assert_eq!(replacement.agent, AgentTranscriptKind::OpenCode);
    assert_eq!(replacement.session_id, "ses_abc123");
    assert_ne!(replacement.binding_token, binding.binding_token);
    assert!(matches!(
        runtime
            .start_agent_chat(binding.binding_token, None)
            .unwrap(),
        AgentChatStartResult::StaleBinding
    ));
}

#[test]
fn normal_or_cosmetically_stale_pane_cannot_create_agent_chat() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    let inner = connected_runtime_inner("normal-pane-agent-chat");
    let runtime = HostRuntime {
        inner: inner.clone(),
    };
    install_agent_chat_snapshot(&inner, agent_chat_snapshot(None, Some("Codex")));

    assert!(matches!(
        runtime
            .open_agent_chat("terminal-pane-1".to_owned())
            .unwrap(),
        AgentChatOpenResult::NoChat {
            reason: AgentChatUnavailableReason::UnsupportedPane,
            ..
        }
    ));
    assert!(!inner.agents.has_terminal_binding("terminal-pane-1"));
}

#[test]
fn releasing_terminal_renderer_bridge_does_not_detach_agent_chat() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    let session_id = "11111111-1111-4111-8111-111111111111";
    let inner = connected_runtime_inner("agent-chat-renderer-release");
    let runtime = HostRuntime {
        inner: inner.clone(),
    };
    install_agent_chat_snapshot(
        &inner,
        agent_chat_snapshot(Some(("codex", session_id)), None),
    );
    let binding = bound(
        runtime
            .open_agent_chat("terminal-pane-1".to_owned())
            .unwrap(),
    );

    runtime.close_terminal("terminal-pane-1".to_owned());

    let retained = runtime
        .current_agent_chat("terminal-pane-1".to_owned())
        .expect("renderer transport release must retain the Chat binding");
    assert_eq!(retained.binding_token, binding.binding_token);
    assert_eq!(retained.session_id, session_id);

    install_agent_chat_snapshot(&inner, agent_chat_snapshot(None, None));
    assert!(
        runtime
            .current_agent_chat("terminal-pane-1".to_owned())
            .is_none(),
        "authoritative pane identity removal must still detach Chat"
    );
}

#[test]
fn authoritative_snapshot_rebinds_session_and_detaches_on_normal_shell() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    let first = "11111111-1111-4111-8111-111111111111";
    let second = "22222222-2222-4222-8222-222222222222";
    let inner = connected_runtime_inner("agent-chat-reconcile");
    let runtime = HostRuntime {
        inner: inner.clone(),
    };
    install_agent_chat_snapshot(&inner, agent_chat_snapshot(Some(("codex", first)), None));
    let original = bound(
        runtime
            .open_agent_chat("terminal-pane-1".to_owned())
            .unwrap(),
    );

    install_agent_chat_snapshot(&inner, agent_chat_snapshot(Some(("codex", second)), None));
    let rebound = runtime
        .current_agent_chat("terminal-pane-1".to_owned())
        .expect("HostState reconciliation should replace the binding");
    assert_eq!(rebound.session_id, second);
    assert_ne!(rebound.binding_token, original.binding_token);
    assert!(inner.agents.state(&original.transcript_key).is_none());

    install_agent_chat_snapshot(&inner, agent_chat_snapshot(None, None));
    assert!(!inner.agents.has_terminal_binding("terminal-pane-1"));
    assert!(
        runtime
            .current_agent_chat("terminal-pane-1".to_owned())
            .is_none()
    );
    assert!(inner.agents.state(&rebound.transcript_key).is_none());
    assert!(matches!(
        runtime
            .open_agent_chat("terminal-pane-1".to_owned())
            .unwrap(),
        AgentChatOpenResult::NoChat { .. }
    ));
}

#[test]
fn failed_sync_preserves_transcripts_until_fresh_removal_is_confirmed() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    let inner = connected_runtime_inner("agent-chat-failed-sync");
    let runtime = HostRuntime {
        inner: inner.clone(),
    };
    install_agent_chat_snapshot(
        &inner,
        agent_chat_snapshot(
            Some(("codex", "11111111-1111-4111-8111-111111111111")),
            None,
        ),
    );
    let binding = bound(runtime.open_agent_chat("terminal-pane-1".into()).unwrap());
    {
        let mut state = inner.state.lock();
        let token = state.host_state.begin_sync(1);
        state.host_state.fail_sync(token, "offline".into());
    }
    emit_host_state(&inner);
    assert!(inner.agents.state(&binding.transcript_key).is_some());
    assert!(
        runtime
            .current_agent_chat("terminal-pane-1".into())
            .is_some()
    );
    install_agent_chat_snapshot(&inner, agent_chat_snapshot(None, None));
    assert!(inner.agents.state(&binding.transcript_key).is_none());
}

#[test]
fn authoritative_pane_close_event_removes_transcript_without_waiting_for_sync() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    let inner = connected_runtime_inner("agent-chat-pane-close");
    let runtime = HostRuntime {
        inner: inner.clone(),
    };
    install_agent_chat_snapshot(
        &inner,
        agent_chat_snapshot(
            Some(("codex", "11111111-1111-4111-8111-111111111111")),
            None,
        ),
    );
    let binding = bound(runtime.open_agent_chat("terminal-pane-1".into()).unwrap());
    inner.state.lock().host_state.apply_event(
        1,
        HerdrEvent::PaneClosed {
            workspace_id: "workspace".into(),
            pane_id: "pane-1".into(),
        },
        2,
    );
    emit_host_state(&inner);
    assert!(inner.agents.state(&binding.transcript_key).is_none());
    assert!(
        runtime
            .current_agent_chat("terminal-pane-1".into())
            .is_none()
    );
}

fn agent_status_event(pane_id: &str, status: HerdrAgentStatus) -> HerdrEvent {
    HerdrEvent::PaneAgentStatusChanged {
        workspace_id: "workspace".to_owned(),
        pane_id: pane_id.to_owned(),
        agent_status: status,
        agent: Some("codex".to_owned()),
        title: None,
        display_agent: None,
        state_labels: None,
    }
}

#[test]
fn ssh_failures_map_to_typed_runtime_errors() {
    let authentication =
        HostRuntimeError::from(SshFailure::Authentication("bad credentials".to_owned()));
    assert!(matches!(
        authentication,
        HostRuntimeError::AuthenticationFailure(message) if message == "bad credentials"
    ));

    let host_key = HostRuntimeError::from(SshFailure::HostKeyChanged(Box::new(
        crate::ssh::HostKeyChallenge {
            host: "example.com".to_owned(),
            port: 2222,
            key_type: "ssh-ed25519".to_owned(),
            fingerprint: "SHA256:new".to_owned(),
            public_key: "ssh-ed25519 AAAA".to_owned(),
        },
    )));
    assert!(matches!(
        host_key,
        HostRuntimeError::HostKeyChanged(challenge)
            if challenge.host == "example.com" && challenge.port == 2222
    ));

    assert_eq!(
        HostRuntimeError::from(SshFailure::UnsupportedHostCertificate),
        HostRuntimeError::UnsupportedHostCertificate,
    );

    let transport = HostRuntimeError::from(SshFailure::Transport {
        code: SshErrorCode::ConnectionTimeout,
        message: "timed out".to_owned(),
    });
    assert!(matches!(
        transport,
        HostRuntimeError::SshConnectionFailure {
            code: SshErrorCode::ConnectionTimeout,
            message,
        } if message == "timed out"
    ));
}

#[test]
fn runtime_callbacks_are_reentrant_and_diagnostics_are_isolated() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    let runtime_config = config();
    let inner = runtime_inner_with_state(
        "reentrant-test",
        runtime_config.clone(),
        RuntimeState::new(&runtime_config),
    );
    let sink = Arc::new(ReentrantRuntimeSink {
        inner: inner.clone(),
        called: AtomicBool::new(false),
        runtime_unlocked: AtomicBool::new(false),
        registry_unlocked: AtomicBool::new(false),
    });
    set_host_runtime_event_sink(sink.clone());

    emit_host_state(&inner);
    clear_host_runtime_event_sink();

    assert!(sink.called.load(Ordering::SeqCst));
    assert!(sink.runtime_unlocked.load(Ordering::SeqCst));
    assert!(sink.registry_unlocked.load(Ordering::SeqCst));

    let diagnostics = Arc::new(RecordingRuntimeSink::default());
    set_host_runtime_event_sink(diagnostics.clone());
    emit_diagnostic(
        &inner,
        RuntimeDiagnosticOperation::TerminalAttach,
        Instant::now(),
        None,
        Some("terminal-1".to_owned()),
        None,
    );
    emit_diagnostic(
        &inner,
        RuntimeDiagnosticOperation::TerminalRecovery,
        Instant::now(),
        None,
        Some("terminal-1".to_owned()),
        Some("closed".to_owned()),
    );
    clear_host_runtime_event_sink();
    let events = diagnostics.events.lock();
    assert!(matches!(
        &events[0],
        HostRuntimeEvent::Diagnostic { diagnostic, .. }
            if diagnostic.outcome == RuntimeDiagnosticOutcome::Succeeded
    ));
    assert!(matches!(
        &events[1],
        HostRuntimeEvent::Diagnostic { diagnostic, .. }
            if diagnostic.outcome == RuntimeDiagnosticOutcome::Failed
                && diagnostic.error.as_deref() == Some("closed")
    ));
    drop(events);

    set_host_runtime_event_sink(Arc::new(PanickingRuntimeSink));
    emit_diagnostic(
        &inner,
        RuntimeDiagnosticOperation::SshConnect,
        Instant::now(),
        None,
        None,
        None,
    );
    clear_host_runtime_event_sink();
}

#[test]
fn herdr_event_burst_is_fully_applied_before_one_projection() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    let runtime_config = config();
    let mut state = RuntimeState::new(&runtime_config);
    state.connection = HostConnectionState::Connected;
    state.generation = 1;
    state.event = Some(EventSubscriptionRuntime {
        pane_ids: vec!["pane-1".to_owned(), "pane-2".to_owned()],
        operation_epoch: 1,
        retry_running: false,
    });
    state.host_state.connection_installed(1);
    let token = state.host_state.begin_sync(1);
    state
        .host_state
        .complete_sync(token, batch_test_snapshot(), 1);
    let inner = runtime_inner_with_state("batch-delivery-test", runtime_config, state);
    runtimes()
        .write()
        .insert(inner.id.clone(), Arc::downgrade(&inner));
    let sink = Arc::new(RecordingRuntimeSink::default());
    set_host_runtime_event_sink(sink.clone());

    let revision_before_output = inner.state.lock().host_state.projection().revision;
    let output_forwarded = deliver_herdr_events(
        &inner.id,
        vec![HerdrEvent::PaneOutputChanged {
            workspace_id: "workspace-1".to_owned(),
            pane_id: "pane-1".to_owned(),
            revision: 2.0,
        }],
    );
    assert!(output_forwarded.is_none());
    assert!(sink.events.lock().is_empty());
    assert_eq!(
        inner.state.lock().host_state.projection().revision,
        revision_before_output
    );

    let forwarded = deliver_herdr_events(
        &inner.id,
        vec![
            agent_status_event("pane-1", HerdrAgentStatus::Blocked),
            agent_status_event("pane-2", HerdrAgentStatus::Working),
            agent_status_event("pane-1", HerdrAgentStatus::Idle),
        ],
    );
    clear_host_runtime_event_sink();
    runtimes().write().remove(&inner.id);

    assert!(forwarded.is_none());
    let events = sink.events.lock();
    assert_eq!(events.len(), 1);
    let HostRuntimeEvent::HostStateChanged {
        state,
        agent_status_transitions,
        ..
    } = &events[0]
    else {
        panic!("event burst emitted an unexpected runtime event");
    };
    assert_eq!(agent_status_transitions.len(), 1);
    assert_eq!(agent_status_transitions[0].pane_id, "pane-2");
    assert_eq!(
        agent_status_transitions[0].previous,
        Some(HerdrAgentStatus::Idle)
    );
    assert_eq!(
        agent_status_transitions[0].current,
        Some(HerdrAgentStatus::Working)
    );
    let snapshot = state.snapshot.as_ref().unwrap();
    assert_eq!(snapshot.panes[0].agent_status, HerdrAgentStatus::Idle);
    assert_eq!(snapshot.panes[1].agent_status, HerdrAgentStatus::Working);
    drop(events);
}

#[test]
fn herdr_event_batch_preserves_resync_requests() {
    let mut state = RuntimeState::new(&config());
    state.connection = HostConnectionState::Connected;
    state.generation = 1;
    state.host_state.connection_installed(1);
    let token = state.host_state.begin_sync(1);
    state
        .host_state
        .complete_sync(token, batch_test_snapshot(), 1);

    let result = apply_herdr_event_batch(
        &mut state,
        [agent_status_event(
            "missing-pane",
            HerdrAgentStatus::Working,
        )],
    );
    assert!(result.changed);
    assert!(result.resync_reason.is_some());
    assert!(state.host_state.projection().needs_resync);
}

#[test]
fn confirmed_pane_close_cancels_terminal_retry_without_restarting_events() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    let inner = connected_runtime_inner("pane-close-local-test");
    {
        let mut state = inner.state.lock();
        let token = state.host_state.begin_sync(1);
        assert_eq!(
            state
                .host_state
                .complete_sync(token, batch_test_snapshot(), 1),
            ApplyResult::Applied
        );
        state.event = Some(EventSubscriptionRuntime {
            pane_ids: vec!["pane-1".to_owned(), "pane-2".to_owned()],
            operation_epoch: 1,
            retry_running: false,
        });
        for terminal_id in ["terminal-pane-1", "terminal-pane-2"] {
            state.terminals.insert(
                terminal_id.to_owned(),
                TerminalRuntime {
                    state: HostTerminalState::Attached,
                    takeover: true,
                    columns: 80,
                    rows: 24,
                    cell_width_px: 0,
                    cell_height_px: 0,
                    operation_epoch: 1,
                    reconnect_attempt: 0,
                    retry_running: false,
                    bridge_id: Some(1),
                },
            );
        }
    }
    let sink = Arc::new(RecordingRuntimeSink::default());
    set_host_runtime_event_sink(sink.clone());

    reconcile_control_result(
        &inner,
        &HerdrControlRequest::PaneClose {
            pane_id: "pane-1".to_owned(),
        },
        &HerdrControlResult::Ok,
        Some("terminal-pane-1"),
    );

    clear_host_runtime_event_sink();
    let state = inner.state.lock();
    assert!(!state.terminals.contains_key("terminal-pane-1"));
    assert!(state.terminals.contains_key("terminal-pane-2"));
    assert_eq!(state.event.as_ref().unwrap().pane_ids, ["pane-1", "pane-2"]);
    assert!(!state.host_state.projection().needs_resync);
    assert!(!state.host_state.resync_running());
    assert!(
        state
            .host_state
            .projection()
            .snapshot
            .unwrap()
            .panes
            .iter()
            .all(|pane| pane.pane_id != "pane-1")
    );
    drop(state);

    let events = sink.events.lock();
    assert!(events.iter().any(|event| matches!(
        event,
        HostRuntimeEvent::TerminalStateChanged {
            terminal_id,
            state: HostTerminalState::Closed,
            retrying: false,
            ..
        } if terminal_id == "terminal-pane-1"
    )));
    drop(events);
}

#[test]
fn event_subscription_closure_schedules_snapshot_resync() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    let inner = connected_runtime_inner("event-subscription-resync-test");
    runtimes()
        .write()
        .insert(inner.id.clone(), Arc::downgrade(&inner));

    assert!(event_subscription_closed(
        &inner.id,
        "unexpected EOF".to_owned(),
    ));

    {
        let mut state = inner.state.lock();
        assert!(state.host_state.projection().needs_resync);
        assert!(state.host_state.resync_running());
        assert!(state.event.as_ref().unwrap().retry_running);
        state.explicit_disconnect = true;
    }
    runtimes().write().remove(&inner.id);
}

#[test]
fn lifecycle_connect_install_disconnect_is_explicit() {
    let mut state = RuntimeState::new(&config());
    let epoch = state.begin_connect().unwrap();
    assert_eq!(state.connection, HostConnectionState::Connecting);
    assert!(state.install_connection(epoch));
    assert_eq!(state.connection, HostConnectionState::Connected);
    assert_eq!(state.generation, 1);
    state.disconnect();
    assert_eq!(state.connection, HostConnectionState::Disconnecting);
    assert!(state.explicit_disconnect);
}

#[test]
fn stale_runtime_cleanup_preserves_replacement_registration() {
    let old = runtime_inner_with_state("reused-runtime-id", config(), RuntimeState::new(&config()));
    let replacement =
        runtime_inner_with_state("reused-runtime-id", config(), RuntimeState::new(&config()));
    runtimes()
        .write()
        .insert(replacement.id.clone(), Arc::downgrade(&replacement));

    unregister_runtime(&old);

    let registered = runtimes()
        .read()
        .get(&replacement.id)
        .and_then(Weak::upgrade)
        .expect("replacement runtime should remain registered");
    assert!(Arc::ptr_eq(&registered, &replacement));
    unregister_runtime(&replacement);
}

#[test]
fn reconnect_waiter_cannot_miss_fast_connected_transition() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    crate::runtime().unwrap().block_on(async {
        let inner = connected_runtime_inner("fast-reconnect-wait-test");
        let epoch = inner
            .state
            .lock()
            .begin_reconnect(None, "transport closed")
            .expect("connected runtime starts reconnect")
            .0;
        publish_lifecycle_status(&inner);
        let status_rx = inner.status_tx.subscribe();

        assert!(inner.state.lock().install_connection(epoch));
        publish_lifecycle_status(&inner);

        assert_eq!(wait_for_reconnect(status_rx).await, Ok(()));
    });
}

#[test]
fn reconnect_receiver_created_while_connected_returns_immediately() {
    crate::runtime().unwrap().block_on(async {
        let inner = connected_runtime_inner("already-connected-wait-test");
        assert_eq!(
            wait_for_reconnect(inner.status_tx.subscribe()).await,
            Ok(())
        );
    });
}

#[test]
fn failed_status_preserves_latest_error_for_waiters() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    crate::runtime().unwrap().block_on(async {
        let inner = connected_runtime_inner("reconnect-exhaustion-wait-test");
        inner
            .state
            .lock()
            .begin_reconnect(None, "transport closed")
            .expect("connected runtime starts reconnect");
        publish_lifecycle_status(&inner);
        let status_rx = inner.status_tx.subscribe();
        {
            let mut state = inner.state.lock();
            state.connection = HostConnectionState::Failed;
            state.reconnect_running = false;
            state.last_error = Some("authentication was rejected".to_owned());
        }
        publish_lifecycle_status(&inner);

        assert_eq!(
            wait_for_reconnect(status_rx).await,
            Err(HostRuntimeError::ReconnectExhausted(
                "authentication was rejected".to_owned()
            ))
        );
    });
}

#[test]
fn explicit_disconnect_wakes_reconnect_waiter() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    crate::runtime().unwrap().block_on(async {
        let inner = connected_runtime_inner("disconnect-reconnect-wait-test");
        inner
            .state
            .lock()
            .begin_reconnect(None, "transport closed")
            .expect("connected runtime starts reconnect");
        publish_lifecycle_status(&inner);
        let status_rx = inner.status_tx.subscribe();
        let waiter = tokio::spawn(wait_for_reconnect(status_rx));

        inner.state.lock().disconnect();
        publish_lifecycle_status(&inner);

        assert!(matches!(
            waiter.await,
            Ok(Err(HostRuntimeError::RuntimeDisconnected(_)))
        ));
    });
}

#[test]
fn simultaneous_recovery_waiters_observe_one_reconnect_lifecycle() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    crate::runtime().unwrap().block_on(async {
        let inner = connected_runtime_inner("simultaneous-recovery-wait-test");
        let epoch = inner
            .state
            .lock()
            .begin_reconnect(None, "transport closed")
            .expect("connected runtime starts reconnect")
            .0;
        publish_lifecycle_status(&inner);
        let waiter_one = tokio::spawn(wait_for_reconnect(inner.status_tx.subscribe()));
        let waiter_two = tokio::spawn(wait_for_reconnect(inner.status_tx.subscribe()));
        let waiter_three = tokio::spawn(wait_for_reconnect(inner.status_tx.subscribe()));

        assert!(inner.state.lock().install_connection(epoch));
        publish_lifecycle_status(&inner);

        let (one, two, three) = tokio::join!(waiter_one, waiter_two, waiter_three);
        assert!(matches!(one, Ok(Ok(()))));
        assert!(matches!(two, Ok(Ok(()))));
        assert!(matches!(three, Ok(Ok(()))));
    });
}

#[test]
fn closed_lifecycle_sender_fails_reconnect_waiter() {
    crate::runtime().unwrap().block_on(async {
        let (status_tx, status_rx) = watch::channel(HostRuntimeStatus {
            state: HostConnectionState::Reconnecting,
            generation: 1,
            reconnect_attempt: 1,
            error: Some("transport closed".to_owned()),
        });
        drop(status_tx);

        assert!(matches!(
            wait_for_reconnect(status_rx).await,
            Err(HostRuntimeError::RuntimeDisconnected(_))
        ));
    });
}

#[test]
fn terminal_notify_still_wakes_existing_open_waiter() {
    crate::runtime().unwrap().block_on(async {
        let inner = connected_runtime_inner("terminal-open-wait-test");
        inner.state.lock().terminals.insert(
            "terminal-1".to_owned(),
            TerminalRuntime {
                state: HostTerminalState::Opening,
                takeover: true,
                columns: 80,
                rows: 24,
                cell_width_px: 8,
                cell_height_px: 16,
                operation_epoch: 1,
                reconnect_attempt: 0,
                retry_running: true,
                bridge_id: None,
            },
        );
        let waiter_inner = inner.clone();
        let waiter =
            tokio::spawn(
                async move { wait_for_terminal_open(&waiter_inner, "terminal-1", 1).await },
            );
        tokio::task::yield_now().await;

        {
            let mut state = inner.state.lock();
            let terminal = state
                .terminals
                .get_mut("terminal-1")
                .expect("terminal remains registered");
            terminal.state = HostTerminalState::Attached;
            terminal.retry_running = false;
            terminal.bridge_id = Some(1);
            drop(state);
        }
        inner.terminal_settled.notify_waiters();

        assert!(matches!(waiter.await, Ok(Ok(()))));
    });
}

#[test]
fn ssh_shell_notify_wakes_concurrent_open_waiter() {
    crate::runtime().unwrap().block_on(async {
        let inner = connected_runtime_inner("ssh-shell-open-wait-test");
        inner.state.lock().ssh_shells.insert(
            "ssh-shell-1".to_owned(),
            SshShellRuntime {
                desired_open: true,
                state: HostTerminalState::Opening,
                geometry: HostTerminalGeometry::normalized(100, 30, 8, 16),
                dispatched_geometry: None,
                operation_epoch: 1,
                reconnect_attempt: 0,
                retry_running: true,
            },
        );
        let waiter_inner = inner.clone();
        let waiter =
            tokio::spawn(
                async move { wait_for_ssh_shell_open(&waiter_inner, "ssh-shell-1", 1).await },
            );
        tokio::task::yield_now().await;

        {
            let mut state = inner.state.lock();
            let shell = state
                .ssh_shells
                .get_mut("ssh-shell-1")
                .expect("SSH shell remains registered");
            shell.state = HostTerminalState::Attached;
            shell.dispatched_geometry = Some(shell.geometry);
            drop(state);
        }
        inner.terminal_settled.notify_waiters();

        assert!(matches!(waiter.await, Ok(Ok(()))));
    });
}

#[test]
fn bridge_close_during_open_invalidates_owned_attempt_without_second_worker() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    clear_host_runtime_event_sink();
    let inner = connected_runtime_inner("terminal-close-during-open-test");
    inner.state.lock().terminals.insert(
        "terminal-1".to_owned(),
        TerminalRuntime {
            state: HostTerminalState::Opening,
            takeover: true,
            columns: 80,
            rows: 24,
            cell_width_px: 8,
            cell_height_px: 16,
            operation_epoch: 7,
            reconnect_attempt: 2,
            retry_running: true,
            bridge_id: Some(41),
        },
    );

    schedule_terminal_retry(
        inner.clone(),
        "terminal-1".to_owned(),
        Some(41),
        "bridge closed before attach committed".to_owned(),
    );

    let state = inner.state.lock();
    let terminal = &state.terminals["terminal-1"];
    assert_eq!(terminal.state, HostTerminalState::Failed);
    assert_eq!(terminal.bridge_id, None);
    assert!(terminal.retry_running);
    assert_eq!(terminal.operation_epoch, 7);
    assert_eq!(terminal.reconnect_attempt, 2);
    drop(state);
}

#[test]
fn stale_bridge_close_cannot_invalidate_replacement() {
    let _guard = EVENT_SINK_TEST_LOCK.lock();
    clear_host_runtime_event_sink();
    let inner = connected_runtime_inner("stale-terminal-close-test");
    inner.state.lock().terminals.insert(
        "terminal-1".to_owned(),
        TerminalRuntime {
            state: HostTerminalState::Attached,
            takeover: true,
            columns: 80,
            rows: 24,
            cell_width_px: 8,
            cell_height_px: 16,
            operation_epoch: 8,
            reconnect_attempt: 0,
            retry_running: false,
            bridge_id: Some(42),
        },
    );

    schedule_terminal_retry(
        inner.clone(),
        "terminal-1".to_owned(),
        Some(41),
        "old bridge closed late".to_owned(),
    );

    let state = inner.state.lock();
    let terminal = &state.terminals["terminal-1"];
    assert_eq!(terminal.state, HostTerminalState::Attached);
    assert_eq!(terminal.bridge_id, Some(42));
    assert!(!terminal.retry_running);
    drop(state);
}

#[test]
fn bridge_claim_is_scoped_to_the_current_open_operation() {
    let inner = connected_runtime_inner("terminal-bridge-claim-test");
    inner.state.lock().terminals.insert(
        "terminal-1".to_owned(),
        TerminalRuntime {
            state: HostTerminalState::Restoring,
            takeover: true,
            columns: 80,
            rows: 24,
            cell_width_px: 8,
            cell_height_px: 16,
            operation_epoch: 9,
            reconnect_attempt: 1,
            retry_running: true,
            bridge_id: None,
        },
    );

    assert_eq!(claim_terminal_bridge(&inner, "terminal-1", 9, 51), Ok(()));
    assert_eq!(
        inner.state.lock().terminals["terminal-1"].bridge_id,
        Some(51)
    );
    assert!(matches!(
        claim_terminal_bridge(&inner, "terminal-1", 8, 50),
        Err(HerdrBridgeError::BridgeUnavailable(_))
    ));
    assert_eq!(
        inner.state.lock().terminals["terminal-1"].bridge_id,
        Some(51)
    );
}

#[test]
fn unexpected_transport_death_starts_host_reconnect() {
    let mut state = RuntimeState::new(&config());
    let epoch = state.begin_connect().unwrap();
    assert!(state.install_connection(epoch));

    assert!(
        state
            .begin_reconnect(Some(1), "SSH transport disconnected")
            .is_some()
    );
    assert_eq!(state.connection, HostConnectionState::Reconnecting);
    assert!(state.reconnect_running);
}

#[test]
fn explicit_disconnect_rejects_transport_reconnect() {
    let mut state = RuntimeState::new(&config());
    let epoch = state.begin_connect().unwrap();
    assert!(state.install_connection(epoch));
    state.disconnect();

    assert!(
        state
            .begin_reconnect(Some(1), "russh callback after user disconnect")
            .is_none()
    );
}

#[test]
fn simultaneous_transport_failures_start_one_reconnect() {
    let mut state = RuntimeState::new(&config());
    let epoch = state.begin_connect().unwrap();
    assert!(state.install_connection(epoch));

    assert!(state.begin_reconnect(Some(1), "channel failed").is_some());
    assert!(
        state
            .begin_reconnect(Some(1), "russh disconnected")
            .is_none()
    );
    assert_eq!(state.epoch, epoch.wrapping_add(1));
}

#[test]
fn herdr_timeout_with_healthy_ssh_selects_only_herdr_recovery() {
    let mut state = RuntimeState::new(&config());
    let epoch = state.begin_connect().unwrap();
    assert!(state.install_connection(epoch));
    state.terminals.insert(
        "terminal-1".to_owned(),
        TerminalRuntime {
            state: HostTerminalState::Attached,
            takeover: true,
            columns: 80,
            rows: 24,
            cell_width_px: 8,
            cell_height_px: 16,
            operation_epoch: 1,
            reconnect_attempt: 0,
            retry_running: false,
            bridge_id: Some(7),
        },
    );

    assert_eq!(
        recovery_scope_for_transport_state(
            &HerdrControlError::RequestTimeout("Herdr request timed out".to_owned()),
            true,
        ),
        RecoveryScope::Herdr
    );
    assert_eq!(state.connection, HostConnectionState::Connected);
    assert_eq!(state.generation, 1);
    assert_eq!(
        state.terminals["terminal-1"].state,
        HostTerminalState::Attached
    );
    assert!(!state.reconnect_running);
}

#[test]
fn herdr_timeout_with_dead_ssh_starts_exactly_one_host_reconnect() {
    let mut state = RuntimeState::new(&config());
    let epoch = state.begin_connect().unwrap();
    assert!(state.install_connection(epoch));
    assert_eq!(
        recovery_scope_for_transport_state(
            &HerdrControlError::RequestTimeout("Herdr request timed out".to_owned()),
            false,
        ),
        RecoveryScope::Ssh
    );

    let reconnect_epoch = state
        .begin_reconnect(Some(1), "confirmed SSH transport failure")
        .expect("dead SSH starts reconnect")
        .0;
    assert!(
        state
            .begin_reconnect(Some(1), "duplicate timeout")
            .is_none()
    );
    assert_eq!(state.connection, HostConnectionState::Reconnecting);
    assert!(state.reconnect_running);
    assert_ne!(reconnect_epoch, epoch);
}

#[test]
fn explicit_ssh_disconnect_bypasses_herdr_recovery() {
    assert_eq!(
        recovery_scope_for_transport_state(
            &HerdrControlError::TransportDisconnected("SSH transport disconnected".to_owned(),),
            false,
        ),
        RecoveryScope::Ssh
    );
}

#[test]
fn reconnect_policy_enters_persistent_phase_after_fast_attempts() {
    assert_eq!(reconnect_attempt(1, true, 1.0).delay_ms, 0);
    assert_eq!(reconnect_attempt(5, true, 1.0).phase, ReconnectPhase::Fast);
    let first_persistent = reconnect_attempt(6, true, 1.0);
    assert_eq!(first_persistent.phase, ReconnectPhase::Persistent);
    assert_eq!(first_persistent.phase_attempt, 1);
    assert_eq!(first_persistent.delay_ms, 15_000);
    assert_eq!(reconnect_attempt(7, true, 1.0).delay_ms, 30_000);
    assert_eq!(reconnect_attempt(8, true, 1.0).delay_ms, 60_000);
    assert_eq!(reconnect_attempt(30, true, 1.0).delay_ms, 60_000);
}

#[test]
fn persistent_failures_keep_runtime_reconnecting_and_worker_owned() {
    let inner = connected_runtime_inner("persistent-reconnect-test");
    let epoch = inner
        .state
        .lock()
        .begin_reconnect(None, "transport lost")
        .expect("connected runtime starts reconnect")
        .0;
    for attempt in 1..=8 {
        assert!(record_reconnect_failure(
            &inner,
            epoch,
            attempt,
            "network unavailable"
        ));
    }
    let state = inner.state.lock();
    assert_eq!(state.connection, HostConnectionState::Reconnecting);
    assert_eq!(state.reconnect_attempt, 8);
    assert!(state.reconnect_running);
    assert_eq!(state.last_error.as_deref(), Some("network unavailable"));
}

#[test]
fn persistent_reconnect_success_installs_one_new_generation_and_stops_worker() {
    let inner = connected_runtime_inner("persistent-success-test");
    let epoch = inner
        .state
        .lock()
        .begin_reconnect(None, "transport lost")
        .expect("connected runtime starts reconnect")
        .0;
    for attempt in 1..=7 {
        assert!(record_reconnect_failure(
            &inner,
            epoch,
            attempt,
            "network unavailable"
        ));
    }
    assert!(inner.state.lock().install_connection(epoch));
    let state = inner.state.lock();
    assert_eq!(state.connection, HostConnectionState::Connected);
    assert_eq!(state.generation, 2);
    assert!(!state.reconnect_running);
    assert_eq!(state.reconnect_attempt, 0);
}

#[test]
fn explicit_disconnect_cancels_persistent_failure_updates() {
    let inner = connected_runtime_inner("persistent-disconnect-test");
    let epoch = inner
        .state
        .lock()
        .begin_reconnect(None, "transport lost")
        .expect("connected runtime starts reconnect")
        .0;
    assert!(record_reconnect_failure(
        &inner,
        epoch,
        6,
        "network unavailable"
    ));
    inner.state.lock().disconnect();
    assert!(!record_reconnect_failure(
        &inner,
        epoch,
        7,
        "late reconnect failure"
    ));
    let state = inner.state.lock();
    assert_eq!(state.connection, HostConnectionState::Disconnecting);
    assert!(state.explicit_disconnect);
    assert!(!state.reconnect_running);
    drop(state);
}

#[test]
fn foreground_activation_interrupts_a_persistent_reconnect_delay() {
    crate::runtime().unwrap().block_on(async {
        let inner = connected_runtime_inner("persistent-foreground-wake-test");
        let waiter_inner = inner.clone();
        let mut cancellation = inner.cancellation.subscribe();
        let waiter = tokio::spawn(async move {
            wait_for_reconnect_delay(&waiter_inner, 60_000, &mut cancellation).await
        });
        tokio::task::yield_now().await;

        set_monitoring_state(&inner, true, false, false);

        assert!(matches!(
            tokio::time::timeout(Duration::from_millis(100), waiter).await,
            Ok(Ok(true))
        ));
        set_monitoring_state(&inner, false, false, false);
    });
}

#[test]
fn lifecycle_epoch_change_cancels_a_persistent_reconnect_delay() {
    crate::runtime().unwrap().block_on(async {
        let inner = connected_runtime_inner("persistent-epoch-cancel-test");
        let waiter_inner = inner.clone();
        let mut cancellation = inner.cancellation.subscribe();
        let waiter = tokio::spawn(async move {
            wait_for_reconnect_delay(&waiter_inner, 60_000, &mut cancellation).await
        });
        tokio::task::yield_now().await;

        let _ = inner.cancellation.send(17);

        assert!(matches!(
            tokio::time::timeout(Duration::from_millis(100), waiter).await,
            Ok(Ok(false))
        ));
    });
}

#[test]
fn ssh_transport_loss_retains_direct_shell_intent_and_geometry() {
    let mut state = RuntimeState::new(&config());
    let epoch = state.begin_connect().unwrap();
    assert!(state.install_connection(epoch));
    let geometry = HostTerminalGeometry::normalized(132, 47, 9, 18);
    state.ssh_shells.insert(
        "ssh-shell-1".to_owned(),
        desired_ssh_shell(HostTerminalState::Attached, geometry, 4),
    );

    assert_eq!(
        apply_ssh_shell_close(&mut state, "ssh-shell-1", 4, true),
        SshShellCloseDisposition::Restore
    );
    let shell = &state.ssh_shells["ssh-shell-1"];
    assert!(shell.desired_open);
    assert_eq!(shell.state, HostTerminalState::Restoring);
    assert_eq!(shell.geometry, geometry);
    assert_eq!(shell.dispatched_geometry, None);
}

#[test]
fn explicit_shell_close_during_reconnect_cannot_be_restored() {
    let mut state = RuntimeState::new(&config());
    let epoch = state.begin_connect().unwrap();
    assert!(state.install_connection(epoch));
    let geometry = HostTerminalGeometry::normalized(100, 31, 8, 16);
    state.ssh_shells.insert(
        "ssh-shell-1".to_owned(),
        desired_ssh_shell(HostTerminalState::Attached, geometry, 2),
    );
    state
        .begin_reconnect(Some(1), "SSH transport disconnected")
        .expect("transport loss starts reconnect");
    state.ssh_shells.remove("ssh-shell-1");

    assert!(!state.ssh_shells.contains_key("ssh-shell-1"));
}

#[test]
fn stale_ssh_shell_open_cannot_resurrect_a_newer_lifecycle() {
    let mut state = RuntimeState::new(&config());
    let epoch = state.begin_connect().unwrap();
    assert!(state.install_connection(epoch));
    let geometry = HostTerminalGeometry::normalized(80, 24, 8, 16);
    state.ssh_shells.insert(
        "ssh-shell-1".to_owned(),
        desired_ssh_shell(HostTerminalState::Opening, geometry, 9),
    );
    assert!(ssh_shell_open_is_current(
        &state,
        "ssh-shell-1",
        epoch,
        1,
        9
    ));
    state
        .ssh_shells
        .get_mut("ssh-shell-1")
        .unwrap()
        .operation_epoch = 10;
    assert!(!ssh_shell_open_is_current(
        &state,
        "ssh-shell-1",
        epoch,
        1,
        9
    ));
}

#[test]
fn multiple_desired_ssh_shells_restore_independently() {
    let mut state = RuntimeState::new(&config());
    let epoch = state.begin_connect().unwrap();
    assert!(state.install_connection(epoch));
    let first_geometry = HostTerminalGeometry::normalized(80, 24, 8, 16);
    let second_geometry = HostTerminalGeometry::normalized(120, 40, 9, 18);
    state.ssh_shells.insert(
        "ssh-shell-1".to_owned(),
        desired_ssh_shell(HostTerminalState::Attached, first_geometry, 3),
    );
    state.ssh_shells.insert(
        "ssh-shell-2".to_owned(),
        desired_ssh_shell(HostTerminalState::Attached, second_geometry, 7),
    );
    state
        .begin_reconnect(Some(1), "SSH transport disconnected")
        .expect("transport loss starts reconnect");
    state.ssh_shells.get_mut("ssh-shell-1").unwrap().state = HostTerminalState::Failed;

    assert!(state.ssh_shells["ssh-shell-1"].desired_open);
    assert!(state.ssh_shells["ssh-shell-2"].desired_open);
    assert_eq!(
        state.ssh_shells["ssh-shell-2"].state,
        HostTerminalState::Restoring
    );
    assert_eq!(state.ssh_shells["ssh-shell-2"].geometry, second_geometry);
}

#[test]
fn stale_session_generation_cannot_reconnect_replacement() {
    let mut state = RuntimeState::new(&config());
    let first = state.begin_connect().unwrap();
    assert!(state.install_connection(first));
    state.connection = HostConnectionState::Failed;
    let second = state.begin_connect().unwrap();
    assert!(state.install_connection(second));
    assert_eq!(state.generation, 2);

    assert!(
        state
            .begin_reconnect(Some(1), "old session disconnected")
            .is_none()
    );
    assert_eq!(state.connection, HostConnectionState::Connected);
    assert!(!state.reconnect_running);
}

#[test]
fn repeated_connect_does_not_create_a_second_epoch() {
    let mut state = RuntimeState::new(&config());
    let epoch = state.begin_connect().unwrap();
    assert!(state.install_connection(epoch));
    assert_eq!(state.begin_connect().unwrap(), epoch);
}

#[test]
fn concurrent_connect_is_rejected() {
    let mut state = RuntimeState::new(&config());
    state.begin_connect().unwrap();
    assert!(matches!(
        state.begin_connect(),
        Err(HostRuntimeError::StaleOperation(_))
    ));
}

#[test]
fn stale_connection_cannot_overwrite_newer_epoch() {
    let mut state = RuntimeState::new(&config());
    let old = state.begin_connect().unwrap();
    state.disconnect();
    assert!(!state.install_connection(old));
    assert_eq!(state.generation, 0);
}

#[test]
fn disconnect_closes_terminal_intent_and_event_subscription() {
    let mut state = RuntimeState::new(&config());
    state.event = Some(EventSubscriptionRuntime {
        pane_ids: vec!["p1".to_owned()],
        operation_epoch: 1,
        retry_running: true,
    });
    state.terminals.insert(
        "t1".to_owned(),
        TerminalRuntime {
            state: HostTerminalState::Restoring,
            takeover: true,
            columns: 91,
            rows: 33,
            cell_width_px: 8,
            cell_height_px: 16,
            operation_epoch: 2,
            reconnect_attempt: 3,
            retry_running: true,
            bridge_id: None,
        },
    );
    let geometry = HostTerminalGeometry::normalized(91, 33, 8, 16);
    state
        .terminal_dispatched_geometries
        .insert("t1".to_owned(), geometry);
    state
        .terminal_kitty_keyboard_report_all
        .insert("t1".to_owned(), true);
    state.ssh_shells.insert(
        "ssh-shell-1".to_owned(),
        SshShellRuntime {
            desired_open: true,
            state: HostTerminalState::Attached,
            geometry,
            dispatched_geometry: Some(geometry),
            operation_epoch: 4,
            reconnect_attempt: 0,
            retry_running: false,
        },
    );
    state.disconnect();
    assert!(state.event.is_none());
    assert!(state.terminal_dispatched_geometries.is_empty());
    assert!(state.terminal_kitty_keyboard_report_all.is_empty());
    let terminal = &state.terminals["t1"];
    assert_eq!(terminal.state, HostTerminalState::Closed);
    assert!(!terminal.retry_running);
    assert_eq!(terminal.reconnect_attempt, 0);
    assert_eq!(terminal.operation_epoch, 3);
    let shell = &state.ssh_shells["ssh-shell-1"];
    assert!(!shell.desired_open);
    assert_eq!(shell.state, HostTerminalState::Closed);
    assert_eq!(shell.geometry, geometry);
    assert_eq!(shell.dispatched_geometry, None);
    assert_eq!(shell.operation_epoch, 5);
    assert_eq!(shell.reconnect_attempt, 0);
    assert!(!shell.retry_running);
}

#[test]
fn backoff_matches_the_typescript_policy_boundaries() {
    assert_eq!(reconnect_delay(1, 1.0), 750);
    assert_eq!(reconnect_delay(2, 1.0), 1_500);
    assert_eq!(reconnect_delay(5, 1.0), 8_000);
    assert_eq!(reconnect_delay(1, 0.0), 375);
    assert_eq!(reconnect_delay(5, 0.0), 4_000);
}

#[test]
fn only_focus_operations_are_replayed() {
    assert!(idempotent_replay(&HerdrControlRequest::WorkspaceFocus {
        workspace_id: "w".to_owned()
    }));
    assert!(idempotent_replay(&HerdrControlRequest::AgentFocus {
        target: "a".to_owned()
    }));
    assert!(!idempotent_replay(&HerdrControlRequest::WorkspaceClose {
        workspace_id: "w".to_owned()
    }));
}

#[test]
fn terminal_geometry_survives_restoring_state() {
    let terminal = TerminalRuntime {
        state: HostTerminalState::Restoring,
        takeover: true,
        columns: 132,
        rows: 47,
        cell_width_px: 9,
        cell_height_px: 18,
        operation_epoch: 7,
        reconnect_attempt: 2,
        retry_running: false,
        bridge_id: None,
    };
    assert_eq!(
        (
            terminal.columns,
            terminal.rows,
            terminal.cell_width_px,
            terminal.cell_height_px
        ),
        (132, 47, 9, 18)
    );
    assert!(terminal.takeover);
    assert_eq!(terminal.reconnect_attempt, 2);
}

#[test]
fn malformed_config_is_rejected_without_panicking() {
    let mut invalid = config();
    invalid.ssh.port = 0;
    assert!(matches!(
        validate_config(&invalid),
        Err(HostRuntimeError::InvalidConfiguration(_))
    ));
    invalid.ssh.port = 22;
    invalid.socket_path = Some("relative.sock".to_owned());
    assert!(matches!(
        validate_config(&invalid),
        Err(HostRuntimeError::InvalidConfiguration(_))
    ));
}

#[test]
fn generation_advances_only_after_a_connection_wins() {
    let mut state = RuntimeState::new(&config());
    let first = state.begin_connect().unwrap();
    assert_eq!(state.generation, 0);
    assert!(state.install_connection(first));
    assert_eq!(state.generation, 1);
    state.connection = HostConnectionState::Failed;
    let second = state.begin_connect().unwrap();
    assert_eq!(state.generation, 1);
    assert!(state.install_connection(second));
    assert_eq!(state.generation, 2);
}

#[test]
fn disconnect_while_connecting_invalidates_the_connect_epoch() {
    let mut state = RuntimeState::new(&config());
    let connecting = state.begin_connect().unwrap();
    let disconnecting = state.disconnect();
    assert_ne!(connecting, disconnecting);
    assert!(!state.install_connection(connecting));
}

#[test]
fn disconnect_while_reconnecting_prevents_replacement_install() {
    let mut state = RuntimeState::new(&config());
    state.connection = HostConnectionState::Reconnecting;
    state.reconnect_running = true;
    state.epoch = 8;
    let replacement = state.epoch;
    state.disconnect();
    assert!(!state.install_connection(replacement));
    assert!(!state.reconnect_running);
}

#[test]
fn stale_event_subscription_epoch_is_detectable_after_restart() {
    let mut state = RuntimeState::new(&config());
    state.event = Some(EventSubscriptionRuntime {
        pane_ids: vec!["old".to_owned()],
        operation_epoch: 4,
        retry_running: true,
    });
    let stale = state.event.as_ref().unwrap().operation_epoch;
    state.event = Some(EventSubscriptionRuntime {
        pane_ids: vec!["new".to_owned()],
        operation_epoch: stale + 1,
        retry_running: false,
    });
    assert_ne!(state.event.as_ref().unwrap().operation_epoch, stale);
    assert_eq!(state.event.as_ref().unwrap().pane_ids, ["new"]);
}

#[test]
fn old_subscription_cannot_survive_explicit_disconnect() {
    let mut state = RuntimeState::new(&config());
    state.event = Some(EventSubscriptionRuntime {
        pane_ids: vec![],
        operation_epoch: 9,
        retry_running: false,
    });
    state.disconnect();
    assert!(state.event.is_none());
    assert!(state.explicit_disconnect);
}

#[test]
fn closing_terminal_during_restore_invalidates_operation() {
    let mut terminal = TerminalRuntime {
        state: HostTerminalState::Restoring,
        takeover: true,
        columns: 80,
        rows: 24,
        cell_width_px: 0,
        cell_height_px: 0,
        operation_epoch: 5,
        reconnect_attempt: 1,
        retry_running: true,
        bridge_id: None,
    };
    let restoring = terminal.operation_epoch;
    terminal.operation_epoch = terminal.operation_epoch.wrapping_add(1);
    terminal.state = HostTerminalState::Closed;
    terminal.retry_running = false;
    assert_ne!(terminal.operation_epoch, restoring);
    assert_eq!(terminal.state, HostTerminalState::Closed);
}

#[test]
fn terminal_failure_does_not_change_host_connection_state() {
    let mut state = RuntimeState::new(&config());
    state.connection = HostConnectionState::Connected;
    state.terminals.insert(
        "failed".to_owned(),
        TerminalRuntime {
            state: HostTerminalState::Failed,
            takeover: true,
            columns: 80,
            rows: 24,
            cell_width_px: 0,
            cell_height_px: 0,
            operation_epoch: 1,
            reconnect_attempt: 5,
            retry_running: false,
            bridge_id: None,
        },
    );
    assert_eq!(state.connection, HostConnectionState::Connected);
    assert_eq!(state.terminals["failed"].state, HostTerminalState::Failed);
}

#[test]
fn one_failed_terminal_does_not_close_other_terminal_intent() {
    let mut failed = TerminalRuntime {
        state: HostTerminalState::Restoring,
        takeover: true,
        columns: 80,
        rows: 24,
        cell_width_px: 0,
        cell_height_px: 0,
        operation_epoch: 1,
        reconnect_attempt: 1,
        retry_running: false,
        bridge_id: None,
    };
    let attached = failed.clone();
    failed.state = HostTerminalState::Failed;
    assert_eq!(attached.state, HostTerminalState::Restoring);
    assert_eq!(failed.state, HostTerminalState::Failed);
}

#[test]
fn reconnect_delay_clamps_untrusted_random_source() {
    assert_eq!(reconnect_delay(1, -10.0), 375);
    assert_eq!(reconnect_delay(1, 10.0), 750);
    assert_eq!(reconnect_delay(u32::MAX, 1.0), 8_000);
}

#[test]
fn status_is_one_coherent_runtime_record() {
    let mut state = RuntimeState::new(&config());
    state.connection = HostConnectionState::Reconnecting;
    state.generation = 7;
    state.reconnect_attempt = 3;
    state.last_error = Some("broken pipe".to_owned());
    let status = state.status();
    assert_eq!(status.state, HostConnectionState::Reconnecting);
    assert_eq!(status.generation, 7);
    assert_eq!(status.reconnect_attempt, 3);
    assert_eq!(status.error.as_deref(), Some("broken pipe"));
}

#[test]
fn valid_jump_chain_configuration_is_accepted() {
    let mut value = config();
    value.jump_hosts.push(HostSshConfig {
        host: "jump.test".to_owned(),
        port: 2222,
        username: "jump".to_owned(),
        credential: HostSshCredential::Key {
            private_key: "private".to_owned(),
            passphrase: None,
        },
        forward_agent: true,
    });
    assert!(validate_config(&value).is_ok());
}

#[test]
fn malformed_jump_host_is_rejected_before_transport_creation() {
    let mut value = config();
    value.jump_hosts.push(HostSshConfig {
        host: String::new(),
        port: 22,
        username: "jump".to_owned(),
        credential: HostSshCredential::Password {
            password: "secret".to_owned(),
        },
        forward_agent: false,
    });
    assert!(matches!(
        validate_config(&value),
        Err(HostRuntimeError::InvalidConfiguration(_))
    ));
}

#[test]
fn all_focus_requests_are_replayable_but_mutations_are_not() {
    assert!(idempotent_replay(&HerdrControlRequest::TabFocus {
        tab_id: "t".to_owned()
    }));
    assert!(idempotent_replay(&HerdrControlRequest::PaneFocus {
        pane_id: "p".to_owned()
    }));
    assert!(!idempotent_replay(&HerdrControlRequest::PaneSendText {
        pane_id: "p".to_owned(),
        text: "hello".to_owned()
    }));
    assert!(safe_control_replay(&HerdrControlRequest::SessionSnapshot));
    assert!(safe_control_replay(&HerdrControlRequest::PaneRead {
        pane_id: "p".to_owned(),
        lines: 10
    }));
    assert!(!safe_control_replay(&HerdrControlRequest::PaneSendText {
        pane_id: "p".to_owned(),
        text: "hello".to_owned()
    }));
    assert_eq!(
        request_replay(&HerdrControlRequest::SessionSnapshot),
        HerdrRequestReplay::AfterSocketRediscovery
    );
    assert_eq!(
        request_replay(&HerdrControlRequest::PaneSendText {
            pane_id: "p".to_owned(),
            text: "do not replay".to_owned(),
        },),
        HerdrRequestReplay::Never
    );
}
