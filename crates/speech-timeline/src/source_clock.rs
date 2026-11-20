//! Pair consumed PCM positions with the RTP source clock. A source gap does not
//! require queued silence, but still belongs on the provider's caption timeline.
use std::collections::VecDeque;

const RTP_TICKS_PER_SAMPLE: usize = 2;
const MAX_ANCHORS: usize = 4096;

struct Anchor {
    pcm: usize,
    source: usize,
}

#[derive(Default)]
/// Maps 24 kHz PCM to a wrapping 48 kHz source timestamp clock.
/// Timestamp parsing and packet delivery remain the provider adapter’s job.
pub struct SourceClock {
    next_timestamp: Option<u32>,
    source: usize,
    anchors: VecDeque<Anchor>,
}

impl SourceClock {
    /// Record a decoded packet before queueing it. `pcm` and `count` are source
    /// PCM frames, while `timestamp` uses 48 kHz ticks. Missing timestamps retain
    /// continuity; positive gaps add source time without inserting silence.
    /// Returns an error if 4096 unconsumed gap anchors accumulate.
    pub fn record(
        &mut self,
        pcm: usize,
        count: usize,
        timestamp: Option<u32>,
    ) -> Result<(), &'static str> {
        let gap = timestamp
            .zip(self.next_timestamp)
            .map(|(actual, expected)| {
                i32::from_ne_bytes(actual.wrapping_sub(expected).to_ne_bytes())
            })
            .and_then(|ticks| usize::try_from(ticks).ok())
            .unwrap_or(0)
            / RTP_TICKS_PER_SAMPLE;
        self.source = self.source.saturating_add(gap);
        if self.anchors.is_empty() || gap > 0 {
            if self.anchors.len() == MAX_ANCHORS {
                return Err("Source playback timing fell behind.");
            }
            self.anchors.push_back(Anchor {
                pcm,
                source: self.source,
            });
        }
        self.source = self.source.saturating_add(count);
        self.next_timestamp = timestamp.or(self.next_timestamp).map(|timestamp| {
            timestamp.wrapping_add(
                u32::try_from(count.saturating_mul(RTP_TICKS_PER_SAMPLE)).unwrap_or(u32::MAX),
            )
        });
        Ok(())
    }

    /// Source position of a sample, including the first sample after a gap.
    pub fn sample(&self, pcm: usize) -> Option<usize> {
        let anchor = self
            .anchors
            .iter()
            .rev()
            .find(|anchor| anchor.pcm <= pcm)
            .or_else(|| self.anchors.front())?;
        Some(anchor.source.saturating_add(pcm.saturating_sub(anchor.pcm)))
    }

    /// Map monotonically acknowledged device PCM into source time. A gap becomes
    /// visible only after the next packet starts playing. Retires old anchors;
    /// callers must fence stale generations and never supply decreasing PCM.
    pub fn played(&mut self, pcm: usize) -> Option<usize> {
        // A queued packet's timestamp cannot advance the caption before any
        // of that packet has actually played, including at a gap boundary.
        while self.anchors.get(1).is_some_and(|anchor| anchor.pcm < pcm) {
            self.anchors.pop_front();
        }
        let anchor = self.anchors.front()?;
        Some(anchor.source.saturating_add(pcm.saturating_sub(anchor.pcm)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: usize = 24_000;

    #[test]
    fn skipped_source_silence_does_not_make_later_captions_lag() -> Result<(), &'static str> {
        let mut clock = SourceClock::default();
        clock.record(0, RATE, Some(1000))?;
        // One second of speech, two seconds without RTP, then more speech.
        clock.record(RATE, RATE, Some(145_000))?;
        assert_eq!(clock.sample(RATE), Some(RATE * 3));
        assert_eq!(clock.played(RATE), Some(RATE));
        assert_eq!(clock.played(RATE + RATE / 2), Some(RATE * 3 + RATE / 2));
        assert_eq!(clock.played(RATE * 2), Some(RATE * 4));
        Ok(())
    }

    #[test]
    fn contiguous_audio_and_concealment_share_one_source_clock() -> Result<(), &'static str> {
        let mut clock = SourceClock::default();
        clock.record(0, 480, Some(1000))?;
        clock.record(480, 240, None)?;
        clock.record(720, 480, Some(2440))?;
        for position in [0, 240, 480, 720, 960, 1200] {
            assert_eq!(clock.played(position), Some(position));
        }
        Ok(())
    }

    #[test]
    fn timestamp_wrap_and_clock_reset_do_not_move_captions_backwards() -> Result<(), &'static str> {
        let mut clock = SourceClock::default();
        clock.record(0, 480, Some(u32::MAX - 479))?;
        clock.record(480, 480, Some(480))?;
        clock.record(960, 480, Some(0))?;
        assert_eq!(clock.played(1200), Some(1200));
        assert_eq!(clock.played(1440), Some(1440));
        Ok(())
    }
}
