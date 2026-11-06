//! Call-owned AEC3. Only audio submitted to the media device is a render reference.
use serde::Serialize;
use std::collections::VecDeque;

const MAX_SPANS: usize = 128;
const MAX_RENDER_SAMPLES: usize = super::RATE / 2;
const SMOOTHING: f64 = 0.1;
const DSP_ERROR: &str = "Realtime echo cancellation could not process device audio.";

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Signal {
    raw_rms: f64,
    processed_rms: f64,
    dropped_frames: u64,
}

fn mean_power(samples: &[i16]) -> f64 {
    samples
        .iter()
        .map(|&sample| (f64::from(sample) / 32768.0).powi(2))
        .sum::<f64>()
        / f64::from(u32::try_from(samples.len().max(1)).unwrap_or(u32::MAX))
}

struct Render {
    at: std::time::Instant,
    samples: Vec<i16>,
}

struct Span {
    end: usize,
    count: usize,
    audio: bool,
}

#[derive(Default)]
struct PlaybackClock {
    epoch: u64,
    submitted: usize,
    acknowledged: usize,
    heard: usize,
    spans: VecDeque<Span>,
}
impl PlaybackClock {
    fn submit(&mut self, epoch: u64, count: usize, audio: bool) -> Result<(), &'static str> {
        if self.epoch != epoch {
            *self = Self {
                epoch,
                ..Self::default()
            };
        }
        if self.spans.len() >= MAX_SPANS {
            return Err("Realtime playback acknowledgements fell behind.");
        }
        self.submitted += count;
        self.spans.push_back(Span {
            end: self.submitted,
            count,
            audio,
        });
        Ok(())
    }
    fn played(&mut self, epoch: u64, position: usize) -> usize {
        if epoch != self.epoch {
            return 0;
        }
        let position = position.min(self.submitted).max(self.acknowledged);
        while let Some(span) = self.spans.front() {
            let start = span.end - span.count;
            if start >= position {
                break;
            }
            if span.audio {
                self.heard += position.min(span.end) - self.acknowledged.max(start);
            }
            self.acknowledged = position.min(span.end);
            if span.end > position {
                break;
            }
            self.spans.pop_front();
        }
        self.heard
    }
}

pub(super) struct MediaEchoCanceller {
    processor: super::processing::Processor,
    clock: PlaybackClock,
    rendered: VecDeque<Render>,
    render_samples: usize,
    provider_reference: VecDeque<i16>,
    signal: Signal,
    raw_power: f64,
    processed_power: f64,
}
impl MediaEchoCanceller {
    pub(super) fn new() -> Result<Self, &'static str> {
        Ok(Self {
            processor: super::processing::Processor::new()?,
            clock: PlaybackClock::default(),
            rendered: VecDeque::new(),
            render_samples: 0,
            provider_reference: VecDeque::new(),
            signal: Signal::default(),
            raw_power: 0.0,
            processed_power: 0.0,
        })
    }
    pub(super) fn render(
        &mut self,
        epoch: u64,
        samples: &[i16],
        audio: bool,
        delay_ns: i64,
    ) -> Result<(), &'static str> {
        let now = std::time::Instant::now();
        let delay = std::time::Duration::from_nanos(delay_ns.unsigned_abs());
        let at = if delay_ns >= 0 {
            now.checked_add(delay)
        } else {
            now.checked_sub(delay)
        }
        .ok_or(DSP_ERROR)?;
        self.submit_render(epoch, at, samples, audio)
    }

    /// Retain unmixed provider PCM until the device submits the corresponding
    /// samples. Local UI sounds must not trigger speech echo suppression.
    pub(super) fn queue_reference(&mut self, samples: &[i16]) -> Result<(), &'static str> {
        if self.provider_reference.len() + samples.len() > MAX_RENDER_SAMPLES {
            return Err("Realtime speaker reference fell behind.");
        }
        self.provider_reference.extend(samples);
        Ok(())
    }
    fn submit_render(
        &mut self,
        epoch: u64,
        at: std::time::Instant,
        samples: &[i16],
        audio: bool,
    ) -> Result<(), &'static str> {
        self.clock.submit(epoch, samples.len(), audio)?;
        let reference = if self.provider_reference.is_empty() {
            samples.to_vec()
        } else {
            if self.provider_reference.len() < samples.len() {
                return Err(DSP_ERROR);
            }
            self.provider_reference.drain(..samples.len()).collect()
        };
        self.enqueue_render(at, reference);
        Ok(())
    }
    fn enqueue_render(&mut self, at: std::time::Instant, samples: Vec<i16>) {
        if self.render_samples + samples.len() > MAX_RENDER_SAMPLES {
            self.processor.reset_render();
            self.rendered.clear();
            self.render_samples = 0;
        }
        self.render_samples += samples.len();
        self.rendered.push_back(Render { at, samples });
    }
    pub(super) fn capture(
        &mut self,
        samples: &[i16],
        at: std::time::Instant,
        now: std::time::Instant,
    ) -> Result<Vec<i16>, &'static str> {
        // Like Codex's capture worker, service speaker references before capture
        // on the same worker. Device submission only queues PCM, and delay is
        // measured when processing it rather than on the playback thread.
        while let Some(render) = self.rendered.pop_front() {
            self.render_samples -= render.samples.len();
            self.processor.render_at(render.at, &render.samples, now)?;
        }
        let cleaned = match self.processor.capture(at, samples, now) {
            Err(super::processing::PROCESSING_LATE) => {
                self.signal.dropped_frames += 1;
                self.reset_capture()?;
                Ok(vec![])
            }
            result => result,
        }?;
        // Coarse signal energy only: never retain microphone samples for logs.
        self.raw_power += SMOOTHING * (mean_power(samples) - self.raw_power);
        self.processed_power += SMOOTHING * (mean_power(&cleaned) - self.processed_power);
        self.signal.raw_rms = self.raw_power.sqrt();
        self.signal.processed_rms = self.processed_power.sqrt();
        Ok(cleaned)
    }
    pub(super) fn diagnostics(&self) -> Signal {
        self.signal
    }
    pub(super) fn reset_capture(&mut self) -> Result<(), &'static str> {
        self.rendered.clear();
        self.render_samples = 0;
        self.processor.reset()
    }
    pub(super) fn played(&mut self, epoch: u64, position: usize) -> usize {
        self.clock.played(epoch, position)
    }
}

#[cfg(test)]
#[path = "echo_tests.rs"]
mod tests;
