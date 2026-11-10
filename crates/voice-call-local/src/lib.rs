//! Local voice-call policy, without audio devices, runtimes, providers or networking.
#![doc = include_str!("../README.md")]

mod echo;
mod input;
pub use echo::EchoGuard;
use input::{Input, MAX_UTTERANCE_SAMPLES, VAD_PAUSE_SAMPLES};

pub const SAMPLE_RATE: usize = 16_000;
#[cfg(feature = "smart-turn")]
pub const SMART_TURN_AUDIO_SAMPLES: usize = SAMPLE_RATE * 8;

pub const DEFAULT_VAD_SENSITIVITY: u8 = 50;
pub const MAX_VAD_SENSITIVITY: u8 = 100;
pub const MAX_TEXT_BYTES: usize = 64_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Setup,
    Preparing,
    Listening,
    Finishing,
    Waiting,
    Speaking,
    Muted,
    Closed,
}

/// Identity of an assistant generation. Keep it with asynchronous host work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Generation(u64);

/// A committed user turn. The host may record it independently of dispatch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserTurn {
    pub input_id: u64,
    pub generation: Generation,
    pub text: String,
}

/// Read-only state; only `Call` can perform transitions.
#[allow(
    clippy::struct_excessive_bools,
    reason = "Mute, inference mode and response acknowledgments are independent state"
)]
pub struct View {
    pub phase: Phase,
    pub input_id: u64,
    pub muted: bool,
    pub smart_turn: bool,
    pub text: String,
    pub level: f32,
    pub response_completed: bool,
    pub response_skipped: bool,
}

/// Synchronous policy. Use under the host's existing coordinator lock.
pub struct Call {
    view: View,
    input: Input,
    sensitivity: u8,
    prompt: Option<String>,
    sequence: u64,
    generation: Option<Generation>,
}

impl Default for Call {
    fn default() -> Self {
        Self {
            view: View {
                phase: Phase::Preparing,
                input_id: 0,
                muted: false,
                smart_turn: false,
                text: String::new(),
                level: 0.0,
                response_completed: false,
                response_skipped: false,
            },
            input: Input::default(),
            sensitivity: DEFAULT_VAD_SENSITIVITY,
            prompt: None,
            sequence: 0,
            generation: None,
        }
    }
}

impl Call {
    #[must_use]
    pub fn view(&self) -> &View {
        &self.view
    }

    #[must_use]
    pub fn generation(&self) -> Option<Generation> {
        self.generation
    }

    #[must_use]
    pub fn silence_ms(&self) -> u32 {
        u32::try_from(self.input.silent.saturating_mul(1_000) / SAMPLE_RATE).unwrap_or(u32::MAX)
    }

    /// A new recognizer/capture cycle must use the current input ID.
    #[must_use]
    pub fn accepts_audio(&self, input_id: u64) -> bool {
        self.view.input_id == input_id
            && !self.view.muted
            && matches!(
                self.view.phase,
                Phase::Listening | Phase::Waiting | Phase::Speaking
            )
    }

    fn next_input(&mut self) {
        self.view.input_id += 1;
        self.input = Input::default();
        self.view.text.clear();
    }

    /// Start or replace local input. Closed calls cannot be restarted.
    pub fn listen(&mut self) {
        if self.view.phase == Phase::Closed {
            return;
        }
        self.next_input();
        self.view.phase = if self.view.muted {
            Phase::Muted
        } else {
            Phase::Listening
        };
        self.view.level = 0.0;
        self.prompt = None;
        self.generation = None;
        self.view.response_completed = false;
        self.view.response_skipped = false;
    }

    /// Model installation and inference remain application responsibilities.
    pub fn begin_preparation(&mut self) {
        if matches!(
            self.view.phase,
            Phase::Setup | Phase::Preparing | Phase::Listening | Phase::Muted
        ) {
            self.next_input();
            self.view.phase = Phase::Preparing;
        }
    }

    /// Activate capture after host preparation. Default builds always use VAD.
    pub fn prepared(&mut self, smart_turn: bool) {
        if self.view.phase != Phase::Closed {
            self.view.smart_turn = smart_turn && cfg!(feature = "smart-turn");
            self.listen();
        }
    }

