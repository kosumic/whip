// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
//! Port of Codex voice-host/src/processing.rs at f2b94ef8b52196f127d162c6db71e390b9bb265c.
//! Android supplies device timestamps instead of CPAL callbacks. The public
//! WebSocket transport takes PCM24 rather than the helper's Opus packets.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use rubato::Resampler;
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use sonora::config::{AdaptiveDigital, EchoCanceller, GainController2, NoiseSuppression};
use sonora::{AudioProcessing, StreamConfig};

const RATE: u32 = 48_000;
const BLOCK: usize = 480;
const PCM_BLOCK: usize = super::RATE / 100;
pub const MAX_DELAY: Duration = Duration::from_millis(500);
pub const PROCESSING_LATE: &str = "Realtime audio processing fell behind.";
const INVALID_AUDIO: &str = "Realtime audio processing received invalid samples or timing.";
type Result<T> = std::result::Result<T, &'static str>;

fn duration(samples: usize, rate: u32) -> Duration {
    Duration::from_secs_f64(f64::from(u32::try_from(samples).unwrap_or(u32::MAX)) / f64::from(rate))
}

struct Converter {
    resampler: rubato::Async<f32>,
    input: VecDeque<f32>,
    output: VecDeque<f32>,
    scratch: Vec<f32>,
    rate: u32,
    target: u32,
    end: Option<Instant>,
}
impl Converter {
    fn new(rate: u32, target: u32) -> Result<Self> {
        let resampler = rubato::Async::new_sinc(
            f64::from(target) / f64::from(rate),
            1.0,
            &rubato::SincInterpolationParameters::default(),
            usize::try_from(rate.div_ceil(100)).map_err(|_| INVALID_AUDIO)?,
            1,
            rubato::FixedAsync::Input,
        )
        .map_err(|_| "Realtime audio resampler could not start.")?;
        let scratch = vec![0.0; resampler.output_frames_max()];
        Ok(Self {
            resampler,
            input: VecDeque::new(),
            output: VecDeque::new(),
            scratch,
            rate,
            target,
            end: None,
        })
    }
    fn push(&mut self, at: Instant, samples: &[f32]) -> Result<()> {
        if self.input.len() + samples.len() > self.rate as usize
            || self.output.len() > self.target as usize
            || samples.iter().any(|v| !v.is_finite())
        {
            return Err(INVALID_AUDIO);
        }
        self.end = Some(at + duration(samples.len(), self.rate));
        self.input.extend(samples);
        while self.input.len() >= self.resampler.input_frames_next() {
            let samples = self.input.make_contiguous();
            let input =
                InterleavedSlice::new(samples, 1, samples.len()).map_err(|_| INVALID_AUDIO)?;
            let capacity = self.scratch.len();
            let mut output = InterleavedSlice::new_mut(&mut self.scratch, 1, capacity)
                .map_err(|_| INVALID_AUDIO)?;
            let (consumed, produced) = self
                .resampler
                .process_into_buffer(&input, &mut output, None)
                .map_err(|_| INVALID_AUDIO)?;
            self.input.drain(..consumed);
            self.output.extend(&self.scratch[..produced]);
        }
        Ok(())
    }
    fn next<const N: usize>(&mut self) -> Option<(Instant, [f32; N])> {
        if self.output.len() < N {
            return None;
        }
        let delay = duration(self.input.len(), self.rate)
            + duration(
                self.output.len() + self.resampler.output_delay(),
                self.target,
            );
        let end = self.end?;
        let at = end.checked_sub(delay).unwrap_or(end);
        let mut output = [0.0; N];
        for (out, sample) in output.iter_mut().zip(self.output.drain(..N)) {
            *out = sample;
        }
        Some((at, output))
    }
    fn reset(&mut self) {
        self.resampler.reset();
        self.input.clear();
        self.output.clear();
        self.end = None;
    }
}

