use super::*;
use crate::realtime_voice::{FRAME, Output};

fn identity(owner: &RealtimeVoiceAdapter) -> u64 {
    owner.microphone.lock().announcement_id
}

#[test]
fn cue_waits_for_whole_item_and_actual_device_tail_then_serializes_the_next_item()
-> Result<(), &'static str> {
    let (owner, _commands) = owner(false)?;
    owner.render_pcm("one".into(), 0, vec![1; FRAME * 4])?;
    owner.render_pcm("two".into(), 0, vec![2; FRAME * 2])?;
    let mut frame = [0; FRAME];
    let (epoch, count) = owner.read_output(&mut frame);
    assert_eq!(count, FRAME);
    owner.set_microphone(true, None)?;
    let id = identity(&owner);
    assert!(!owner.announcement_start(id));
    assert_eq!(owner.read_output(&mut frame).1, FRAME);
    assert_eq!(owner.read_output(&mut frame).1, 0);
    owner.output.lock().acknowledge(epoch, FRAME * 2 - 1);
    assert!(!owner.announcement_start(id));
    owner.output.lock().acknowledge(epoch, FRAME * 2);
    assert!(owner.announcement_start(id));
    assert_eq!(owner.read_output(&mut frame).1, 0);
    owner
        .microphone
        .lock()
        .announcement_finished(id, Instant::now());
    assert_eq!(owner.read_output(&mut frame).1, FRAME);
    assert!(
        frame
            .iter()
            .all(|sample| *sample == i16::from_le_bytes([2, 2]))
    );
    owner.close();
    Ok(())
}

#[test]
fn continuous_live_stream_yields_only_at_real_silence_without_dropping_next_segment()
-> Result<(), &'static str> {
    let (owner, _commands) = owner(true)?;
    let samples: Vec<i16> = [vec![1000; FRAME], vec![0; QUIET_SAMPLES], vec![2000; FRAME]].concat();
    owner.render_pcm(
        "live-stream".into(),
        0,
        samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect(),
    )?;
    owner.set_microphone(true, None)?;
    let id = identity(&owner);
    let mut frame = [0; FRAME];
    let mut heard = Vec::new();
    let epoch = loop {
        let (epoch, count) = owner.read_output(&mut frame);
        if count == 0 {
            break epoch;
        }
        heard.extend_from_slice(&frame[..count]);
    };
    assert_eq!(heard, samples[..FRAME + QUIET_SAMPLES]);
    assert!(!owner.announcement_start(id));
    owner.output.lock().acknowledge(epoch, heard.len());
    assert!(owner.announcement_start(id));
    owner
        .microphone
        .lock()
        .announcement_finished(id, Instant::now());
    assert_eq!(owner.read_output(&mut frame).1, FRAME);
    assert_eq!(frame, [2000; FRAME]);
    owner.close();
    Ok(())
}

#[test]
fn packet_gaps_and_unacknowledged_output_are_not_speech_boundaries() -> Result<(), &'static str> {
    let mut output = Output::default();
    let now = Instant::now();
    output.append("stream".into(), 0, vec![1; FRAME * 2])?;
    output.read(&mut [0; FRAME]);
    assert!(!output.at_speech_boundary(now));
    assert!(!output.at_speech_boundary(now + BOUNDARY_QUIET));
    output.acknowledge(output.epoch, FRAME);
    assert!(!output.at_speech_boundary(now));
    output.append("stream".into(), 0, vec![1; FRAME * 2])?;
    output.read(&mut [0; FRAME]);
    output.acknowledge(output.epoch, FRAME * 2);
    assert!(!output.at_speech_boundary(now + BOUNDARY_QUIET));
    assert!(output.at_speech_boundary(now + BOUNDARY_QUIET * 2));
    Ok(())
}

