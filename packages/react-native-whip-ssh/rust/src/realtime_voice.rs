//! Public OpenAI Realtime WebRTC/WebSocket adapter. Native media never crosses JS.
//! The actor owns all wire writes; dropping it cancels transport and tools.
mod captions;
pub(crate) mod context;
mod cost;
mod delegation;
mod echo;
pub(crate) mod feedback;
mod ffi;
pub(crate) mod handoff_context;
mod models;
mod processing;
mod recovery;
mod response;
mod socket;
mod startup;
#[cfg(test)]
mod tests;
mod transcript;
mod webrtc;
mod wire;

use std::collections::{HashSet, VecDeque};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use futures::{SinkExt, StreamExt};
use oai_rt_rs::{ClientEvent, ServerEvent};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::{
    Message, client::IntoClientRequest, protocol::WebSocketConfig,
};

use crate::host_runtime::realtime_agent::{
    AgentTarget, BACKGROUND_AGENT, PinnedAgent, REMAIN_SILENT,
};
use captions::Language as TranscriptionLanguage;

pub(super) const RATE: usize = 24_000;
pub(super) const FRAME: usize = RATE / 50;
const MAX_OUTPUT: usize = RATE * 30;
const MAX_WIRE: usize = 512 * 1024;
const MAX_TEXT: usize = 16 * 1024;
const MAX_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_CALLS: usize = 128;
const IO_TIMEOUT: Duration = Duration::from_secs(10);
static EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const INSTRUCTIONS: &str = include_str!("realtime_voice/instructions.md");
// Adapted from Codex's realtime_websocket/methods_v2.rs default tool description
// at 93b4e5b4c6474cdbf12614c4ac3acbd006fbee89 (Apache-2.0).
const PROMPT_DESCRIPTION: &str = "Send the user's own request to the bound coding agent. Use this as the default action for tasks, research, browsing and current information. If idle, start a task; if Codex is working, send guidance to steer it. Set delivery to later only when the user asks for work next, later, after this or once current work finishes. Later requests enter this call's bounded queue and are submitted in order when the agent settles; ending the call cancels unsent work. Briefly acknowledge intent, keep listening for corrections, and never retry an uncertain submission. Admission is not task completion.";
const PREVIEW_TIMEOUT: Duration = Duration::from_secs(30);
const PREVIEW_TOKEN_LIMIT: u32 = 256;
const PREVIEW_AUDIO_LIMIT: usize = RATE * 12;
const PREVIEW_INSTRUCTIONS: &str = "Read this sample exactly once, without adding anything: Hello! I'm here to help. What would you like to work on?";
const VOICES: &[&str] = &[
    "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
];

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Config {
    #[serde(default)]
    client_elapsed_ms: u64,
    #[serde(default)]
    webrtc: bool,
    target: Option<AgentTarget>,
    #[serde(default)]
    model: Option<String>,
    voice: String,
    vad: Option<Vad>,
    #[serde(default)]
    language: TranscriptionLanguage,
    #[serde(default)]
    preview: bool,
    #[serde(default)]
    software_echo_cancellation: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Vad {
    ServerVad {
        threshold: f32,
        prefix_padding_ms: u32,
        silence_duration_ms: u32,
    },
}

impl Config {
    fn model(&self) -> Result<&'static models::Model, &'static str> {
        models::selected(self.model.as_deref())
    }

    fn validate_model(&self, confirmed: &str) -> Result<(), &'static str> {
        if self.model()?.accepts(confirmed) {
            Ok(())
        } else {
            Err(models::MISMATCH)
        }
    }

    fn validate_audio(&self, audio: oai_rt_rs::AudioConfig) -> Result<(), &'static str> {
        let input = audio.input.ok_or("OpenAI did not negotiate input audio.")?;
        let output = audio
            .output
            .ok_or("OpenAI did not negotiate output audio.")?;
        if input.format != Some(oai_rt_rs::AudioFormat::pcm_24khz())
            || output.format != Some(oai_rt_rs::AudioFormat::pcm_24khz())
            || output.voice.as_ref().map(ToString::to_string).as_deref()
                != Some(self.voice.as_str())
        {
            return Err("OpenAI did not accept the selected voice or PCM format.");
        }
        let accepted = serde_json::to_value(input.turn_detection)
            .map_err(|_| "Invalid Realtime VAD confirmation.")?;
        if self.preview {
            return if accepted["type"] == "server_vad"
                && accepted["create_response"] == false
                && accepted["interrupt_response"] == false
            {
                Ok(())
            } else {
                Err("OpenAI did not accept preview server VAD settings.")
            };
        }
        let requested =
            serde_json::to_value(&self.vad).map_err(|_| "Invalid Realtime VAD settings.")?;
        if !requested.as_object().is_some_and(|fields| {
            fields
                .iter()
                .all(|(key, value)| accepted.get(key) == Some(value))
        }) || accepted["create_response"] != true
            || accepted["interrupt_response"] != true
        {
            return Err("OpenAI did not accept the selected Realtime VAD settings.");
        }
        Ok(())
    }

    fn session_update(&self) -> Result<ClientEvent, &'static str> {
        self.model()?;
        if !VOICES.contains(&self.voice.as_str()) {
            return Err("Choose a supported OpenAI Realtime voice.");
        }
        if self.preview {
            if self.target.is_some() {
                return Err("Voice previews cannot connect to an agent.");
            }
            return typed(json!({"type":"session.update","session":{
                "type":"realtime", "output_modalities":["audio"], "max_output_tokens":PREVIEW_TOKEN_LIMIT,
                "instructions":PREVIEW_INSTRUCTIONS,
                "audio":{"input":{"format":{"type":"audio/pcm","rate":RATE},"turn_detection":{"type":"server_vad","create_response":false,"interrupt_response":false}},
                    "output":{"format":{"type":"audio/pcm","rate":RATE},"voice":self.voice}},
                "tools":[], "tool_choice":"none"
            }}));
        }
        if self.target.is_none() || self.vad.is_none() {
            return Err("Realtime calls require a bound agent and turn detection settings.");
        }
        if let Some(Vad::ServerVad {
            threshold,
            prefix_padding_ms,
            silence_duration_ms,
        }) = self.vad
            && (!threshold.is_finite()
                || !(0.0..=1.0).contains(&threshold)
                || prefix_padding_ms > 2000
                || !(100..=3000).contains(&silence_duration_ms))
        {
            return Err("Invalid Realtime VAD settings.");
        }
        let mut vad =
            serde_json::to_value(&self.vad).map_err(|_| "Invalid Realtime VAD settings.")?;
        vad["create_response"] = json!(true);
        vad["interrupt_response"] = json!(true);
        typed(json!({"type":"session.update","session":{
            "type":"realtime", "output_modalities":["audio"], "max_output_tokens":512,
            "instructions":INSTRUCTIONS,
            "audio":{"input":{"format":{"type":"audio/pcm","rate":RATE},"turn_detection":vad,
                "noise_reduction":{"type":"near_field"},
                "transcription":captions::settings(self.language)},
                "output":{"format":{"type":"audio/pcm","rate":RATE},"voice":self.voice}},
            "tools":[
                {"type":"function","name":BACKGROUND_AGENT,"description":PROMPT_DESCRIPTION,"parameters":{"type":"object","properties":{"prompt":{"type":"string","maxLength":8192},"delivery":{"type":"string","enum":["now","later"],"description":"Default now: start or steer. Choose later only for an explicit request to defer work."}},"required":["prompt"],"additionalProperties":false}},
                silence_tool()
            ],"tool_choice":"auto"
        }}))
    }
}