pub struct Processor {
    capture: Converter,
    render: Converter,
    output: Converter,
    apm: AudioProcessing,
    cutoff: Instant,
    render_delay: i64,
}
impl Processor {
    pub fn new() -> Result<Self> {
        let device_rate = u32::try_from(super::RATE).map_err(|_| INVALID_AUDIO)?;
        Ok(Self {
            capture: Converter::new(device_rate, RATE)?,
            render: Converter::new(device_rate, RATE)?,
            output: Converter::new(RATE, device_rate)?,
            apm: AudioProcessing::builder()
                .config(sonora::Config {
                    echo_canceller: Some(EchoCanceller::default()),
                    noise_suppression: Some(NoiseSuppression::default()),
                    gain_controller2: Some(GainController2 {
                        adaptive_digital: Some(AdaptiveDigital::default()),
                        ..Default::default()
                    }),
                    ..Default::default()
                })
                .capture_config(StreamConfig::new(RATE, 1))
                .render_config(StreamConfig::new(RATE, 1))
                .build(),
            cutoff: Instant::now(),
            render_delay: 0,
        })
    }
    pub fn reset(&mut self) -> Result<()> {
        *self = Self::new()?;
        Ok(())
    }
    pub fn reset_render(&mut self) {
        self.render.reset();
        self.render_delay = 0;
    }
    pub fn render_at(&mut self, at: Instant, samples: &[i16], now: Instant) -> Result<()> {
        if now.saturating_duration_since(at) > MAX_DELAY {
            self.reset_render();
            return Ok(());
        }
        let input: Vec<_> = samples.iter().map(|&s| f32::from(s) / 32768.0).collect();
        self.render.push(at, &input)?;
        while let Some((at, input)) = self.render.next::<BLOCK>() {
            let mut output = [0.0; BLOCK];
            self.apm
                .process_render_f32(&[&input], &mut [&mut output])
                .map_err(|_| "Realtime echo reference processing failed.")?;
            self.render_delay = if at > now {
                i64::try_from(at.duration_since(now).as_millis()).map_err(|_| INVALID_AUDIO)?
            } else {
                -i64::try_from(now.duration_since(at).as_millis()).map_err(|_| INVALID_AUDIO)?
            };
        }
        Ok(())
    }
    pub fn capture(&mut self, at: Instant, samples: &[i16], now: Instant) -> Result<Vec<i16>> {
        if at < self.cutoff {
            return Ok(vec![]);
        }
        if self
            .capture
            .end
            .is_some_and(|end| at.saturating_duration_since(end) > Duration::from_millis(20))
        {
            let cutoff = self.cutoff;
            self.reset()?;
            self.cutoff = cutoff;
        }
        let input: Vec<_> = samples.iter().map(|&s| f32::from(s) / 32768.0).collect();
        self.capture.push(at, &input)?;
        let mut cleaned = Vec::new();
        while let Some((at, input)) = self.capture.next::<BLOCK>() {
            let age = now.saturating_duration_since(at);
            let delay = (i64::try_from(age.as_millis()).map_err(|_| INVALID_AUDIO)?
                + self.render_delay)
                .max(0);
            if age > MAX_DELAY
                || delay > i64::try_from(MAX_DELAY.as_millis()).map_err(|_| INVALID_AUDIO)?
            {
                return Err(PROCESSING_LATE);
            }
            self.apm
                .set_stream_delay_ms(i32::try_from(delay).map_err(|_| INVALID_AUDIO)?)
                .map_err(|_| INVALID_AUDIO)?;
            let mut output = [0.0; BLOCK];
            self.apm
                .process_capture_f32(&[&input], &mut [&mut output])
                .map_err(|_| "Realtime microphone processing failed.")?;
            self.output.push(at, &output)?;
            while let Some((_, pcm)) = self.output.next::<PCM_BLOCK>() {
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "normalized DSP output is explicitly clipped to PCM16"
                )]
                cleaned.extend(pcm.iter().map(|sample| {
                    (sample * 32768.0)
                        .round()
                        .clamp(f32::from(i16::MIN), f32::from(i16::MAX)) as i16
                }));
            }
        }
        Ok(cleaned)
    }
}

#[cfg(test)]
#[path = "processing_tests.rs"]
mod tests;
