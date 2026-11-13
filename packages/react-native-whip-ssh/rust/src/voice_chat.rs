//! Local turn detection and transcript-bound, half-duplex conversation policy.
//! Platform adapters own speech recognition and audio devices; no speech API is used.

mod capture;
pub(crate) mod coordinator;
pub use coordinator::VoiceChatObserver;
#[cfg(feature = "smart-turn")]
mod smart_turn;
pub(crate) mod transcript;
mod waiting_filler;

use crate::{AgentTranscriptKind, ChatSpeechMessage, ChatSpeechQueue};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
#[cfg(feature = "smart-turn")]
use smart_turn::SmartTurn;
#[cfg(feature = "smart-turn")]
use std::path::PathBuf;
use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use voice_call_local::{Call, EchoGuard, Phase, UserTurn};
use waiting_filler::WaitingFiller;

#[cfg(feature = "smart-turn")]
const MODEL_FILE: &str = "smart-turn-v3.2-gpu.onnx";
#[cfg(feature = "smart-turn")]
const MODEL_BYTES: u64 = 32_411_198;
#[cfg(not(feature = "smart-turn"))]
const MODEL_BYTES: u64 = 0;
#[cfg(feature = "smart-turn")]
const MODEL_SHA256: &str = "ab8dc64b88713f90b571c15b714bd1330e6c883cad8763dacf65c9376dc539be";
#[cfg(feature = "smart-turn")]
const MODEL_URL: &str = "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-gpu.onnx";
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

impl From<Phase> for VoiceChatPhase {
    fn from(phase: Phase) -> Self {
        match phase {
            Phase::Setup => Self::Setup,
            Phase::Preparing => Self::Preparing,
            Phase::Listening => Self::Listening,
            Phase::Finishing => Self::Finishing,
            Phase::Waiting => Self::Waiting,
            Phase::Speaking => Self::Speaking,
            Phase::Muted => Self::Muted,
            Phase::Closed => Self::Closed,
        }
    }
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
    pub audio_error: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub events_json: String,
    pub coordination_json: String,
}

#[derive(uniffi::Record)]
pub struct VoiceChatTranscriptTurn {
    pub id: String,
    pub user_text: String,
    pub completed: bool,
    pub failed: bool,
    pub messages: Vec<ChatSpeechMessage>,
    pub tools_json: String,
}

#[derive(serde::Deserialize)]
struct TranscriptTool {
    id: String,
    #[serde(flatten)]
    event: crate::voice_history::Event,
}

#[derive(Default)]
pub(crate) struct State {
    call: Call,
    echo: EchoGuard,
    ingress: Option<Arc<crate::audio_ingress::NativeIngress>>,
    audio_error: Option<String>,
    expected: String,
    baseline: HashSet<String>,
    observed_turns: HashSet<String>,
    observed_tail: Option<String>,
    baseline_anchor: Option<String>,
    turn_id: Option<String>,
    waiting_filler: Option<WaitingFiller>,
    history: crate::voice_history::Conversation,
    delegation_id: String,
    pub(crate) coordinator: voice_call_local::coordinator::Coordinator,
    connection: Option<coordinator::Connection>,
    pub(crate) source: Option<transcript::Source>,
    receipt: Option<coordinator::Receipt>,
    submission_marker: Option<String>,
    retired_submissions: Vec<(Arc<crate::TerminalSubmissionQueue>, String, String)>,
    diagnostic_stage: Option<voice_call_local::coordinator::Stage>,
    diagnostic_at: u64,
    effects: Vec<serde_json::Value>,
    refresh_transcript: bool,
}
impl State {
    // Core transitions and native capture invalidation share the coordinator lock.
    fn update_call<R>(&mut self, update: impl FnOnce(&mut Call) -> R) -> R {
        let input_id = self.call.view().input_id;
        let generation = self.call.generation();
        let result = update(&mut self.call);
        if self.call.view().input_id != input_id {
            self.close_capture();
        }
        if generation.is_some() && self.call.generation().is_none() {
            self.echo.finish(Instant::now());
            self.expected.clear();
            self.turn_id = None;
            self.waiting_filler = None;
            self.coordinator.cancel();
            self.retire_receipt();
        }
        if self.call.view().phase == Phase::Speaking {
            self.waiting_filler = None;
        }
        result
    }
    fn close_capture(&mut self) {
        if let Some(ingress) = self.ingress.take() {
            ingress.close();
        }
    }

