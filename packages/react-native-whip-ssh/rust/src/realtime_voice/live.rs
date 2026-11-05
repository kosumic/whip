//! Public GPT-Live, independent of the Realtime wire protocol.
//! Codex architectural reference: realtime_conversation.rs and session/turn_input.rs
//! at c90354172c5c49535b122443e9a8ed52c2233b80. Native media ownership is shared;
//! Live delegation/context events never become Realtime function calls.
pub(super) mod captions;
mod global;
mod preview;
#[cfg(test)]
mod tests;
mod usage;

use super::{Config, RealtimeVoiceAdapter, capture_worker, feedback};
use crate::host_runtime::realtime_agent::{Delegation, Delivery, PinnedAgent};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures::{SinkExt, StreamExt};
use oai_rt_rs::live::{self as api, ClientEvent, Command, Field, Nullable, ServerEvent};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{HashSet, VecDeque},
    sync::{
        Arc, LazyLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{sync::mpsc, task::JoinSet};
use tokio_tungstenite::tungstenite::Message;

const URL: &str = "wss://api.openai.com/v1/live/sessions";
const INSTRUCTIONS: &str = include_str!("live/instructions.md");
const MAX_EVENTS: usize = 16_384;
const MAX_PENDING: usize = 8;
const CAPTION_GRACE: Duration = Duration::from_millis(750);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const CONTEXT_BYTES: usize = 480; // <= 500 tokens even for byte-level tokenization.
static SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pricing {
    id: String,
    source_url: String,
    effective_at_ms: u64,
    usd_per_minute: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    model: String,
    backend_model: String,
    voices: Vec<String>,
    pricing: Pricing,
}
static CATALOG: LazyLock<Result<Catalog, serde_json::Error>> =
    LazyLock::new(|| serde_json::from_str(include_str!("live/catalog.json")));
fn catalog() -> Result<&'static Catalog, &'static str> {
    CATALOG
        .as_ref()
        .map_err(|_| "GPT-Live catalog is unavailable. Install an updated Whip build.")
}
fn codec() -> api::Codec {
    api::Codec {
        max_event_bytes: super::MAX_WIRE,
    }
}

pub(super) struct LiveVoiceAdapter {
    state: State,
    tasks: JoinSet<Completion>,
    usage: usage::Usage,
}
struct Pending {
    id: String,
    offset: f64,
    received: Instant,
}
enum Completion {
    Agent { id: String, value: Value },
    Global(Result<global::Results, &'static str>),
}
struct Handoff {
    id: String,
    feedback: feedback::Handoff,
}

#[derive(Default)]
struct State {
    session_id: Option<String>,
    seen: HashSet<String>,
    delegations: HashSet<String>,
    pending: VecDeque<Pending>,
    through: f64,
    uncertain: bool,
    handoff: Option<Handoff>,
    muted: Option<(String, bool, Instant)>,
    suppress_output_after: Option<f64>,
}
#[derive(Debug, PartialEq, Eq)]
enum Admission {
    Queued,
    Duplicate,
    Full,
}

impl State {
    fn delegate(
        &mut self,
        delegation: &api::Delegation,
        offset: f64,
        active: usize,
    ) -> Result<Admission, &'static str> {
        if delegation.target != api::DelegationTarget::Client
            || delegation.response_id.is_some()
            || delegation.id.is_empty()
            || delegation.id.len() > 128
            || !offset.is_finite()
            || offset < 0.0
        {
            return Err("GPT-Live returned invalid client delegation.");
        }
        if self.delegations.contains(&delegation.id) {
            return Ok(Admission::Duplicate);
        }
        if self.delegations.len() == super::MAX_CALLS {
            return Err("GPT-Live delegation limit reached. Start a new call.");
        }
        self.delegations.insert(delegation.id.clone());
        if self.pending.len() + active >= MAX_PENDING {
            return Ok(Admission::Full);
        }
        self.pending.push_back(Pending {
            id: delegation.id.clone(),
            offset,
            received: Instant::now(),
        });
        Ok(Admission::Queued)
    }
    fn interrupted(&mut self, offset: f64) {
        self.suppress_output_after = Some(offset);
    }
    fn input_caption(&mut self, end: f64) {
        if self.suppress_output_after.is_some_and(|after| end > after) {
            self.suppress_output_after = None;
        }
    }
    fn confirm_mute(&mut self, id: Option<&str>, muted: bool) -> bool {
        if self.muted.as_ref().is_some_and(|(pending_id, pending, _)| {
            Some(pending_id.as_str()) == id && *pending == muted
        }) {
            self.muted = None;
            true
        } else {
            false
        }
    }
    fn unique(&mut self, frame: &api::ServerFrame) -> Result<bool, &'static str> {
        let Some(id) = frame.raw.get("event_id").and_then(Value::as_str) else {
            return Ok(true);
        };
        if id.is_empty() || id.len() > 256 {
            return Err("GPT-Live returned an invalid event identifier.");
        }
        if self.seen.contains(id) {
            return Ok(false);
        }
        if self.seen.len() == MAX_EVENTS {
            return Err("GPT-Live event limit reached. Start a new call.");
        }
        self.seen.insert(id.into());
        Ok(true)
    }
    fn pin_session(
        &mut self,
        session: &api::SessionSnapshot,
        config: &Config,
    ) -> Result<(), &'static str> {
        if session.model != catalog()?.model
            || session.id.is_empty()
            || session.id.len() > 256
            || self.session_id.as_ref().is_some_and(|id| id != &session.id)
            || session.audio.as_ref().is_some_and(|audio| {
                audio
                    .format
                    .is_some_and(|format| format != api::AudioFormat::default())
                    || audio
                        .output
                        .as_ref()
                        .and_then(|output| output.voice.as_ref())
                        .is_some_and(|voice| voice != &api::Voice::Named(config.voice.clone()))
            })
            || match &session.delegation {
                Field::Value(api::DelegationConfig::Responses { responses }) => {
                    !config.global || responses.model != catalog()?.backend_model
                }
                _ => config.global,
            }
        {
            return Err("OpenAI did not accept the selected GPT-Live session configuration.");
        }
        self.session_id = Some(session.id.clone());
        Ok(())
    }
}