#[test]
fn idle_admission_holds_newly_arriving_audio_and_rejects_replaced_snapshots()
-> Result<(), &'static str> {
    let (owner, _commands) = owner(false)?;
    owner.set_microphone(true, None)?;
    let stale = identity(&owner);
    owner.read_output(&mut [0; FRAME]);
    owner.set_microphone(false, None)?;
    let current = identity(&owner);
    assert!(!owner.announcement_start(stale));
    assert!(owner.announcement_start(current));
    owner.render_pcm("new".into(), 0, vec![1; FRAME * 2])?;
    assert_eq!(owner.read_output(&mut [0; FRAME]).1, 0);
    owner
        .microphone
        .lock()
        .announcement_finished(stale, Instant::now());
    assert_eq!(owner.read_output(&mut [0; FRAME]).1, 0);
    owner
        .microphone
        .lock()
        .announcement_finished(current, Instant::now());
    assert_eq!(owner.read_output(&mut [0; FRAME]).1, FRAME);
    owner.close();
    Ok(())
}

#[test]
fn rapid_flips_coalesce_pending_intent_without_truncating_admitted_speech()
-> Result<(), &'static str> {
    let (owner, mut commands) = owner(false)?;
    owner.set_microphone(true, None)?;
    owner.read_output(&mut [0; FRAME]);
    let active = identity(&owner);
    assert!(owner.announcement_start(active));
    assert!(owner.announcement_playing(active));
    for muted in [false, true, false, false] {
        owner.set_microphone(muted, None)?;
        while commands.try_recv().is_ok() {}
    }
    assert_eq!(identity(&owner), active);
    assert_eq!(owner.microphone.lock().announcements, [true, false]);
    assert!(!owner.microphone.lock().cancelled);
    owner
        .microphone
        .lock()
        .announcement_finished(active, Instant::now());
    let next = identity(&owner);
    assert!(owner.announcement_start(next));
    owner
        .microphone
        .lock()
        .announcement_finished(active, Instant::now());
    assert!(owner.microphone.lock().active);
    owner
        .microphone
        .lock()
        .announcement_finished(next, Instant::now());
    assert!(owner.microphone.lock().announcements.is_empty());
    owner.close();
    Ok(())
}

#[test]
fn slow_synthesis_does_not_block_capture_and_superseded_preparation_cannot_become_audible()
-> Result<(), &'static str> {
    let (owner, _commands) = owner(false)?;
    owner.set_microphone(true, None)?;
    owner.set_microphone(false, None)?;
    let old = identity(&owner);
    owner.read_output(&mut [0; FRAME]);
    assert!(owner.announcement_start(old));
    assert!(!owner.microphone.lock().blocks_capture(Instant::now()));
    owner.set_microphone(true, None)?;
    owner.set_microphone(false, None)?;
    assert!(!owner.announcement_playing(old));
    assert!(owner.microphone.lock().cancelled);
    owner
        .microphone
        .lock()
        .announcement_finished(old, Instant::now());
    let current = identity(&owner);
    assert!(owner.announcement_start(current));
    assert!(!owner.microphone.lock().blocks_capture(Instant::now()));
    // A backend failure/timeout before any sound needs no echo tail.
    owner
        .microphone
        .lock()
        .announcement_finished(current, Instant::now());
    assert!(!owner.microphone.lock().blocks_capture(Instant::now()));
    owner.close();
    Ok(())
}

#[test]
fn skip_and_rotation_wait_for_native_cancellation_before_releasing_new_output()
-> Result<(), &'static str> {
    for retire in [false, true] {
        let (owner, _commands) = owner(false)?;
        owner.set_microphone(true, Some(Duration::from_secs(60)))?;
        let deadline = owner.microphone.lock().deadline;
        owner.read_output(&mut [0; FRAME]);
        let id = identity(&owner);
        assert!(owner.announcement_start(id));
        if retire {
            owner.retire_session();
        } else {
            owner.command(Command::Skip);
        }
        assert_eq!(owner.microphone.lock().deadline, deadline);
        assert!(owner.microphone.lock().cancelled);
        owner.render_pcm("replacement".into(), 0, vec![1; FRAME * 2])?;
        assert_eq!(owner.read_output(&mut [0; FRAME]).1, 0);
        owner
            .microphone
            .lock()
            .announcement_finished(id, Instant::now());
        assert_eq!(owner.read_output(&mut [0; FRAME]).1, FRAME);
        assert!(owner.microphone.lock().announcements.is_empty());
        owner.close();
    }
    Ok(())
}
