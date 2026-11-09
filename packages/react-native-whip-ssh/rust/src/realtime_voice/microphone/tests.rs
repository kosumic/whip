use super::*;
use crate::realtime_voice::playback_owner_with_commands;
use voice_call_openai::session::Audio;

mod provider;

fn owner(
    live: bool,
) -> Result<
    (
        std::sync::Arc<RealtimeVoiceAdapter>,
        tokio::sync::mpsc::Receiver<crate::realtime_voice::Command>,
    ),
    &'static str,
> {
    let (mut owner, commands) = playback_owner_with_commands()?;
    std::sync::Arc::get_mut(&mut owner)
        .ok_or("Shared test owner")?
        .live = live;
    Ok((owner, commands))
}

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
fn hangup_and_permanent_failures_never_allow_an_old_timer_to_unmute() -> Result<(), &'static str> {
    for live in [false, true] {
        for end in [
            RealtimeVoiceAdapter::close,
            |owner: &RealtimeVoiceAdapter| owner.fail("Interrupted"),
        ] {
            let (owner, _commands) = owner(live)?;
            owner.set_microphone(true, Some(Duration::from_secs(60)))?;
            let deadline = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
            owner.retire_session();
            end(&owner);
            owner.microphone_tick(deadline);
            assert!(owner.view.lock().muted);
            assert!(owner.microphone.lock().deadline.is_none());
            assert!(owner.microphone.lock().announcements.is_empty());
            owner.close();
        }
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
fn reconnect_and_rotation_preserve_the_absolute_deadline_and_transition_speech()
-> Result<(), &'static str> {
    use crate::realtime_voice::recovery;
    use voice_call_openai::continuity::Reason;

    for live in [false, true] {
        let (owner, _commands) = owner(live)?;
        owner.set_microphone(true, Some(Duration::from_secs(600)))?;
        let deadline = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
        for reason in [Reason::ConnectionLost, Reason::Lifetime] {
            owner.retiring.store(false, Ordering::Release);
            let attempt = recovery::Attempt::new(owner.clone());
            attempt.activate().map_err(|failure| failure.message)?;
            if reason == Reason::ConnectionLost {
                attempt.fail(recovery::Failure {
                    message: "Voice network connection did not recover.",
                    retryable: true,
                });
            } else {
                owner.recovering(reason);
            }
            owner.retire_session();
            assert_eq!(owner.microphone.lock().deadline, Some(deadline));
            assert!(owner.speech.is_current());
            assert!(!owner.input.accepts(owner.input.generation()));
            owner.retiring.store(false, Ordering::Release);
            owner.ready.store(true, Ordering::Release);
            owner.view.lock().phase = "muted";
            owner.microphone_tick(
                deadline
                    .checked_sub(Duration::from_millis(1))
                    .ok_or("Invalid deadline")?,
            );
            assert!(owner.view.lock().muted);
            assert_eq!(owner.microphone.lock().deadline, Some(deadline));
        }
        owner.microphone_tick(deadline);
        assert!(!owner.view.lock().muted);
        assert_eq!(owner.microphone.lock().announcements, [true, false]);
        assert!(owner.microphone.lock().deadline.is_none());
        // Realtime resumes immediately; GPT-Live still needs its provider ack.
        assert_eq!(owner.input.accepts(owner.input.generation()), !live);
        owner.microphone_tick(deadline + Duration::from_secs(600));
        assert_eq!(owner.microphone.lock().announcements, [true, false]);
        owner.close();
    }
    Ok(())
}

#[test]
fn expiry_waits_through_provider_retirement_and_startup_until_ready() -> Result<(), &'static str> {
    for live in [false, true] {
        let (owner, _commands) = owner(live)?;
        owner.set_microphone(true, Some(Duration::from_secs(60)))?;
        let deadline = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
        // Complete the original mute announcement before the outage.
        let id = owner.microphone.lock().announcement_id;
        owner
            .microphone
            .lock()
            .announcement_finished(id, Instant::now());
        owner.retire_session();
        for retiring in [true, false] {
            owner.retiring.store(retiring, Ordering::Release);
            owner.microphone_tick(deadline);
            assert!(owner.view.lock().muted);
            assert_eq!(owner.microphone.lock().deadline, Some(deadline));
            assert!(owner.microphone.lock().announcements.is_empty());
            assert!(!owner.input.accepts(owner.input.generation()));
        }
        owner.ready.store(true, Ordering::Release);
        owner.view.lock().phase = "muted";
        owner.microphone_tick(deadline + Duration::from_secs(600));
        assert!(!owner.view.lock().muted);
        assert_eq!(owner.microphone.lock().announcements, [false]);
        assert_eq!(owner.input.accepts(owner.input.generation()), !live);
        owner.microphone_tick(deadline + Duration::from_secs(601));
        assert_eq!(owner.microphone.lock().announcements, [false]);
        owner.close();
    }
    Ok(())
}

#[test]
fn recovery_controls_replace_expired_deadlines_without_reopening_inactive_capture()
-> Result<(), &'static str> {
    for live in [false, true] {
        for muted in [true, false] {
            let (owner, _commands) = owner(live)?;
            owner.set_microphone(true, Some(Duration::from_secs(60)))?;
            let deadline = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
            owner.retire_session();
            owner.microphone_tick(deadline);
            owner.set_microphone(muted, None)?;
            assert!(owner.microphone.lock().deadline.is_none());
            assert!(!owner.input.accepts(owner.input.generation()));
            assert!(
                owner
                    .set_microphone(true, Some(Duration::from_secs(60)))
                    .is_err()
            );
            // A delayed command must not republish intent over a later control.
            owner.command(crate::realtime_voice::Command::Mute(!muted));
            assert_eq!(owner.view.lock().muted, muted);
            owner.retiring.store(false, Ordering::Release);
            owner.ready.store(true, Ordering::Release);
            owner.set_muted(muted)?; // Replacement session's startup synchronization.
            owner.microphone_tick(deadline + Duration::from_secs(600));
            assert_eq!(owner.view.lock().muted, muted);
            assert_eq!(owner.input.accepts(owner.input.generation()), !muted);
            if muted {
                owner.set_muted(false)?; // Old unmute acknowledgement cannot win.
                assert!(!owner.input.accepts(owner.input.generation()));
            }
            owner.close();
        }
    }
    Ok(())
}

#[test]
fn revoked_credentials_cancel_the_deadline_even_during_recovery() -> Result<(), &'static str> {
    let (mut owner, _commands) = owner(false)?;
    owner.set_microphone(true, Some(Duration::from_secs(60)))?;
    let deadline = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
    owner.retire_session();
    std::sync::Arc::get_mut(&mut owner)
        .ok_or("Shared test owner")?
        .credential_generation = crate::voice_credentials::generation().wrapping_sub(1);
    owner.microphone_tick(deadline);
    assert!(owner.microphone.lock().deadline.is_none());
    assert!(owner.microphone.lock().announcements.is_empty());
    assert!(owner.view.lock().muted);
    assert!(!owner.input.accepts(owner.input.generation()));
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
