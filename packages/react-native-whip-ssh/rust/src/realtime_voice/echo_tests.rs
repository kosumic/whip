use super::echo::*;
use std::collections::{HashSet, VecDeque};
const DSP_ERROR: &str = "Echo regression failed.";
use std::time::{Duration, Instant};

const BLOCK: usize = super::RATE / 100;

fn speech(position: usize, reverse: bool) -> i16 {
    let fixture = include_bytes!("../../tests/fixtures/voice-counting-16k.f32");
    let length = fixture.len() / 4;
    let index = position * 2 / 3 % length;
    let offset = if reverse { length - 1 - index } else { index } * 4;
    let bytes = [
        fixture[offset],
        fixture[offset + 1],
        fixture[offset + 2],
        fixture[offset + 3],
    ];
    #[expect(
        clippy::cast_possible_truncation,
        reason = "bounded normalized fixture converted to PCM16"
    )]
    {
        (f32::from_le_bytes(bytes).clamp(-1.0, 1.0) * 20_000.0) as i16
    }
}

fn energy(samples: &[i16]) -> f64 {
    samples.iter().map(|&v| f64::from(v).powi(2)).sum()
}

fn assert_speech_level(actual: &[i16], expected: &[i16]) {
    let actual_power = energy(actual);
    let expected_power = energy(expected);
    assert!(expected_power > 1.0, "speech control must be audible");
    assert!(
        actual_power > expected_power / 4.0 && actual_power < expected_power * 4.0,
        "near-end speech level must stay within 6 dB of the clean control: {actual_power} / {expected_power}"
    );
}

fn assert_speech_preserved(actual: &[i16], expected: &[i16]) {
    assert_eq!(actual.len(), expected.len());
    assert_speech_level(actual, expected);
    let dot: f64 = actual
        .iter()
        .zip(expected)
        .map(|(&a, &b)| f64::from(a) * f64::from(b))
        .sum();
    let correlation = dot / (energy(actual) * energy(expected)).sqrt();
    assert!(
        correlation > 0.75,
        "output must preserve the real speech waveform, not just noise energy: {correlation}"
    );
}

#[test]
fn local_cue_reference_is_independent_of_assistant_playback_classification()
-> Result<(), &'static str> {
    let mut mixed = MediaEchoCanceller::new()?;
    let mut control = MediaEchoCanceller::new()?;
    let cue = super::cue::load(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../assets/audio/voice-ready.wav"
    ))?;
    let start = Instant::now() + Duration::from_millis(100);
    let mut actual = Vec::new();
    let mut expected = Vec::new();
    for frame in 0..150 {
        let at = start + Duration::from_millis(u64::try_from(frame).map_err(|_| DSP_ERROR)? * 10);
        let device: Vec<_> = (0..BLOCK)
            .map(|i| cue.get(frame * BLOCK + i).copied().unwrap_or(0) / 2)
            .collect();
        // Hardware may accept only part of the mixed PCM in each write.
        for (index, samples) in device.chunks(BLOCK / 2).enumerate() {
            let delay = 40 + u64::try_from(index).map_err(|_| DSP_ERROR)? * 5;
            mixed.submit_render(1, at + Duration::from_millis(delay), samples, false)?;
        }
        control.submit_render(1, at + Duration::from_millis(40), &device, true)?;
        assert_eq!(mixed.played(1, (frame + 1) * BLOCK), 0);
        assert_eq!(control.played(1, (frame + 1) * BLOCK), (frame + 1) * BLOCK);
        let capture: Vec<_> = (0..BLOCK)
            .map(|i| speech(frame * BLOCK + i, false))
            .collect();
        let captured_at = at.checked_sub(Duration::from_millis(20)).ok_or(DSP_ERROR)?;
        actual.extend(mixed.capture(&capture, captured_at, at)?);
        expected.extend(control.capture(&capture, captured_at, at)?);
    }
    assert!(!actual.is_empty());
    // Unlike the previous zero-reference control, both processors hear the
    // actual cue. Classifying identical PCM as cue/provider must affect only
    // playback accounting, including when the device accepts partial writes.
    assert_eq!(actual, expected);
    Ok(())
}