    pub fn use_vad(&mut self) {
        if self.view.phase == Phase::Preparing {
            self.prepared(false);
        }
    }

    pub fn set_vad_sensitivity(&mut self, sensitivity: u8) {
        let sensitivity = sensitivity.min(MAX_VAD_SENSITIVITY);
        if self.sensitivity != sensitivity {
            self.sensitivity = sensitivity;
            self.input.voiced = 0;
            self.input.interruption_voiced = 0;
            self.input.silent = 0;
            self.input.revision += 1;
        }
    }

    /// Borrow mono 16 kHz samples directly from the host's ingress buffer.
    /// Returns true when recognized barge-in requires cancelling host playback.
    pub fn audio(&mut self, input_id: u64, samples: &[f32]) -> bool {
        if !self.accepts_audio(input_id) {
            return false;
        }
        if !samples.is_empty() {
            #[allow(
                clippy::cast_precision_loss,
                reason = "Capture packets are bounded by the host"
            )]
            {
                self.view.level = (samples.iter().map(|s| s * s).sum::<f32>()
                    / samples.len() as f32)
                    .sqrt()
                    .min(1.0);
            }
        }
        self.input.push(samples, self.sensitivity);
        let interrupted = self.interrupt_if_recognized();
        if self.view.phase == Phase::Listening
            && self.input.speech_started
            && (self.input.samples - self.input.speech_started_at >= MAX_UTTERANCE_SAMPLES
                || (!self.view.smart_turn && self.input.silent >= VAD_PAUSE_SAMPLES))
        {
            self.finish();
        }
        interrupted
    }

    /// Partial or final STT text does not itself commit a user turn.
    /// Returns true when the host must cancel playback for a barge-in.
    pub fn recognition(&mut self, input_id: u64, text: String) -> bool {
        if self.view.input_id == input_id
            && matches!(
                self.view.phase,
                Phase::Listening | Phase::Finishing | Phase::Speaking | Phase::Waiting
            )
            && text.len() <= MAX_TEXT_BYTES
        {
            self.view.text = text;
            return self.interrupt_if_recognized();
        }
        false
    }

    fn interrupt_if_recognized(&mut self) -> bool {
        if !self.view.muted
            && matches!(self.view.phase, Phase::Speaking | Phase::Waiting)
            && !self.view.text.trim().is_empty()
            && self.input.should_interrupt()
        {
            // Retain this capture and the user's buffered first words.
            self.view.phase = Phase::Listening;
            self.view.response_completed = false;
            self.generation = None;
            return true;
        }
        false
    }

    pub fn finish(&mut self) {
        if self.view.phase == Phase::Listening {
            self.view.phase = Phase::Finishing;
        }
    }

    /// Commit only after a turn boundary. Empty STT starts another input cycle.
    ///
    /// # Errors
    /// Returns an error if the current recognizer ends before a turn boundary.
    pub fn recognition_ended(&mut self, input_id: u64) -> Result<Option<UserTurn>, &'static str> {
        if self.view.input_id != input_id {
            return Ok(None);
        }
        if self.view.phase == Phase::Listening {
            return Err("The local recognizer ended before your turn was finished. Try again.");
        }
        if self.view.phase != Phase::Finishing {
            return Ok(None);
        }
        let text = self.view.text.trim().to_owned();
        if text.is_empty() {
            self.listen();
            return Ok(None);
        }
        let turn = self.await_reply(text);
        self.prompt = Some(turn.text.clone());
        Ok(Some(turn))
    }

    /// Dispatch each spoken user turn at most once.
    pub fn take_prompt(&mut self) -> Option<String> {
        self.prompt.take()
    }

    /// Follow an already-dispatched text turn without dispatching it again.
    /// Replaces and fences any previous assistant generation.
    ///
    /// # Errors
    /// Rejects text larger than `MAX_TEXT_BYTES`.
    pub fn submit_text(&mut self, text: &str) -> Result<Option<UserTurn>, &'static str> {
        if text.len() > MAX_TEXT_BYTES {
            return Err("Voice chat message is too long");
        }
        if self.view.phase == Phase::Closed || text.trim().is_empty() {
            return Ok(None);
        }
        Ok(Some(self.await_reply(text.trim().to_owned())))
    }

    fn await_reply(&mut self, text: String) -> UserTurn {
        self.sequence += 1;
        let generation = Generation(self.sequence);
        let turn = UserTurn {
            input_id: self.view.input_id,
            generation,
            text,
        };
        self.generation = Some(generation);
        self.view.phase = Phase::Waiting;
        self.prompt = None;
        self.view.response_completed = false;
        self.view.response_skipped = false;
        self.next_input();
        turn
    }

    /// The host adapts incoming assistant text to its speech queue, then reports
    /// whether that queue has pending speech. Completion means the entire
    /// assistant generation ended, not merely one text segment or audio buffer.
    pub fn assistant_progress(
        &mut self,
        generation: Generation,
        completed: bool,
        pending_speech: bool,
    ) {
        if self.generation != Some(generation) {
            return;
        }
        self.view.response_completed |= completed;
        if self.view.phase == Phase::Waiting {
            if pending_speech && !self.view.response_skipped {
                self.view.phase = Phase::Speaking;
            } else if self.view.response_completed {
                self.listen();
            }
        }
    }

    #[must_use]
    pub fn speech_finished(&self, pending_speech: bool) -> bool {
        self.view.phase != Phase::Speaking || (self.view.response_completed && !pending_speech)
    }

    /// The host cancels/clears its speech queue; generation still gates input.
    pub fn skip_response(&mut self) {
        if matches!(self.view.phase, Phase::Speaking | Phase::Waiting) {
            self.view.response_skipped = true;
            self.view.phase = Phase::Waiting;
            self.next_input();
            if self.view.response_completed {
                self.listen();
            }
        }
    }

    /// Acknowledge actual playback drain separately from generation completion.
    pub fn playback_ended(&mut self, generation: Generation, pending_speech: bool) {
        if self.generation == Some(generation)
            && self.view.phase == Phase::Speaking
            && self.view.response_completed
            && !pending_speech
        {
            if self.view.muted {
                self.listen();
            } else {
                // Preserve echo-cancelled capture across the last audio buffer.
                self.view.phase = Phase::Listening;
                self.generation = None;
                self.view.response_completed = false;
                self.view.response_skipped = false;
            }
        }
    }

    pub fn set_muted(&mut self, muted: bool) {
        if self.view.muted == muted {
            return;
        }
        self.view.muted = muted;
        if matches!(self.view.phase, Phase::Speaking | Phase::Waiting) {
            self.next_input();
        }
        if matches!(
            self.view.phase,
            Phase::Listening | Phase::Finishing | Phase::Muted
        ) {
            self.listen();
        }
    }

    pub fn close(&mut self) {
        if self.view.phase != Phase::Closed {
            self.next_input();
            self.view.phase = Phase::Closed;
            self.prompt = None;
            self.generation = None;
        }
    }

    #[must_use]
    pub fn should_probe(&self) -> bool {
        self.view.smart_turn && self.view.phase == Phase::Listening && self.input.should_probe()
    }

    /// Only optional builds retain the bounded classifier window.
    #[cfg(feature = "smart-turn")]
    pub fn begin_probe(&mut self, input_id: u64) -> Option<Probe> {
        if self.view.input_id != input_id || !self.should_probe() {
            return None;
        }
        self.input.probing = true;
        self.input.last_probe = self.input.samples;
        Some(Probe {
            input_id,
            revision: self.input.revision,
            audio: self.input.audio.iter().copied().collect(),
        })
    }

    #[cfg(feature = "smart-turn")]
    pub fn complete_probe(&mut self, probe: &Probe, probability: f32) {
        if self.view.input_id == probe.input_id && self.view.phase == Phase::Listening {
            self.input.probing = false;
            if self.input.revision == probe.revision && probability > 0.5 {
                self.finish();
            }
        }
    }
}

/// An inference request fenced against input replacement and resumed speech.
#[cfg(feature = "smart-turn")]
pub struct Probe {
    input_id: u64,
    revision: u64,
    pub audio: Vec<f32>,
}

#[cfg(test)]
mod tests;
