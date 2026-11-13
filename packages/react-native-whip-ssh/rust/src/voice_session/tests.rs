use super::*;
fn service_current(token: &std::ffi::CStr) -> bool {
    // SAFETY: The borrowed CStr lives through the synchronous native call.
    unsafe { whip_voice_session_current(token.as_ptr()) }
}
fn service_end(token: &std::ffi::CStr, interrupted: bool) {
    // SAFETY: The borrowed CStr lives through the synchronous native call.
    unsafe {
        whip_voice_session_end(token.as_ptr(), interrupted);
    }
}
fn source() -> Source {
    Source {
        runtime_id: "runtime".into(),
        incarnation: "2".into(),
        terminal_id: "terminal".into(),
        pane_id: "pane".into(),
        agent: "codex".into(),
        target_key: "destination".into(),
    }
}
fn admit(core: &VoiceSessionCoordinator, mode: &str) -> Result<String, VoiceSessionError> {
    let request: Request = decode(&json!({"scope":{"kind":"Agent","hostId":"host","tabId":"tab","paneId":"pane","agent":"codex","source":source()},"mode":mode,"available":true}).to_string())?;
    let value: Value = decode(&encode(&core.update(|state| state.request(request)))?)?;
    let id = value["id"]
        .as_str()
        .ok_or(VoiceSessionError::InvalidCommand)?
        .to_owned();
    core.take_effects()?;
    core.acknowledge(id.clone(), "prepared".into())?;
    core.take_effects()?;
    Ok(id)
}
#[test]
fn cancelling_app_owner_synchronously_closes_native_local_core() -> Result<(), VoiceSessionError> {
    let core = VoiceSessionCoordinator::default();
    let id = admit(&core, "TurnBased")?;
    let local = VoiceChat::new(String::new());
    core.bind_local(id.clone(), local.clone(), encode(&source())?)?;
    core.end(id.clone(), None);
    assert_eq!(local.view().phase, crate::VoiceChatPhase::Closed);
    assert!(!core.is_current(id.clone()));
    assert!(
        core.bind_local(id, VoiceChat::new(String::new()), encode(&source())?)
            .is_err()
    );
    Ok(())
}
#[test]
fn local_attachment_checks_mode_and_entire_native_destination() -> Result<(), VoiceSessionError> {
    for mode in ["TurnBased", "Realtime", "Live"] {
        let core = VoiceSessionCoordinator::default();
        let id = admit(&core, mode)?;
        let mut changed = source();
        changed.incarnation = "3".into();
        assert!(
            core.bind_local(id.clone(), VoiceChat::new(String::new()), encode(&changed)?)
                .is_err()
        );
        let result = core.bind_local(id, VoiceChat::new(String::new()), encode(&source())?);
        assert_eq!(result.is_ok(), mode == "TurnBased");
    }
    Ok(())
}
#[test]
fn cloud_admission_checks_generation_mode_and_native_scope_without_a_chat_binding()
-> Result<(), VoiceSessionError> {
    for mode in ["Realtime", "Live"] {
        let core = VoiceSessionCoordinator::default();
        let id = admit(&core, mode)?;
        assert!(core.accepts_realtime(&id, mode == "Live", false, Some(&source()), None, None));
        assert!(!core.accepts_realtime(&id, mode != "Live", false, Some(&source()), None, None));
        assert!(!core.accepts_realtime(&id, mode == "Live", true, None, None, None));
        let mut changed = source();
        changed.terminal_id = "other".into();
        assert!(!core.accepts_realtime(&id, mode == "Live", false, Some(&changed), None, None));
        core.end(id.clone(), None);
        assert!(!core.accepts_realtime(&id, mode == "Live", false, Some(&source()), None, None));
    }
    Ok(())
}
#[test]
fn early_context_is_bounded_ordered_and_erased_on_cancellation() -> Result<(), VoiceSessionError> {
    let core = VoiceSessionCoordinator::default();
    let id = admit(&core, "Realtime")?;
    for index in 0..8 {
        core.submit_context(id.clone(), index.to_string())?;
    }
    assert!(core.submit_context(id.clone(), "overflow".into()).is_err());
    assert_eq!(
        core.inner.lock().submissions[&id]
            .iter()
            .cloned()
            .collect::<Vec<_>>(),
        (0..8).map(|index| index.to_string()).collect::<Vec<_>>()
    );
    core.end(id.clone(), None);
    assert!(core.inner.lock().submissions.is_empty());
    assert!(core.submit_context(id, "late".into()).is_err());
    Ok(())
}
#[tokio::test(start_paused = true)]
async fn observation_coalesces_updates_and_rejects_a_second_waiter() -> Result<(), VoiceSessionError>
{
    let core = Arc::new(VoiceSessionCoordinator::default());
    let id = admit(&core, "Realtime")?;
    core.save_realtime(
        &id,
        json!({"phase":"listening","level":0.0,"capturePackets":1}),
    );
    let first: Value = decode(&core.snapshot(&id)?)?;
    let revision = first["revision"]
        .as_str()
        .ok_or(VoiceSessionError::InvalidCommand)?
        .to_owned();
    let waiting = {
        let core = core.clone();
        let id = id.clone();
        let revision = revision.clone();
        tokio::spawn(async move { core.wait_view(id, revision).await })
    };
    tokio::task::yield_now().await;
    assert!(core.wait_view(id.clone(), revision.clone()).await.is_err());
    core.save_realtime(
        &id,
        json!({"phase":"listening","level":0.0,"capturePackets":100}),
    );
    tokio::time::advance(Duration::from_millis(100)).await;
    tokio::task::yield_now().await;
    assert!(!waiting.is_finished(), "diagnostics do not wake JS");
    core.save_realtime(&id, json!({"phase":"speaking","text":"first"}));
    core.save_realtime(&id, json!({"phase":"speaking","text":"latest"}));
    tokio::time::advance(Duration::from_millis(100)).await;
    let update: Value = decode(&waiting.await.map_err(|_| VoiceSessionError::Cancelled)??)?;
    assert_eq!(update["view"]["text"], "latest");
    assert_ne!(update["revision"], revision);
    Ok(())
}
#[tokio::test(start_paused = true)]
async fn teardown_returns_final_usage_and_releases_observation_after_acknowledgement()
-> Result<(), VoiceSessionError> {
    let core = VoiceSessionCoordinator::default();
    let id = admit(&core, "Live")?;
    core.end(id.clone(), None);
    core.save_realtime(
        &id,
        json!({"phase":"closed","usageFinalized":true,"estimatedUsd":0.25}),
    );
    let final_view: Value = decode(&core.wait_view(id.clone(), "0".into()).await?)?;
    assert_eq!(final_view["ended"], true);
    assert_eq!(final_view["view"]["usageFinalized"], true);
    assert_eq!(final_view["view"]["estimatedUsd"], 0.25);
    core.acknowledge(id.clone(), "closed".into())?;
    assert!(core.inner.lock().observations.is_empty());
    core.save_realtime(&id, json!({"phase":"listening"}));
    assert!(core.inner.lock().observations.is_empty());
    Ok(())
}