fn typed(value: Value) -> Result<ClientEvent, &'static str> {
    serde_json::from_value(value).map_err(|_| "Invalid Realtime event.")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct View {
    phase: &'static str,
    muted: bool,
    level: f32,
    playback_level: f32,
    text: String,
    user_text: String,
    error: Option<&'static str>,
    input_tokens: u64,
    output_tokens: u64,
    estimated_usd: Option<f64>,
    tool: Option<String>,
    captions: Option<captions::Diagnostics>,
    messages: Vec<transcript::Message>,
    startup: startup::Timings,
    media_ready: bool,
    recovery: recovery::State,
    startup_attempt: u64,
    capture_packets: u64,
    capture_gaps: u64,
}

struct Output {
    transcript: transcript::Transcript,
    epoch: u64,
    samples: VecDeque<i16>,
    item: Option<(String, u32)>,
    played: usize,
    delivered: usize,
    generated: usize,
}
impl Default for Output {
    fn default() -> Self {
        Self {
            transcript: transcript::Transcript::default(),
            epoch: 1,
            samples: VecDeque::new(),
            item: None,
            played: 0,
            delivered: 0,
            generated: 0,
        }
    }
}
impl Output {
    fn clear(&mut self) {
        if let Some((item, index)) = &self.item {
            self.transcript.stop_item(item, *index);
        }
        self.epoch += 1;
        self.samples.clear();
        self.item = None;
        self.played = 0;
        self.delivered = 0;
        self.generated = 0;
    }
    fn append(&mut self, item: String, index: u32, pcm: Vec<u8>) -> Result<(), &'static str> {
        if !pcm.len().is_multiple_of(2) {
            return Err("OpenAI returned an invalid PCM frame.");
        }
        if !self
            .item
            .as_ref()
            .is_some_and(|(id, content)| *id == item && *content == index)
        {
            // An item boundary cannot replace audio still playing on the device.
            if self.delivered > self.played || !self.samples.is_empty() {
                return Err("Realtime audio items overlapped. Please call again.");
            }
            self.clear();
            self.item = Some((item, index));
        }
        let count = pcm.len() / 2;
        if self.generated - self.played + count > MAX_OUTPUT {
            return Err("Realtime playback fell behind. Please call again.");
        }
        self.generated += count;
        if let Some((item, index)) = &self.item {
            self.transcript.audio(item, *index, self.generated);
        }
        self.samples.extend(
            pcm.as_chunks::<2>()
                .0
                .iter()
                .copied()
                .map(i16::from_le_bytes),
        );
        Ok(())
    }
    fn read(&mut self, out: &mut [i16]) -> usize {
        let count = out.len().min(self.samples.len());
        for sample in &mut out[..count] {
            *sample = self.samples.pop_front().unwrap_or_default();
        }
        self.delivered += count;
        count
    }
    fn acknowledge(&mut self, epoch: u64, count: usize) {
        if epoch == self.epoch {
            self.played = self.played.max(count.min(self.delivered));
            if let Some((item, index)) = &self.item {
                self.transcript.played(item, *index, self.played);
            }
        }
    }
    fn interrupt(&mut self) -> Option<ClientEvent> {
        self.transcript.stop();
        let event = self.item.take().map(|(item_id, content_index)| {
            ClientEvent::ConversationItemTruncate {
                event_id: None,
                item_id,
                content_index,
                audio_end_ms: u32::try_from(self.played * 1000 / RATE).unwrap_or(u32::MAX),
            }
        });
        self.clear();
        event
    }
}