#[test]
fn acoustic_ready_cue_echo_is_suppressed_during_near_end_speech() -> Result<(), &'static str> {
    acoustic_cue_echo(false)
}

#[test]
fn acoustic_provider_plus_cue_echo_is_suppressed_during_near_end_speech() -> Result<(), &'static str>
{
    acoustic_cue_echo(true)
}

fn acoustic_cue_echo(provider_audio: bool) -> Result<(), &'static str> {
    let mut complete = MediaEchoCanceller::new()?;
    let mut excluded = MediaEchoCanceller::new()?;
    let mut clean_speech = MediaEchoCanceller::new()?;
    let cue_samples = super::cue::load(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../assets/audio/voice-ready.wav"
    ))?;
    let mut cue = super::cue::Cue::default();
    let mut cue_generation = 0;
    let start = Instant::now() + Duration::from_millis(100);
    let mut history = VecDeque::from(vec![[0_i16; BLOCK]; 11]);
    let mut powers = [0.0; 3];
    let mut actual_speech = Vec::new();
    let mut expected_speech = Vec::new();
    let mut delivered = 0;
    for frame in 0..650 {
        let at = start + Duration::from_millis(u64::try_from(frame).map_err(|_| DSP_ERROR)? * 10);
        // Retiring a reply changes accounting epochs, not the acoustic path:
        // already written cue/provider PCM can still reach the microphone.
        let epoch = u64::try_from(frame / 100 + 1).map_err(|_| DSP_ERROR)?;
        // Repeated cues give the adaptive canceller a stable synthetic path.
        // This is not a claim about a single startup cue on a physical phone.
        if !cue.playing(cue_generation) {
            cue_generation = cue.begin();
            assert!(cue.load(cue_generation, cue_samples.clone()));
        }
        let provider = std::array::from_fn::<_, BLOCK, _>(|i| {
            if provider_audio {
                speech(frame * BLOCK + i, true) / 2
            } else {
                0
            }
        });
        let mut render = provider;
        cue.mix(&mut render);
        history.push_back(render);
        let delayed = history.pop_front().ok_or(DSP_ERROR)?;
        let near = std::array::from_fn::<_, BLOCK, _>(|i| {
            if (400..650).contains(&frame) {
                speech((frame - 400) * BLOCK + i, false)
            } else {
                0
            }
        });
        let capture: Vec<_> = delayed
            .iter()
            .zip(near)
            .map(|(&v, n)| n.saturating_add(v / 2))
            .collect();
        // Non-frame-aligned partial writes exercise device timing and PCM
        // buffering. Only accepted samples, with the cue already mixed, count.
        let mut offset = 0;
        for count in [73, BLOCK - 73] {
            let scheduled = at
                + Duration::from_millis(40)
                + Duration::from_micros(
                    u64::try_from(offset).map_err(|_| DSP_ERROR)? * 1_000_000
                        / u64::try_from(super::RATE).map_err(|_| DSP_ERROR)?,
                );
            complete.submit_render(
                epoch,
                scheduled,
                &render[offset..offset + count],
                provider_audio,
            )?;
            // Negative control reproduces the old omission of cue PCM.
            excluded.submit_render(
                epoch,
                scheduled,
                &provider[offset..offset + count],
                provider_audio,
            )?;
            offset += count;
        }
        clean_speech.submit_render(epoch, at + Duration::from_millis(40), &[0; BLOCK], false)?;
        let position = (frame % 100 + 1) * BLOCK;
        assert_eq!(
            complete.played(epoch, position),
            if provider_audio { position } else { 0 }
        );
        excluded.played(epoch, position);
        clean_speech.played(epoch, position);
        let captured_at = at.checked_sub(Duration::from_millis(20)).ok_or(DSP_ERROR)?;
        let cleaned = complete.capture(&capture, captured_at, at)?;
        let missing_cue = excluded.capture(&capture, captured_at, at)?;
        let expected = clean_speech.capture(&near, captured_at, at)?;
        if (200..400).contains(&frame) {
            powers[0] += energy(&capture);
            powers[1] += energy(&cleaned);
            powers[2] += energy(&missing_cue);
            delivered += cleaned.len();
        }
        if (400..650).contains(&frame) {
            actual_speech.extend(cleaned);
            expected_speech.extend(expected);
        }
    }
    assert!(
        powers[0] > 1.0 && powers[2] > 1.0,
        "controls must contain acoustic echo"
    );
    assert!(
        delivered >= 200 * BLOCK * 95 / 100,
        "AEC must deliver microphone audio"
    );
    assert!(
        powers[1] < powers[0] / 10.0 && powers[1] < powers[2] / 10.0,
        "complete reference must suppress acoustic echo by at least 10 dB vs raw and missing cue: {powers:?}"
    );
    // Bound the overall speech level including double-talk onset, then check
    // waveform preservation after one second of AEC/AGC transition. Startup
    // transparency and single-cue/first-word intelligibility need device tests.
    assert_speech_level(&actual_speech, &expected_speech);
    assert_speech_preserved(
        &actual_speech[super::RATE..],
        &expected_speech[super::RATE..],
    );
    Ok(())
}

