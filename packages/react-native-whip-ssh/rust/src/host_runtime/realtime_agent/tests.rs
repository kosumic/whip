use super::*;
use crate::agent_sessions::AgentChatOpenResult;
use crate::herdr_api::HerdrSessionSnapshot;
use crate::host_runtime::{register_connected_test_runtime, terminal_delivery_test_guard};
type Fixture = (Arc<HostRuntime>, Arc<PinnedAgent>, HerdrSessionSnapshot);

#[test]
fn delegated_context_and_progress_require_the_original_source_epoch_and_post_admission_revision()
-> Result<(), Box<dyn std::error::Error>> {
    use crate::realtime_voice::observer::DeliveryDecision;
    let _guard = terminal_delivery_test_guard();
    let (_runtime, pinned, _) = fixture("voice-receipt-generation")?;
    let source = pinned.source_id();
    pinned.receipts.lock().insert(
        "call".into(),
        Receipt {
            accepted: true,
            turn_id: Some("turn".into()),
            epoch: Some(7),
            after_revision: Some(10),
            ..Receipt::default()
        },
    );
    assert_eq!(
        pinned.context_delivery(&source, Some("turn"), 7, 11),
        DeliveryDecision::Allow
    );
    assert!(pinned.progress_matches("call", "turn", 7, 11));
    for (turn, epoch, revision) in [
        ("other", 7, 11),
        ("turn", 8, 11),
        ("turn", 7, 10),
        ("turn", 7, 9),
    ] {
        assert_eq!(
            pinned.context_delivery(&source, Some(turn), epoch, revision),
            DeliveryDecision::Ignore
        );
        assert!(!pinned.progress_matches("call", turn, epoch, revision));
    }
    let mut other = source.clone();
    other.binding_generation += 1;
    assert_eq!(
        pinned.context_delivery(&other, Some("turn"), 7, 11),
        DeliveryDecision::Ignore
    );
    pinned
        .receipts
        .lock()
        .get_mut("call")
        .ok_or("missing receipt")?
        .terminal = true;
    assert!(!pinned.progress_matches("call", "turn", 7, 11));
    assert_eq!(
        pinned.context_delivery(&source, Some("turn"), 7, 11),
        DeliveryDecision::Allow
    );
    pinned
        .receipts
        .lock()
        .get_mut("call")
        .ok_or("missing receipt")?
        .lost = true;
    assert_eq!(
        pinned.context_delivery(&source, Some("turn"), 7, 11),
        DeliveryDecision::Ignore
    );
    Ok(())
}

fn install(runtime: &HostRuntime, snapshot: HerdrSessionSnapshot) {
    let mut state = runtime.inner.state.lock();
    let generation = state.generation;
    let token = state.host_state.begin_sync(generation);
    state.host_state.complete_sync(token, snapshot, 1);
}

fn fixture(id: &str) -> Result<Fixture, Box<dyn std::error::Error>> {
    let runtime = register_connected_test_runtime(id);
    let snapshot = crate::host_runtime::tests::agent_chat_snapshot(
        Some(("codex", "11111111-1111-4111-8111-111111111111")),
        Some("codex"),
    );
    install(&runtime, snapshot.clone());
    let AgentChatOpenResult::Bound { binding } =
        runtime.open_agent_chat("terminal-pane-1".into())?
    else {
        return Err("No bound chat".into());
    };
    let pinned = PinnedAgent::pin(AgentTarget {
        runtime_id: id.into(),
        terminal_id: binding.terminal_id,
        pane_id: binding.pane_id,
        binding_token: binding.binding_token,
    })?;
    Ok((runtime, pinned, snapshot))
}

#[test]
fn global_voice_selection_pins_agent_identity_before_confirmation()
-> Result<(), Box<dyn std::error::Error>> {
    let _guard = terminal_delivery_test_guard();
    let (runtime, _, mut snapshot) = fixture("voice-global-selection")?;
    let selected = PinnedAgent::select("voice-global-selection".into(), "pane-1")?;
    selected.check()?;
    assert!(PinnedAgent::select("voice-global-selection".into(), "missing-pane").is_err());
    snapshot.panes[0]
        .agent_session
        .as_mut()
        .ok_or("No agent identity")?
        .value = "22222222-2222-4222-8222-222222222222".into();
    install(&runtime, snapshot);
    assert!(selected.check().is_err());
    Ok(())
}

#[test]
fn realtime_agent_snapshot_refresh_retains_call_but_blocks_tools_until_fresh()
-> Result<(), Box<dyn std::error::Error>> {
    let _guard = terminal_delivery_test_guard();
    let (runtime, pinned, snapshot) = fixture("voice-refresh")?;
    let token = {
        let mut state = runtime.inner.state.lock();
        state
            .host_state
            .mark_needs_resync("ordinary refresh".into());
        let generation = state.generation;
        state.host_state.begin_sync(generation)
    };
    pinned.check_liveness()?;
    assert!(pinned.check().is_err());
    assert!(pinned.read_context(12)?["stale"].as_bool().unwrap_or(false));
    runtime
        .inner
        .state
        .lock()
        .host_state
        .complete_sync(token, snapshot, 2);
    pinned.check_liveness()?;
    pinned.check()?;
    Ok(())
}