pub(super) enum Command {
    Skip,
    Mute(bool),
}
pub(super) struct RealtimeVoiceAdapter {
    started_at: Instant,
    client_elapsed_ms: u64,
    webrtc: bool,
    media: Mutex<Option<webrtc::Handle>>,
    view: Mutex<View>,
    output: Mutex<Output>,
    echo: Mutex<Option<echo::MediaEchoCanceller>>,
    commands: mpsc::Sender<Command>,
    input: Arc<crate::audio_ingress::NativeIngress>,
    cancel: watch::Sender<bool>,
    closed: AtomicBool,
    ready: AtomicBool,
    stopped: AtomicBool,
    attempt: AtomicU64,
    devices_ready: AtomicBool,
    allow_input: bool,
    speech: crate::speech_playback::RealtimeSpeechLease,
}
enum StartError {
    Session,
    Credential(native_credentials::CredentialError),
}
impl From<&'static str> for StartError {
    fn from(_: &'static str) -> Self {
        Self::Session
    }
}
impl RealtimeVoiceAdapter {
    fn start(
        config: Config,
        credentials: impl FnOnce() -> Result<
            native_credentials::NativeCredential,
            native_credentials::CredentialError,
        >,
    ) -> Result<Arc<Self>, StartError> {
        let started_at = Instant::now();
        let mut update = config.session_update()?;
        let agent = config
            .target
            .clone()
            .map(PinnedAgent::pin)
            .transpose()
            .map_err(|_| "Open the connected agent chat before starting Realtime.")?;
        if let Some(context) = agent
            .as_ref()
            .map(|agent| agent.startup_context())
            .transpose()
            .map_err(|_| "The bound chat context is unavailable. Refresh it before calling.")?
            .flatten()
            && !context.is_empty()
        {
            let mut value =
                serde_json::to_value(update).map_err(|_| "Voice configuration failed.")?;
            value["session"]["instructions"] = json!(format!("{INSTRUCTIONS}\n\n{context}"));
            update = typed(value)?;
        }
        let speech = crate::speech_playback::RealtimeSpeechLease::claim(config.preview)
            .ok_or("Another speech session is active. Finish it before previewing.")?;
        let (commands, command_rx) = mpsc::channel(8);
        let input = crate::audio_ingress::NativeIngress::realtime(
            u32::try_from(RATE).map_err(|_| "Invalid capture rate.")?,
            FRAME * 4,
            32,
        )?;
        input.set_muted(config.preview);
        let (cancel, mut cancellation) = watch::channel(false);
        let adapter = Arc::new(Self {
            started_at,
            client_elapsed_ms: config.client_elapsed_ms,
            webrtc: config.webrtc,
            media: Mutex::new(None),
            view: Mutex::new(View {
                phase: "starting",
                muted: config.preview,
                level: 0.0,
                playback_level: 0.0,
                text: String::new(),
                user_text: String::new(),
                error: None,
                input_tokens: 0,
                output_tokens: 0,
                estimated_usd: None,
                messages: Vec::new(),
                startup: startup::Timings::default(),
                media_ready: false,
                recovery: recovery::State::Starting,
                startup_attempt: 0,
                capture_packets: 0,
                capture_gaps: 0,
                tool: None,
                captions: (!config.preview)
                    .then(|| captions::Diagnostics::pending(config.language)),
            }),
            output: Mutex::new(Output::default()),
            echo: Mutex::new(
                config
                    .software_echo_cancellation
                    .then(echo::MediaEchoCanceller::new)
                    .transpose()?,
            ),
            commands,
            input,
            cancel,
            closed: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            attempt: AtomicU64::new(0),
            devices_ready: AtomicBool::new(false),
            allow_input: !config.preview,
            speech,
        });
        let owner = adapter.clone();
        let runtime = crate::runtime().map_err(|_| "Realtime runtime could not start.")?;
        adapter.view.lock().startup.preparation = Some(startup::elapsed(started_at));
        let credential_start = Instant::now();
        let key = credentials().map_err(StartError::Credential)?;
        adapter.view.lock().startup.credentials = Some(startup::elapsed(credential_start));
        runtime.spawn(async move {
                let mut tools: JoinSet<ToolCompletion> = JoinSet::new();
                // Keep driving startup through cancellation: an in-flight POST
                // may create a call whose identity must be read and retired.
                let connection = owner.prepare_connection(&config, &key, update, agent.as_ref()).await;
                drop(key);
                let result = match connection {
                    Ok((socket, configuration_started)) if !owner.closed.load(Ordering::Acquire) => tokio::select! {
                    biased;
                    _ = cancellation.changed() => Ok(()),
                result = owner.run(config, socket, configuration_started, agent, command_rx, &mut tools) => result,
                    },
                    Ok(_) => Ok(()),
                    Err(_) if owner.closed.load(Ordering::Acquire) => Ok(()),
                    Err(error) => Err(error),
                };
                tools.shutdown().await;
                if let Err(message) = result {
                    owner.fail(message);
                }
                owner.ready.store(false, Ordering::Release);
                let media = owner.media.lock().take();
                if let Some(media) = media { let _ = media.close().await; }
                owner.output.lock().clear();
                owner.speech.release();
                {
                    let mut view = owner.view.lock();
                    view.recovery = recovery::State::Ended;
                    view.media_ready = false;
                }
                owner.stopped.store(true, Ordering::Release);
            });
        Ok(adapter)
    }

