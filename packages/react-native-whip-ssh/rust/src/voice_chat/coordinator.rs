use super::{State, VoiceChat, VoiceChatError, transcript};
use crate::AgentTranscriptKind;
use crate::terminal_submissions::{
    TerminalSubmissionQueue, TerminalSubmissionStatus, VoiceSubmissionBinding,
};
use parking_lot::Mutex;
use serde_json::json;
use std::{sync::Arc, time::Instant};
use voice_call_local::coordinator::{Effect, Lease, Speech, SpeechKind, Stage};

const EFFECT_VERSION: u8 = 1;
use voice_call_local::{Call, Phase};

#[uniffi::export(with_foreign)]
pub trait VoiceChatObserver: Send + Sync {
    fn changed(&self);
}

#[derive(Clone)]
pub(crate) struct Connection {
    pub runtime_id: String,
    pub incarnation: u64,
    pub terminal_id: String,
    pub pane_id: String,
    pub queue: Arc<TerminalSubmissionQueue>,
    pub target_key: String,
    pub agent: AgentTranscriptKind,
}

pub(super) struct Receipt {
    pub generation: u64,
    pub status: Arc<Mutex<TerminalSubmissionStatus>>,
    pub id: String,
}

#[uniffi::export]
impl VoiceChat {
    /// Pin native source and submission owner once. Presentation binding tokens
    /// are intentionally absent from this API.
    #[allow(
        clippy::too_many_arguments,
        reason = "Explicit immutable native destination plus existing I/O owners"
    )]
    pub fn connect(
        self: Arc<Self>,
        runtime_id: String,
        incarnation: u64,
        terminal_id: String,
        pane_id: String,
        queue: Arc<TerminalSubmissionQueue>,
        target_key: String,
        observer: Arc<dyn VoiceChatObserver>,
        playback_capacity: u8,
        agent: AgentTranscriptKind,
    ) -> Result<(), VoiceChatError> {
        {
            let mut state = self.state.lock();
            if state.connection.is_some() || state.call.view().phase == Phase::Closed {
                return Err("Local call was already connected or closed"
                    .to_owned()
                    .into());
            }
            state.coordinator.acquiring(self.now());
            state
                .coordinator
                .set_playback_capacity(usize::from(playback_capacity));
            state.connection = Some(Connection {
                runtime_id,
                incarnation,
                terminal_id,
                pane_id,
                queue,
                target_key,
                agent,
            });
        }
        *self.observer.lock() = Some(observer);
        transcript::register(&self);
        let weak = Arc::downgrade(&self);
        crate::runtime()?.spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(50));
            let mut refresh = 0;
            loop {
                interval.tick().await;
                let Some(call) = weak.upgrade() else {
                    break;
                };
                if call.state.lock().call.view().phase == Phase::Closed {
                    break;
                }
                if refresh % 5 == 0 {
                    call.refresh_source();
                }
                refresh += 1;
                call.tick_coordinator();
                let observer = call.observer.lock().clone();
                if let Some(observer) = observer {
                    observer.changed();
                }
            }
        });
        Ok(())
    }

    pub fn take_effects(&self) -> String {
        self.flush_effects();
        serde_json::to_string(&std::mem::take(&mut self.state.lock().effects))
            .unwrap_or_else(|_| "[]".into())
    }

    pub fn playback_current(&self, token: String) -> bool {
        let state = self.state.lock();
        current_lease(&state, &token, self.id).is_some()
    }

    /// Word/PCM callbacks are checked under the same lock as lease revocation.
    pub fn playback_event(&self, token: String, text: String, active: bool) {
        let mut state = self.state.lock();
        if current_lease(&state, &token, self.id).is_some()
            && text.len() <= voice_call_local::MAX_TEXT_BYTES
        {
            state.echo.observe(&text, active, Instant::now());
        }
    }

    /// Startup and actual PCM/TTS drain are separate token-scoped acknowledgments.
    pub fn acknowledge_speech(&self, token: String, chunk: u64, event: String) {
        let mut state = self.state.lock();
        let Some(lease) = current_lease(&state, &token, self.id) else {
            return;
        };
        match event.as_str() {
            "started" => state.coordinator.started(lease, self.now()),
            "played" => state.coordinator.played(lease, chunk, self.now()),
            "failed" | "stopped" => {
                if lease.kind == SpeechKind::Filler {
                    // Filler failure is optional; cancellation releases its lease.
                    state.coordinator.failed_playback(lease);
                } else {
                    self.speech.reset_voice();
                    state.coordinator.cancel();
                    state.update_call(Call::skip_response);
                }
            }
            _ => {}
        }
        drop(state);
        self.flush_effects();
    }
}