impl LiveVoiceAdapter {
    pub(super) fn validate(config: &Config) -> Result<(), &'static str> {
        let catalog = catalog()?;
        if config.preview {
            config.validate_preview()?;
        }
        if (!config.preview
            && (usize::from(config.target.is_some()) + usize::from(config.global) != 1))
            || (config.global_shizuku_access && !config.global)
            || config.terminal_target.is_some()
            || !catalog.voices.contains(&config.voice)
            || config
                .model
                .as_ref()
                .is_some_and(|model| model != &catalog.model)
        {
            return Err("Choose a supported GPT-Live voice and exactly one call scope.");
        }
        Ok(())
    }
    fn session(config: &Config) -> Result<api::SessionConfig, &'static str> {
        Self::validate(config)?;
        let mut session = api::SessionConfig {
            model: catalog()?.model.clone(),
            audio: Some(api::AudioConfig {
                format: Some(api::AudioFormat::default()),
                output: Some(api::AudioOutput {
                    voice: Some(api::Voice::Named(config.voice.clone())),
                }),
            }),
            delegation: Field::Value(api::DelegationConfig::Client),
            instructions: Field::Value(if config.preview {
                config.preview_instructions()?
            } else {
                INSTRUCTIONS.into()
            }),
            store: Some(false),
            ..api::SessionConfig::default()
        };
        if config.preview {
            session.input = serde_json::from_value(serde_json::json!([{
                "type":"message", "role":"developer", "content":[{
                    "type":"input_text", "text":config.preview_instructions()?
                }]
            }]))
            .map_err(|_| "Invalid GPT-Live preview instructions.")?;
        } else if config.global {
            global::configure(
                config,
                &mut session,
                crate::reverse_control::voice::base_instructions(config.global_shizuku_access),
            )?;
        }
        Ok(session)
    }
    pub(super) async fn run(
        owner: Arc<RealtimeVoiceAdapter>,
        config: Config,
        key: native_credentials::NativeCredential,
        agent: Option<Arc<PinnedAgent>>,
        commands: mpsc::Receiver<super::Command>,
    ) -> Result<(), &'static str> {
        let mut session = Self::session(&config)?;
        if let Some(global) = &owner.global {
            global::configure(&config, &mut session, global.instructions()?)?;
        }
        let usage = usage::Usage::start(&config.voice, config.preview, config.global)?;
        let mut cancelled = owner.cancel.subscribe();
        // No retries after session.start: a lost acknowledgement may still mean
        // a billable session exists. A new user-initiated call gets a new ledger ID.
        let connected = tokio::select! {
            biased;
            _ = cancelled.changed() => return Ok(()),
            result = super::connect_raw(&key, URL) => result,
        };
        drop(key);
        let mut socket = connected.map_err(
            |_| "GPT-Live could not connect. Check the saved API key, model access and network.",
        )?;
        if owner.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        owner.view.lock().startup.websocket = Some(super::startup::elapsed(owner.started_at));
        send(&mut socket, Command::Start { session }).await?;
        let mut adapter = Self {
            state: State::default(),
            tasks: JoinSet::new(),
            usage,
        };
        let mut result = if config.preview {
            preview::drive(
                &owner,
                &config,
                &mut socket,
                &mut adapter.state,
                &mut adapter.usage,
                commands,
            )
            .await
        } else if config.global || agent.is_some() {
            adapter
                .drive(&owner, &config, agent.as_ref(), &mut socket, commands)
                .await
        } else {
            Err("Open a connected coding agent before calling GPT-Live.")
        };
        // Dropping observation futures never invokes remote cancel. Dispatched
        // agent prompts continue; only this call's unsent pending requests stop.
        if let Some(global) = &owner.global {
            global.close();
        }
        adapter.tasks.shutdown().await;
        adapter.state.pending.clear();
        owner.ready.store(false, Ordering::Release);
        owner.output.lock().clear();
        if !adapter.usage.finalized {
            let closed =
                Self::graceful_close(&config, &mut socket, &mut adapter.state, &mut adapter.usage)
                    .await;
            if config.preview && result.is_ok() {
                result = closed;
            }
        }
        if !config.preview {
            let fragments = owner
                .output
                .lock()
                .live_transcript
                .as_ref()
                .map(captions::Transcript::snapshot)
                .unwrap_or_default();
            if let Err(error) = crate::voice_history::persist(
                &catalog()?.model,
                Some(&config.voice),
                fragments.into_iter().map(Into::into).collect(),
            )
            .await
            {
                owner.view.lock().error = Some(error);
            }
        }
        update_usage(&owner, &adapter.usage);
        if config.preview && result.is_ok() {
            owner.close();
        }
        result
    }
    async fn drive(
        &mut self,
        owner: &Arc<RealtimeVoiceAdapter>,
        config: &Config,
        agent: Option<&Arc<PinnedAgent>>,
        socket: &mut super::socket::RawSocket,
        mut commands: mpsc::Receiver<super::Command>,
    ) -> Result<(), &'static str> {
        let Self {
            state,
            tasks,
            usage,
        } = self;
        let mut cancelled = owner.cancel.subscribe();
        let mut backend = config.global.then(global::Backend::default);
        let started = Instant::now();
        let mut tick = tokio::time::interval(capture_worker::PACKET_DURATION);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut capture = ::audio_ingress::Packet::new(owner.input.packet_samples);
        let mut pending = capture_worker::Pending::new(owner);
        let mut last_feedback = Instant::now();
        let mut pong = Instant::now();
        let mut ping = Instant::now();
        loop {
            if owner.closed.load(Ordering::Acquire) {
                return Ok(());
            }
            tokio::select! {
                biased;
                _ = cancelled.changed() => return Ok(()),
                command = commands.recv() => match command {
                    Some(super::Command::Mute(muted)) => {
                        pending.reset(owner)?;
                        // Native mute takes effect immediately; unmute waits for
                        // provider acknowledgement before accepting microphone frames.
                        owner.view.lock().muted = true;
                        let id = send(socket, if muted {Command::InputAudioMute} else {Command::InputAudioUnmute}).await?;
                        state.muted = Some((id,muted,Instant::now()));
                    }
                    Some(super::Command::Skip) => {
                        owner.output.lock().clear();
                        state.interrupted(started.elapsed().as_secs_f64() * 1000.0);
                        owner.view.lock().playback_level = 0.0;
                        append(socket, None, "The user interrupted your spoken reply. Stop speaking now and listen. This does not cancel coding-agent work.", Channel::Instructions).await?;
                    }
                    Some(super::Command::Submitted(text)) => {
                        if let Some(backend) = &mut backend {
                            send(socket,Command::ResponseItemCreate { item: api::ResponseInputItem::user_text(text) }).await?;
                            backend.request();
                            continue;
                        }
                        // Typed input is already an agent submission. Advance
                        // the native speech cursor so a model handoff caused by
                        // this context cannot replay old spoken input.
                        let offset=started.elapsed().as_secs_f64()*1000.0;
                        if let Some(transcript)=owner.output.lock().live_transcript.as_mut() { transcript.admit(offset); }
                        state.through=state.through.max(offset);
                        append(socket,None,&format!("Already submitted to the bound agent; context only, never delegate again: {text}"),Channel::Thinking).await?;
                    }
                    None => return Ok(()),
                },
                frame = socket.next() => {
                    match frame {
                        Some(Ok(Message::Text(text))) => {
                            let frame = codec().decode_server(&text).map_err(|_| "GPT-Live returned an invalid session event.")?;
                            if !state.unique(&frame)? { continue; }
                            owner.view.lock().server_events += 1;
                            match frame.event {
                                ServerEvent::Started {session,..} => {
                                    state.pin_session(&session,config)?;
                                    let muted = owner.view.lock().muted;
                                    { let mut view = owner.view.lock(); view.media_ready = true; view.phase = if muted {"muted"} else {"listening"}; view.recovery = super::recovery::State::Active; }
                                    owner.ready.store(true,Ordering::Release);
                                    if muted { let id = send(socket,Command::InputAudioMute).await?; state.muted=Some((id,true,Instant::now())); }
                                }
                                ServerEvent::Closed {session,usage:final_usage,reason,..} => {
                                    state.pin_session(&session,config)?;
                                    let confirmed = !matches!(reason,api::CloseReason::ConnectionLost);
                                    usage.observe(final_usage.seconds,confirmed)?;
                                    update_usage(owner,usage);
                                    if !confirmed { return Err("GPT-Live disconnected. Usage is an estimate; check the agent chat for pending results."); }
                                    owner.close();
                                    return Ok(());
                                }
                                ServerEvent::Updated {session,..} => { state.pin_session(&session,config)?; }
                                _ if state.session_id.is_none() => return Err("GPT-Live session did not start correctly."),
                                ServerEvent::UsageUpdated {usage:reported,..} => {
                                    usage.observe(reported.seconds,false)?;
                                    update_usage(owner,usage);
                                }
                                ServerEvent::InputTranscriptDelta {event_id,delta,start_ms,end_ms} => {
                                    state.input_caption(end_ms);
                                    owner.view.lock().user_text = super::limit_text(delta.clone());
                                    owner.view.lock().caption_events += 1;
                                    if let Some(transcript) = owner.output.lock().live_transcript.as_mut() { transcript.append(captions::Fragment {id:event_id,role:"user".into(),text:delta,start_ms,end_ms,event:None})?; }
                                }
                                ServerEvent::OutputTranscriptDelta {event_id,delta,start_ms,end_ms} => {
                                    super::bounded_text(&mut owner.view.lock().text,&delta);
                                    if let Some(transcript) = owner.output.lock().live_transcript.as_mut() { transcript.append(captions::Fragment {id:event_id,role:"assistant".into(),text:delta,start_ms,end_ms,event:None})?; }
                                }
                                ServerEvent::OutputAudioDelta {delta,..} => {
                                    if state.suppress_output_after.is_some() { continue; }
                                    let pcm = STANDARD.decode(delta).map_err(|_| "GPT-Live returned invalid audio.")?;
                                    owner.output.lock().append("live-stream".into(),0,pcm)?;
                                }
                                ServerEvent::DelegationCreated {delegation,offset_ms,..} => {
                                    if let Some(transcript) = owner.output.lock().live_transcript.as_mut() {
                                        transcript.event(&delegation.id, crate::voice_history::Event::new("delegation", if config.global { "Responses" } else { "Coding agent" }, "requested"));
                                    }
                                    if config.global {
                                        if delegation.target != api::DelegationTarget::Responses || delegation.response_id.is_none() {
                                            return Err("Global GPT-Live requires Responses delegation.");
                                        }
                                    } else if state.delegate(&delegation,offset_ms,tasks.len())? == Admission::Full {
                                        if let Some(transcript) = owner.output.lock().live_transcript.as_mut() { transcript.event_result(&delegation.id, &serde_json::json!({"error":"queue_full"})); }
                                        append(socket,Some(&delegation.id),"No request was sent: the call's agent queue is full. Use the agent chat.",Channel::Commentary).await?;
                                    }
                                }
                                ServerEvent::Response {delegation_id,event,..} => {
                                    let backend = backend.as_mut().ok_or("Unexpected GPT-Live backend response.")?;
                                    let event = api::ResponseEvent::decode(Value::Object(event)).map_err(|_| "Invalid global Live backend event.")?;
                                    if let Some(batch) = backend.observe(delegation_id.value().map(String::as_str), &event)? {
                                        let global = owner.global.clone().ok_or("Global call controls are unavailable.")?;
                                        let owner = owner.clone();
                                        tasks.spawn(async move { Completion::Global(batch.execute(global, owner).await) });
                                    }
                                    if let api::ResponseEvent::OutputTextDone {text,..} = event {
                                        let text = public_text(&super::limit_text(text));
                                        if let Some(id) = delegation_id.value() && let Some(transcript) = owner.output.lock().live_transcript.as_mut() {
                                            let mut event = crate::voice_history::Event::new("delegation", "Responses", "responded");
                                            event.output = Some(text.clone()); transcript.event(id, event);
                                        }
                                        owner.view.lock().backend_text = Some(text);
                                    }
                                }
                                ServerEvent::InputAudioMuted {..} => {
                                    if state.confirm_mute(frame.client_event_id.as_deref(),true) { owner.view.lock().muted=true; }
                                }
                                ServerEvent::InputAudioUnmuted {..} => {
                                    if state.confirm_mute(frame.client_event_id.as_deref(),false) { owner.view.lock().muted=false; }
                                }
                                ServerEvent::Error {..} => return Err("GPT-Live rejected a session command. Please use the agent chat; no request will be replayed."),
                                _ => {}
                            }
                        }
                        Some(Ok(Message::Ping(bytes))) => { tokio::time::timeout(capture_worker::SEND_TIMEOUT,socket.send(Message::Pong(bytes))).await.map_err(|_| "GPT-Live upload timed out.")?.map_err(|_| "GPT-Live disconnected.")?; }
                        Some(Ok(Message::Pong(_))) => pong=Instant::now(),
                        Some(Ok(Message::Close(_)) | Err(_)) | None => return Err("GPT-Live disconnected. Use the agent chat for results; prompts were not replayed."),
                        _ => {}
                    }
                },
                completion = tasks.join_next(), if !tasks.is_empty() => {
                    let completion = completion.ok_or("GPT-Live agent observation stopped.")?.map_err(|_| "GPT-Live agent observation failed.")?;
                    match completion {
                        Completion::Agent {id,value} => {
                            if let Some(agent) = agent && let Ok(Some(snapshot)) = agent.feedback_snapshot(None) { owner.agent_events(&snapshot); }
                            state.uncertain |= value["error"]=="outcome_unknown";
                            let text = public_result(&value);
                            if let Some(transcript) = owner.output.lock().live_transcript.as_mut() { transcript.event_result(&id, &serde_json::json!({"completion":value["completion"], "error":value["error"], "result":text})); }
                            // Text fallback survives failed voice/context delivery.
                            owner.view.lock().backend_text = Some(text.clone());
                            append(socket,Some(&id),&text,Channel::Commentary).await?;
                            if state.handoff.as_ref().is_some_and(|handoff| handoff.id==id) { state.handoff=None; }
                        }
                        Completion::Global(results) => {
                            let results = results?;
                            let backend = backend.as_mut().ok_or("Global Live backend is unavailable.")?;
                            backend.finished(&results)?;
                            for item in results.items { send(socket,Command::ResponseItemCreate {item}).await?; }
                        }
                    }
                },
                _ = tick.tick() => {
                    if !owner.speech.is_current() { return Err("Voice audio was replaced by another speech session."); }
                    if let Some(agent) = agent { agent.check_liveness().map_err(|_| "The bound agent disconnected or changed. Please call again.")?; }
                    if let Some(global) = &owner.global { global.check().map_err(|_| "Global call authorization ended.")?; }
                    if state.session_id.is_none() {
                        if started.elapsed()>super::IO_TIMEOUT { return Err("GPT-Live session startup timed out."); }
                        continue;
                    }
                    if state.muted.as_ref().is_some_and(|(_,_,at)| at.elapsed()>super::IO_TIMEOUT) { return Err("GPT-Live did not confirm the microphone state."); }
                    {
                        let speaking = !owner.output.lock().samples.is_empty();
                        let mut view = owner.view.lock();
                        view.phase = if speaking { "speaking" } else if view.muted { "muted" } else { "listening" };
                    }
                    if let Some(backend) = &mut backend && backend.take_continuation() {
                        send(socket,Command::ResponseCreate).await?;
                    }
                    if let Some(agent) = agent {
                        Self::dispatch(owner,agent,socket,state,tasks).await?;
                        if last_feedback.elapsed()>=Duration::from_millis(500) {
                            last_feedback=Instant::now();
                            if let Some(handoff) = &mut state.handoff {
                                let snapshot = agent.feedback_snapshot(handoff.feedback.revision()).map_err(|_| "The bound agent changed.")?;
                                if let Some(snapshot)=snapshot { owner.agent_events(&snapshot); for text in handoff.feedback.observe(snapshot) { let text = public_text(&text); append(socket,Some(&handoff.id),&text,Channel::Thinking).await?; } }
                            }
                        }
                    }
                    if pong.elapsed()>Duration::from_secs(45) { return Err("GPT-Live stopped responding."); }
                    if ping.elapsed()>Duration::from_secs(15) { tokio::time::timeout(capture_worker::SEND_TIMEOUT,socket.send(Message::Ping(Vec::new().into()))).await.map_err(|_| "GPT-Live upload timed out.")?.map_err(|_| "GPT-Live disconnected.")?; ping=Instant::now(); }
                    pending.refresh(owner)?;
                    let samples = pending.take().filter(|frame| frame.current(owner)).map_or([0;super::FRAME],|frame| frame.samples);
                    let bytes:Vec<_> = samples.iter().flat_map(|sample|sample.to_le_bytes()).collect();
                    send(socket,Command::InputAudioAppend {audio:STANDARD.encode(bytes)}).await?;
                    owner.view.lock().uploaded_packets += 1;
                },
                packet = owner.next_capture(&mut capture), if !pending.ready() && state.session_id.is_some() => {
                    if packet? { pending.reset(owner)?; }
                    pending.refresh(owner)?;
                    owner.process_capture(&mut capture)?;
                    pending.push(&capture)?;
                },
            }
        }
    }

    async fn dispatch(
        owner: &RealtimeVoiceAdapter,
        agent: &Arc<PinnedAgent>,
        socket: &mut super::socket::RawSocket,
        state: &mut State,
        tasks: &mut JoinSet<Completion>,
    ) -> Result<(), &'static str> {
        if state
            .pending
            .front()
            .is_none_or(|pending| pending.received.elapsed() < CAPTION_GRACE)
        {
            return Ok(());
        }
        let Some(pending) = state.pending.pop_front() else {
            return Ok(());
        };
        if state.uncertain || pending.offset < state.through {
            append(socket,Some(&pending.id),"No new request was sent. The previous result or transcript ordering is uncertain; inspect the agent chat. Never replay it.",Channel::Commentary).await?;
            return Ok(());
        }
        let request = owner
            .output
            .lock()
            .live_transcript
            .as_ref()
            .ok_or("Voice captions are unavailable.")?
            .request(state.through, pending.offset);
        let prompt = match request {
            Ok(prompt) => prompt,
            Err(message) => {
                append(socket, Some(&pending.id), message, Channel::Commentary).await?;
                return Ok(());
            }
        };
        state.through = pending.offset;
        if let Some(transcript) = owner.output.lock().live_transcript.as_mut() {
            transcript.admit(pending.offset);
        }
        let followup = state.handoff.is_some();
        if !followup {
            agent.clear_feedback();
            state.handoff = Some(Handoff {
                id: pending.id.clone(),
                feedback: feedback::Handoff::new(
                    pending.id.clone(),
                    String::new(),
                    agent
                        .feedback_snapshot(None)
                        .map_err(|_| "The bound agent changed.")?,
                    true,
                    Instant::now(),
                ),
            });
        }
        append(socket,Some(&pending.id),"The request is admitted for the bound coding agent. This is not acknowledgement of submission or task completion. Approval controls remain in Whip.",Channel::Thinking).await?;
        let agent = agent.clone();
        if let Some(transcript) = owner.output.lock().live_transcript.as_mut() {
            let mut event =
                crate::voice_history::Event::new("delegation", "Coding agent", "admitted");
            event.input = Some(prompt.clone());
            transcript.event(&pending.id, event);
        }
        tasks.spawn(async move {
            let value = agent
                .delegate(
                    Delegation {
                        prompt,
                        delivery: Delivery::Now,
                        context: None,
                    },
                    followup,
                )
                .await;
            Completion::Agent {
                id: pending.id,
                value,
            }
        });
        Ok(())
    }
    async fn graceful_close(
        config: &Config,
        socket: &mut super::socket::RawSocket,
        state: &mut State,
        usage: &mut usage::Usage,
    ) -> Result<(), &'static str> {
        tokio::time::timeout(CLOSE_TIMEOUT, async {
            send(socket, Command::Close).await?;
            while let Some(frame) = socket.next().await {
                let Message::Text(text) =
                    frame.map_err(|_| "GPT-Live final usage is unavailable.")?
                else {
                    continue;
                };
                let frame = codec()
                    .decode_server(&text)
                    .map_err(|_| "GPT-Live final usage is unavailable.")?;
                match frame.event {
                    ServerEvent::Closed {
                        session,
                        reason,
                        usage: reported,
                        ..
                    } => {
                        state.pin_session(&session, config)?;
                        usage.observe(
                            reported.seconds,
                            reason != api::CloseReason::ConnectionLost,
                        )?;
                        return Ok(());
                    }
                    ServerEvent::UsageUpdated {
                        usage: reported, ..
                    } => usage.observe(reported.seconds, false)?,
                    _ => {}
                }
            }
            Err("GPT-Live closed without final usage.")
        })
        .await
        .map_err(|_| "GPT-Live final usage timed out.")?
    }
}

