use super::*;
use crate::realtime_voice::playback_owner_with_commands;
use voice_call_openai::session::Audio;

fn request(json: &str) -> Result<Option<Duration>, String> {
    serde_json::from_str::<Request>(json)
        .map_err(|error| error.to_string())?
        .duration()
        .map_err(str::to_owned)
}

#[test]
fn minutes_are_optional_positive_bounded_numbers_and_only_apply_to_mute() {
    assert_eq!(
        request(r#"{"muted":true,"duration_minutes":10}"#),
        Ok(Some(Duration::from_secs(600)))
    );
    assert_eq!(
        request(r#"{"muted":true,"duration_minutes":0.5}"#),
        Ok(Some(Duration::from_secs(30)))
    );
    assert_eq!(request(r#"{"muted":true}"#), Ok(None));
    assert_eq!(request(r#"{"muted":false}"#), Ok(None));
    for json in [
        r#"{"muted":true,"duration_minutes":0}"#,
        r#"{"muted":true,"duration_minutes":-1}"#,
        r#"{"muted":true,"duration_minutes":61}"#,
        r#"{"muted":true,"duration_minutes":"10"}"#,
        r#"{"muted":false,"duration_minutes":10}"#,
        r#"{"duration_minutes":10}"#,
        r#"{"muted":true,"duration_seconds":10}"#,
        r#"{"muted":true,"duration_minutes":null}"#,
    ] {
        assert!(request(json).is_err(), "Accepted {json}");
    }
}

#[test]
fn expiry_changes_shared_view_without_ending_the_call_and_announces_each_edge()
-> Result<(), &'static str> {
    let (owner, _commands) = playback_owner_with_commands()?;
    owner.set_microphone(true, Some(Duration::from_secs(600)))?;
    let deadline = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
    assert!(owner.view.lock().muted);
    owner.microphone_tick(
        deadline
            .checked_sub(Duration::from_millis(1))
            .ok_or("Invalid deadline")?,
    );
    assert!(owner.view.lock().muted);
    owner.microphone_tick(deadline);
    assert!(!owner.view.lock().muted);
    assert_eq!(owner.view.lock().phase, "listening");
    assert!(!owner.closed.load(Ordering::Acquire));
    assert_eq!(owner.microphone.lock().announcements, [true, false]);
    owner.microphone_tick(deadline + Duration::from_secs(600));
    assert_eq!(owner.microphone.lock().announcements.len(), 2);
    owner.close();
    Ok(())
}

#[test]
fn manual_and_overlapping_agent_commands_replace_the_deadline_without_duplicate_speech()
-> Result<(), &'static str> {
    let (owner, _commands) = playback_owner_with_commands()?;
    owner.set_microphone(true, Some(Duration::from_secs(60)))?;
    let old = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
    owner.set_microphone(true, Some(Duration::from_secs(600)))?;
    let new = owner
        .microphone
        .lock()
        .deadline
        .ok_or("Missing replacement deadline")?;
    owner.microphone_tick(old);
    assert!(owner.view.lock().muted);
    assert_eq!(owner.microphone.lock().announcements, [true]);
    // The UI/system call control follows exactly the same path as the tool.
    owner.set_microphone(false, None)?;
    owner.set_microphone(true, None)?;
    owner.microphone_tick(new);
    assert!(owner.view.lock().muted);
    assert!(owner.microphone.lock().deadline.is_none());
    assert_eq!(owner.microphone.lock().announcements, [true, false, true]);
    owner.set_microphone(false, None)?;
    owner.microphone_tick(new + Duration::from_secs(600));
    assert!(!owner.view.lock().muted);
    owner.close();
    Ok(())
}

#[test]
fn hangup_session_retirement_and_interruptions_never_allow_an_old_timer_to_unmute()
-> Result<(), &'static str> {
    for end in [
        RealtimeVoiceAdapter::close,
        RealtimeVoiceAdapter::retire_session,
        |owner: &RealtimeVoiceAdapter| owner.fail("Interrupted"),
    ] {
        let (owner, _commands) = playback_owner_with_commands()?;
        owner.set_microphone(true, Some(Duration::from_secs(60)))?;
        let deadline = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
        end(&owner);
        owner.microphone_tick(deadline);
        assert!(owner.view.lock().muted);
        assert!(owner.microphone.lock().deadline.is_none());
        assert!(owner.microphone.lock().announcements.is_empty());
        owner.close();
    }
    Ok(())
}

#[test]
fn repeated_manual_mute_cancels_timer_and_old_provider_ack_cannot_reopen_capture()
-> Result<(), &'static str> {
    let (owner, _commands) = playback_owner_with_commands()?;
    owner.set_microphone(true, Some(Duration::from_secs(60)))?;
    let deadline = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
    owner.set_microphone(true, None)?;
    owner.set_muted(false)?; // Stale Live unmute acknowledgement.
    assert!(!owner.input.accepts(owner.input.generation()));
    assert!(owner.view.lock().muted);
    owner.microphone_tick(deadline);
    assert!(owner.view.lock().muted);
    assert_eq!(owner.microphone.lock().announcements, [true]);
    owner.close();
    Ok(())
}

#[test]
fn concurrent_commands_and_a_replacement_owner_cannot_be_reversed_by_old_deadlines()
-> Result<(), &'static str> {
    let (owner, _commands) = playback_owner_with_commands()?;
    std::thread::scope(|scope| {
        let mute = scope.spawn(|| owner.set_microphone(true, Some(Duration::from_secs(60))));
        let unmute = scope.spawn(|| owner.set_microphone(false, None));
        mute.join().map_err(|_| "Mute worker panicked")??;
        unmute.join().map_err(|_| "Unmute worker panicked")??;
        Ok::<(), &'static str>(())
    })?;
    // Whichever concurrent command won, this later explicit command owns intent.
    owner.set_microphone(true, Some(Duration::from_secs(600)))?;
    let deadline = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
    let (replacement, _replacement_commands) = playback_owner_with_commands()?;
    owner.microphone_tick(deadline);
    assert!(owner.view.lock().muted);
    assert!(!replacement.view.lock().muted);
    assert!(owner.microphone.lock().deadline.is_none());
    owner.close();
    replacement.close();
    Ok(())
}

#[test]
fn an_inactive_session_cancels_expiry_without_reactivating_capture() -> Result<(), &'static str> {
    let (owner, _commands) = playback_owner_with_commands()?;
    owner.set_microphone(true, Some(Duration::from_secs(60)))?;
    let deadline = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
    owner.ready.store(false, Ordering::Release);
    owner.microphone_tick(deadline);
    assert!(owner.view.lock().muted);
    assert!(!owner.input.accepts(owner.input.generation()));
    owner.ready.store(true, Ordering::Release);
    owner.microphone_tick(deadline + Duration::from_secs(600));
    assert!(owner.view.lock().muted);
    owner.close();
    Ok(())
}