    fn record_turn(&mut self, turn: UserTurn, now: u64) {
        self.retire_receipt();
        self.coordinator.submit(now);
        self.receipt = None;
        self.submission_marker = None;
        self.history.user(&turn.text);
        self.delegation_id = format!("delegation:{}", turn.input_id);
        let mut event = crate::voice_history::Event::new("delegation", "Coding agent", "requested");
        event.input = Some(turn.text.clone());
        self.history.event(&self.delegation_id, event);
        self.baseline = self.observed_turns.clone();
        self.baseline_anchor.clone_from(&self.observed_tail);
        self.expected = turn.text;
        self.turn_id = None;
        self.waiting_filler = Some(WaitingFiller::new(Instant::now()));
    }

    fn retire_receipt(&mut self) {
        if let Some(receipt) = self.receipt.take()
            && let Some(connection) = &self.connection
            && !receipt.id.is_empty()
        {
            self.retired_submissions.push((
                connection.queue.clone(),
                connection.target_key.clone(),
                receipt.id,
            ));
        }
    }

    #[cfg(any(test, feature = "smart-turn"))]
    fn listen(&mut self) {
        self.update_call(Call::listen);
        self.expected.clear();
        self.turn_id = None;
        self.waiting_filler = None;
    }
}

#[derive(uniffi::Object)]
pub struct VoiceChat {
    #[cfg(feature = "smart-turn")]
    root: PathBuf,
    pub(crate) state: Mutex<State>,
    #[cfg(feature = "smart-turn")]
    model: Mutex<Option<SmartTurn>>,
    downloaded: AtomicU64,
    speech: Arc<ChatSpeechQueue>,
    started: Instant,
    observer: Mutex<Option<Arc<dyn VoiceChatObserver>>>,
    id: u64,
}

static NEXT_CALL: AtomicU64 = AtomicU64::new(1);

#[uniffi::export]
impl VoiceChat {
    #[uniffi::constructor]
    pub fn new(root: String) -> Arc<Self> {
        // Preserve the native bridge constructor when model support is disabled.
        #[cfg(not(feature = "smart-turn"))]
        let _ = root;
        Arc::new(Self {
            #[cfg(feature = "smart-turn")]
            root: root.into(),
            state: Mutex::new(State::default()),
            #[cfg(feature = "smart-turn")]
            model: Mutex::new(None),
            downloaded: AtomicU64::new(0),
            speech: ChatSpeechQueue::new(),
            started: Instant::now(),
            observer: Mutex::new(None),
            id: NEXT_CALL.fetch_add(1, Ordering::Relaxed),
        })
    }

    /// Opens a fresh native capture ticket for each recognizer cycle.
    pub fn open_audio_capture(self: Arc<Self>, input_id: u64) -> Result<u64, VoiceChatError> {
        self.open_capture(input_id)
            .map_err(|error| error.to_owned().into())
    }
    pub fn close_audio_capture(&self, handle: u64) {
        let mut state = self.state.lock();
        if state
            .ingress
            .as_ref()
            .is_some_and(|stream| stream.id() == handle)
        {
            state.close_capture();
        }
    }
    pub fn view(&self) -> VoiceChatView {
        self.view_unlocked(&self.state.lock())
    }

    /// Higher sensitivity accepts softer speech, including during reply interruption.
    pub fn set_vad_sensitivity(&self, sensitivity: u8) {
        self.state.lock().call.set_vad_sensitivity(sensitivity);
    }

