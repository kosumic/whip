//! Public GPT-Live, independent of the Realtime wire protocol.
//! Codex architectural reference: realtime_conversation.rs and session/turn_input.rs
//! at c90354172c5c49535b122443e9a8ed52c2233b80. Native media ownership is shared;
//! Live delegation/context events never become Realtime function calls.
pub(super) mod captions;
mod global;
mod preview;
mod session_host;
#[cfg(test)]
mod tests;
mod usage;

use super::{Config, RealtimeVoiceAdapter, feedback};
use crate::host_runtime::realtime_agent::{Delegation, Delivery, PinnedAgent};
#[cfg(test)]
use base64::{Engine, engine::general_purpose::STANDARD};
#[cfg(test)]
use futures::StreamExt;
#[cfg(test)]
use oai_rt_rs::live::ClientEvent;
use oai_rt_rs::live::{self as api, Command, Field};
#[cfg(test)]
use oai_rt_rs::live::{Nullable, ServerEvent};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, LazyLock, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio::{sync::mpsc, task::JoinSet};
#[cfg(test)]
use tokio_tungstenite::tungstenite::Message;
#[cfg(test)]
use voice_call_openai::live::commands::CONTEXT_BYTES;

const URL: &str = voice_call_openai::live::URL;
const EVENT_PREFIX: &str = "whip-live";
const INSTRUCTIONS: &str = include_str!("live/instructions.md");
const MAX_PENDING: usize = 8;
const CAPTION_GRACE: Duration = Duration::from_millis(750);

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
#[cfg(test)]
use voice_call_openai::live::{chunks, codec};

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
    #[cfg(test)]
    protocol: voice_call_openai::live::Control,
    delegations: HashSet<String>,
    pending: VecDeque<Pending>,
    through: f64,
    uncertain: bool,
    handoff: Option<Handoff>,
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
    #[cfg(test)]
    fn pin_session(
        &mut self,
        session: &api::SessionSnapshot,
        config: &Config,
    ) -> Result<(), &'static str> {
        let catalog = catalog()?;
        self.protocol.pin_session(
            session,
            &voice_call_openai::live::Selection {
                model: &catalog.model,
                voice: &config.voice,
                backend_model: config.global.then_some(catalog.backend_model.as_str()),
            },
        )
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
    pub(super) fn session(config: &Config) -> Result<api::SessionConfig, &'static str> {
        Self::validate(config)?;
        let mut session = api::SessionConfig {
            model: catalog()?.model.clone(),
            audio: Some(api::AudioConfig {
                format: (!config.webrtc || config.preview).then(api::AudioFormat::default),
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
        let (mut socket, session_id) = if config.webrtc && !config.preview {
            let session = serde_json::to_value(session).map_err(|_| "Invalid GPT-Live session.")?;
            let (socket, id) = super::webrtc::start_live(owner.clone(), &key, session).await?;
            (socket, Some(id))
        } else {
            let connected = tokio::select! {
                biased;
                _ = cancelled.changed() => return Ok(()),
                result = super::connect_raw(&key, URL) => result,
            };
            let socket = connected.map_err(
                |_| "GPT-Live could not connect. Check the saved API key, model access and network.",
            )?;
            owner.view.lock().startup.websocket = Some(super::startup::elapsed(owner.started_at));
            let mut socket = super::socket::Socket::Direct(Box::new(socket));
            send(&mut socket, Command::Start { session }).await?;
            (socket, None)
        };
        drop(key);
        if owner.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut adapter = Self {
            state: State::default(),
            tasks: JoinSet::new(),
            usage,
        };
        let provider = provider_config(&config, session_id)?;
        let mut provider =
            voice_call_openai::session::Session::live(&mut socket, provider, owner.webrtc)
                .with_prefix(EVENT_PREFIX);
        let mut result = if config.preview {
            preview::drive(&owner, &config, &mut provider, &mut adapter.usage, commands).await
        } else if config.global || agent.is_some() {
            adapter
                .drive(&owner, &config, agent.as_ref(), &mut provider, commands)
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
        if let Some(media) = owner.media.lock().as_ref() {
            media.cancel_audio(None);
        }
        owner.output.lock().clear();
        if !adapter.usage.provider.finalized {
            let closed = provider
                .finish_live(
                    || {
                        !crate::voice_credentials::is_updating()
                            && crate::voice_credentials::generation() == owner.credential_generation
                    },
                    |seconds, finalized| adapter.usage.observe(seconds, finalized),
                )
                .await;
            if closed.is_ok()
                && let Some(media) = owner.media.lock().as_ref()
            {
                media.confirm_live_closed();
            }
            if config.preview && result.is_ok() {
                result = closed;
            }
        }
        {
            let fragments = if config.preview {
                let mut transcript = crate::voice_history::Conversation::default();
                transcript.assistant(&owner.view.lock().text);
                transcript.into_captions()
            } else {
                owner
                    .output
                    .lock()
                    .live_transcript
                    .as_ref()
                    .map(captions::Transcript::snapshot)
                    .unwrap_or_default()
                    .into_iter()
                    .map(Into::into)
                    .collect()
            };
            if let Err(error) = crate::voice_history::persist(
                adapter.usage.history_identity(),
                &catalog()?.model,
                Some(&config.voice),
                fragments,
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
        session: &mut voice_call_openai::session::Session<'_>,
        commands: mpsc::Receiver<super::Command>,
    ) -> Result<(), &'static str> {
        let mut app = session_host::App::new(owner, config, agent, self, commands);
        session.drive(&**owner, &mut app).await
    }

    async fn dispatch(
        owner: &RealtimeVoiceAdapter,
        agent: &Arc<PinnedAgent>,
        socket: &mut super::RealtimeSocket,
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
    #[cfg(test)]
    async fn graceful_close(
        config: &Config,
        socket: &mut super::RealtimeSocket,
        state: &mut State,
        usage: &mut usage::Usage,
    ) -> Result<(), &'static str> {
        let mut provider = voice_call_openai::session::Session::live(
            socket,
            provider_config(config, state.protocol.session_id.clone())?,
            config.webrtc,
        )
        .with_prefix(EVENT_PREFIX);
        provider
            .finish_live(
                || true,
                |seconds, finalized| usage.observe(seconds, finalized),
            )
            .await
    }
}

use voice_call_openai::live::commands::Context as Channel;
async fn append(
    socket: &mut super::RealtimeSocket,
    id: Option<&str>,
    text: &str,
    channel: Channel,
) -> Result<(), &'static str> {
    voice_call_openai::live::commands::append_context_with_prefix(
        socket,
        id,
        text,
        channel,
        EVENT_PREFIX,
    )
    .await
}
async fn send(
    socket: &mut super::RealtimeSocket,
    command: Command,
) -> Result<String, &'static str> {
    let kind = command.kind();
    let id = voice_call_openai::live::send_with_prefix(socket, command, EVENT_PREFIX).await?;
    if kind != "session.input_audio.append" {
        crate::host_runtime::diagnostics::log_lifecycle(format_args!(
            "GPT-Live sent command={kind} client_event_id={id}"
        ));
    }
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
    view.live_seconds = Some(usage.provider.seconds);
    view.usage_finalized = usage.provider.finalized;
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

fn provider_config(
    config: &Config,
    session_id: Option<String>,
) -> Result<voice_call_openai::session::LiveConfig, &'static str> {
    let catalog = catalog()?;
    Ok(voice_call_openai::session::LiveConfig {
        model: catalog.model.clone(),
        voice: config.voice.clone(),
        backend_model: config.global.then(|| catalog.backend_model.clone()),
        session_id,
    })
}