    fn fail(&self, error: &'static str) {
        let mut view = self.view.lock();
        if !self.closed.swap(true, Ordering::AcqRel) {
            view.phase = "error";
            view.recovery = recovery::State::Ended;
            view.error = Some(error);
            view.level = 0.0;
            view.playback_level = 0.0;
            view.estimated_usd = None;
        }
        drop(view);
        self.output.lock().clear();
        self.cancel.send_replace(true);
    }
    fn close(&self) {
        self.input.close();
        {
            let mut view = self.view.lock();
            self.closed.store(true, Ordering::Release);
            self.ready.store(false, Ordering::Release);
            view.media_ready = false;
            view.recovery = recovery::State::Ended;
            if view.phase != "error" {
                view.phase = "closed";
            }
        }
        self.cancel.send_replace(true);
        self.output.lock().clear();
    }
    fn command(&self, command: Command) {
        if !self.ready.load(Ordering::Acquire)
            && let Command::Mute(muted) = &command
        {
            self.view.lock().muted = *muted;
            return;
        }
        if !self.closed.load(Ordering::Acquire) && self.commands.try_send(command).is_err() {
            self.fail("Realtime control queue is full. Please call again.");
        }
    }
    fn capture(&self, samples: &[i16], generation: u64, at: Instant) -> bool {
        if !self.allow_input {
            return false;
        }
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        if !self.speech.is_current() {
            self.fail("Voice audio was replaced by another speech session.");
            return false;
        }
        if samples.len() > FRAME * 4 {
            self.fail("The microphone returned an oversized audio frame.");
            return false;
        }
        if !self.ready.load(Ordering::Acquire)
            || self.view.lock().muted
            || !self.input.accepts(generation)
        {
            return true;
        }
        match self.input.push(generation, at, samples) {
            Ok(())
            | Err(
                ::audio_ingress::Error::Stale
                | ::audio_ingress::Error::Closed
                | ::audio_ingress::Error::Overflow
                | ::audio_ingress::Error::Busy
                | ::audio_ingress::Error::Expired,
            ) => true,
            Err(_) => {
                self.fail("Realtime microphone delivery fell behind.");
                false
            }
        }
    }

