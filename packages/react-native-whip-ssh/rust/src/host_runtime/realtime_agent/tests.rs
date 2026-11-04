use super::*;
use crate::agent_sessions::AgentChatOpenResult;
use crate::herdr_api::HerdrSessionSnapshot;
use crate::host_runtime::{register_connected_test_runtime, terminal_delivery_test_guard};
type Fixture = (Arc<HostRuntime>, Arc<PinnedAgent>, HerdrSessionSnapshot);

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
    assert!(pinned.feedback_snapshot(None)?.is_none());
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
    assert!(pinned.feedback_snapshot(None).is_err());
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