impl VoiceChat {
    pub(crate) fn now(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    pub(super) fn tick_coordinator(self: &Arc<Self>) {
        let connection = self.state.lock().connection.clone();
        let Some(connection) = connection else {
            return;
        };
        let prompt = {
            let mut state = self.state.lock();
            // A new agent may create its transcript only after its first input.
            // Pin the native binding before dispatch; the unique submission
            // marker makes the first snapshot safe without a history baseline.
            let binding = state.source.as_ref().map(|source| VoiceSubmissionBinding {
                agent: source.agent,
                session_id: source.session.clone(),
                admission: None,
            });
            if let Some(binding) = binding
                && !matches!(state.coordinator.stage, Stage::Failed | Stage::Closed)
            {
                state
                    .call
                    .take_prompt()
                    .map(|text| (state.coordinator.generation(), text, binding))
            } else {
                None
            }
        };
        if let Some((generation, text, binding)) = prompt {
            self.queue_prompt(&connection, generation, text, binding);
        }

        let mut state = self.state.lock();
        let now = self.now();
        if let Some(receipt) = &state.receipt {
            let generation = receipt.generation;
            let status = *receipt.status.lock();
            match status {
                TerminalSubmissionStatus::Accepted => {
                    if state.coordinator.delivery == Some(voice_call_local::coordinator::Delivery::Queued) && state.submission_marker.is_none() {
                        state.refresh_transcript = true;
                    }
                    state.coordinator.dispatched(generation, now);
                }
                TerminalSubmissionStatus::Failed | TerminalSubmissionStatus::Ambiguous => state.coordinator.fail("The voice message could not be delivered reliably. Inspect the send queue before retrying."),
                _ => {}
            }
        }
        state.coordinator.tick(now);
        if state.coordinator.filler_due(now)
            && let Some(text) = state
                .waiting_filler
                .as_mut()
                .and_then(|f| f.next(Instant::now()))
        {
            state.coordinator.filler(text.into(), now);
        }
        // An undispatched timed-out prompt must not retry after the call ends.
        let unqueue = if state.coordinator.error.is_some() {
            state
                .receipt
                .take()
                .filter(|r| *r.status.lock() != TerminalSubmissionStatus::Accepted)
                .map(|r| r.id)
        } else {
            None
        };
        drop(state);
        if let Some(id) = unqueue {
            connection.queue.cancel_voice(&connection.target_key, &id);
        }
        self.flush_effects();
    }

    fn queue_prompt(
        self: &Arc<Self>,
        connection: &Connection,
        generation: u64,
        text: String,
        mut binding: VoiceSubmissionBinding,
    ) {
        let weak = Arc::downgrade(self);
        binding.admission = Some(Arc::new(move || {
            weak.upgrade().is_some_and(|call| {
                let state = call.state.lock();
                state.coordinator.generation() == generation
                    && !matches!(state.coordinator.stage, Stage::Failed | Stage::Closed)
            })
        }));
        let marker = format!(
            "[Whip local voice {}; tracking metadata]",
            uuid::Uuid::new_v4()
        );
        {
            let mut state = self.state.lock();
            if state.coordinator.generation() != generation {
                return;
            }
            state.submission_marker = Some(marker.clone());
        }
        // Transcript callbacks hold manager -> call. Never enter the queue
        // while holding the call lock; permits check the weak generation
        // guard immediately before writing, including after cancellation.
        let message = connection.queue.clone().enqueue_voice(
            connection.target_key.clone(),
            format!("{marker}\n{text}"),
            &crate::TerminalSubmissionTarget {
                key: connection.target_key.clone(),
                runtime_id: connection.runtime_id.clone(),
                runtime_incarnation: connection.incarnation,
                terminal_id: connection.terminal_id.clone(),
                pane_id: connection.pane_id.clone(),
                ssh: false,
                online: true,
            },
            binding,
        );
        let receipt = message.as_ref().and_then(|message| {
            connection
                .queue
                .observe(&connection.target_key, &message.id)
        });
        let mut state = self.state.lock();
        let current = state.coordinator.generation() == generation
            && !matches!(state.coordinator.stage, Stage::Failed | Stage::Closed);
        if current {
            if let Some(message) = &message {
                state.receipt = receipt.map(|status| Receipt {
                    generation,
                    status,
                    id: message.id.clone(),
                });
            } else {
                state
                    .coordinator
                    .fail("The voice message could not be queued for this agent.");
            }
        }
        drop(state);
        if !current && let Some(message) = message {
            connection
                .queue
                .cancel_voice(&connection.target_key, &message.id);
        }
        connection.queue.clone().start();
    }

    pub(super) fn collect_reply(&self, state: &mut State) {
        while let Some(chunk) = self.next_reply(state) {
            state.coordinator.reply(
                Speech {
                    text: chunk.text,
                    message_id: chunk.message_id,
                    part_id: chunk.part_id,
                    start_utf16: chunk.start_utf16,
                },
                self.now(),
            );
        }
    }

    pub(super) fn flush_effects(&self) {
        let mut state = self.state.lock();
        if state.diagnostic_stage != Some(state.coordinator.stage) {
            let now = self.now();
            log::info!(
                "LocalVoice app_call={:?} call={} generation={} from={:?} to={:?} delivery={:?} depth={} state_ms={}",
                self.app_session.lock().as_deref(),
                self.id,
                state.coordinator.generation(),
                state.diagnostic_stage,
                state.coordinator.stage,
                state.coordinator.delivery,
                state.coordinator.queue_depth(),
                now.saturating_sub(state.diagnostic_at)
            );
            state.diagnostic_stage = Some(state.coordinator.stage);
            state.diagnostic_at = now;
        }
        for effect in state.coordinator.take_effects() {
            match effect {
                Effect::Start(lease) => state.effects.push(json!({"version":EFFECT_VERSION, "type":"start", "token":lease_token(lease,self.id), "filler":lease.kind == SpeechKind::Filler})),
                Effect::Stop(lease) => {
                    state.echo.finish(Instant::now());
                    state.effects.push(json!({"version":EFFECT_VERSION, "type":"stop", "token":lease_token(lease,self.id)}));
                }
                Effect::Speak(lease, chunk, speech) => state.effects.push(json!({"version":EFFECT_VERSION, "type":"speak", "token":lease_token(lease,self.id), "chunk":chunk.to_string(), "filler":lease.kind == SpeechKind::Filler, "text":speech.text, "messageId":speech.message_id, "partId":speech.part_id, "startUtf16":speech.start_utf16})),
                Effect::Drained(generation) if generation == state.coordinator.generation() => {
                    state.echo.finish(Instant::now());
                    if let Some(generation) = state.call.generation() { state.update_call(|call| call.playback_ended(generation, false)); }
                }
                Effect::Drained(_) => {}
            }
        }
        let retired = std::mem::take(&mut state.retired_submissions);
        let error = state
            .audio_error
            .clone()
            .or_else(|| state.coordinator.error.map(str::to_owned));
        drop(state);
        for (queue, key, id) in retired {
            queue.cancel_voice(&key, &id);
        }
        if let Some(error) = error {
            let session = self.app_session.lock().take();
            if let Some(session) = session {
                crate::voice_session_coordinator().backend_ended(&session, Some(error));
            }
        }
    }

    fn refresh_source(self: &Arc<Self>) {
        let connection = self.state.lock().connection.clone();
        let Some(connection) = connection else {
            return;
        };
        let Some(runtime) = crate::get_host_runtime(connection.runtime_id.clone()) else {
            self.state.lock().coordinator.binding(false, self.now());
            return;
        };
        runtime.observe_local_voice(self, &connection);
    }
}

// Lease serials never repeat during a call; the call's opaque ID fences bridge
// callbacks across object replacement. Tokens contain no transcript identities.
fn lease_token(lease: Lease, call: u64) -> String {
    format!(
        "local:v{EFFECT_VERSION}:{call}:{}:{}:{:?}",
        lease.generation, lease.serial, lease.kind
    )
}
fn current_lease(state: &State, token: &str, call: u64) -> Option<Lease> {
    // Effects carry the exact lease; retain only the current start identity.
    state
        .coordinator
        .lease()
        .filter(|lease| lease_token(*lease, call) == token)
}
