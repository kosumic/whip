//! Call-owned AEC3. Only audio submitted to the media device is a render reference.
use std::collections::VecDeque;

const MAX_SPANS: usize = 128;
const DSP_ERROR: &str = "Realtime echo cancellation could not process device audio.";

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
}
impl MediaEchoCanceller {
    pub(super) fn new() -> Result<Self, &'static str> {
        Ok(Self {
            processor: super::processing::Processor::new()?,
            clock: PlaybackClock::default(),
        })
    }
    pub(super) fn render(
        &mut self,
        epoch: u64,
        samples: &[i16],
        audio: bool,
        delay_ns: i64,
    ) -> Result<(), &'static str> {
        if self.clock.epoch != epoch {
            self.processor.reset_render();
        }
        self.clock.submit(epoch, samples.len(), audio)?;
        let now = std::time::Instant::now();
        let delay = std::time::Duration::from_nanos(delay_ns.unsigned_abs());
        let at = if delay_ns >= 0 {
            now.checked_add(delay)
        } else {
            now.checked_sub(delay)
        }
        .ok_or(DSP_ERROR)?;
        self.processor.render(at, samples)
    }
    pub(super) fn capture(
        &mut self,
        samples: &[i16],
        at: std::time::Instant,
        now: std::time::Instant,
    ) -> Result<Vec<i16>, &'static str> {
        match self.processor.capture(at, samples, now) {
            Err(super::processing::PROCESSING_LATE) => {
                self.processor.reset()?;
                Ok(vec![])
            }
            result => result,
        }
    }
    pub(super) fn reset_capture(&mut self) -> Result<(), &'static str> {
        self.processor.reset()
    }
    pub(super) fn played(&mut self, epoch: u64, position: usize) -> usize {
        self.clock.played(epoch, position)
    }
}

#[cfg(test)]
#[path = "echo_tests.rs"]
mod tests;
