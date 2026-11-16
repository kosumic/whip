use super::*;
use crate::realtime_voice::{ffi, playback_owner_with_commands};
use voice_call_media::Capture;
use voice_call_openai::session::Audio;

#[test]
fn interruption_preserves_call_and_mute_for_both_providers() -> Result<(), &'static str> {
    for live in [false, true] {
        for muted in [false, true] {
            let (mut owner, mut commands) = playback_owner_with_commands()?;
            std::sync::Arc::get_mut(&mut owner)
                .ok_or("Shared owner")?
                .live = live;
            owner.set_microphone(muted, None)?;
            while commands.try_recv().is_ok() {}
            let generation = owner.input.generation();
            owner.suspend_audio();
            owner.suspend_audio();
            assert!(!owner.closed.load(Ordering::Acquire));
            assert!(!owner.capture_enabled());
            assert!(matches!(commands.try_recv(), Ok(Command::SuspendAudio)));
            assert!(commands.try_recv().is_err());
            assert_eq!(
                ffi::snapshot(&owner).ok_or("Snapshot")?["phase"],
                "suspended"
            );
            assert!(owner.capture(&[1; 480], generation, Instant::now()));
            assert!(!owner.input.accepts(generation));
            owner.resume_audio();
            owner.resume_audio();
            assert_eq!(owner.microphone.lock().muted, muted);
            assert_eq!(owner.capture_enabled(), !muted);
            assert!(!owner.input.accepts(generation));
            owner.close();
        }
    }
    Ok(())
}

#[test]
fn recovery_preserves_provider_mute_acknowledgement_gate() -> Result<(), &'static str> {
    let (owner, _commands) = playback_owner_with_commands()?;
    Audio::set_muted(&*owner, true)?;
    owner.suspend_audio();
    owner.resume_audio();
    assert!(!owner.input.accepts(owner.input.generation()));
    Audio::set_muted(&*owner, false)?;
    assert!(owner.input.accepts(owner.input.generation()));
    owner.close();
    Ok(())
}

#[test]
fn startup_and_provider_rotation_are_not_activated_by_focus_gain() -> Result<(), &'static str> {
    let (owner, _commands) = playback_owner_with_commands()?;
    owner.ready.store(false, Ordering::Release);
    owner.suspend_audio();
    owner.resume_audio();
    assert!(!owner.capture_enabled());
    owner.ready.store(true, Ordering::Release);
    owner.suspend_audio();
    owner.retire_session();
    owner.resume_audio();
    assert!(!owner.capture_enabled());
    assert!(!owner.input.accepts(owner.input.generation()));
    owner.close();
    Ok(())
}

#[test]
fn hangup_or_failure_wins_over_late_focus_gain() -> Result<(), &'static str> {
    for fail in [false, true] {
        let (owner, _commands) = playback_owner_with_commands()?;
        owner.suspend_audio();
        if fail {
            owner.fail_native("The audio output was disconnected.");
        } else {
            owner.close();
        }
        owner.resume_audio();
        assert!(owner.closed.load(Ordering::Acquire));
        assert!(!owner.capture_enabled());
        assert_eq!(
            ffi::snapshot(&owner).ok_or("Snapshot")?["phase"],
            if fail { "error" } else { "closed" }
        );
    }
    Ok(())
}

#[test]
fn interrupted_playback_cannot_replay_on_recovery() -> Result<(), &'static str> {
    let (owner, _commands) = playback_owner_with_commands()?;
    Audio::render_pcm(&*owner, "reply".into(), 0, vec![1; 960])?;
    owner.suspend_audio();
    assert_eq!(owner.read_output(&mut [0; 480]).1, 0);
    Audio::render_pcm(&*owner, "late".into(), 0, vec![2; 960])?;
    owner.resume_audio();
    assert_eq!(owner.read_output(&mut [0; 480]).1, 0);
    owner.close();
    Ok(())
}

#[test]
fn recovery_deadline_is_not_extended_by_duplicate_loss() -> Result<(), &'static str> {
    let (owner, _commands) = playback_owner_with_commands()?;
    owner.suspend_audio();
    let since = owner.interruption.lock().ok_or("Missing interruption")?;
    owner.suspend_audio();
    owner.interruption_tick(since + RECOVERY_TIMEOUT - Duration::from_millis(1));
    assert!(!owner.closed.load(Ordering::Acquire));
    owner.interruption_tick(since + RECOVERY_TIMEOUT);
    assert!(owner.closed.load(Ordering::Acquire));
    assert_eq!(ffi::snapshot(&owner).ok_or("Snapshot")?["phase"], "error");
    owner.resume_audio();
    assert!(!owner.capture_enabled());
    Ok(())
}