    /// Standard builds use local VAD without loading or downloading a model.
    /// The optional smart-turn build feature permits explicit model installation.
    #[cfg_attr(
        not(feature = "smart-turn"),
        allow(
            clippy::unused_async,
            clippy::unused_async_trait_impl,
            reason = "Preserve the asynchronous UniFFI bridge when model inference is disabled"
        )
    )]
    pub async fn prepare(self: Arc<Self>, install: bool) -> Result<VoiceChatView, VoiceChatError> {
        if self.state.lock().call.view().phase == Phase::Closed {
            return Ok(self.view());
        }
        #[cfg(feature = "smart-turn")]
        {
            self.prepare_smart_turn(install).await
        }

        #[cfg(not(feature = "smart-turn"))]
        {
            let _ = install;
            let mut state = self.state.lock();
            if state.call.view().phase != Phase::Closed {
                state.update_call(|call| call.prepared(false));
            }
            drop(state);
            Ok(self.view())
        }
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
        if state.call.accepts_audio(input_id) {
            self.process_audio(&mut state, &samples);
        }
        drop(state);
        Ok(self.view())
    }

    /// Inference runs only when the optional smart-turn build feature is enabled.
    #[cfg_attr(
        not(feature = "smart-turn"),
        allow(
            clippy::unused_async,
            clippy::unused_async_trait_impl,
            reason = "Preserve the asynchronous UniFFI bridge when model inference is disabled"
        )
    )]
    pub async fn analyze(self: Arc<Self>, input_id: u64) -> Result<VoiceChatView, VoiceChatError> {
        #[cfg(feature = "smart-turn")]
        {
            self.analyze_smart_turn(input_id).await
        }

        #[cfg(not(feature = "smart-turn"))]
        {
            let _ = input_id;
            Ok(self.view())
        }
    }

    pub fn finish(&self) {
        self.state.lock().call.finish();
    }

    /// Optional model setup temporarily releases capture. Basic VAD remains usable.
    pub fn begin_preparation(&self) {
        self.state.lock().update_call(Call::begin_preparation);
    }

    pub fn use_vad(&self) {
        self.state.lock().update_call(Call::use_vad);
    }

    pub fn recognition(&self, input_id: u64, text: String) {
        let mut state = self.state.lock();
        let text = state.echo.filter(text, Instant::now());
        if state.update_call(|call| call.recognition(input_id, text)) {
            self.speech.reset_voice();
        }
    }

    /// Native word/PCM callbacks report audible chunks, including waiting fillers.
    pub fn playback_text(&self, text: String, active: bool) {
        let mut state = self.state.lock();
        if state.call.view().phase != Phase::Closed
            && text.len() <= voice_call_local::MAX_TEXT_BYTES
        {
            state.echo.observe(&text, active, Instant::now());
        }
    }

    /// Only a local turn boundary permits submission.
    /// An early recognizer final may update the text, but cannot commit a turn.
    pub fn recognition_ended(&self, input_id: u64) -> Result<VoiceChatView, VoiceChatError> {
        let mut state = self.state.lock();
        if let Some(turn) = state
            .update_call(|call| call.recognition_ended(input_id))
            .map_err(str::to_owned)?
        {
            state.record_turn(turn, self.now());
            self.speech.reset_voice();
        }
        drop(state);
        Ok(self.view())
    }

    pub fn take_prompt(&self) -> Option<String> {
        self.state.lock().call.take_prompt()
    }

    /// A composer message is already queued by the app. Follow its reply without
    /// submitting it again, using the same conversation and history boundary.
    pub fn submit_text(&self, text: String) -> Result<(), VoiceChatError> {
        let connection = self.state.lock().connection.clone();
        let receipt = connection
            .as_ref()
            .and_then(|c| c.queue.observe_text(&c.target_key, &text));
        let mut state = self.state.lock();
        state.echo.finish(Instant::now());
        if let Some(turn) = state
            .update_call(|call| call.submit_text(&text))
            .map_err(str::to_owned)?
        {
            state.record_turn(turn, self.now());
            state.receipt = receipt.map(|status| coordinator::Receipt {
                generation: state.coordinator.generation(),
                status,
                id: String::new(),
            });
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
        if baseline && matches!(state.call.view().phase, Phase::Waiting | Phase::Speaking) {
            return Err(
                "The agent transcript changed during this conversation. Reopen voice chat."
                    .to_owned()
                    .into(),
            );
        }
        self.accept_turns(&mut state, agent, !live, turns)?;
        drop(state);
        Ok(self.view())
    }

    pub fn next_speech(&self) -> Option<String> {
        let mut state = self.state.lock();
        match state.call.view().phase {
            Phase::Waiting if !state.call.view().response_skipped => state
                .waiting_filler
                .as_mut()
                .and_then(|filler| filler.next(Instant::now()))
                .map(str::to_owned),
            Phase::Speaking => self.next_reply(&mut state).map(|chunk| chunk.text),
            _ => None,
        }
    }

    /// Preserve original transcript part IDs and prose offsets for inline captions.
    pub fn next_speech_with_source(&self) -> Option<String> {
        let mut state = self.state.lock();
        if state.call.view().phase != Phase::Speaking {
            return None;
        }
        let chunk = self.next_reply(&mut state);
        drop(state);
        chunk.and_then(|chunk| serde_json::to_string(&chunk).ok())
    }

    pub fn speech_finished(&self) -> bool {
        self.state
            .lock()
            .call
            .speech_finished(self.speech.has_pending())
    }

    pub fn skip_response(&self) {
        let mut state = self.state.lock();
        state.echo.finish(Instant::now());
        if matches!(state.call.view().phase, Phase::Speaking | Phase::Waiting) {
            self.speech.reset_voice();
            state.coordinator.cancel();
            state.retire_receipt();
            state.update_call(Call::skip_response);
        }
    }

    pub fn playback_ended(&self) -> VoiceChatView {
        let mut state = self.state.lock();
        state.echo.finish(Instant::now());
        if let Some(generation) = state.call.generation() {
            state.update_call(|call| call.playback_ended(generation, self.speech.has_pending()));
        }
        drop(state);
        self.view()
    }

    pub fn set_muted(&self, muted: bool) -> VoiceChatView {
        let mut state = self.state.lock();
        state.update_call(|call| call.set_muted(muted));
        drop(state);
        self.view()
    }

    pub fn close(&self) {
        let mut state = self.state.lock();
        let pending = state.connection.clone().zip(state.receipt.take());
        state.update_call(Call::close);
        state.coordinator.close();
        drop(state);
        if let Some((connection, receipt)) = pending
            && !receipt.id.is_empty()
        {
            connection
                .queue
                .cancel_voice(&connection.target_key, &receipt.id);
        }
        self.flush_effects();
        self.observer.lock().take();
        transcript::unregister(self);
    }
}