    async fn next_capture(
        &self,
        packet: &mut ::audio_ingress::Packet,
    ) -> Result<bool, &'static str> {
        if self.input.receive(packet).await? {
            if let Some(echo) = self.echo.lock().as_mut() {
                echo.reset_capture()?;
            }
            return Ok(true);
        }
        if !self.input.accepts(packet.ticket.generation)
            || !self.ready.load(Ordering::Acquire)
            || self.view.lock().muted
        {
            packet.samples.clear();
            return Ok(false);
        }
        // Echo processing runs on the consumer, outside the device callback.
        let cleaned = self
            .echo
            .lock()
            .as_mut()
            .map(|echo| echo.capture(&packet.samples, packet.at, Instant::now()))
            .transpose()?;
        if let Some(cleaned) = cleaned {
            packet.samples.clear();
            packet.samples.extend(cleaned);
        }
        if !self.input.accepts(packet.ticket.generation) {
            packet.samples.clear();
        }
        self.view.lock().level = peak(&packet.samples);
        Ok(false)
    }

    async fn send_capture(
        &self,
        socket: &mut RealtimeSocket,
        capture: &::audio_ingress::Packet,
    ) -> Result<(), &'static str> {
        if capture.samples.is_empty() {
            return Ok(());
        }
        let bytes: Vec<u8> = capture
            .samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        send(
            socket,
            ClientEvent::InputAudioBufferAppend {
                event_id: None,
                audio: STANDARD.encode(bytes),
            },
        )
        .await?;
        self.view.lock().startup.first_input.get_or_insert_with(|| {
            self.client_elapsed_ms
                .saturating_add(startup::elapsed(self.started_at))
        });
        Ok(())
    }

    async fn run(
        self: &Arc<Self>,
        config: Config,
        mut socket: RealtimeSocket,
        configuration_started: Instant,
        agent: Option<Arc<PinnedAgent>>,
        mut commands: mpsc::Receiver<Command>,
        tools: &mut JoinSet<ToolCompletion>,
    ) -> Result<(), &'static str> {
        let started = tokio::time::Instant::now();
        let mut heartbeat = tokio::time::interval(Duration::from_millis(250));
        let mut capture = ::audio_ingress::Packet::new(self.input.packet_samples);
        let mut responses = response::ResponseCreateQueue::default();
        let mut costs = cost::CurrentChat::new(config.model()?);
        let mut input_item = String::new();
        let mut ignored = HashSet::new();
        let mut ledger = ToolLedger::default();
        let mut last_pong = tokio::time::Instant::now();
        let mut ping_at = last_pong;
        let mut preview_done = false;
        let mut preview_requested = false;
        let mut seen = wire::Seen::default();
        let mut handoff: Option<feedback::Handoff> = None;
        let mut deferred = delegation::Deferred::default();
        let context = handoff_context::Context::default();
        let mut last_audio_response = None;
        loop {
            if self.closed.load(Ordering::Acquire) {
                return Ok(());
            }
            tokio::select! {
                command = commands.recv() => match command {
                    Some(Command::Skip) => {
                        if let Some(media) = self.media.lock().as_ref() { media.cancel_audio(responses.active().map(String::as_str)); }
                        if let Some(id) = responses.active().cloned() { ignored.insert(id.clone()); send(&mut socket, ClientEvent::ResponseCancel { event_id: None, response_id: Some(id) }).await?; }
                        let event = self.output.lock().interrupt();
                        if config.webrtc { send(&mut socket, ClientEvent::OutputAudioBufferClear { event_id: None }).await?; } else if let Some(event) = event { send(&mut socket, event).await?; }
                        self.view.lock().playback_level = 0.0;
                        self.view.lock().phase = "listening";
                    }
                    Some(Command::Mute(muted)) => {
                        if muted { self.view.lock().muted = true; }
                        self.view.lock().level = 0.0;
                        { let mut echo = self.echo.lock(); if let Some(echo) = echo.as_mut() { echo.reset_capture()?; } }
                        send(&mut socket, ClientEvent::InputAudioBufferClear { event_id: None }).await?;
                        responses.clear_input();
                        self.view.lock().muted = muted;
                    }
                    None => return Ok(()),
                },
                result = tools.join_next(), if !tools.is_empty() => {
                    let ToolCompletion { call_id, deferred: was_deferred, mut value } = result.ok_or("Realtime tool task ended.")?.map_err(|_| "Realtime tool task failed.")?;
                    let agent = agent.as_ref().ok_or("Voice previews cannot execute tools.")?;
                    agent.check_liveness().map_err(|_| "The bound agent disconnected or changed. Please call again.")?;
                    let uncertain = value.get("error").and_then(Value::as_str) == Some("outcome_unknown");
                    ledger.complete(true, uncertain);
                    if was_deferred { deferred.finish(); }
                    self.view.lock().tool = None;
                    if let Some(handoff) = handoff.as_mut() {
                        forward_feedback(&mut socket, agent, handoff).await?;
                        value["handoff_role"] = json!(if handoff.call_id == call_id {"original"} else {"followup"});
                    }
                    if uncertain {
                        agent.mark_uncertain();
                        let cancelled = deferred.cancel();
                        if cancelled > 0 {
                            send(&mut socket, feedback_message("Unsent deferred requests were cancelled because a submission outcome is unknown. Inspect the agent before submitting again.")?).await?;
                        }
                    }
                    if value.get("error").is_none() && value["completion"] != "submitted" {
                        value["feedback_guidance"] = json!(feedback::FINISHED_GUIDANCE);
                    }
                    if was_deferred {
                        send(&mut socket, feedback_message(&format!("Deferred request turn observation: {value}"))?).await?;
                    } else {
                        send(&mut socket, function_output(call_id, value)).await?;
                    }
                    if tools.is_empty() && deferred.len() == 0 { handoff = None; }
                    responses.request_create();
                },
                _ = heartbeat.tick() => {
                    if !self.speech.is_current() { return Err("Voice audio was replaced by another speech session."); }
                    if let Some(agent) = &agent { agent.check_liveness().map_err(|_| "The bound agent disconnected or changed. Please call again.")?; }
                    if config.preview && started.elapsed() > PREVIEW_TIMEOUT { return Err("Voice preview timed out. Please try again."); }
                    if preview_done && (!config.webrtc || self.media.lock().as_ref().is_some_and(webrtc::Handle::drained)) && { let output = self.output.lock(); output.generated == output.played } {
                        if self.output.lock().generated == 0 { return Err("OpenAI returned no playable voice preview audio."); }
                        self.view.lock().phase = "closed";
                        self.closed.store(true, Ordering::Release);
                        return Ok(());
                    }
                    if !self.ready.load(Ordering::Acquire) && started.elapsed() > IO_TIMEOUT { return Err("OpenAI did not confirm the Realtime session settings."); }
                    if started.elapsed() > Duration::from_mins(55) { return Err("Realtime call time limit reached. Start a new call."); }
                    if last_pong.elapsed() > Duration::from_secs(45) { return Err("OpenAI Realtime stopped responding."); }
                    if ping_at.elapsed() > Duration::from_secs(15) {
                        tokio::time::timeout(IO_TIMEOUT, socket.send(Message::Ping(Vec::new().into()))).await.map_err(|_| "Realtime send timed out.")?.map_err(|_| "Realtime connection ended.")?;
                        ping_at = tokio::time::Instant::now();
                    }
                    if let Some(pending) = deferred.take() {
                        spawn_delegation(tools, agent.as_ref().ok_or("Missing bound voice agent.")?.clone(), pending, true, false);
                    }
                    if let Some(handoff) = handoff.as_mut() {
                        forward_feedback(&mut socket, agent.as_ref().ok_or("Missing bound voice agent.")?, handoff).await?;
                    }
                    if { let output = self.output.lock(); output.generated == output.played }
                        && let Some(event) = next_response(&responses, handoff.as_mut(), Instant::now())? {
                        send(&mut socket, event).await?;
                        responses.mark_requested();
                    }
                    if self.ready.load(Ordering::Acquire) {
                        let output = self.output.lock();
                        let mut view = self.view.lock();
                        view.phase = if output.generated > output.played { "speaking" } else if view.muted { "muted" } else if !tools.is_empty() || responses.is_active() { "waiting" } else { "listening" };
                        if output.generated == output.played { view.playback_level = 0.0; }
                    }
                },
                samples = self.next_capture(&mut capture), if !self.webrtc && self.ready.load(Ordering::Acquire) => {
                    samples?;
                    self.send_capture(&mut socket, &capture).await?;
                },
                message = socket.next() => {
                    let Some(text) = socket.receive_text(message, &mut last_pong).await? else {
                        continue;
                    };
                    if config.webrtc && !seen.accept(&text)? { continue; }
                    let event: ServerEvent = serde_json::from_str(&text).map_err(|_| "OpenAI returned an unsupported Realtime event.")?;
                    if let ServerEvent::SessionCreated { session, .. } | ServerEvent::SessionUpdated { session, .. } = &event {
                        config.validate_model(&session.config.model)?;
                    }
                    if matches!(event, ServerEvent::SessionCreated { .. }) { continue; }
                    if costs.observe(&event) { self.view.lock().estimated_usd = costs.estimated_usd(); }
                    if !config.webrtc || !matches!(event, ServerEvent::ResponseOutputAudioDone { .. }) { self.output.lock().transcript.observe(&event, &ignored); }
                    match event {
                        ServerEvent::SessionUpdated { session, .. } | ServerEvent::SessionCreated { session, .. } => {
                            if !config.webrtc && !self.ready.load(Ordering::Acquire) && session.config.audio.is_none() { continue; }
                            self.confirm_audio(&config, session.config.audio, configuration_started)?;
                            if config.preview && !preview_requested {
                                preview_requested = true;
                                send(&mut socket, preview_response()?).await?;
                                responses.mark_requested();
                            }
                        }
                        ServerEvent::ResponseCreated { response: created, .. } => { responses.mark_started(created.id); self.view.lock().text.clear(); }
                        ServerEvent::ResponseDone { response: done, .. } | ServerEvent::ResponseCancelled { response: done, .. } => {
                            responses.mark_finished(&done.id);
                            if let Some(usage) = done.usage {
                                let mut view = self.view.lock();
                                view.input_tokens += u64::from(usage.input_tokens);
                                view.output_tokens += u64::from(usage.output_tokens);
                            }
                            if matches!(done.status, oai_rt_rs::ResponseStatus::Failed) { return Err("OpenAI could not generate a response. Check quota and model access."); }
                            if config.preview {
                                if !matches!(done.status, oai_rt_rs::ResponseStatus::Completed) || (!config.webrtc && self.output.lock().generated == 0) {
                                    return Err("OpenAI did not complete the voice preview. Please try again.");
                                }
                                preview_done = true;
                            }
                        }
                        ServerEvent::OutputAudioBufferStarted { response_id, .. } if config.webrtc && !ignored.contains(&response_id) => {
                            if let Some(handoff) = handoff.as_mut() { handoff.audio(&response_id, Instant::now()); }
                            last_audio_response = Some(response_id);
                        }
                        ServerEvent::ResponseOutputAudioDelta { response_id, item_id, content_index, delta, .. } => {
                            if config.webrtc || ignored.contains(&response_id) { continue; }
                            if let Some(handoff) = handoff.as_mut() { handoff.audio(&response_id, Instant::now()); }
                            last_audio_response = Some(response_id);
                            let pcm = STANDARD.decode(delta).map_err(|_| "OpenAI returned invalid audio.")?;
                            self.output.lock().append(item_id, content_index, pcm)?;
                            if config.preview && self.output.lock().generated > PREVIEW_AUDIO_LIMIT { return Err("Voice preview exceeded its audio limit."); }
                        }
                        ServerEvent::InputAudioBufferSpeechStarted { item_id, .. } => {
                            input_item = item_id;
                            responses.speech_started();
                            if let Some(id) = responses.active().cloned() { ignored.insert(id); }
                            let event = self.output.lock().interrupt();
                            if !config.webrtc && let Some(event) = event { send(&mut socket, event).await?; }
                            self.view.lock().text.clear();
                            self.view.lock().user_text.clear();
                        }
                        ServerEvent::InputAudioBufferSpeechStopped { .. } => { responses.speech_stopped(); }
                        ServerEvent::ResponseOutputAudioTranscriptDelta { response_id, delta, .. } => {
                            if !ignored.contains(&response_id) { bounded_text(&mut self.view.lock().text, &delta); }
                        }
                        ServerEvent::InputAudioTranscriptionCompleted { item_id, transcript, .. } => { if item_id == input_item { self.view.lock().user_text = limit_text(transcript); } }
                        ServerEvent::InputAudioTranscriptionFailed { .. } => { self.view.lock().error = Some("OpenAI could not transcribe this turn. Voice audio is still connected."); }
                        ServerEvent::ResponseFunctionCallArgumentsDone { call_id, name, arguments, response_id, .. } => {
                            let agent = agent.as_ref().ok_or("Voice previews cannot execute tools.")?;
                            if ignored.contains(&response_id) { continue; }
                            let transcript = self.output.lock().transcript.delegation_snapshot();
                            let dispatch = delegation::Dispatch { ledger: &mut ledger, deferred: &mut deferred, handoff: &mut handoff, tools, responses: &mut responses, context: &context, transcript };
                            let call = delegation::Invocation { already_spoke: last_audio_response.as_deref() == Some(response_id.as_str()), call_id, name: name.clone(), arguments, response_id };
                            if dispatch.handle(&mut socket, agent, call).await? { self.view.lock().tool = Some(name); }
                        }

                        ServerEvent::Error { error, .. } => {
                            if error.is_response_cancel_not_active() { continue; }
                            if response::is_active_response_error(&error) { responses.defer_active_response(); continue; }
                            return Err(response::provider_error_message(&error));
                        }
                        _ => {},
                    }
                    if ignored.len() > MAX_CALLS { return Err("Realtime interruption limit reached. Start a new call."); }
                },
            }
        }
    }

    fn confirm_audio(
        &self,
        config: &Config,
        audio: Option<oai_rt_rs::AudioConfig>,
        started: Instant,
    ) -> Result<(), &'static str> {
        let audio = audio.ok_or("OpenAI did not negotiate audio.")?;
        if !config.preview {
            let captions = captions::Diagnostics::confirm(config.language, &audio);
            let accepted = captions.validate();
            self.view.lock().captions = Some(captions);
            accepted?;
        }
        config.validate_audio(audio)?;
        if !config.webrtc {
            self.ready.store(true, Ordering::Release);
            self.record_listening(started);
            self.view.lock().phase = "listening";
        }
        Ok(())
    }

    fn record_listening(&self, configuration_started: Instant) {
        let mut view = self.view.lock();
        if view.startup.listening.is_none() {
            view.startup.configuration = Some(startup::elapsed(configuration_started));
            view.startup.listening = Some(
                self.client_elapsed_ms
                    .saturating_add(startup::elapsed(self.started_at)),
            );
        }
    }

    async fn prepare_connection(
        self: &Arc<Self>,
        config: &Config,
        key: &native_credentials::NativeCredential,
        update: ClientEvent,
        agent: Option<&Arc<PinnedAgent>>,
    ) -> Result<(RealtimeSocket, Instant), &'static str> {
        let connection = self.connect_session(config, key, update);
        tokio::pin!(connection);
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        loop {
            tokio::select! {
                result = &mut connection => return result,
                _ = tick.tick() => {
                    if !self.speech.is_current() {
                        self.fail("Voice audio was replaced by another speech session.");
                    }
                    if agent.is_some_and(|agent| agent.check_liveness().is_err()) {
                        self.fail("The bound agent disconnected or changed. Please call again.");
                    }
                }
            }
        }
    }

    async fn connect_session(
        self: &Arc<Self>,
        config: &Config,
        key: &native_credentials::NativeCredential,
        update: ClientEvent,
    ) -> Result<(RealtimeSocket, Instant), &'static str> {
        let started = Instant::now();
        if config.webrtc {
            let encoded = serde_json::to_value(update).map_err(|_| "Invalid voice session.")?;
            loop {
                if self.closed.load(Ordering::Acquire) {
                    return Err(recovery::CANCELLED);
                }
                let attempt = recovery::Attempt::new(self.clone());
                {
                    let mut view = self.view.lock();
                    view.startup_attempt = attempt.id;
                    view.media_ready = false;
                    view.recovery = if attempt.id == 1 {
                        recovery::State::Starting
                    } else {
                        recovery::State::Retrying
                    };
                    view.startup.offer = None;
                    view.startup.websocket = None;
                    view.startup.configuration = None;
                    view.startup.negotiation = None;
                }
                let update = serde_json::from_value(encoded.clone())
                    .map_err(|_| "Invalid voice session.")?;
                match webrtc::start(self.clone(), key, update, config, attempt.clone()).await {
                    Ok(socket) => return Ok((socket, started)),
                    Err(error)
                        if error.retryable
                            && attempt.id == 1
                            && !self.closed.load(Ordering::Acquire) => {}
                    Err(error) => return Err(error.message),
                }
            }
        }
        let mut socket = connect_raw(key, &config.model()?.websocket_url())
            .await
            .map(|socket| socket::Socket::Direct(Box::new(socket)))?;
        self.view.lock().startup.websocket = Some(startup::elapsed(started));
        let configuration_started = Instant::now();
        send(&mut socket, update).await?;
        Ok((socket, configuration_started))
    }
}

