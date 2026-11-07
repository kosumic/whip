use crate::{DEFAULT_VAD_SENSITIVITY, MAX_VAD_SENSITIVITY, SAMPLE_RATE};

const FRAME_SAMPLES: usize = 256;
const PAUSE_SAMPLES: usize = SAMPLE_RATE * 256 / 1_000;
pub(super) const VAD_PAUSE_SAMPLES: usize = SAMPLE_RATE * 800 / 1_000;
const PROBE_INTERVAL: usize = SAMPLE_RATE / 2;
pub(super) const MAX_UTTERANCE_SAMPLES: usize = SAMPLE_RATE * 60;
const INTERRUPTION_SAMPLES: usize = FRAME_SAMPLES * 16;
const INTERRUPTION_RECOGNITION_SAMPLES: usize = SAMPLE_RATE * 2;
const INTERRUPTION_CONFIDENCE_MARGIN: f32 = 0.25;

#[cfg(feature = "smart-turn")]
use crate::SMART_TURN_AUDIO_SAMPLES as AUDIO_SAMPLES;

pub(super) struct Input {
    pub(super) vad: Box<earshot::Detector>,
    pub(super) frame: Vec<f32>,
    #[cfg(feature = "smart-turn")]
    pub(super) audio: std::collections::VecDeque<f32>,
    pub(super) voiced: usize,
    pub(super) interruption_voiced: usize,
    pub(super) interruption_detected_at: Option<usize>,
    pub(super) silent: usize,
    pub(super) samples: usize,
    pub(super) speech_started: bool,
    pub(super) speech_started_at: usize,
    pub(super) revision: u64,
    pub(super) last_probe: usize,
    pub(super) probing: bool,
}
impl Default for Input {
    fn default() -> Self {
        Self {
            vad: earshot::Detector::default_boxed(),
            frame: Vec::with_capacity(FRAME_SAMPLES),
            #[cfg(feature = "smart-turn")]
            audio: std::collections::VecDeque::with_capacity(AUDIO_SAMPLES),
            voiced: 0,
            interruption_voiced: 0,
            interruption_detected_at: None,
            silent: 0,
            samples: 0,
            speech_started: false,
            speech_started_at: 0,
            revision: 0,
            last_probe: 0,
            probing: false,
        }
    }
}
impl Input {
    pub(super) fn push(&mut self, samples: &[f32], sensitivity: u8) {
        for &sample in samples {
            #[cfg(feature = "smart-turn")]
            {
                self.audio.push_back(sample);
                if self.audio.len() > AUDIO_SAMPLES {
                    self.audio.pop_front();
                }
            }
            self.frame.push(sample);
            self.samples += 1;
            if self.frame.len() != FRAME_SAMPLES {
                continue;
            }
            let Some(frame) = self.frame.as_chunks::<FRAME_SAMPLES>().0.first() else {
                continue;
            };
            let probability = self.vad.predict_f32(frame);
            self.frame.clear();
            self.probability(probability, sensitivity);
        }
    }
    pub(super) fn probability(&mut self, probability: f32, sensitivity: u8) {
        // 50% preserves the original 0.60/0.35 onset/continuation thresholds.
        // Keep hysteresis so quieter syllables do not split an ongoing phrase.
        let offset = (f32::from(DEFAULT_VAD_SENSITIVITY) - f32::from(sensitivity))
            / f32::from(MAX_VAD_SENSITIVITY)
            * 0.6;
        let onset_threshold = 0.6 + offset;
        // Derive interruption confidence from normal sensitivity, but keep it
        // above onset even after listening hysteresis accepts quieter syllables.
        let interruption_threshold =
            onset_threshold + (1.0 - onset_threshold) * INTERRUPTION_CONFIDENCE_MARGIN;
        if probability >= interruption_threshold {
            self.interruption_voiced += FRAME_SAMPLES;
            // Keep recent evidence for delayed recognition, but never interrupt
            // on microphone activity alone.
            if self.interruption_voiced >= INTERRUPTION_SAMPLES {
                self.interruption_detected_at = Some(self.samples);
            }
        } else {
            self.interruption_voiced = 0;
        }
        let threshold = if self.speech_started {
            0.35 + offset
        } else {
            onset_threshold
        };
        if probability >= threshold {
            self.voiced += FRAME_SAMPLES;
            self.silent = 0;
            // Any resumed voice invalidates an in-flight Smart Turn result.
            self.revision += 1;
            if !self.speech_started && self.voiced >= FRAME_SAMPLES * 4 {
                self.speech_started = true;
                self.speech_started_at = self.samples;
            }
        } else {
            self.voiced = 0;
            self.silent += FRAME_SAMPLES;
        }
    }
    pub(super) fn should_probe(&self) -> bool {
        self.speech_started
            && self.silent >= PAUSE_SAMPLES
            && !self.probing
            && (self.last_probe == 0 || self.samples - self.last_probe >= PROBE_INTERVAL)
    }