impl VoiceChat {
    fn accept_turns(
        &self,
        state: &mut State,
        agent: AgentTranscriptKind,
        disconnected: bool,
        turns: Vec<VoiceChatTranscriptTurn>,
    ) -> Result<(), VoiceChatError> {
        if state.call.view().phase == Phase::Closed {
            return Ok(());
        }
        if disconnected {
            return Err(
                "The agent transcript disconnected. Reopen voice chat when it reconnects."
                    .to_owned()
                    .into(),
            );
        }
        state.observed_turns = turns.iter().map(|turn| turn.id.clone()).collect();
        state.observed_tail = turns.last().map(|turn| turn.id.clone());
        if !matches!(state.call.view().phase, Phase::Waiting | Phase::Speaking) {
            let State {
                baseline,
                observed_turns,
                ..
            } = state;
            baseline.clone_from(observed_turns);
            return Ok(());
        }
        // Typed enqueues require a native dispatch receipt before correlation.
        if state.connection.is_some()
            && state.submission_marker.is_none()
            && state.coordinator.delivery == Some(voice_call_local::coordinator::Delivery::Queued)
        {
            return Ok(());
        }
        if state
            .turn_id
            .as_ref()
            .is_some_and(|id| !turns.iter().any(|turn| &turn.id == id))
        {
            state.turn_id = None;
            state.coordinator.awaiting_turn(self.now());
        }
        if state.turn_id.is_none() {
            let expected = normalize_prompt(&state.expected);
            let anchor = state
                .baseline_anchor
                .as_ref()
                .map(|id| turns.iter().position(|t| &t.id == id));
            let candidates: Vec<_> = turns
                .iter()
                .enumerate()
                .filter(|(index, t)| {
                    state.submission_marker.as_ref().map_or_else(
                        || {
                            anchor.is_none_or(|anchor| anchor.is_some_and(|anchor| *index > anchor))
                                && !state.baseline.contains(&t.id)
                                && normalize_prompt(&t.user_text) == expected
                        },
                        |marker| t.user_text.contains(marker),
                    )
                })
                .map(|(_, t)| t)
                .collect();
            if candidates.len() == 1 {
                state.turn_id = Some(candidates[0].id.clone());
            }
            log::info!(
                "LocalVoice correlation generation={} revision={:?} candidates={} matched={}",
                state.coordinator.generation(),
                state.source.as_ref().and_then(|s| s.revision),
                candidates.len(),
                state.turn_id.is_some()
            );
        }
        // Keep the submission's history fixed while matching the reply. A
        // turn-upsert may precede its user message; observing that placeholder
        // must not turn the pending response into historical speech.
        if let Some(turn) = turns
            .into_iter()
            .find(|t| state.turn_id.as_ref() == Some(&t.id))
        {
            if !turn.user_text.trim().is_empty()
                && state
                    .submission_marker
                    .as_ref()
                    .is_some_and(|marker| !turn.user_text.contains(marker))
            {
                return Err("Another input replaced the matched agent turn. Check the transcript before continuing.".to_owned().into());
            }
            state.coordinator.observed(self.now());
            let event = crate::voice_history::Event::new(
                "delegation",
                match agent {
                    AgentTranscriptKind::Claude => "Claude",
                    AgentTranscriptKind::Codex => "Codex",
                    AgentTranscriptKind::OpenCode => "OpenCode",
                    AgentTranscriptKind::Pi => "Pi",
                },
                if turn.failed {
                    "failed"
                } else if turn.completed && turn.messages.iter().any(|message| message.assistant) {
                    "completed"
                } else {
                    "running"
                },
            );
            let id = state.delegation_id.clone();
            state.history.event(&id, event);
            if turn.tools_json.len() > 1024 * 1024 {
                return Err("Voice transcript tool details are too large"
                    .to_owned()
                    .into());
            }
            let tools: Vec<TranscriptTool> = serde_json::from_str(&turn.tools_json)
                .map_err(|_| "Invalid voice transcript tool details".to_owned())?;
            for tool in tools.into_iter().take(64) {
                state
                    .history
                    .event(&format!("tool:{}:{}", turn.id, tool.id), tool.event);
            }
            if turn.failed {
                return Err("The agent turn was interrupted or failed. Check the transcript before continuing.".to_owned().into());
            }
            // OpenCode can publish an idle user-only turn before the assistant
            // exists. That acknowledges our prompt, not a completed response.
            let completed = state.call.view().response_completed
                || (turn.completed && turn.messages.iter().any(|message| message.assistant));
            if !state.call.view().response_skipped {
                self.speech.update_voice(agent, turn.messages, completed);
            }
            if state.connection.is_some() {
                self.collect_reply(state);
                if completed {
                    state.coordinator.completed(self.now());
                }
            }
            let pending = self.speech.has_pending() || state.coordinator.queue_depth() > 0;
            if let Some(generation) = state.call.generation() {
                state.update_call(|call| {
                    call.assistant_progress(generation, completed, pending);
                });
            }
        }
        Ok(())
    }