type RealtimeSocket = socket::Socket;

async fn connect_raw(
    key: &native_credentials::NativeCredential,
    url: &str,
) -> Result<socket::RawSocket, &'static str> {
    connect_request(authorized_request(key, url)?)
        .await
        .map_err(|error| error.message)
}

fn authorized_request(
    key: &native_credentials::NativeCredential,
    url: &str,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, &'static str> {
    let mut request = url
        .into_client_request()
        .map_err(|_| "Realtime request could not be prepared.")?;
    let header = key.authorization();
    let mut authorization = tokio_tungstenite::tungstenite::http::HeaderValue::from_bytes(&header)
        .map_err(|_| "Invalid OpenAI API credential.")?;
    authorization.set_sensitive(true);
    request.headers_mut().insert("Authorization", authorization);
    drop(header);
    Ok(request)
}

async fn connect_request(
    request: tokio_tungstenite::tungstenite::http::Request<()>,
) -> Result<socket::RawSocket, recovery::Failure> {
    let socket_config = WebSocketConfig::default()
        .max_message_size(Some(MAX_WIRE))
        .max_frame_size(Some(MAX_WIRE));
    let (socket, _) = tokio::time::timeout(
        IO_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(request, Some(socket_config), false),
    )
    .await
    .map_err(|_| recovery::Failure {
        message: "OpenAI Realtime connection timed out.",
        retryable: true,
    })?
    .map_err(|error| match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            recovery::Failure::from(match response.status().as_u16() {
                401 | 403 | 404 => models::ACCESS_ERROR,
                429 => "OpenAI Realtime quota or rate limit reached.",
                _ => "OpenAI Realtime could not connect. Check model access and connectivity.",
            })
        }
        _ => recovery::Failure {
            message: "OpenAI Realtime could not connect. Check your network.",
            retryable: true,
        },
    })?;
    Ok(socket)
}

