//! Whip delegates tools and application events to its own services.
use super::{
    Admission, Arc, Channel, Command, Completion, Config, Duration, Instant, LiveVoiceAdapter,
    Ordering, PinnedAgent, RealtimeVoiceAdapter, Value, api, append, captions, global, mpsc,
    public_result, public_text, send, update_usage,
};
use oai_rt_rs::live::ServerEvent;
use tokio::sync::watch;
use voice_call_openai::session::{Delegate, Event, Flow, Session};

pub(super) enum Work {
    Command(super::super::Command),
    Completion(Result<Completion, tokio::task::JoinError>),
}
pub(super) struct App<'a> {
    owner: &'a Arc<RealtimeVoiceAdapter>,
    config: &'a Config,
    agent: Option<&'a Arc<PinnedAgent>>,
    adapter: &'a mut LiveVoiceAdapter,
    commands: &'a mut mpsc::Receiver<super::super::Command>,
    cancellation: watch::Receiver<bool>,
    backend: Option<global::Backend>,
    started: Instant,
    last_input: Instant,
    active: bool,
    updates: Option<super::super::observer::Subscription>,
}
impl<'a> App<'a> {
    pub(super) fn new(
        owner: &'a Arc<RealtimeVoiceAdapter>,
        config: &'a Config,
        agent: Option<&'a Arc<PinnedAgent>>,
        adapter: &'a mut LiveVoiceAdapter,
        commands: &'a mut mpsc::Receiver<super::super::Command>,
    ) -> Self {
        let scope = if config.global {
            Some(super::super::observer::Scope::Global)
        } else {
            agent.map(|agent| super::super::observer::Scope::Pinned(agent.source_id()))
        };
        let updates = owner
            .updates
            .lock()
            .take()
            .or_else(|| scope.map(super::super::observer::Subscription::new));
        Self {
            owner,
            config,
            agent,
            adapter,
            commands,
            cancellation: owner.cancel.subscribe(),
            backend: config.global.then(global::Backend::default),
            started: Instant::now(),
            last_input: Instant::now(),
            active: false,
            updates,
        }
    }
    async fn forward_updates(&mut self, session: &mut Session<'_>) -> Result<(), &'static str> {
        if let Some(updates) = &self.updates {
            self.owner.agent_events(&updates.take_events());
        }
        if !session.ready() || self.owner.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        if self.agent.is_some_and(|agent| agent.check().is_err()) {
            return Ok(());
        }
        if let Some(updates) = &self.updates {
            let batch = updates.take_for_call(
                crate::automatic_speech::tracking_enabled(),
                Instant::now(),
                |source, turn, epoch, revision| {
                    self.owner.context_delivery(
                        self.agent.map(AsRef::as_ref),
                        source,
                        turn,
                        epoch,
                        revision,
                    )
                },
            );
            self.owner.agent_events(&batch.events);
            if let Some(text) = batch.context {
                self.owner.view.lock().backend_text = Some(text.clone());
                if super::super::deliver_agent_context(session, &text)
                    .await
                    .is_err()
                {
                    updates.delivery_failed();
                }
            }
        }
        Ok(())
    }
}
impl Drop for App<'_> {
    fn drop(&mut self) {
        if let Some(updates) = &self.updates {
            self.owner.agent_events(&updates.take_events());
        }
    }
}
impl Delegate for App<'_> {
    type Work = Work;
    async fn next_work(&mut self) -> Option<Work> {
        tokio::select! { biased;
        _ = self.cancellation.changed() => None,
        command = self.commands.recv(), if self.active => command.map(Work::Command),
        completion = self.adapter.tasks.join_next(), if !self.adapter.tasks.is_empty() => completion.map(Work::Completion),
        }
    }
    async fn work(&mut self, session: &mut Session<'_>, work: Work) -> Result<Flow, &'static str> {
        self.forward_updates(session).await?;
        match work {
            Work::Command(super::super::Command::Mute(muted)) => {
                let current = self.owner.microphone.lock().muted;
                if current == muted {
                    session.mute(&**self.owner, muted).await?;
                }
            }
            Work::Command(super::super::Command::Skip) => {
                session.interrupt(&**self.owner).await?;
                self.owner.view.lock().playback_level = 0.0;
            }
            Work::Command(super::super::Command::Submitted(text)) => {
                if let Some(backend) = self.backend.as_mut() {
                    session
                        .send_live(Command::ResponseItemCreate {
                            item: api::ResponseInputItem::user_text(text),
                        })
                        .await?;
                    backend.request();
                } else {
                    let offset = self.started.elapsed().as_secs_f64() * 1000.0;
                    if let Some(transcript) = self.owner.output.lock().live_transcript.as_mut() {
                        transcript.admit(offset);
                    }
                    self.adapter.state.through = self.adapter.state.through.max(offset);
                    session.append_context(None, &format!("Already submitted to the bound agent; context only, never delegate again: {text}"), voice_call_openai::session::Context::Thinking).await?;
                }
            }
            Work::Completion(completion) => {
                let Self {
                    owner,
                    adapter,
                    backend,
                    ..
                } = self;
                let LiveVoiceAdapter { state, .. } = adapter;
                let socket = &mut *session.socket;
                let completion = completion.map_err(|_| "GPT-Live agent observation failed.")?;
                match completion {
                    Completion::Agent { id, mut value } => {
                        state.uncertain |= value["error"] == "outcome_unknown";
                        let text = public_result(&value);
                        if let Some(transcript) = owner.output.lock().live_transcript.as_mut() {
                            transcript.event_result(&id, &serde_json::json!({"completion":value["completion"], "error":value["error"], "result":text}));
                        }
                        // Text fallback survives failed voice/context delivery.
                        owner.view.lock().backend_text = Some(text.clone());
                        if let Some(object) = value.as_object_mut() {
                            object.remove("assistant_output");
                        }
                        append(
                            socket,
                            Some(&id),
                            &format!(
                                "Delegation receipt: {value}. {}",
                                super::super::feedback::FINISHED_GUIDANCE
                            ),
                            Channel::Commentary,
                        )
                        .await?;
                        if state
                            .handoff
                            .as_ref()
                            .is_some_and(|handoff| handoff.id == id)
                        {
                            state.handoff = None;
                        }
                    }
                    Completion::Global(results) => {
                        let results = results?;
                        let backend = backend
                            .as_mut()
                            .ok_or("Global Live backend is unavailable.")?;
                        backend.finished(&results)?;
                        for item in results.items {
                            send(socket, Command::ResponseItemCreate { item }).await?;
                        }
                    }
                }
            }
        }
        Ok(Flow::Continue)
    }
    async fn event(
        &mut self,
        session: &mut Session<'_>,
        event: Event,
    ) -> Result<Flow, &'static str> {
        let Event::Live(frame) = event else {
            return Err("Invalid voice protocol.");
        };
        self.active = session.ready();
        let Self {
            owner,
            config,
            adapter,
            backend,
            ..
        } = self;
        let LiveVoiceAdapter {
            state,
            tasks,
            usage,
        } = adapter;
        let voice_call_openai::session::Protocol::Live(provider) = &mut session.protocol else {
            return Err("Invalid voice protocol.");
        };
        let socket = &mut *session.socket;
        owner.view.lock().server_events += 1;
        match frame.event {
            ServerEvent::Error {
                event_id, error, ..
            } => {
                let id = voice_call_openai::live::errors::client_event_id(
                    &error,
                    frame.client_event_id.as_deref(),
                );
                if let Some(backend) = backend.as_mut() {
                    backend.rejected(id);
                }
                record_rejection(owner, provider, &event_id);
            }
            ServerEvent::Started { session, .. } => {
                owner.provider_expiry(&session);
                let muted = confirm_start(owner, config);
                if muted {
                    let id = send(socket, Command::InputAudioMute).await?;
                    provider.control.muted = Some((id, true, Instant::now()));
                }
            }
            ServerEvent::Closed {
                session: _,
                usage: final_usage,
                reason,
                ..
            } => {
                if let Some(media) = owner.media.lock().as_ref() {
                    media.confirm_live_closed();
                }
                let confirmed = !matches!(reason, api::CloseReason::ConnectionLost);
                usage.observe(final_usage.seconds, confirmed)?;
                update_usage(owner, usage);
                if !confirmed {
                    return Err("GPT-Live disconnected before final usage was confirmed.");
                }
                if matches!(reason, api::CloseReason::Content) {
                    return Err(voice_call_openai::live::errors::CONTENT_ENDED);
                }
                return Err("GPT-Live ended the call.");
            }
            ServerEvent::UsageUpdated {
                usage: reported, ..
            } => {
                usage.observe(reported.seconds, false)?;
                update_usage(owner, usage);
            }
            ServerEvent::InputTranscriptDelta {
                event_id,
                delta,
                start_ms,
                end_ms,
            } => {
                self.last_input = Instant::now();
                {
                    let mut view = owner.view.lock();
                    view.user_text = super::super::limit_text(delta.clone());
                    if view.error == Some(voice_call_openai::live::errors::COMMAND_REJECTED) {
                        view.error = None;
                    }
                }
                owner.view.lock().caption_events += 1;
                if let Some(transcript) = owner.output.lock().live_transcript.as_mut() {
                    transcript.append(captions::Fragment {
                        id: event_id,
                        role: "user".into(),
                        text: delta,
                        start_ms,
                        end_ms,
                        event: None,
                    })?;
                }
            }
            ServerEvent::OutputTranscriptDelta {
                event_id,
                delta,
                start_ms,
                end_ms,
            } => {
                super::super::bounded_text(&mut owner.view.lock().text, &delta);
                if let Some(transcript) = owner.output.lock().live_transcript.as_mut() {
                    transcript.append(captions::Fragment {
                        id: event_id,
                        role: "assistant".into(),
                        text: delta,
                        start_ms,
                        end_ms,
                        event: None,
                    })?;
                }
            }
            ServerEvent::DelegationCreated {
                delegation,
                offset_ms,
                ..
            } => {
                if let Some(transcript) = owner.output.lock().live_transcript.as_mut() {
                    transcript.event(
                        &delegation.id,
                        crate::voice_history::Event::new(
                            "delegation",
                            if config.global {
                                "Responses"
                            } else {
                                "Coding agent"
                            },
                            "requested",
                        ),
                    );
                }
                if config.global {
                    if delegation.target != api::DelegationTarget::Responses
                        || delegation.response_id.is_none()
                    {
                        return Err("Global GPT-Live requires Responses delegation.");
                    }
                } else if state.delegate(&delegation, offset_ms, tasks.len())? == Admission::Full {
                    if let Some(transcript) = owner.output.lock().live_transcript.as_mut() {
                        transcript.event_result(
                            &delegation.id,
                            &serde_json::json!({"error":"queue_full"}),
                        );
                    }
                    append(
                        socket,
                        Some(&delegation.id),
                        "No request was sent: the call's agent queue is full. Use the agent chat.",
                        Channel::Commentary,
                    )
                    .await?;
                }
            }
            ServerEvent::Response {
                delegation_id,
                event,
                ..
            } => {
                let backend = backend
                    .as_mut()
                    .ok_or("Unexpected GPT-Live backend response.")?;
                let event = api::ResponseEvent::decode(Value::Object(event))
                    .map_err(|_| "Invalid global Live backend event.")?;
                if let Some(batch) =
                    backend.observe(delegation_id.value().map(String::as_str), &event)?
                {
                    let global = owner.global_session(config.global_shizuku_access);
                    let owner = owner.clone();
                    tasks.spawn(
                        async move { Completion::Global(batch.execute(global, owner).await) },
                    );
                }
                if let api::ResponseEvent::OutputTextDone { text, .. } = event {
                    let text = public_text(&super::super::limit_text(text));
                    if let Some(id) = delegation_id.value()
                        && let Some(transcript) = owner.output.lock().live_transcript.as_mut()
                    {
                        let mut event = crate::voice_history::Event::new(
                            "delegation",
                            "Responses",
                            "responded",
                        );
                        event.output = Some(text.clone());
                        transcript.event(id, event);
                    }
                    owner.view.lock().backend_text = Some(text);
                }
            }
            _ => {}
        }

        Ok(Flow::Continue)
    }
    async fn tick(&mut self, session: &mut Session<'_>) -> Result<Flow, &'static str> {
        self.forward_updates(session).await?;
        let idle = self.adapter.tasks.is_empty()
            && self.adapter.state.pending.is_empty()
            && self.backend.as_ref().is_none_or(|backend| !backend.busy())
            && {
                let output = self.owner.output.lock();
                !output.live_speaking() && output.generated == output.played
            }
            && self.last_input.elapsed() > Duration::from_secs(2)
            && self.owner.view.lock().level < 0.02;
        if self.owner.continuity_tick(idle)? {
            return Ok(Flow::Stop);
        }
        let active = session.ready();
        let Self {
            owner,
            config,
            agent,
            adapter,
            backend,
            ..
        } = self;
        let LiveVoiceAdapter { state, tasks, .. } = adapter;
        let socket = &mut *session.socket;
        if !owner.speech.is_current() {
            return Err("Voice audio was replaced by another speech session.");
        }
        if let Some(agent) = agent {
            agent
                .check_liveness()
                .map_err(|_| "The bound agent disconnected or changed. Please call again.")?;
        }
        if !active {
            return Ok(Flow::Continue);
        }
        {
            let speaking = {
                let output = owner.output.lock();
                if config.webrtc {
                    output.live_speaking()
                } else {
                    !output.samples.is_empty()
                }
            };
            let mut view = owner.view.lock();
            view.phase = if speaking {
                "speaking"
            } else if view.muted {
                "muted"
            } else if config.webrtc && view.startup.first_input.is_none() {
                "starting"
            } else {
                "listening"
            };
        }
        if let Some(backend) = backend.as_mut()
            && backend.take_continuation()
        {
            let id = send(socket, Command::ResponseCreate).await?;
            backend.request_sent(id);
        }
        if let Some(agent) = agent {
            LiveVoiceAdapter::dispatch(owner, agent, socket, state, tasks).await?;
        }

        Ok(Flow::Continue)
    }
}
fn record_rejection(
    owner: &RealtimeVoiceAdapter,
    provider: &voice_call_openai::session::Live,
    event_id: &str,
) {
    {
        let mut view = owner.view.lock();
        view.live_command_errors = provider.command_errors;
        view.live_error.clone_from(&provider.last_error);
        view.error = Some(voice_call_openai::live::errors::COMMAND_REJECTED);
    }
    if let Some(transcript) = owner.output.lock().live_transcript.as_mut() {
        let mut event =
            crate::voice_history::Event::new("protocol", "GPT-Live request", "rejected");
        event.output = serde_json::to_string(&provider.last_error).ok();
        transcript.event(event_id, event);
    }
}

fn confirm_start(owner: &RealtimeVoiceAdapter, config: &Config) -> bool {
    let muted = {
        let mut view = owner.view.lock();
        view.startup.settings_confirmed = Some(
            owner
                .client_elapsed_ms
                .saturating_add(super::super::startup::elapsed(owner.started_at)),
        );
        if !config.webrtc {
            view.media_ready = true;
            view.phase = if view.muted { "muted" } else { "listening" };
            view.recovery = super::super::recovery::State::Active;
        }
        view.muted
    };
    if config.webrtc {
        super::super::webrtc::media_connected(owner);
    } else {
        owner.ready.store(true, Ordering::Release);
    }
    muted
}