    fn next_reply(&self, state: &mut State) -> Option<crate::chat_speech::ChatSpeechChunk> {
        let chunk = self.speech.next_content()?;
        state.history.assistant(&chunk.text);
        Some(chunk)
    }

    fn process_audio(&self, state: &mut State, samples: &[f32]) {
        let input_id = state.call.view().input_id;
        if state.update_call(|call| call.audio(input_id, samples)) {
            self.speech.reset_voice();
        }
    }

    fn view_unlocked(&self, s: &State) -> VoiceChatView {
        let view = s.call.view();
        VoiceChatView {
            phase: view.phase.into(),
            input_id: view.input_id,
            muted: view.muted,
            smart_turn: view.smart_turn,
            text: view.text.clone(),
            level: view.level,
            silence_ms: s.call.silence_ms(),
            audio_error: s
                .audio_error
                .clone()
                .or_else(|| s.coordinator.error.map(str::to_owned)),
            analyze: s.call.should_probe(),
            downloaded_bytes: self.downloaded.load(Ordering::Relaxed),
            total_bytes: MODEL_BYTES,
            events_json: s.history.events_json(),
            coordination_json: serde_json::json!({
                "call": self.id.to_string(),
                "generation": s.coordinator.generation().to_string(),
                "stage": format!("{:?}", s.coordinator.stage),
                "delivery": s.coordinator.delivery.map(|delivery| format!("{delivery:?}")),
                "queueDepth": s.coordinator.queue_depth(),
                "source": s.source.as_ref().map(|source| format!("{:x}", Sha256::digest(source.binding.as_bytes()))),
                "epoch": s.source.as_ref().map(|source| source.epoch.to_string()),
                "revision": s.source.as_ref().and_then(|source| source.revision).map(|revision| revision.to_string()),
                "live": s.source.as_ref().is_some_and(|source| source.live),
            }).to_string(),
        }
    }

