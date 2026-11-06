use super::*;
use std::time::{Duration, Instant};

#[test]
fn local_cue_playback_preserves_near_end_speech_and_partial_device_writes()
-> Result<(), &'static str> {
    const BLOCK: usize = super::super::RATE / 100;
    let mut mixed = MediaEchoCanceller::new()?;
    let mut control = MediaEchoCanceller::new()?;
    let cue = super::super::cue::load(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../assets/audio/voice-ready.wav"
    ))?;
    let speech = include_bytes!("../../tests/fixtures/voice-counting-16k.f32");
    let start = Instant::now() + Duration::from_millis(100);
    let mut actual = Vec::new();
    let mut expected = Vec::new();
    for frame in 0..150 {
        let at = start + Duration::from_millis(u64::try_from(frame).map_err(|_| DSP_ERROR)? * 10);
        let device: Vec<_> = (0..BLOCK)
            .map(|i| cue.get(frame * BLOCK + i).copied().unwrap_or(0) / 2)
            .collect();
        mixed.queue_reference(&[0; BLOCK])?;
        // Hardware may accept only part of the mixed PCM in each write.
        for (index, samples) in device.chunks(BLOCK / 2).enumerate() {
            let delay = 40 + u64::try_from(index).map_err(|_| DSP_ERROR)? * 5;
            mixed.submit_render(1, at + Duration::from_millis(delay), samples, true)?;
        }
        control.submit_render(1, at + Duration::from_millis(40), &[0; BLOCK], true)?;
        mixed.played(1, (frame + 1) * BLOCK);
        control.played(1, (frame + 1) * BLOCK);
        let capture: Vec<_> = (0..BLOCK)
            .map(|i| {
                let offset = ((frame * BLOCK + i) * 2 / 3) % (speech.len() / 4) * 4;
                let bytes = [
                    speech[offset],
                    speech[offset + 1],
                    speech[offset + 2],
                    speech[offset + 3],
                ];
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "bounded normalized fixture converted to PCM16"
                )]
                {
                    (f32::from_le_bytes(bytes).clamp(-1.0, 1.0) * 20_000.0) as i16
                }
            })
            .collect();
        let captured_at = at.checked_sub(Duration::from_millis(20)).ok_or(DSP_ERROR)?;
        actual.extend(mixed.capture(&capture, captured_at, at)?);
        expected.extend(control.capture(&capture, captured_at, at)?);
    }
    assert!(!actual.is_empty());
    assert!(
        actual == expected,
        "A local cue must not suppress or alter unrelated microphone speech"
    );
    Ok(())
}

#[test]
fn silence_in_media_track_never_counts_as_heard_assistant_audio() -> Result<(), &'static str> {
    let mut clock = PlaybackClock::default();
    clock.submit(1, 240, false)?;
    clock.submit(1, 240, true)?;
    clock.submit(1, 240, false)?;
    assert_eq!(clock.played(1, 120), 0);
    assert_eq!(clock.played(1, 360), 120);
    assert_eq!(clock.played(1, 720), 240);
    assert_eq!(clock.played(1, 240), 240);
    clock.submit(2, 240, false)?;
    assert_eq!(clock.played(1, 720), 0);
    assert_eq!(clock.played(2, 240), 0);
    Ok(())
}

#[test]
fn queued_speaker_echo_stays_suppressed_across_reply_boundaries() -> Result<(), &'static str> {
    const BLOCK: usize = super::super::RATE / 100;
    let mut echo = MediaEchoCanceller::new()?;
    let fixture: Vec<_> = include_bytes!("../../tests/fixtures/voice-counting-16k.f32")
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect();
    let start = Instant::now() + Duration::from_millis(100);
    let mut history = VecDeque::from(vec![[0_i16; BLOCK]; 11]);
    let mut energy = [0_f64; 2];
    let mut delivered = 0;
    for frame in 0..800 {
        let at = start + Duration::from_millis(frame * 10);
        let epoch = frame / 100 + 1;
        let audio = frame % 100 < 90;
        let mut render = [0_i16; BLOCK];
        if audio {
            for (index, sample) in render.iter_mut().enumerate() {
                let position =
                    (usize::try_from(frame).map_err(|_| DSP_ERROR)? * BLOCK + index) * 2 / 3;
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "normalized speech fixture is bounded PCM16"
                )]
                {
                    *sample =
                        (fixture[position % fixture.len()].clamp(-1.0, 1.0) * 20_000.0) as i16;
                }
            }
        }
        history.push_back(render);
        let capture: Vec<_> = history
            .pop_front()
            .ok_or(DSP_ERROR)?
            .iter()
            .map(|sample| sample / 2)
            .collect();
        echo.submit_render(epoch, at + Duration::from_millis(40), &render, audio)?;
        echo.played(
            epoch,
            usize::try_from(frame % 100 + 1).map_err(|_| DSP_ERROR)? * BLOCK,
        );
        // Simulate references waiting for a delayed microphone consumer, as on
        // a busy phone. Only device audio is present; there is no user speech.
        let cleaned = echo.capture(
            &capture,
            at.checked_sub(Duration::from_millis(20)).ok_or(DSP_ERROR)?,
            at + Duration::from_millis(450),
        )?;
        if frame >= 300 {
            delivered += cleaned.len();
            energy[0] += capture.iter().map(|&v| f64::from(v).powi(2)).sum::<f64>();
            energy[1] += cleaned.iter().map(|&v| f64::from(v).powi(2)).sum::<f64>();
        }
    }
    assert!(energy[0] > 1.0, "fixture must contain speaker echo");
    assert!(
        delivered >= 500 * BLOCK * 95 / 100,
        "fresh microphone audio must survive delayed reference processing"
    );
    assert!(
        energy[1] < energy[0] / 10.0,
        "speaker echo must remain suppressed across replies: {energy:?}"
    );
    Ok(())
}