    pub(super) fn should_interrupt(&self) -> bool {
        self.interruption_detected_at.is_some_and(|detected| {
            self.samples.saturating_sub(detected) <= INTERRUPTION_RECOGNITION_SAMPLES
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sensitivity_controls_speech_onset_and_continuation() {
        let mut sensitive = Input::default();
        let mut normal = Input::default();
        let mut strict = Input::default();
        for _ in 0..4 {
            sensitive.probability(0.45, MAX_VAD_SENSITIVITY);
            normal.probability(0.45, DEFAULT_VAD_SENSITIVITY);
            strict.probability(0.75, 0);
        }
        assert!(sensitive.speech_started);
        assert!(!normal.speech_started);
        assert!(!strict.speech_started);
        for _ in 0..4 {
            strict.probability(0.95, 0);
        }
        assert!(strict.speech_started);
        sensitive.probability(0.2, MAX_VAD_SENSITIVITY);
        strict.probability(0.2, 0);
        assert_eq!(sensitive.silent, 0);
        assert_eq!(strict.silent, FRAME_SAMPLES);
    }

    #[test]
    fn interruption_rejects_marginal_speech_that_normal_listening_accepts() {
        let mut input = Input::default();
        // Speech-like background noise can start listening, but must not gain
        // permission to interrupt just because continuation uses a lower threshold.
        for _ in 0..100 {
            input.probability(0.65, DEFAULT_VAD_SENSITIVITY);
        }
        assert!(input.speech_started);
        assert!(!input.should_interrupt());
    }

    #[test]
    fn interruption_requires_sustained_speech_but_confirms_within_256_ms() {
        let mut input = Input::default();
        // Separate short bursts must not add up to an interruption.
        for _ in 0..5 {
            for _ in 0..10 {
                input.probability(0.95, DEFAULT_VAD_SENSITIVITY);
                assert!(!input.should_interrupt());
            }
            input.probability(0.1, DEFAULT_VAD_SENSITIVITY);
        }
        for _ in 0..15 {
            input.probability(0.95, DEFAULT_VAD_SENSITIVITY);
            assert!(!input.should_interrupt());
        }
        input.probability(0.95, DEFAULT_VAD_SENSITIVITY);
        assert!(input.should_interrupt());
    }

    #[test]
    fn interruption_tracks_normal_sensitivity_and_remains_stricter_at_the_extremes() {
        for (sensitivity, marginal, clear) in [(0, 0.91, 0.95), (50, 0.65, 0.75), (100, 0.4, 0.55)]
        {
            let mut input = Input::default();
            for _ in 0..20 {
                input.probability(marginal, sensitivity);
            }
            assert!(input.speech_started, "sensitivity {sensitivity}");
            assert!(!input.should_interrupt(), "sensitivity {sensitivity}");
            for _ in 0..16 {
                input.probability(clear, sensitivity);
            }
            assert!(input.should_interrupt(), "sensitivity {sensitivity}");
        }
    }

    #[test]
    fn resumed_speech_invalidates_a_pending_turn_verdict() {
        let mut input = Input::default();
        for _ in 0..3 {
            input.probability(0.9, DEFAULT_VAD_SENSITIVITY);
        }
        assert!(!input.speech_started);
        input.probability(0.9, DEFAULT_VAD_SENSITIVITY);
        for _ in 0..16 {
            input.probability(0.1, DEFAULT_VAD_SENSITIVITY);
        }
        assert!(input.should_probe());
        let revision = input.revision;
        input.probing = true;
        input.probability(0.4, DEFAULT_VAD_SENSITIVITY);
        assert!(input.revision > revision);
        assert_eq!(input.silent, 0);
    }
}
