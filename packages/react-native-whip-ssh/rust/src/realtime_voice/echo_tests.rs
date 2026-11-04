use super::*;
use std::time::{Duration, Instant};

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
