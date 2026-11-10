//! Speech recognition progress is separate from ICE and RTP delivery health.
use std::time::{Duration, Instant};

pub(super) const WARNING: &str =
    "Speech is being sent but has not been detected. Try speaking again or restart the call.";
const VOICED: Duration = Duration::from_millis(800);
const EVIDENCE_WINDOW: Duration = Duration::from_secs(4);
const ACK_WAIT: Duration = Duration::from_secs(8);

pub(super) struct Input {
    detector: voice_call_media::activity::Detector,
    generation: Option<u64>,
    first: Option<Instant>,
    voiced: Duration,
    server_speaking: bool,
    monitoring: bool,
}
impl Input {
    pub fn new() -> Result<Self, &'static str> {
        Ok(Self {
            detector: voice_call_media::activity::Detector::new()?,
            generation: None,
            first: None,
            voiced: Duration::ZERO,
            server_speaking: false,
            monitoring: false,
        })
    }
    fn clear(&mut self) {
        self.first = None;
        self.voiced = Duration::ZERO;
    }
    pub fn server_speech(&mut self, speaking: bool) {
        self.server_speaking = speaking;
        self.clear();
    }
    pub fn capture(
        &mut self,
        samples: &[i16],
        at: Instant,
        generation: u64,
        monitoring: bool,
    ) -> Result<(), &'static str> {
        if self.generation != Some(generation) {
            self.generation = Some(generation);
            self.server_speaking = false;
            self.clear();
            self.detector.reset();
        }
        if self.monitoring != monitoring {
            self.monitoring = monitoring;
            self.clear();
            self.detector.reset();
        }
        if !monitoring || self.server_speaking {
            return Ok(());
        }
        let voiced = self.detector.observe(samples, at)?;
        self.observe(voiced, at);
        Ok(())
    }
    fn observe(&mut self, voiced: Duration, at: Instant) {
        if self.voiced < VOICED
            && self
                .first
                .is_some_and(|first| at.saturating_duration_since(first) > EVIDENCE_WINDOW)
        {
            self.clear();
        }
        if !voiced.is_zero() {
            self.first.get_or_insert(at);
            self.voiced += voiced;
        }
    }
    pub fn stalled(&mut self, now: Instant, monitoring: bool) -> bool {
        if !monitoring {
            self.clear();
            return false;
        }
        !self.server_speaking
            && self.voiced >= VOICED
            && self
                .first
                .is_some_and(|first| now.saturating_duration_since(first) >= ACK_WAIT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unacknowledged_speech_warns_and_server_progress_clears_it() -> Result<(), &'static str> {
        let mut input = Input::new()?;
        let now = Instant::now();
        input.observe(VOICED, now);
        assert!(!input.stalled(now + Duration::from_secs(2), true));
        assert!(input.stalled(now + ACK_WAIT, true));
        // Unrelated events and local sends do not acknowledge speech.
        assert!(input.stalled(now + ACK_WAIT * 2, true));
        input.server_speech(true);
        assert!(!input.stalled(now + ACK_WAIT * 2, true));
        input.server_speech(false);
        assert!(!input.stalled(now + ACK_WAIT * 3, true));
        Ok(())
    }
    #[test]
    fn silence_brief_noise_mute_and_assistant_output_do_not_arm_a_stall() -> Result<(), &'static str>
    {
        let now = Instant::now();
        let mut input = Input::new()?;
        input.observe(Duration::ZERO, now);
        assert!(!input.stalled(now + ACK_WAIT, true));
        input.observe(Duration::from_millis(16), now);
        assert!(!input.stalled(now + ACK_WAIT, true));
        input.observe(VOICED, now + ACK_WAIT);
        assert!(!input.stalled(now + ACK_WAIT * 2, false));
        assert!(!input.stalled(now + ACK_WAIT * 3, true));
        Ok(())
    }
}
