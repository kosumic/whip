use super::*;

fn echo_only() -> Result<Processor> {
    let mut processor = Processor::new()?;
    processor.apm.apply_config(sonora::Config {
        echo_canceller: Some(EchoCanceller::default()),
        ..Default::default()
    });
    Ok(processor)
}

#[test]
fn rendered_reference_cancels_delayed_echo_without_using_noise_suppression() -> Result<()> {
    let mut reference = echo_only()?;
    let mut control = echo_only()?;
    let start = Instant::now() + Duration::from_millis(100);
    let mut history = VecDeque::from(vec![[0_i16; PCM_BLOCK]; 11]);
    let mut seed = 1_u32;
    let mut energies = [0_f64; 2];
    for frame in 0..1500 {
        let now = start + Duration::from_millis(frame * 10);
        let mut render = [0_i16; PCM_BLOCK];
        for sample in &mut render {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let bytes = seed.to_le_bytes();
            *sample = i16::from_le_bytes([bytes[2], bytes[3]]) / 8;
        }
        history.push_back(render);
        let delayed = history.pop_front().ok_or(INVALID_AUDIO)?;
        let capture: Vec<_> = delayed.iter().map(|sample| sample / 2).collect();
        reference.render_at(now + Duration::from_millis(40), &render, now)?;
        control.render_delay = reference.render_delay;
        for (processor, energy) in [&mut reference, &mut control]
            .into_iter()
            .zip(&mut energies)
        {
            let at = now
                .checked_sub(Duration::from_millis(20))
                .ok_or(INVALID_AUDIO)?;
            let cleaned = processor.capture(at, &capture, now)?;
            if frame > 1000 {
                *energy += cleaned.iter().map(|&v| f64::from(v).powi(2)).sum::<f64>();
            }
        }
    }
    assert!(energies[1] > 1.0, "control must contain the echo");
    assert!(
        energies[0] < energies[1] / 10.0,
        "playback reference must suppress echo by at least 10 dB: {energies:?}"
    );
    Ok(())
}

#[test]
fn near_end_speech_survives_when_speaker_is_silent() -> Result<()> {
    let mut processor = Processor::new()?;
    let start = Instant::now() + Duration::from_millis(100);
    let mut energy = 0_f64;
    for frame in 0..100 {
        let now = start + Duration::from_millis(frame * 10);
        let capture: Vec<_> = (0..PCM_BLOCK)
            .map(|index| {
                if (index / 12).is_multiple_of(2) {
                    3000
                } else {
                    -3000
                }
            })
            .collect();
        processor.render_at(now + Duration::from_millis(40), &[0; PCM_BLOCK], now)?;
        let at = now
            .checked_sub(Duration::from_millis(20))
            .ok_or(INVALID_AUDIO)?;
        let cleaned = processor.capture(at, &capture, now)?;
        energy += cleaned.iter().map(|&v| f64::from(v).powi(2)).sum::<f64>();
    }
    assert!(
        energy
            > f64::from(u32::try_from(100 * PCM_BLOCK).map_err(|_| INVALID_AUDIO)?)
                * 3000_f64.powi(2)
                / 10.0,
        "near-end speech must remain audible in the first second without warmup"
    );
    Ok(())
}

#[test]
fn mute_reset_rejects_pre_unmute_audio_and_partial_history() -> Result<()> {
    let mut processor = Processor::new()?;
    let at = Instant::now();
    processor.capture(at, &[2000; PCM_BLOCK / 2], at)?;
    processor.reset()?;
    assert!(
        processor
            .capture(at, &[2000; PCM_BLOCK], Instant::now())?
            .is_empty()
    );
    assert!(processor.capture.input.is_empty());
    assert!(processor.capture.output.is_empty());
    assert!(processor.output.input.is_empty());
    assert!(processor.output.output.is_empty());
    Ok(())
}

#[test]
fn late_capture_is_rejected_and_render_reset_keeps_capture_history() -> Result<()> {
    let mut processor = Processor::new()?;
    let at = Instant::now() + Duration::from_millis(20);
    processor.capture(at, &[2000; PCM_BLOCK / 2], at)?;
    let pending = processor.capture.input.len();
    processor.render_at(at, &[1000; PCM_BLOCK], at)?;
    processor.reset_render();
    assert_eq!(processor.capture.input.len(), pending);
    assert!(processor.render.input.is_empty());
    assert!(processor.render.output.is_empty());
    assert_eq!(
        processor.capture(at, &[1000; PCM_BLOCK * 2], at + Duration::from_secs(1)),
        Err(PROCESSING_LATE)
    );
    Ok(())
}