#[test]
fn cue_reference_preserves_caption_and_truncation_accounting_across_mute_and_cancel()
-> Result<(), Box<dyn std::error::Error>> {
    let mut echo = MediaEchoCanceller::new()?;
    let mut output = super::Output::default();
    let event = serde_json::from_value(serde_json::json!({
        "type": "response.output_audio_transcript.delta", "event_id": "text",
        "response_id": "response", "item_id": "reply", "output_index": 0,
        "content_index": 0, "delta": "Hello world"
    }))?;
    output.transcript.observe(&event, &HashSet::default());
    output.append("reply".into(), 0, vec![0; super::RATE * 2])?;
    let epoch = output.epoch;
    let mut cue = super::cue::Cue::default();
    let generation = cue.begin();
    assert!(cue.load(generation, vec![2000; super::RATE * 2]));
    let at = Instant::now() + Duration::from_millis(100);

    // Cue plays while an assistant reply is still waiting to be read.
    let mut cue_only = vec![0; super::RATE / 2];
    cue.mix(&mut cue_only);
    echo.submit_render(epoch, at, &cue_only, false)?;
    output.acknowledge(epoch, echo.played(epoch, cue_only.len()));
    assert_eq!(output.played, 0);
    assert_eq!(output.transcript.snapshot()[0].spoken_utf16, 0);

    let mut device = vec![0; super::RATE];
    assert_eq!(output.read(&mut device), device.len());
    cue.mix(&mut device);
    // Only a quarter-second reaches AudioTrack before mute/cancellation. The
    // mixed but unwritten suffix must never count as played assistant speech.
    let accepted = super::RATE / 4;
    echo.submit_render(
        epoch,
        at + Duration::from_millis(500),
        &device[..accepted],
        true,
    )?;
    echo.reset_capture()?; // Muting resets DSP, not the device playback clock.
    output.acknowledge(epoch, echo.played(epoch, cue_only.len() + accepted / 2));
    assert_eq!(output.played, accepted / 2);
    output.acknowledge(epoch, echo.played(epoch, cue_only.len() + accepted));
    assert_eq!(output.played, accepted);
    let spoken = output.transcript.snapshot()[0].spoken_utf16;
    assert!(spoken > 0 && spoken < "Hello world".len());
    assert!(matches!(
        output.interrupt(),
        Some(super::ClientEvent::ConversationItemTruncate {
            audio_end_ms: 250,
            ..
        })
    ));
    let frozen = output.transcript.snapshot()[0].spoken_utf16;
    assert!(frozen >= spoken && frozen <= "Hello world".len());

    // Cancellation changes the device epoch. An old completion cannot advance
    // the replacement, even after it has queued cue-only device output.
    output.append("next".into(), 0, vec![0; super::FRAME * 2])?;
    echo.submit_render(output.epoch, at, &cue_only[..BLOCK], false)?;
    output.acknowledge(epoch, echo.played(epoch, usize::MAX));
    output.acknowledge(output.epoch, echo.played(output.epoch, BLOCK));
    assert_eq!(output.played, 0);
    assert_eq!(output.transcript.snapshot()[0].spoken_utf16, frozen);
    Ok(())
}

#[test]
fn queued_speaker_echo_stays_suppressed_across_reply_boundaries() -> Result<(), &'static str> {
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