#[test]
fn backend_announcements_keep_capture_suppressed_until_playback_and_the_device_tail_finish()
-> Result<(), &'static str> {
    let (owner, _commands) = playback_owner_with_commands()?;
    owner.set_microphone(true, None)?;
    owner.set_microphone(false, None)?;
    let now = Instant::now();
    let generation = owner.input.generation();
    assert!(owner.capture(&[1000; 480], generation, now));
    assert_eq!(owner.input.diagnostics().0, 0);
    let mut state = owner.microphone.lock();
    let muted = state
        .announcement(owner.speech.id())
        .ok_or("Missing announcement")?;
    assert_eq!(muted["text"], "Muted");
    assert_eq!(muted["lease"], owner.speech.id());
    assert_eq!(state.announcement(owner.speech.id()), Some(muted.clone()));
    let id = muted["id"]
        .as_u64()
        .ok_or("Missing announcement identity")?;
    state.announcement_finished(id, now);
    let unmuted = state
        .announcement(owner.speech.id())
        .ok_or("Missing unmute announcement")?;
    assert_eq!(unmuted["text"], "Unmuted");
    state.announcement_finished(id, now); // Old completion cannot consume its successor.
    assert_eq!(state.announcement(owner.speech.id()), Some(unmuted.clone()));
    assert!(state.blocks_capture(now + OUTPUT_TAIL)); // Synthesis may still be running.
    state.announcement_finished(unmuted["id"].as_u64().ok_or("Missing identity")?, now);
    assert!(state.blocks_capture(now));
    assert!(!state.blocks_capture(now + OUTPUT_TAIL));
    drop(state);
    owner.close();
    Ok(())
}

#[test]
fn cancelled_announcement_callbacks_cannot_consume_speech_for_a_new_transition()
-> Result<(), &'static str> {
    let (owner, _commands) = playback_owner_with_commands()?;
    owner.set_microphone(true, None)?;
    let old = owner.microphone.lock().announcement_id;
    owner.microphone.lock().cancel();
    owner.set_microphone(false, None)?;
    let mut state = owner.microphone.lock();
    state.announcement_finished(old, Instant::now());
    assert_eq!(
        state
            .announcement(owner.speech.id())
            .ok_or("Missing speech")?["text"],
        "Unmuted"
    );
    drop(state);
    owner.close();
    Ok(())
}
