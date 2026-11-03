//! Local turn detection and transcript-bound, half-duplex conversation policy.
//! Platform adapters own speech recognition and audio devices; no speech API is used.

mod smart_turn;
mod waiting_filler;

use crate::{AgentTranscriptKind, ChatSpeechMessage, ChatSpeechQueue};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use smart_turn::{AUDIO_SAMPLES, SmartTurn};
use std::{
    collections::{HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use waiting_filler::WaitingFiller;

const MODEL_FILE: &str = "smart-turn-v3.2-gpu.onnx";
const MODEL_BYTES: u64 = 32_411_198;
const MODEL_SHA256: &str = "ab8dc64b88713f90b571c15b714bd1330e6c883cad8763dacf65c9376dc539be";
const MODEL_URL: &str = "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-gpu.onnx";
const FRAME_SAMPLES: usize = 256;
const PAUSE_SAMPLES: usize = 16_000 * 256 / 1_000;
const VAD_PAUSE_SAMPLES: usize = 16_000 * 800 / 1_000;
const PROBE_INTERVAL: usize = 16_000 / 2;
const MAX_UTTERANCE_SAMPLES: usize = 16_000 * 60;
const MAX_TEXT_BYTES: usize = 64_000;
const INTERRUPTION_SAMPLES: usize = FRAME_SAMPLES * 16;
const INTERRUPTION_RECOGNITION_SAMPLES: usize = 16_000 * 2;
const INTERRUPTION_CONFIDENCE_MARGIN: f32 = 0.25;
const DEFAULT_VAD_SENSITIVITY: u8 = 50;
const MAX_VAD_SENSITIVITY: u8 = 100;

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum VoiceChatError {
    #[error("{message}")]
    Failed { message: String },
}
impl From<String> for VoiceChatError {
    fn from(message: String) -> Self {
        Self::Failed { message }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum VoiceChatPhase {
    Setup,
    Preparing,
    Listening,
    Finishing,
    Waiting,
    Speaking,
    Muted,
    Closed,
}

#[derive(Clone, uniffi::Record)]
pub struct VoiceChatView {
    pub phase: VoiceChatPhase,
    pub input_id: u64,
    pub muted: bool,
    pub smart_turn: bool,
    pub text: String,
    pub level: f32,
    pub silence_ms: u32,
    pub analyze: bool,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

#[derive(uniffi::Record)]
pub struct VoiceChatTranscriptTurn {
    pub id: String,
    pub user_text: String,
    pub completed: bool,
    pub failed: bool,
    pub messages: Vec<ChatSpeechMessage>,
}

struct Input {
    vad: Box<earshot::Detector>,
    frame: Vec<f32>,
    audio: VecDeque<f32>,
    voiced: usize,
    interruption_voiced: usize,
    interruption_detected_at: Option<usize>,
    silent: usize,
    samples: usize,
    speech_started: bool,
    speech_started_at: usize,
    revision: u64,
    last_probe: usize,
    probing: bool,
}
impl Default for Input {
    fn default() -> Self {
        Self {
            vad: earshot::Detector::default_boxed(),
            frame: Vec::with_capacity(FRAME_SAMPLES),
            audio: VecDeque::with_capacity(AUDIO_SAMPLES),
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
    fn push(&mut self, samples: &[f32], sensitivity: u8) {
        for &sample in samples {
            self.audio.push_back(sample);
            if self.audio.len() > AUDIO_SAMPLES {
                self.audio.pop_front();
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
    fn probability(&mut self, probability: f32, sensitivity: u8) {
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
    fn should_probe(&self) -> bool {
        self.speech_started
            && self.silent >= PAUSE_SAMPLES
            && !self.probing
            && (self.last_probe == 0 || self.samples - self.last_probe >= PROBE_INTERVAL)
    }

    fn should_interrupt(&self) -> bool {
        self.interruption_detected_at.is_some_and(|detected| {
            self.samples.saturating_sub(detected) <= INTERRUPTION_RECOGNITION_SAMPLES
        })
    }
}

struct State {
    phase: VoiceChatPhase,
    input_id: u64,
    muted: bool,
    smart_turn: bool,
    vad_sensitivity: u8,
    text: String,
    level: f32,
    input: Input,
    prompt: Option<String>,
    expected: String,
    baseline: HashSet<String>,
    observed_turns: HashSet<String>,
    turn_id: Option<String>,
    response_completed: bool,
    response_skipped: bool,
    waiting_filler: Option<WaitingFiller>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            phase: VoiceChatPhase::Preparing,
            input_id: 0,
            muted: false,
            smart_turn: false,
            vad_sensitivity: DEFAULT_VAD_SENSITIVITY,
            text: String::new(),
            level: 0.0,
            input: Input::default(),
            prompt: None,
            expected: String::new(),
            baseline: HashSet::new(),
            observed_turns: HashSet::new(),
            turn_id: None,
            response_completed: false,
            response_skipped: false,
            waiting_filler: None,
        }
    }
}
impl State {
    fn await_reply(&mut self, text: String) {
        self.phase = VoiceChatPhase::Waiting;
        self.baseline = self.observed_turns.clone();
        self.expected = text;
        self.prompt = None;
        self.turn_id = None;
        self.response_completed = false;
        self.response_skipped = false;
        self.waiting_filler = Some(WaitingFiller::new(Instant::now()));
        self.input_id += 1;
        self.input = Input::default();
        self.text.clear();
    }

    fn listen(&mut self) {
        self.input_id += 1;
        self.phase = if self.muted {
            VoiceChatPhase::Muted
        } else {
            VoiceChatPhase::Listening
        };
        self.input = Input::default();
        self.text.clear();
        self.level = 0.0;
        self.prompt = None;
        self.expected.clear();
        self.turn_id = None;
        self.response_completed = false;
        self.response_skipped = false;
        self.waiting_filler = None;
    }
}

#[derive(uniffi::Object)]
pub struct VoiceChat {
    root: PathBuf,
    state: Mutex<State>,
    model: Mutex<Option<SmartTurn>>,
    downloaded: AtomicU64,
    speech: Arc<ChatSpeechQueue>,
}

#[uniffi::export]
impl VoiceChat {
    #[uniffi::constructor]
    pub fn new(root: String) -> Arc<Self> {
        Arc::new(Self {
            root: root.into(),
            state: Mutex::new(State::default()),
            model: Mutex::new(None),
            downloaded: AtomicU64::new(0),
            speech: ChatSpeechQueue::new(),
        })
    }

    pub fn view(&self) -> VoiceChatView {
        self.view_unlocked(&self.state.lock())
    }

    /// Higher sensitivity accepts softer speech, including during reply interruption.
    pub fn set_vad_sensitivity(&self, sensitivity: u8) {
        let mut state = self.state.lock();
        let sensitivity = sensitivity.min(MAX_VAD_SENSITIVITY);
        if state.vad_sensitivity != sensitivity {
            state.vad_sensitivity = sensitivity;
            state.input.voiced = 0;
            state.input.interruption_voiced = 0;
            state.input.silent = 0;
            state.input.revision += 1;
        }
    }

    /// Download is explicit. Once installed, neither VAD nor Smart Turn opens a network connection.
    pub async fn prepare(self: Arc<Self>, install: bool) -> Result<VoiceChatView, VoiceChatError> {
        if self.state.lock().phase == VoiceChatPhase::Closed {
            return Ok(self.view());
        }
        let path = self.root.join(MODEL_FILE);
        let check_path = path.clone();
        let valid = crate::runtime()?
            .spawn_blocking(move || verify_model(&check_path))
            .await
            .map_err(|e| e.to_string())?;
        if !valid && !install {
            let mut state = self.state.lock();
            if state.phase != VoiceChatPhase::Closed {
                state.listen();
            }
            drop(state);
            return Ok(self.view());
        }
        if !valid {
            let session = self.clone();
            crate::runtime()?
                .spawn(async move { session.download().await })
                .await
                .map_err(|e| e.to_string())??;
        }
        let model = crate::runtime()?
            .spawn_blocking(move || SmartTurn::load(&path))
            .await
            .map_err(|e| e.to_string())?
            .map_err(VoiceChatError::from)?;
        *self.model.lock() = Some(model);
        let mut state = self.state.lock();
        if state.phase != VoiceChatPhase::Closed {
            state.smart_turn = true;
            state.listen();
        }
        drop(state);
        Ok(self.view())
    }

    /// PCM16LE mono, 16 kHz. Small capture packets keep VAD on the sample clock.
    pub fn audio(&self, input_id: u64, pcm: String) -> Result<VoiceChatView, VoiceChatError> {
        if pcm.len() > 24_000 {
            return Err("Oversized microphone packet".to_owned().into());
        }
        let bytes = STANDARD.decode(pcm).map_err(|e| e.to_string())?;
        if bytes.len() % 2 != 0 {
            return Err("Unaligned microphone packet".to_owned().into());
        }
        let samples: Vec<f32> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0)
            .collect();
        let mut state = self.state.lock();
        if state.input_id == input_id
            && !state.muted
            && matches!(
                state.phase,
                VoiceChatPhase::Listening | VoiceChatPhase::Speaking | VoiceChatPhase::Waiting
            )
        {
            if !samples.is_empty() {
                #[allow(
                    clippy::cast_precision_loss,
                    reason = "Capture packets are bounded to a few thousand samples"
                )]
                {
                    state.level = (samples.iter().map(|s| s * s).sum::<f32>()
                        / samples.len() as f32)
                        .sqrt()
                        .min(1.0);
                }
            }
            let sensitivity = state.vad_sensitivity;
            state.input.push(&samples, sensitivity);
            self.interrupt_if_recognized(&mut state);
            if state.phase == VoiceChatPhase::Listening
                && state.input.speech_started
                && (state.input.samples - state.input.speech_started_at >= MAX_UTTERANCE_SAMPLES
                    || (!state.smart_turn && state.input.silent >= VAD_PAUSE_SAMPLES))
            {
                state.phase = VoiceChatPhase::Finishing;
            }
        }
        drop(state);
        Ok(self.view())
    }

    /// Inference runs independently: capture keeps advancing and invalidates stale verdicts.
    pub async fn analyze(self: Arc<Self>, input_id: u64) -> Result<VoiceChatView, VoiceChatError> {
        let probe = {
            let mut state = self.state.lock();
            if state.input_id != input_id
                || state.phase != VoiceChatPhase::Listening
                || !state.smart_turn
                || !state.input.should_probe()
            {
                return Ok(self.view_unlocked(&state));
            }
            state.input.probing = true;
            state.input.last_probe = state.input.samples;
            (
                state.input.revision,
                state.input.audio.iter().copied().collect::<Vec<_>>(),
            )
        };
        let session = self.clone();
        let probability = crate::runtime()?
            .spawn_blocking(move || {
                session
                    .model
                    .lock()
                    .as_mut()
                    .ok_or_else(|| "Smart Turn is not ready".to_owned())?
                    .predict(&probe.1)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(VoiceChatError::from)?;
        let mut state = self.state.lock();
        if state.input_id == input_id && state.phase == VoiceChatPhase::Listening {
            state.input.probing = false;
            if state.input.revision == probe.0 && probability > 0.5 {
                state.phase = VoiceChatPhase::Finishing;
            }
        }
        drop(state);
        Ok(self.view())
    }

    pub fn finish(&self) {
        let mut state = self.state.lock();
        if state.phase == VoiceChatPhase::Listening {
            state.phase = VoiceChatPhase::Finishing;
        }
    }

    /// Optional model setup temporarily releases capture. Basic VAD remains usable.
    pub fn begin_preparation(&self) {
        let mut state = self.state.lock();
        if matches!(
            state.phase,
            VoiceChatPhase::Setup
                | VoiceChatPhase::Preparing
                | VoiceChatPhase::Listening
                | VoiceChatPhase::Muted
        ) {
            state.input_id += 1;
            state.phase = VoiceChatPhase::Preparing;
            state.input = Input::default();
            state.text.clear();
        }
    }

    pub fn use_vad(&self) {
        let mut state = self.state.lock();
        if state.phase == VoiceChatPhase::Preparing {
            state.smart_turn = false;
            state.listen();
        }
    }

    pub fn recognition(&self, input_id: u64, text: String) {
        let mut state = self.state.lock();
        if state.input_id == input_id
            && matches!(
                state.phase,
                VoiceChatPhase::Listening
                    | VoiceChatPhase::Finishing
                    | VoiceChatPhase::Speaking
                    | VoiceChatPhase::Waiting
            )
            && text.len() <= MAX_TEXT_BYTES
        {
            state.text = text;
            self.interrupt_if_recognized(&mut state);
        }
        drop(state);
    }

    /// Only an explicit stop or accepted Smart Turn verdict permits submission.
    /// An early recognizer final may update the text, but cannot commit a turn.
    pub fn recognition_ended(&self, input_id: u64) -> Result<VoiceChatView, VoiceChatError> {
        let mut state = self.state.lock();
        if state.input_id != input_id {
            return Ok(self.view_unlocked(&state));
        }
        if state.phase == VoiceChatPhase::Listening {
            return Err(
                "The local recognizer ended before your turn was finished. Try again."
                    .to_owned()
                    .into(),
            );
        }
        if state.phase == VoiceChatPhase::Finishing {
            let text = state.text.trim().to_owned();
            if text.is_empty() {
                state.listen();
            } else {
                state.await_reply(text.clone());
                state.prompt = Some(text);
                self.speech.reset_voice();
            }
        }
        drop(state);
        Ok(self.view())
    }

    pub fn take_prompt(&self) -> Option<String> {
        self.state.lock().prompt.take()
    }

    /// A composer message is already queued by the app. Follow its reply without
    /// submitting it again, using the same conversation and history boundary.
    pub fn submit_text(&self, text: String) -> Result<(), VoiceChatError> {
        if text.len() > MAX_TEXT_BYTES {
            return Err("Voice chat message is too long".to_owned().into());
        }
        let mut state = self.state.lock();
        if state.phase != VoiceChatPhase::Closed && !text.trim().is_empty() {
            state.await_reply(text.trim().to_owned());
            self.speech.reset_voice();
        }
        drop(state);
        Ok(())
    }

    /// Existing turns establish history. Only a new, matching user turn may be read.
    pub fn transcript(
        &self,
        agent: AgentTranscriptKind,
        live: bool,
        baseline: bool,
        turns: Vec<VoiceChatTranscriptTurn>,
    ) -> Result<VoiceChatView, VoiceChatError> {
        let mut state = self.state.lock();
        if state.phase == VoiceChatPhase::Closed {
            return Ok(self.view_unlocked(&state));
        }
        if !live {
            return Err(
                "The agent transcript disconnected. Reopen voice chat when it reconnects."
                    .to_owned()
                    .into(),
            );
        }
        if baseline
            && matches!(
                state.phase,
                VoiceChatPhase::Waiting | VoiceChatPhase::Speaking
            )
        {
            return Err(
                "The agent transcript changed during this conversation. Reopen voice chat."
                    .to_owned()
                    .into(),
            );
        }
        state.observed_turns = turns.iter().map(|turn| turn.id.clone()).collect();
        if !matches!(
            state.phase,
            VoiceChatPhase::Waiting | VoiceChatPhase::Speaking
        ) {
            let State {
                baseline,
                observed_turns,
                ..
            } = &mut *state;
            baseline.clone_from(observed_turns);
            return Ok(self.view_unlocked(&state));
        }
        if state.turn_id.is_none() {
            state.turn_id = turns
                .iter()
                .find(|t| !state.baseline.contains(&t.id) && t.user_text.trim() == state.expected)
                .map(|t| t.id.clone());
        }
        // Keep the submission's history fixed while matching the reply. A
        // turn-upsert may precede its user message; observing that placeholder
        // must not turn the pending response into historical speech.
        if let Some(turn) = turns
            .into_iter()
            .find(|t| state.turn_id.as_ref() == Some(&t.id))
        {
            if turn.failed {
                return Err("The agent turn was interrupted or failed. Check the transcript before continuing.".to_owned().into());
            }
            // OpenCode can publish an idle user-only turn before the assistant
            // exists. That acknowledges our prompt, not a completed response.
            state.response_completed |=
                turn.completed && turn.messages.iter().any(|message| message.assistant);
            if !state.response_skipped {
                self.speech
                    .update_voice(agent, turn.messages, state.response_completed);
            }
            if state.phase == VoiceChatPhase::Waiting && self.speech.has_pending() {
                state.phase = VoiceChatPhase::Speaking;
                state.waiting_filler = None;
            } else if state.phase == VoiceChatPhase::Waiting && state.response_completed {
                state.listen();
            }
        }
        drop(state);
        Ok(self.view())
    }

    pub fn next_speech(&self) -> Option<String> {
        let mut state = self.state.lock();
        match state.phase {
            VoiceChatPhase::Waiting if !state.response_skipped => state
                .waiting_filler
                .as_mut()
                .and_then(|filler| filler.next(Instant::now()))
                .map(str::to_owned),
            VoiceChatPhase::Speaking => self.speech.next(),
            _ => None,
        }
    }

    pub fn speech_finished(&self) -> bool {
        let state = self.state.lock();
        state.phase != VoiceChatPhase::Speaking
            || (state.response_completed && !self.speech.has_pending())
    }

    pub fn skip_response(&self) {
        let mut state = self.state.lock();
        if matches!(
            state.phase,
            VoiceChatPhase::Speaking | VoiceChatPhase::Waiting
        ) {
            self.speech.reset_voice();
            state.response_skipped = true;
            state.phase = VoiceChatPhase::Waiting;
            state.input_id += 1;
            state.input = Input::default();
            state.text.clear();
            if state.response_completed {
                state.listen();
            }
        }
    }

    pub fn playback_ended(&self) -> VoiceChatView {
        let mut state = self.state.lock();
        if state.phase == VoiceChatPhase::Speaking
            && state.response_completed
            && !self.speech.has_pending()
        {
            if state.muted {
                state.listen();
            } else {
                // Reuse the echo-cancelled capture across the last audio buffer;
                // a user starting their next sentence must not lose its first words.
                state.phase = VoiceChatPhase::Listening;
                state.expected.clear();
                state.turn_id = None;
                state.response_completed = false;
                state.response_skipped = false;
            }
        }
        drop(state);
        self.view()
    }

    pub fn set_muted(&self, muted: bool) -> VoiceChatView {
        let mut state = self.state.lock();
        state.muted = muted;
        if matches!(
            state.phase,
            VoiceChatPhase::Speaking | VoiceChatPhase::Waiting
        ) {
            state.input_id += 1;
            state.input = Input::default();
            state.text.clear();
        }
        if matches!(
            state.phase,
            VoiceChatPhase::Listening | VoiceChatPhase::Finishing | VoiceChatPhase::Muted
        ) {
            state.listen();
        }
        drop(state);
        self.view()
    }

    pub fn close(&self) {
        let mut state = self.state.lock();
        state.input_id += 1;
        state.phase = VoiceChatPhase::Closed;
        state.input = Input::default();
        state.text.clear();
        state.prompt = None;
    }
}

impl VoiceChat {
    fn interrupt_if_recognized(&self, state: &mut State) {
        if !state.muted
            && matches!(
                state.phase,
                VoiceChatPhase::Speaking | VoiceChatPhase::Waiting
            )
            && !state.text.trim().is_empty()
            && state.input.should_interrupt()
        {
            // Background noise must not discard the reply before the recognizer
            // confirms words. Keep this capture and the user's buffered first words.
            state.phase = VoiceChatPhase::Listening;
            state.expected.clear();
            state.turn_id = None;
            state.response_completed = false;
            self.speech.reset_voice();
        }
    }

    fn view_unlocked(&self, s: &State) -> VoiceChatView {
        VoiceChatView {
            phase: s.phase,
            input_id: s.input_id,
            muted: s.muted,
            smart_turn: s.smart_turn,
            text: s.text.clone(),
            level: s.level,
            silence_ms: u32::try_from(s.input.silent.saturating_mul(1_000) / 16_000)
                .unwrap_or(u32::MAX),
            analyze: s.smart_turn && s.phase == VoiceChatPhase::Listening && s.input.should_probe(),
            downloaded_bytes: self.downloaded.load(Ordering::Relaxed),
            total_bytes: MODEL_BYTES,
        }
    }

    async fn download(&self) -> Result<(), VoiceChatError> {
        tokio::fs::create_dir_all(&self.root)
            .await
            .map_err(|e| e.to_string())?;
        let temporary = self.root.join(format!("{}.partial", uuid::Uuid::new_v4()));
        let result = self.fetch_model(&temporary).await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
        }
        result
    }
    async fn fetch_model(&self, temporary: &std::path::Path) -> Result<(), VoiceChatError> {
        use tokio::io::AsyncWriteExt;
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .read_timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        let mut response = client
            .get(MODEL_URL)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let mut file = tokio::fs::File::create(temporary)
            .await
            .map_err(|e| e.to_string())?;
        let mut bytes = 0;
        let mut hash = Sha256::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if self.state.lock().phase == VoiceChatPhase::Closed {
                return Err("Download cancelled".to_owned().into());
            }
            bytes += chunk.len() as u64;
            if bytes > MODEL_BYTES {
                return Err("Oversized Smart Turn download".to_owned().into());
            }
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            hash.update(&chunk);
            self.downloaded.store(bytes, Ordering::Relaxed);
        }
        if bytes != MODEL_BYTES || format!("{:x}", hash.finalize()) != MODEL_SHA256 {
            return Err("Smart Turn download checksum mismatch. Please retry."
                .to_owned()
                .into());
        }
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
        tokio::fs::rename(temporary, self.root.join(MODEL_FILE))
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn verify_model(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    if file.metadata().map_or(true, |m| m.len() != MODEL_BYTES) {
        return false;
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 65_536].into_boxed_slice();
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => hash.update(&buffer[..n]),
            Err(_) => return false,
        }
    }
    format!("{:x}", hash.finalize()) == MODEL_SHA256
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ChatSpeechPart;

    fn conversation() -> Arc<VoiceChat> {
        let session = VoiceChat::new(String::new());
        session.state.lock().listen();
        session
    }

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
    fn sensitivity_survives_new_turns_and_mute() {
        let session = conversation();
        session.set_vad_sensitivity(75);
        session.finish();
        session.recognition_ended(session.view().input_id).unwrap();
        session.set_muted(true);
        session.set_muted(false);
        let mut state = session.state.lock();
        let sensitivity = state.vad_sensitivity;
        for _ in 0..4 {
            state.input.probability(0.5, sensitivity);
        }
        let speech_started = state.input.speech_started;
        drop(state);
        assert!(speech_started);
    }
    #[tokio::test]
    async fn a_missing_optional_model_starts_voice_chat_without_downloading() {
        let directory = tempfile::tempdir().unwrap();
        let session = VoiceChat::new(
            directory
                .path()
                .join("not-created")
                .to_string_lossy()
                .into_owned(),
        );
        let view = session.prepare(false).await.unwrap();
        assert_eq!(view.phase, VoiceChatPhase::Listening);
        assert!(!view.smart_turn);
        assert_eq!(view.downloaded_bytes, 0);
        assert!(!directory.path().join("not-created").exists());
    }
    #[test]
    #[allow(
        clippy::cast_possible_truncation,
        reason = "Fixture audio is clamped to PCM16 range"
    )]
    fn basic_vad_finishes_real_speech_without_the_smart_turn_model() {
        let session = conversation();
        let id = session.view().input_id;
        let audio: Vec<u8> = include_bytes!("../tests/fixtures/voice-counting-16k.f32")
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| {
                let sample = f32::from_le_bytes(*b).clamp(-1.0, 1.0);
                (sample * 32767.0) as i16
            })
            .flat_map(i16::to_le_bytes)
            .collect();
        for packet in audio.chunks(4096) {
            session.audio(id, STANDARD.encode(packet)).unwrap();
        }
        for _ in 0..8 {
            session.audio(id, STANDARD.encode([0_u8; 4096])).unwrap();
        }
        assert_eq!(session.view().phase, VoiceChatPhase::Finishing);
        assert!(!session.view().smart_turn);
        assert!(!session.view().analyze);
        assert!(session.take_prompt().is_none());
        session.recognition(id, "one two three".into());
        session.recognition_ended(id).unwrap();
        assert_eq!(session.take_prompt().as_deref(), Some("one two three"));
    }
    fn submit(session: &VoiceChat, text: &str) {
        let id = session.view().input_id;
        session.recognition(id, text.into());
        session.finish();
        session.recognition_ended(id).unwrap();
    }
    fn turn(id: &str, text: &str, completed: bool) -> VoiceChatTranscriptTurn {
        VoiceChatTranscriptTurn {
            id: id.into(),
            user_text: text.into(),
            completed,
            failed: false,
            messages: vec![ChatSpeechMessage {
                id: format!("{id}:reply"),
                assistant: true,
                completed,
                prose: vec![ChatSpeechPart::Text {
                    id: "prose".into(),
                    text: "A spoken reply.".into(),
                }],
            }],
        }
    }
    #[test]
    fn silence_and_empty_recognition_never_submit() {
        let session = conversation();
        let id = session.view().input_id;
        let silence = STANDARD.encode([0_u8; 4096]);
        for _ in 0..300 {
            session.audio(id, silence.clone()).unwrap();
        }
        assert_eq!(session.view().phase, VoiceChatPhase::Listening);
        assert!(!session.view().analyze);
        session.finish();
        session.recognition_ended(id).unwrap();
        assert_eq!(session.view().phase, VoiceChatPhase::Listening);
        assert!(session.take_prompt().is_none());
    }
    #[test]
    fn manual_stop_submits_once_and_late_recognition_cannot_change_it() {
        let session = conversation();
        let id = session.view().input_id;
        submit(&session, "  Hello agent  ");
        assert_eq!(session.take_prompt().as_deref(), Some("Hello agent"));
        session.recognition(id, "late final".into());
        session.recognition_ended(id).unwrap();
        assert!(session.take_prompt().is_none());
        assert_eq!(session.view().phase, VoiceChatPhase::Waiting);
    }

    fn make_filler_due(session: &VoiceChat) {
        session.state.lock().waiting_filler = Some(WaitingFiller::new(
            Instant::now()
                .checked_sub(std::time::Duration::from_secs(8))
                .unwrap(),
        ));
    }

    #[test]
    fn waiting_filler_does_not_submit_or_complete_the_agent_reply() {
        let session = conversation();
        submit(&session, "Hello");
        assert!(session.next_speech().is_none());
        make_filler_due(&session);
        assert!(session.next_speech().is_some());
        assert_eq!(session.view().phase, VoiceChatPhase::Waiting);
        assert_eq!(session.take_prompt().as_deref(), Some("Hello"));
        assert!(session.next_speech().is_none());
        session
            .transcript(
                AgentTranscriptKind::Codex,
                true,
                false,
                vec![turn("reply", "Hello", true)],
            )
            .unwrap();
        assert_eq!(session.next_speech().as_deref(), Some("A spoken reply."));
        assert!(session.next_speech().is_none());
        session.playback_ended();
        assert_eq!(session.view().phase, VoiceChatPhase::Listening);
    }

    #[test]
    fn skipping_or_closing_suppresses_fillers_and_a_new_prompt_restarts_the_delay() {
        let session = conversation();
        submit(&session, "First");
        make_filler_due(&session);
        session.skip_response();
        assert!(session.next_speech().is_none());
        session.submit_text("Follow up".into()).unwrap();
        assert!(session.next_speech().is_none());
        make_filler_due(&session);
        assert!(session.next_speech().is_some());
        make_filler_due(&session);
        session.close();
        assert!(session.next_speech().is_none());
    }

    #[test]
    fn recognizer_final_without_a_turn_boundary_cannot_send() {
        let session = conversation();
        let id = session.view().input_id;
        session.recognition(id, "unfinished sentence".into());
        assert!(session.recognition_ended(id).is_err());
        assert!(session.take_prompt().is_none());
    }
    #[test]
    fn mute_discards_unconfirmed_speech_and_ignores_late_events() {
        let session = conversation();
        let id = session.view().input_id;
        session.recognition(id, "do not send this".into());
        session.finish();
        session.set_muted(true);
        session.recognition(id, "late final".into());
        session.recognition_ended(id).unwrap();
        assert_eq!(session.view().phase, VoiceChatPhase::Muted);
        assert!(session.view().text.is_empty());
        assert!(session.take_prompt().is_none());
        assert!(session.next_speech().is_none());
        session.set_muted(false);
        assert_eq!(session.view().phase, VoiceChatPhase::Listening);
    }
    #[test]
    fn only_a_new_matching_completed_turn_is_read_and_repeated_prompts_stay_distinct() {
        for agent in [
            AgentTranscriptKind::Claude,
            AgentTranscriptKind::Codex,
            AgentTranscriptKind::OpenCode,
            AgentTranscriptKind::Pi,
        ] {
            let session = conversation();
            session
                .transcript(agent, true, true, vec![turn("history", "Hello", true)])
                .unwrap();
            submit(&session, "Hello");
            session.take_prompt();
            session
                .transcript(
                    agent,
                    true,
                    false,
                    vec![
                        turn("history", "Hello", true),
                        turn("other", "Different prompt", true),
                    ],
                )
                .unwrap();
            assert_eq!(session.view().phase, VoiceChatPhase::Waiting);
            session
                .transcript(
                    agent,
                    true,
                    false,
                    vec![turn("history", "Hello", true), turn("one", "Hello", false)],
                )
                .unwrap();
            assert!(session.next_speech().is_none());
            session
                .transcript(
                    agent,
                    true,
                    false,
                    vec![turn("history", "Hello", true), turn("one", "Hello", true)],
                )
                .unwrap();
            assert_eq!(session.next_speech().as_deref(), Some("A spoken reply."));
            assert!(session.next_speech().is_none());
            session.playback_ended();
            submit(&session, "Hello");
            session
                .transcript(agent, true, false, vec![turn("one", "Hello", true)])
                .unwrap();
            assert_eq!(session.view().phase, VoiceChatPhase::Waiting);
            session
                .transcript(
                    agent,
                    true,
                    false,
                    vec![turn("one", "Hello", true), turn("two", "Hello", true)],
                )
                .unwrap();
            session.set_muted(true);
            assert_eq!(session.view().phase, VoiceChatPhase::Speaking);
            assert_eq!(session.next_speech().as_deref(), Some("A spoken reply."));
            assert!(session.next_speech().is_none());
            session.playback_ended();
            assert_eq!(session.view().phase, VoiceChatPhase::Muted);
        }
    }
    #[test]
    fn idle_user_only_turn_waits_for_its_assistant_reply() {
        for agent in [
            AgentTranscriptKind::Claude,
            AgentTranscriptKind::Codex,
            AgentTranscriptKind::OpenCode,
            AgentTranscriptKind::Pi,
        ] {
            let session = conversation();
            session
                .transcript(agent, true, true, vec![turn("history", "Hello", true)])
                .unwrap();
            submit(&session, "Hello");
            session.take_prompt();
            let mut user_only = turn("new", "Hello", true);
            user_only.messages.clear();
            session
                .transcript(
                    agent,
                    true,
                    false,
                    vec![turn("history", "Hello", true), user_only],
                )
                .unwrap();
            assert_eq!(session.view().phase, VoiceChatPhase::Waiting);
            assert!(session.next_speech().is_none());
            session
                .transcript(
                    agent,
                    true,
                    false,
                    vec![turn("history", "Hello", true), turn("new", "Hello", true)],
                )
                .unwrap();
            assert_eq!(session.view().phase, VoiceChatPhase::Speaking);
            assert_eq!(session.next_speech().as_deref(), Some("A spoken reply."));
            assert!(session.next_speech().is_none());
            session.playback_ended();
            assert_eq!(session.view().phase, VoiceChatPhase::Listening);
        }
    }
    #[test]
    fn reconnects_and_agent_failures_do_not_replay_a_reply() {
        let session = conversation();
        submit(&session, "Hello");
        assert!(
            session
                .transcript(AgentTranscriptKind::Claude, false, false, vec![])
                .is_err()
        );
        assert!(
            session
                .transcript(
                    AgentTranscriptKind::Claude,
                    true,
                    true,
                    vec![turn("one", "Hello", true)]
                )
                .is_err()
        );
        let mut failed = turn("failed", "Hello", true);
        failed.failed = true;
        assert!(
            session
                .transcript(AgentTranscriptKind::Claude, true, false, vec![failed])
                .is_err()
        );
        assert!(session.next_speech().is_none());
        session.close();
        session.set_muted(false);
        assert_eq!(session.view().phase, VoiceChatPhase::Closed);
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
    fn streamed_turn(
        id: &str,
        text: &str,
        prose: &str,
        completed: bool,
    ) -> VoiceChatTranscriptTurn {
        let mut result = turn(id, text, completed);
        result.messages[0].prose = vec![ChatSpeechPart::Text {
            id: "prose".into(),
            text: prose.into(),
        }];
        result
    }
    #[test]
    fn typed_input_follows_its_reply_without_resending_and_supersedes_old_speech() {
        let session = conversation();
        submit(&session, "Hello");
        session.take_prompt();
        session
            .transcript(
                AgentTranscriptKind::Codex,
                true,
                false,
                vec![turn("voice", "Hello", true)],
            )
            .unwrap();
        assert_eq!(session.view().phase, VoiceChatPhase::Speaking);
        session.submit_text("Typed follow-up".into()).unwrap();
        assert_eq!(session.view().phase, VoiceChatPhase::Waiting);
        assert!(session.take_prompt().is_none());
        assert!(session.next_speech().is_none());
        session
            .transcript(
                AgentTranscriptKind::Codex,
                true,
                false,
                vec![
                    turn("voice", "Hello", true),
                    turn("typed", "Typed follow-up", true),
                ],
            )
            .unwrap();
        assert_eq!(session.next_speech().as_deref(), Some("A spoken reply."));
        session.playback_ended();
        assert_eq!(session.view().phase, VoiceChatPhase::Listening);
    }

    #[test]
    fn an_incomplete_turn_reference_remains_eligible_when_its_user_message_arrives() {
        for agent in [
            AgentTranscriptKind::Claude,
            AgentTranscriptKind::Codex,
            AgentTranscriptKind::OpenCode,
            AgentTranscriptKind::Pi,
        ] {
            let session = conversation();
            session
                .transcript(agent, true, true, vec![turn("history", "Hello", true)])
                .unwrap();
            submit(&session, "Hello");
            session
                .transcript(
                    agent,
                    true,
                    false,
                    vec![turn("history", "Hello", true), turn("reply", "", false)],
                )
                .unwrap();
            assert_eq!(session.view().phase, VoiceChatPhase::Waiting);
            assert!(session.next_speech().is_none());
            let replies = || vec![turn("history", "Hello", true), turn("reply", "Hello", true)];
            session.transcript(agent, true, false, replies()).unwrap();
            assert_eq!(session.view().phase, VoiceChatPhase::Speaking);
            assert_eq!(session.next_speech().as_deref(), Some("A spoken reply."));
            session.transcript(agent, true, false, replies()).unwrap();
            assert!(session.next_speech().is_none());
        }
    }

    #[test]
    fn streaming_speaks_coherent_prose_before_completion_and_waits_for_both_drains() {
        for agent in [
            AgentTranscriptKind::Claude,
            AgentTranscriptKind::Codex,
            AgentTranscriptKind::OpenCode,
            AgentTranscriptKind::Pi,
        ] {
            let session = conversation();
            submit(&session, "Hello");
            session.take_prompt();
            session
                .transcript(
                    agent,
                    true,
                    false,
                    vec![streamed_turn(
                        "one",
                        "Hello",
                        "First sentence. Mutable",
                        false,
                    )],
                )
                .unwrap();
            assert_eq!(session.view().phase, VoiceChatPhase::Speaking);
            assert_eq!(session.next_speech().as_deref(), Some("First sentence."));
            assert!(session.next_speech().is_none());
            assert!(!session.speech_finished());
            session.playback_ended();
            assert_eq!(session.view().phase, VoiceChatPhase::Speaking);
            session
                .transcript(
                    agent,
                    true,
                    false,
                    vec![streamed_turn(
                        "one",
                        "Hello",
                        "First sentence. Mutable ending",
                        true,
                    )],
                )
                .unwrap();
            assert!(!session.speech_finished());
            assert_eq!(session.next_speech().as_deref(), Some("Mutable ending"));
            assert!(session.speech_finished());
            assert_eq!(session.view().phase, VoiceChatPhase::Speaking);
            session.playback_ended();
            assert_eq!(session.view().phase, VoiceChatPhase::Listening);
        }
    }
    #[test]
    fn a_rewritten_spoken_prefix_and_repeated_snapshots_cannot_replay_audio() {
        let session = conversation();
        submit(&session, "Hello");
        session.take_prompt();
        let agent = AgentTranscriptKind::Claude;
        session
            .transcript(
                agent,
                true,
                false,
                vec![streamed_turn(
                    "one",
                    "Hello",
                    "First sentence. Draft",
                    false,
                )],
            )
            .unwrap();
        assert_eq!(session.next_speech().as_deref(), Some("First sentence."));
        session
            .transcript(
                agent,
                true,
                false,
                vec![streamed_turn(
                    "one",
                    "Hello",
                    "First sentence. Draft",
                    false,
                )],
            )
            .unwrap();
        assert!(session.next_speech().is_none());
        session
            .transcript(
                agent,
                true,
                false,
                vec![streamed_turn("one", "Hello", "A replacement answer.", true)],
            )
            .unwrap();
        assert!(session.next_speech().is_none());
        assert!(session.speech_finished());
    }
    #[test]
    fn skipping_a_stream_suppresses_future_chunks_until_generation_finishes() {
        let session = conversation();
        submit(&session, "Hello");
        session.take_prompt();
        let agent = AgentTranscriptKind::Claude;
        session
            .transcript(
                agent,
                true,
                false,
                vec![streamed_turn(
                    "one",
                    "Hello",
                    "First sentence. Draft",
                    false,
                )],
            )
            .unwrap();
        session.next_speech();
        session.skip_response();
        assert_eq!(session.view().phase, VoiceChatPhase::Waiting);
        session
            .transcript(
                agent,
                true,
                false,
                vec![streamed_turn(
                    "one",
                    "Hello",
                    "First sentence. More speech. ",
                    false,
                )],
            )
            .unwrap();
        assert!(session.next_speech().is_none());
        assert_eq!(session.view().phase, VoiceChatPhase::Waiting);
        session
            .transcript(
                agent,
                true,
                false,
                vec![streamed_turn(
                    "one",
                    "Hello",
                    "First sentence. More speech.",
                    true,
                )],
            )
            .unwrap();
        assert_eq!(session.view().phase, VoiceChatPhase::Listening);
    }
    #[test]
    fn sustained_user_speech_interrupts_playback_and_keeps_recognition_of_first_words() {
        let session = conversation();
        submit(&session, "Hello");
        session.take_prompt();
        let agent = AgentTranscriptKind::Claude;
        session
            .transcript(
                agent,
                true,
                false,
                vec![streamed_turn(
                    "one",
                    "Hello",
                    "First sentence. More speech. ",
                    false,
                )],
            )
            .unwrap();
        let id = session.view().input_id;
        session.recognition(id, "Actually stop".into());
        feed_microphone_fixture(&session, id);
        assert_eq!(session.view().phase, VoiceChatPhase::Listening);
        assert_eq!(session.view().input_id, id);
        assert_eq!(session.view().text, "Actually stop");
        assert!(session.next_speech().is_none());
        session
            .transcript(
                agent,
                true,
                false,
                vec![streamed_turn("one", "Hello", "Late old response.", true)],
            )
            .unwrap();
        assert_eq!(session.view().phase, VoiceChatPhase::Listening);
        session.finish();
        session.recognition_ended(id).unwrap();
        assert_eq!(session.take_prompt().as_deref(), Some("Actually stop"));
        session
            .transcript(
                agent,
                true,
                false,
                vec![
                    streamed_turn("one", "Hello", "Late old response.", true),
                    streamed_turn("two", "Actually stop", "New response.", true),
                ],
            )
            .unwrap();
        assert_eq!(session.next_speech().as_deref(), Some("New response."));
    }
    fn awaiting_or_playing_reply(speaking: bool) -> Arc<VoiceChat> {
        let session = conversation();
        submit(&session, "Hello");
        session.take_prompt();
        if speaking {
            session
                .transcript(
                    AgentTranscriptKind::Codex,
                    true,
                    false,
                    vec![streamed_turn(
                        "one",
                        "Hello",
                        "First sentence. Draft",
                        false,
                    )],
                )
                .unwrap();
        }
        session
    }

    fn feed_microphone_fixture(session: &VoiceChat, id: u64) {
        let samples = include_bytes!("../tests/fixtures/voice-counting-16k.f32");
        #[allow(
            clippy::cast_possible_truncation,
            reason = "Fixture values are clamped PCM16 samples"
        )]
        let pcm: Vec<u8> = samples
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|b| {
                ((f32::from_le_bytes(*b).clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()
            })
            .collect();
        for packet in pcm.chunks(4096) {
            session.audio(id, STANDARD.encode(packet)).unwrap();
            if session.view().phase == VoiceChatPhase::Listening {
                break;
            }
        }
    }

    #[test]
    fn unrecognized_audio_preserves_pending_and_playing_replies() {
        for speaking in [false, true] {
            let session = awaiting_or_playing_reply(speaking);
            let id = session.view().input_id;
            session.recognition(id, "   ".into());
            feed_microphone_fixture(&session, id);
            assert_eq!(
                session.view().phase,
                if speaking {
                    VoiceChatPhase::Speaking
                } else {
                    VoiceChatPhase::Waiting
                }
            );
            session
                .transcript(
                    AgentTranscriptKind::Codex,
                    true,
                    false,
                    vec![streamed_turn(
                        "one",
                        "Hello",
                        "First sentence. Complete reply.",
                        true,
                    )],
                )
                .unwrap();
            assert_eq!(session.view().phase, VoiceChatPhase::Speaking);
            assert!(session.next_speech().is_some());
        }
    }

    #[test]
    fn delayed_recognition_confirms_an_interruption_without_another_audio_packet() {
        for speaking in [false, true] {
            let session = awaiting_or_playing_reply(speaking);
            let id = session.view().input_id;
            feed_microphone_fixture(&session, id);
            session.recognition(id, "Actually stop".into());
            assert_eq!(session.view().phase, VoiceChatPhase::Listening);
            assert_eq!(session.view().input_id, id);
            assert_eq!(session.view().text, "Actually stop");
            assert!(session.next_speech().is_none());
            session
                .transcript(
                    AgentTranscriptKind::Codex,
                    true,
                    false,
                    vec![streamed_turn("one", "Hello", "Late old response.", true)],
                )
                .unwrap();
            assert_eq!(session.view().phase, VoiceChatPhase::Listening);
            session.finish();
            session.recognition_ended(id).unwrap();
            assert_eq!(session.take_prompt().as_deref(), Some("Actually stop"));
        }
    }

    #[test]
    fn old_microphone_noise_cannot_prime_a_later_interruption() {
        for speaking in [false, true] {
            let session = awaiting_or_playing_reply(speaking);
            let id = session.view().input_id;
            feed_microphone_fixture(&session, id);
            for _ in 0..24 {
                session.audio(id, STANDARD.encode([0_u8; 4096])).unwrap();
            }
            session.recognition(id, "You".into());
            assert_eq!(
                session.view().phase,
                if speaking {
                    VoiceChatPhase::Speaking
                } else {
                    VoiceChatPhase::Waiting
                }
            );
        }
    }

    #[test]
    #[ignore = "Set WHIP_VOICE_NOISE_PCM to a 16 kHz mono PCM16LE recording"]
    fn recorded_noise_preserves_pending_and_playing_replies() {
        let pcm = std::fs::read(std::env::var("WHIP_VOICE_NOISE_PCM").unwrap()).unwrap();
        assert!(!pcm.is_empty());
        for sensitivity in [50, 75, 100] {
            for speaking in [false, true] {
                let session = awaiting_or_playing_reply(speaking);
                session.set_vad_sensitivity(sensitivity);
                let expected = session.view().phase;
                let id = session.view().input_id;
                for packet in pcm.chunks(4096) {
                    session.audio(id, STANDARD.encode(packet)).unwrap();
                }
                assert_eq!(session.view().phase, expected, "sensitivity {sensitivity}");
                session
                    .transcript(
                        AgentTranscriptKind::Codex,
                        true,
                        false,
                        vec![streamed_turn(
                            "one",
                            "Hello",
                            "First sentence. Complete reply.",
                            true,
                        )],
                    )
                    .unwrap();
                assert_eq!(session.view().phase, VoiceChatPhase::Speaking);
                assert!(session.next_speech().is_some());
                println!("sensitivity={sensitivity} phase={expected:?}: reply preserved");
            }
        }
    }

    #[test]
    fn silence_and_muted_input_cannot_interrupt_a_reply() {
        let session = conversation();
        submit(&session, "Hello");
        session.take_prompt();
        session
            .transcript(
                AgentTranscriptKind::Claude,
                true,
                false,
                vec![streamed_turn(
                    "one",
                    "Hello",
                    "First sentence. Draft",
                    false,
                )],
            )
            .unwrap();
        let id = session.view().input_id;
        for _ in 0..20 {
            session.audio(id, STANDARD.encode([0_u8; 4096])).unwrap();
        }
        assert_eq!(session.view().phase, VoiceChatPhase::Speaking);
        session.set_muted(true);
        session.audio(id, STANDARD.encode([255_u8; 4096])).unwrap();
        assert_eq!(session.view().phase, VoiceChatPhase::Speaking);
    }
}