#[test]
fn realtime_agent_failed_refresh_stops_call() -> Result<(), Box<dyn std::error::Error>> {
    let _guard = terminal_delivery_test_guard();
    let (runtime, pinned, _) = fixture("voice-refresh-failed")?;
    let token = {
        let mut state = runtime.inner.state.lock();
        let generation = state.generation;
        state.host_state.begin_sync(generation)
    };
    runtime
        .inner
        .state
        .lock()
        .host_state
        .fail_sync(token, "refresh failed".into());
    assert!(pinned.check_liveness().is_err());
    assert!(pinned.read_context(12).is_err());
    Ok(())
}

#[test]
fn realtime_agent_focus_changes_never_retarget_the_call() -> Result<(), Box<dyn std::error::Error>>
{
    let _guard = terminal_delivery_test_guard();
    let (runtime, pinned, mut snapshot) = fixture("voice-focus")?;
    snapshot.panes[0].focused = false;
    snapshot.panes[1].focused = true;
    install(&runtime, snapshot);
    pinned.check()?;
    assert_eq!(pinned.binding.pane_id.as_str(), "pane-1");
    Ok(())
}

#[test]
fn realtime_agent_results_must_match_the_original_remote_session()
-> Result<(), Box<dyn std::error::Error>> {
    let _guard = terminal_delivery_test_guard();
    let (_, pinned, _) = fixture("voice-result")?;
    let mut value = json!({"agent":{"pane_id":"pane-1","terminal_id":"terminal-pane-1","agent_session":{"agent":"codex","value":"11111111-1111-4111-8111-111111111111"}}});
    pinned.check_agent_result(&value)?;
    value["agent"]["agent_session"]["value"] = json!("22222222-2222-4222-8222-222222222222");
    assert!(pinned.check_agent_result(&value).is_err());
    Ok(())
}

#[test]
fn realtime_agent_disconnect_reconnect_and_server_recovery_invalidate_the_original_pin()
-> Result<(), Box<dyn std::error::Error>> {
    let _guard = terminal_delivery_test_guard();
    let (runtime, pinned, _) = fixture("voice-disconnect")?;
    runtime.inner.state.lock().connection = HostConnectionState::Disconnected;
    assert!(pinned.check().is_err());
    assert!(pinned.check_liveness().is_err());
    {
        let mut state = runtime.inner.state.lock();
        state.connection = HostConnectionState::Connected;
        state.generation += 1;
    }
    assert!(pinned.check().is_err());
    let (runtime, pinned, _) = fixture("voice-recovery")?;
    runtime.inner.state.lock().herdr_recovery_revision += 1;
    assert!(pinned.check().is_err());
    assert!(pinned.check_liveness().is_err());
    let (_, pinned, _) = fixture("voice-runtime-rebind")?;
    let _replacement = register_connected_test_runtime("voice-runtime-rebind");
    assert!(pinned.check().is_err());
    assert!(pinned.check_liveness().is_err());
    Ok(())
}

#[test]
fn realtime_agent_session_replacement_and_binding_detach_reject_late_results()
-> Result<(), Box<dyn std::error::Error>> {
    let _guard = terminal_delivery_test_guard();
    let (runtime, pinned, mut snapshot) = fixture("voice-replaced")?;
    snapshot.panes[0]
        .agent_session
        .as_mut()
        .ok_or("no session")?
        .value = "22222222-2222-4222-8222-222222222222".into();
    install(&runtime, snapshot);
    assert!(pinned.check().is_err());
    assert!(pinned.check_liveness().is_err());
    let (runtime, pinned, _) = fixture("voice-detached")?;
    runtime.detach_agent_chat("terminal-pane-1".into())?;
    assert!(pinned.check().is_err());
    assert!(pinned.check_liveness().is_err());
    Ok(())
}

#[test]
fn delegation_allows_busy_codex_steering_but_never_approval_or_unknown_input() {
    use crate::agent_transcript::AgentTranscriptKind as Kind;
    assert_eq!(
        plan(HerdrAgentStatus::Working, Kind::Codex, Delivery::Now),
        Ok(())
    );
    assert_eq!(
        plan(HerdrAgentStatus::Working, Kind::Codex, Delivery::Later),
        Err("agent_busy")
    );
    assert_eq!(
        plan(HerdrAgentStatus::Working, Kind::Claude, Delivery::Now),
        Err("agent_busy")
    );
    for kind in [Kind::Codex, Kind::Claude, Kind::OpenCode, Kind::Pi] {
        for delivery in [Delivery::Now, Delivery::Later] {
            assert_eq!(
                plan(HerdrAgentStatus::Blocked, kind, delivery),
                Err("approval_required")
            );
            assert_eq!(
                plan(HerdrAgentStatus::Unknown, kind, delivery),
                Err("agent_busy")
            );
            assert_eq!(plan(HerdrAgentStatus::Idle, kind, delivery), Ok(()));
            assert_eq!(plan(HerdrAgentStatus::Done, kind, delivery), Ok(()));
        }
    }
}