    #[cfg(feature = "smart-turn")]
    async fn prepare_smart_turn(
        self: Arc<Self>,
        install: bool,
    ) -> Result<VoiceChatView, VoiceChatError> {
        let path = self.root.join(MODEL_FILE);
        let check_path = path.clone();
        let valid = crate::runtime()?
            .spawn_blocking(move || verify_model(&check_path))
            .await
            .map_err(|e| e.to_string())?;
        if !valid && !install {
            let mut state = self.state.lock();
            if state.call.view().phase != Phase::Closed {
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
        if state.call.view().phase != Phase::Closed {
            state.update_call(|call| call.prepared(true));
        }
        drop(state);
        Ok(self.view())
    }

    #[cfg(feature = "smart-turn")]
    async fn analyze_smart_turn(
        self: Arc<Self>,
        input_id: u64,
    ) -> Result<VoiceChatView, VoiceChatError> {
        let probe = {
            let mut state = self.state.lock();
            let Some(probe) = state.call.begin_probe(input_id) else {
                return Ok(self.view_unlocked(&state));
            };
            probe
        };
        let session = self.clone();
        let (probe, probability) = crate::runtime()?
            .spawn_blocking(move || {
                let probability = session
                    .model
                    .lock()
                    .as_mut()
                    .ok_or_else(|| "Smart Turn is not ready".to_owned())?
                    .predict(&probe.audio)?;
                Ok::<_, String>((probe, probability))
            })
            .await
            .map_err(|e| e.to_string())??;
        let mut state = self.state.lock();
        state.call.complete_probe(&probe, probability);
        drop(state);
        Ok(self.view())
    }

    #[cfg(feature = "smart-turn")]
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
    #[cfg(feature = "smart-turn")]
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
            if self.state.lock().call.view().phase == Phase::Closed {
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

#[cfg(feature = "smart-turn")]
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

fn normalize_prompt(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
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

    #[cfg(not(feature = "smart-turn"))]
    #[tokio::test]
    async fn disabled_smart_turn_ignores_install_requests_and_existing_model_files() {
        let directory = tempfile::tempdir().unwrap();
        let model_path = directory.path().join("smart-turn-v3.2-gpu.onnx");
        let existing_model = b"Previously downloaded model data";
        std::fs::write(&model_path, existing_model).unwrap();

        for install in [false, true] {
            let session = VoiceChat::new(directory.path().to_string_lossy().into_owned());
            let view = session.clone().prepare(install).await.unwrap();
            assert_eq!(view.phase, VoiceChatPhase::Listening);
            assert!(!view.smart_turn);
            assert!(!view.analyze);
            assert_eq!(view.downloaded_bytes, 0);
            assert_eq!(view.total_bytes, 0);
            let view = session.clone().analyze(view.input_id).await.unwrap();
            assert_eq!(view.phase, VoiceChatPhase::Listening);
            session.close();
            assert_eq!(
                session.prepare(install).await.unwrap().phase,
                VoiceChatPhase::Closed
            );
            assert_eq!(std::fs::read(&model_path).unwrap(), existing_model);
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        }
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
            tools_json: "[]".into(),
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
                .checked_sub(waiting_filler::INITIAL_DELAY)
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
    fn local_history_records_user_and_reply_without_waiting_filler_or_old_agent_history() {
        let session = conversation();
        submit(&session, "Hello");
        make_filler_due(&session);
        assert!(session.next_speech().is_some());
        session
            .transcript(
                AgentTranscriptKind::Codex,
                true,
                false,
                vec![
                    turn("old", "Historical question", true),
                    turn("reply", "Hello", true),
                ],
            )
            .unwrap();
        assert_eq!(session.next_speech().as_deref(), Some("A spoken reply."));
        let saved = std::mem::take(&mut session.state.lock().history).into_captions();
        let speech: Vec<_> = saved
            .iter()
            .filter(|message| message.event.is_none())
            .collect();
        assert_eq!(speech.len(), 2);
        assert_eq!(speech[0].role, "user");
        assert_eq!(speech[0].text, "Hello");
        assert_eq!(speech[1].role, "assistant");
        assert_eq!(speech[1].text, "A spoken reply.");
        assert!(saved.iter().any(|message| {
            message
                .event
                .as_ref()
                .is_some_and(|event| event.kind == "delegation" && event.status == "completed")
        }));
        session.close();
        session.close();
    }

    #[test]
    fn local_tool_events_follow_the_bound_turn_and_remain_silent() {
        let session = conversation();
        submit(&session, "Hello");
        let mut current = turn("reply", "Hello", true);
        current.tools_json = r#"[{"id":"exec","kind":"tool","name":"shell","status":"completed","input":"cargo check","output":"passed"}]"#.into();
        session
            .transcript(AgentTranscriptKind::Codex, true, false, vec![current])
            .unwrap();
        assert!(session.view().events_json.contains("cargo check"));
        assert!(session.view().events_json.contains("passed"));
        assert_eq!(session.next_speech().as_deref(), Some("A spoken reply."));
        assert!(session.next_speech().is_none());
        let saved = std::mem::take(&mut session.state.lock().history).into_captions();
        assert!(saved.iter().any(
            |message| message.event.as_ref().is_some_and(
                |event| event.kind == "tool" && event.output.as_deref() == Some("passed")
            )
        ));
        session.close();
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
    fn unchanged_unmuted_notifications_preserve_capture_and_the_pending_turn() {
        let session = conversation();
        let id = session.view().input_id;
        // Telecom can report the same mute value again when the initial
        // Bluetooth route connects. This must not replace a starting capture.
        for _ in 0..2 {
            assert_eq!(session.set_muted(false).input_id, id);
        }
        session.recognition(id, "Can you hear me".into());
        assert_eq!(session.set_muted(false).text, "Can you hear me");
        session.finish();
        let finishing = session.set_muted(false);
        assert_eq!(finishing.phase, VoiceChatPhase::Finishing);
        assert_eq!(finishing.input_id, id);
        session.recognition_ended(id).unwrap();
        let waiting = session.view();
        assert_eq!(session.set_muted(false).input_id, waiting.input_id);
        assert_eq!(session.take_prompt().as_deref(), Some("Can you hear me"));
        assert!(session.take_prompt().is_none());
    }

    #[test]
    fn unchanged_muted_notifications_do_not_create_another_input() {
        let session = conversation();
        let muted = session.set_muted(true);
        assert_eq!(muted.phase, VoiceChatPhase::Muted);
        assert_eq!(session.set_muted(true).input_id, muted.input_id);
        let listening = session.set_muted(false);
        assert_eq!(listening.phase, VoiceChatPhase::Listening);
        assert_ne!(listening.input_id, muted.input_id);
        assert_eq!(session.set_muted(false).input_id, listening.input_id);
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
    fn audible_reply_echo_cannot_interrupt_or_become_the_next_prompt() {
        let session = awaiting_or_playing_reply(true);
        let id = session.view().input_id;
        session.playback_text("First sentence. Complete reply.".into(), true);
        session.recognition(id, "First".into());
        feed_microphone_fixture(&session, id);
        assert_eq!(session.view().phase, VoiceChatPhase::Speaking);
        assert!(session.view().text.is_empty());
        session.playback_text("First sentence. Complete reply.".into(), false);
        session.recognition(id, "First sentence".into());
        assert!(session.view().text.is_empty());
        assert!(session.take_prompt().is_none());
        session.recognition(id, "First change the plan".into());
        assert_eq!(session.view().phase, VoiceChatPhase::Listening);
        assert_eq!(session.view().text, "First change the plan");
        session.finish();
        session.recognition_ended(id).unwrap();
        assert_eq!(
            session.take_prompt().as_deref(),
            Some("First change the plan")
        );
    }

    #[test]
    fn voice_chunks_keep_original_transcript_identity_for_inline_highlighting() {
        let session = awaiting_or_playing_reply(true);
        let chunk = session.next_speech_with_source().unwrap();
        let chunk: serde_json::Value = serde_json::from_str(&chunk).unwrap();
        assert_eq!(chunk["text"], "First sentence.");
        assert_eq!(chunk["partId"], "prose");
        assert_eq!(chunk["startUtf16"], 0);
        assert!(chunk["messageId"].as_str().is_some_and(|id| !id.is_empty()));
        assert!(session.next_speech().is_none());
    }

    #[test]
    fn long_voice_replies_keep_natural_pauses_and_original_caption_offsets() {
        let session = conversation();
        submit(&session, "Read this reply");
        let response =
            "Hello 👋. This sentence keeps all its words together at a natural pause. ".repeat(8);
        session
            .transcript(
                AgentTranscriptKind::Codex,
                true,
                false,
                vec![streamed_turn("reply", "Read this reply", &response, true)],
            )
            .unwrap();
        let prose = crate::chat_speech::spoken_prose(&response);
        let units = prose.encode_utf16().collect::<Vec<_>>();
        let mut chunks = Vec::new();
        while let Some(json) = session.next_speech_with_source() {
            let chunk: serde_json::Value = serde_json::from_str(&json).unwrap();
            let text = chunk["text"].as_str().unwrap();
            let start = usize::try_from(chunk["startUtf16"].as_u64().unwrap()).unwrap();
            let expected = text.encode_utf16().collect::<Vec<_>>();
            assert_eq!(&units[start..start + expected.len()], expected);
            assert!(text.ends_with('.'));
            assert!(
                text.chars().count() < 200,
                "Each call chunk should fit a short audio reserve"
            );
            chunks.push(text.to_owned());
        }
        assert!(chunks.len() > 1);
        assert_eq!(chunks.join(" "), prose);
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