fn next_response(
    responses: &response::ResponseCreateQueue,
    handoff: Option<&mut feedback::Handoff>,
    now: Instant,
) -> Result<Option<ClientEvent>, &'static str> {
    // Tool continuations take priority; notices cannot interrupt a response or
    // the user's VAD turn. Playback must also be drained by the caller.
    if responses.can_create() {
        return Ok(Some(ClientEvent::ResponseCreate {
            event_id: None,
            response: None,
        }));
    }
    if responses.can_respond()
        && let Some(notice) = handoff.and_then(|handoff| handoff.notice(now))
    {
        return feedback_response(notice).map(Some);
    }
    Ok(None)
}

fn feedback_message(text: &str) -> Result<ClientEvent, &'static str> {
    typed(
        json!({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":format!("{}{text}", feedback::BACKEND_PREFIX)}]}}),
    )
}

fn feedback_response(notice: feedback::Notice) -> Result<ClientEvent, &'static str> {
    typed(
        json!({"type":"response.create","response":{"instructions":format!("{INSTRUCTIONS}\n\n{}", notice.instructions()),"output_modalities":["audio"],"tools":[silence_tool()],"tool_choice":"auto","max_output_tokens":96}}),
    )
}

fn silence_tool() -> Value {
    json!({"type":"function","name":REMAIN_SILENT,"description":"Say nothing when speech would be distracting, after hidden control messages, or when the user requested silence. This has no effect on agent work.","parameters":{"type":"object","properties":{},"additionalProperties":false}})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SilentArguments {}

struct ToolCompletion {
    call_id: String,
    deferred: bool,
    value: Value,
}

fn spawn_delegation(
    tools: &mut JoinSet<ToolCompletion>,
    agent: Arc<PinnedAgent>,
    pending: delegation::Pending,
    deferred: bool,
    followup: bool,
) {
    tools.spawn(async move {
        let value = agent.delegate(pending.request, followup).await;
        ToolCompletion {
            call_id: pending.call_id,
            deferred,
            value,
        }
    });
}

async fn forward_feedback<S>(
    socket: &mut S,
    agent: &PinnedAgent,
    handoff: &mut feedback::Handoff,
) -> Result<(), &'static str>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    if let Some(snapshot) = agent
        .feedback_snapshot(handoff.revision())
        .map_err(|_| "The bound voice agent changed.")?
    {
        for text in handoff.observe(snapshot) {
            send(socket, feedback_message(&text)?).await?;
        }
    }
    Ok(())
}