#[test]
fn delegation_preserves_the_users_words_and_accepts_only_bounded_delivery_intent()
-> Result<(), Box<dyn std::error::Error>> {
    let prompt = "Keep this correction now.\n稍後執行測試。\tDo not rewrite it.";
    let args = Delegation::parse(&json!({"prompt":prompt}).to_string())?;
    assert_eq!(args.prompt, prompt);
    assert!(args.delivery == Delivery::Now);
    assert!(
        Delegation::parse(&json!({"prompt":prompt,"delivery":"later"}).to_string())?.delivery
            == Delivery::Later
    );
    for args in [
        json!({"prompt":""}),
        json!({"prompt":"x".repeat(8193)}),
        json!({"prompt":"中".repeat(2731)}),
        json!({"prompt":"hello\u{001b}[A"}),
        json!({"prompt":"hello","delivery":"esc"}),
        json!({"prompt":"hello","keys":["Enter"]}),
        json!({"prompt":"hello","target":"other-agent"}),
    ] {
        assert!(Delegation::parse(&args.to_string()).is_err());
    }
    Ok(())
}

#[test]
fn uncertain_submission_prevents_both_immediate_and_deferred_writes()
-> Result<(), Box<dyn std::error::Error>> {
    let _guard = terminal_delivery_test_guard();
    let (_, pinned, _) = fixture("voice-uncertain")?;
    pinned.mark_uncertain();
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    for delivery in ["now", "later"] {
        let request = Delegation::parse(
            &json!({"prompt":"must not be submitted","delivery":delivery}).to_string(),
        )?;
        let result = executor.block_on(pinned.delegate(request, false));
        assert_eq!(result["error"], "outcome_unknown");
    }
    Ok(())
}

#[test]
fn deferred_wait_pauses_for_refresh_and_ends_when_the_bound_agent_disconnects()
-> Result<(), Box<dyn std::error::Error>> {
    let _guard = terminal_delivery_test_guard();
    let (runtime, pinned, snapshot) = fixture("voice-deferred-refresh")?;
    let token = {
        let mut state = runtime.inner.state.lock();
        state
            .host_state
            .mark_needs_resync("ordinary refresh".into());
        let generation = state.generation;
        state.host_state.begin_sync(generation)
    };
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    executor.block_on(async {
        let waiting = {
            let pinned = pinned.clone();
            tokio::spawn(async move { pinned.wait_fresh().await })
        };
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        runtime
            .inner
            .state
            .lock()
            .host_state
            .complete_sync(token, snapshot, 2);
        tokio::time::timeout(Duration::from_secs(2), waiting).await???;
        runtime.inner.state.lock().connection = HostConnectionState::Disconnected;
        assert!(pinned.wait_fresh().await.is_err());
        Ok::<(), Box<dyn std::error::Error>>(())
    })?;
    Ok(())
}

#[test]
fn app_call_pins_native_agent_before_permission_without_a_mounted_chat()
-> Result<(), Box<dyn std::error::Error>> {
    let _guard = terminal_delivery_test_guard();
    let (runtime, pinned, mut snapshot) = fixture("voice-app-admission")?;
    let identity = pinned.source_id();
    let core = crate::VoiceSessionCoordinator::default();
    let request = serde_json::json!({"scope":{"kind":"Agent","hostId":"host","tabId":"tab","paneId":"pane-1","agent":"codex","source":{
        "runtimeId":identity.host_id,"incarnation":identity.runtime_incarnation.to_string(),"terminalId":identity.terminal_id,"paneId":identity.pane_id,"agent":"codex","targetKey":"target"
    }},"mode":"Realtime","available":true}).to_string();
    let admitted: serde_json::Value = serde_json::from_str(&core.request(request.clone())?)?;
    assert!(admitted["error"].is_null());
    let id = admitted["id"].as_str().ok_or("missing call ID")?;
    let pin = core
        .pinned_agent(id)
        .ok_or("missing native admission pin")?;
    assert_eq!(
        pin.binding_identity().session_id,
        pinned.binding_identity().session_id
    );
    snapshot.panes[0]
        .agent_session
        .as_mut()
        .ok_or("missing session")?
        .value = "22222222-2222-4222-8222-222222222222".into();
    install(&runtime, snapshot);
    assert!(pin.check_liveness().is_err());
    // Reattachment never silently adopts a new native session or preferences.
    let attached: serde_json::Value = serde_json::from_str(&core.request(request)?)?;
    assert_eq!(attached["id"], id);
    assert_eq!(attached["attached"], true);
    Ok(())
}