#[test]
fn native_service_admission_and_interruption_use_the_same_generation()
-> Result<(), Box<dyn std::error::Error>> {
    let core = voice_session_coordinator();
    let admitted: Value = decode(&core.request(
        json!({"scope":{"kind":"Global"},"mode":"Realtime","available":true}).to_string(),
    )?)?;
    let id = admitted["id"].as_str().ok_or("missing call ID")?.to_owned();
    let token = std::ffi::CString::new(id.clone())?;
    assert!(!service_current(&token));
    assert!(service_current(c"preview:legacy"));
    core.take_effects()?;
    core.acknowledge(id.clone(), "prepared".into())?;
    core.take_effects()?;
    assert!(service_current(&token));
    service_end(&token, true);
    assert!(!service_current(&token));
    let effects: Value = decode(&core.take_effects()?)?;
    assert_eq!(effects["effects"][0]["action"], "close");
    assert_eq!(
        effects["effects"][0]["error"],
        "The system interrupted the voice audio session."
    );
    core.acknowledge(id, "closed".into())?;
    core.take_effects()?;
    Ok(())
}

#[test]
fn native_call_lifetime_retains_backend_without_a_react_presenter() -> Result<(), VoiceSessionError>
{
    let core = VoiceSessionCoordinator::default();
    let id = admit(&core, "TurnBased")?;
    let local = VoiceChat::new(String::new());
    let observed = Arc::downgrade(&local);
    core.bind_local(id.clone(), local, encode(&source())?)?;
    assert!(observed.upgrade().is_some());
    core.end(id, None);
    assert!(observed.upgrade().is_none());
    Ok(())
}