fn preview_response() -> Result<ClientEvent, &'static str> {
    typed(json!({"type":"response.create","response":{
        "conversation":"none", "input":[], "output_modalities":["audio"],
        "instructions":PREVIEW_INSTRUCTIONS, "tools":[], "tool_choice":"none", "max_output_tokens":PREVIEW_TOKEN_LIMIT
    }}))
}

async fn send<S>(socket: &mut S, event: ClientEvent) -> Result<(), &'static str>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let mut value =
        serde_json::to_value(event).map_err(|_| "Realtime event could not be encoded.")?;
    let kind = value["type"]
        .as_str()
        .ok_or("Realtime event has no type.")?;
    let id = format!(
        "whip:{kind}:{}",
        EVENT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    value["event_id"] = json!(id);
    let text = serde_json::to_string(&value).map_err(|_| "Realtime event could not be encoded.")?;
    tokio::time::timeout(IO_TIMEOUT, socket.send(Message::Text(text.into())))
        .await
        .map_err(|_| "Realtime upload timed out.")?
        .map_err(|_| "Realtime connection ended.")
}

#[derive(Default)]
struct ToolLedger {
    seen: HashSet<String>,
    mutation_uncertain: bool,
}
impl ToolLedger {
    fn begin(&mut self, id: &str, name: &str, arguments: &str) -> Result<bool, &'static str> {
        if self.seen.contains(id) {
            return Err("duplicate");
        }
        if self.seen.len() >= MAX_CALLS {
            return Err("limit");
        }
        if id.is_empty() || id.len() > 128 {
            return Err("invalid_call_id");
        }
        self.seen.insert(id.to_owned());
        if !matches!(name, BACKGROUND_AGENT | REMAIN_SILENT) || arguments.len() > MAX_ARGUMENT_BYTES
        {
            return Err("invalid_tool");
        }
        let mutation = name == BACKGROUND_AGENT;
        if mutation && self.mutation_uncertain {
            return Err("outcome_unknown");
        }
        Ok(mutation)
    }
    fn complete(&mut self, mutation: bool, uncertain: bool) {
        if mutation {
            self.mutation_uncertain |= uncertain;
        }
    }
}
fn function_output(call_id: String, value: Value) -> ClientEvent {
    ClientEvent::ConversationItemCreate {
        event_id: None,
        previous_item_id: None,
        item: Box::new(oai_rt_rs::Item::FunctionCallOutput {
            id: None,
            phase: None,
            call_id,
            output: value.to_string(),
        }),
    }
}
fn peak(samples: &[i16]) -> f32 {
    samples
        .iter()
        .map(|s| f32::from(*s).abs() / 32768.0)
        .fold(0.0, f32::max)
}
fn limit_text(mut text: String) -> String {
    let mut end = text.len().min(MAX_TEXT);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}
fn bounded_text(text: &mut String, delta: &str) {
    if text.len() < MAX_TEXT {
        text.push_str(&limit_text(delta.to_owned()));
        *text = limit_text(std::mem::take(text));
    }
}