#[derive(Clone, Copy)]
enum Channel {
    Thinking,
    Commentary,
    Instructions,
}
async fn append(
    socket: &mut super::socket::RawSocket,
    id: Option<&str>,
    text: &str,
    channel: Channel,
) -> Result<(), &'static str> {
    // Strict byte bound also bounds tokens. Never truncate UTF-8 or repeat a
    // context append after uncertain transport delivery.
    for chunk in chunks(text) {
        let delegation_id = Nullable(id.map(str::to_owned));
        send(
            socket,
            match channel {
                Channel::Thinking => Command::ThinkingAppend {
                    content: chunk.into(),
                    delegation_id,
                },
                Channel::Commentary => Command::CommentaryAppend {
                    content: chunk.into(),
                    delegation_id,
                },
                Channel::Instructions => Command::InstructionsAppend {
                    content: chunk.into(),
                    delegation_id,
                },
            },
        )
        .await?;
    }
    Ok(())
}
fn chunks(mut text: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    while !text.is_empty() {
        let mut end = text.len().min(CONTEXT_BYTES);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&text[..end]);
        text = &text[end..];
    }
    chunks
}
async fn send(
    socket: &mut super::socket::RawSocket,
    command: Command,
) -> Result<String, &'static str> {
    let id = format!("whip-live:{}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let event = ClientEvent {
        event_id: Field::Value(id.clone()),
        command,
    };
    let text = codec()
        .encode(&event)
        .map_err(|_| "GPT-Live command is invalid.")?;
    tokio::time::timeout(
        capture_worker::SEND_TIMEOUT,
        socket.send(Message::Text(text.into())),
    )
    .await
    .map_err(|_| "GPT-Live upload timed out.")?
    .map_err(|_| "GPT-Live connection ended.")?;
    Ok(id)
}
pub(super) fn public_result(value: &Value) -> String {
    let status = match value["error"].as_str() {
        Some("approval_required") => "The agent needs approval in Whip. No approval was accepted.",
        Some("agent_busy" | "agent_syncing") => {
            "The agent is busy or syncing. The new request was not submitted; inspect its chat."
        }
        Some("outcome_unknown") => {
            "The submission outcome is unknown. Inspect the agent chat before trying again."
        }
        Some(_) => "The agent request could not be confirmed. Inspect its chat.",
        None => match value["completion"].as_str() {
            Some("completed") => "The agent finished the task.",
            Some("failed") => "The agent task failed.",
            Some("cancelled" | "interrupted") => "The agent task was interrupted.",
            Some("submitted") => {
                "Guidance was submitted to the running task. Completion is not confirmed."
            }
            _ if value["observation"] == "agent_blocked" => {
                "The agent needs attention or approval in Whip. Completion is not confirmed."
            }
            _ => "The agent outcome is not confirmed. Inspect the agent chat.",
        },
    };
    let output = value["assistant_output"].as_str().unwrap_or_default();
    let mut text = status.to_owned();
    if !output.is_empty() {
        text.push('\n');
        text.push_str(&super::limit_text(output.to_owned()));
    } else {
        text.push_str(" No final answer is available in this call; use the agent chat.");
    }
    public_text(&text)
}

fn update_usage(owner: &RealtimeVoiceAdapter, usage: &usage::Usage) {
    let mut view = owner.view.lock();
    view.estimated_usd = usage.estimate();
    view.live_seconds = Some(usage.seconds);
    view.usage_finalized = usage.finalized;
}

fn public_text(text: &str) -> String {
    // Defense in depth for public assistant prose. Tool/reasoning payloads
    // never enter this function. Withhold a whole update containing credentials.
    let lower = text.to_ascii_lowercase();
    let credential_token = text.split_whitespace().any(|word| {
        let word = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-');
        word.starts_with("sk-") && word.len() >= 16
    });
    if credential_token
        || [
            "-----begin ",
            "bearer ",
            "api_key=",
            "api_key:",
            "api key:",
            "password=",
            "password:",
            "secret_access_key",
            "ghp_",
            "github_pat_",
            "xoxb-",
            "xoxp-",
        ]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        "The agent returned content that cannot be read aloud. Inspect the agent chat for the result.".into()
    } else {
        super::limit_text(text.to_owned())
    }
}
