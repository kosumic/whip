//! Whip application policy over the reusable provider session driver.
use super::{
    Arc, BACKGROUND_AGENT, BoundTargets, Command, Config, Instant, JoinSet, Ordering,
    PREVIEW_AUDIO_LIMIT, PREVIEW_TIMEOUT, PinnedAgent, REMAIN_SILENT, RealtimeVoiceAdapter,
    ServerEvent, ToolCompletion, ToolLedger, Value, bounded_text, cost, delegation, feedback,
    feedback_message, forward_feedback, function_output, global_submitted_message, global_tools,
    handoff_context, json, limit_text, live, mpsc, next_response, preview_response, send,
    spawn_delegation, submitted_message, terminal, terminal_submitted_message, watch, webrtc,
};
use voice_call_openai::session::{Delegate, Event, Flow, Session};

pub(super) enum Work {
    Command(Command),
    Tool(std::result::Result<ToolCompletion, tokio::task::JoinError>),
}
pub(super) struct App<'a> {
    owner: &'a Arc<RealtimeVoiceAdapter>,
    config: Config,
    agent: Option<Arc<PinnedAgent>>,
    terminal: Option<Arc<terminal::Session>>,
    commands: &'a mut mpsc::Receiver<Command>,
    cancellation: watch::Receiver<bool>,
    tools: &'a mut JoinSet<ToolCompletion>,
    costs: &'a mut cost::CurrentChat,
    configuration_started: Instant,
    started: tokio::time::Instant,
    input_item: String,
    ledger: ToolLedger,
    global_calls: voice_call_openai::tools::Ledger,
    preview_done: bool,
    preview_requested: bool,
    handoff: Option<feedback::Handoff>,
    deferred: delegation::Deferred,
    context: handoff_context::Context,
    last_audio_response: Option<String>,
}
impl<'a> App<'a> {
    pub(super) fn new(
        owner: &'a Arc<RealtimeVoiceAdapter>,
        config: Config,
        targets: BoundTargets,
        commands: &'a mut mpsc::Receiver<Command>,
        tools: &'a mut JoinSet<ToolCompletion>,
        costs: &'a mut cost::CurrentChat,
        configuration_started: Instant,
    ) -> Self {
        Self {
            owner,
            config,
            agent: targets.agent,
            terminal: targets.terminal,
            commands,
            cancellation: owner.cancel.subscribe(),
            tools,
            costs,
            configuration_started,
            started: tokio::time::Instant::now(),
            input_item: String::new(),
            ledger: ToolLedger::default(),
            global_calls: voice_call_openai::tools::Ledger::default(),
            preview_done: false,
            preview_requested: false,
            handoff: None,
            deferred: delegation::Deferred::default(),
            context: handoff_context::Context::default(),
            last_audio_response: None,
        }
    }
    async fn tool(
        &mut self,
        socket: &mut super::RealtimeSocket,
        responses: &mut super::response::ResponseCreateQueue,
        call: delegation::Invocation,
    ) -> Result<Flow, &'static str> {
        let Self {
            owner,
            agent,
            terminal,
            tools,
            ledger,
            global_calls,
            deferred,
            handoff,
            context,
            ..
        } = self;
        let delegation::Invocation {
            already_spoke,
            call_id,
            name,
            arguments,
            response_id,
        } = call;
        if name != REMAIN_SILENT {
            let mut event = crate::voice_history::Event::new(
                if matches!(
                    name.as_str(),
                    BACKGROUND_AGENT | global_tools::AGENTS_PROMPT
                ) {
                    "delegation"
                } else {
                    "tool"
                },
                &name,
                "requested",
            );
            event.input = Some(limit_text(arguments.clone()));
            owner.output.lock().transcript.event(&call_id, event);
        }
        if self.config.global {
            // Remember denied requests too: unlocking may admit a new action,
            // never replay the identity of one denied while locked.
            match global_calls.begin(&call_id, &arguments, voice_call_openai::tools::Access::Read) {
                Ok(_) => {}
                Err("duplicate") => return Ok(Flow::Continue),
                Err(_) => return Err("Global tool admission failed."),
            }
            let Ok(global) = owner.global_session(self.config.global_shizuku_access) else {
                send(
                    socket,
                    function_output(call_id, json!({"error":"authorization_unavailable"})),
                )
                .await?;
                responses.request_create();
                return Ok(Flow::Continue);
            };
            if !global.admit(&call_id)? {
                return Ok(Flow::Continue);
            }
            if tools.len() >= delegation::MAX_PENDING {
                owner
                    .output
                    .lock()
                    .transcript
                    .event_result(&call_id, &json!({"error":"queue_full"}));
                send(
                    socket,
                    function_output(call_id, json!({"error":"queue_full"})),
                )
                .await?;
                responses.request_create();
            } else {
                owner
                    .output
                    .lock()
                    .transcript
                    .event_status(&call_id, "running");
                let global = global.clone();
                tools.spawn(async move {
                    ToolCompletion {
                        value: global.execute(&name, &arguments).await,
                        call_id,
                        deferred: false,
                    }
                });
            }
            return Ok(Flow::Continue);
        }
        if let Some(terminal) = &terminal {
            if tools.len() >= delegation::MAX_PENDING {
                owner
                    .output
                    .lock()
                    .transcript
                    .event_result(&call_id, &json!({"error":"queue_full"}));
            } else {
                owner
                    .output
                    .lock()
                    .transcript
                    .event_status(&call_id, "running");
            }
            terminal
                .handle(socket, tools, responses, (call_id, name, arguments))
                .await?;
            return Ok(Flow::Continue);
        }
        let agent = agent
            .as_ref()
            .ok_or("Voice previews cannot execute tools.")?;
        let event_id = call_id.clone();
        let later = serde_json::from_str::<Value>(&arguments)
            .is_ok_and(|value| value["delivery"] == "later");
        let transcript = owner.output.lock().transcript.delegation_snapshot();
        let dispatch = delegation::Dispatch {
            context,
            transcript,
            ledger,
            deferred,
            handoff,
            tools,
            responses,
        };
        let call = delegation::Invocation {
            already_spoke,
            call_id,
            name: name.clone(),
            arguments,
            response_id,
        };
        if dispatch.handle(socket, agent, call).await? {
            owner
                .output
                .lock()
                .transcript
                .event_status(&event_id, if later { "queued" } else { "running" });
            owner.view.lock().tool = Some(name);
        } else {
            owner
                .output
                .lock()
                .transcript
                .event_status(&event_id, "not_admitted");
        }
        Ok(Flow::Continue)
    }
}
impl Delegate for App<'_> {
    type Work = Work;
    async fn next_work(&mut self) -> Option<Work> {
        tokio::select! { biased;
        _ = self.cancellation.changed() => None,
        command = self.commands.recv() => command.map(Work::Command),
        completion = self.tools.join_next(), if !self.tools.is_empty() => completion.map(Work::Tool),
        }
    }
    async fn work(&mut self, session: &mut Session<'_>, work: Work) -> Result<Flow, &'static str> {
        if let Work::Command(command) = work {
            match command {
                Command::Submitted(text) => {
                    let event = if self.config.global {
                        global_submitted_message(&text)?
                    } else if self.terminal.is_some() {
                        terminal_submitted_message(&text)?
                    } else {
                        submitted_message(&text)?
                    };
                    session.send(event).await?;
                    if self.config.global {
                        session.realtime_state()?.responses.request_create();
                    }
                }
                Command::Skip => {
                    session.interrupt(&**self.owner).await?;
                    self.owner.view.lock().playback_level = 0.0;
                    self.owner.view.lock().phase = "listening";
                }
                Command::Mute(muted) => {
                    let current = self.owner.microphone.lock().muted;
                    if current == muted {
                        session.mute(&**self.owner, muted).await?;
                    }
                }
            }
            return Ok(Flow::Continue);
        }
        let Work::Tool(completion) = work else {
            return Ok(Flow::Continue);
        };

        let Self {
            owner,
            agent,
            terminal,
            tools,
            handoff,
            deferred,
            ledger,
            ..
        } = self;
        let voice_call_openai::session::Protocol::Realtime(state) = &mut session.protocol else {
            return Err("Invalid voice protocol.");
        };
        let socket = &mut *session.socket;
        let responses = &mut state.responses;

        let ToolCompletion {
            call_id,
            deferred: was_deferred,
            mut value,
        } = completion.map_err(|_| "Realtime tool task failed.")?;
        let transcript_result = if !self.config.global && terminal.is_none() {
            json!({"completion":value["completion"], "error":value["error"], "result":live::public_result(&value)})
        } else {
            value.clone()
        };
        owner
            .output
            .lock()
            .transcript
            .event_result(&call_id, &transcript_result);
        if self.config.global {
            if owner.closed.load(Ordering::Acquire) {
                return Ok(Flow::Continue);
            }
            let silent = value == json!({});
            send(socket, function_output(call_id, value)).await?;
            if !silent {
                responses.request_create();
            }
            return Ok(Flow::Continue);
        }
        if let Some(terminal) = &terminal {
            terminal.complete(socket, responses, call_id, value).await?;
            return Ok(Flow::Continue);
        }
        let agent = agent
            .as_ref()
            .ok_or("Voice previews cannot execute tools.")?;
        agent
            .check_liveness()
            .map_err(|_| "The bound agent disconnected or changed. Please call again.")?;
        let uncertain = value.get("error").and_then(Value::as_str) == Some("outcome_unknown");
        ledger.complete(true, uncertain);
        if was_deferred {
            deferred.finish();
        }
        owner.view.lock().tool = None;
        if let Some(handoff) = handoff.as_mut() {
            forward_feedback(owner, socket, agent, handoff).await?;
            value["handoff_role"] = json!(if handoff.call_id == call_id {
                "original"
            } else {
                "followup"
            });
        }
        if uncertain {
            agent.mark_uncertain();
            let cancelled = deferred.cancel();
            if cancelled > 0 {
                send(socket, feedback_message("Unsent deferred requests were cancelled because a submission outcome is unknown. Inspect the agent before submitting again.")?).await?;
            }
        }
        if value.get("error").is_none() && value["completion"] != "submitted" {
            value["feedback_guidance"] = json!(feedback::FINISHED_GUIDANCE);
        }
        if was_deferred {
            send(
                socket,
                feedback_message(&format!("Deferred request turn observation: {value}"))?,
            )
            .await?;
        } else {
            send(socket, function_output(call_id, value)).await?;
        }
        if tools.is_empty() && deferred.len() == 0 {
            *handoff = None;
        }
        responses.request_create();

        Ok(Flow::Continue)
    }
    async fn tick(&mut self, session: &mut Session<'_>) -> Result<Flow, &'static str> {
        let drained = {
            let output = self.owner.output.lock();
            output.generated == output.played
        };
        let idle = self.tools.is_empty()
            && self.deferred.len() == 0
            && session.realtime_state()?.responses.is_idle()
            && drained
            && self
                .terminal
                .as_ref()
                .is_none_or(|terminal| !terminal.busy());
        if self.owner.continuity_tick(idle)? {
            return Ok(Flow::Stop);
        }
        let Self {
            owner,
            config,
            agent,
            terminal,
            tools,
            started,
            preview_done,
            handoff,
            deferred,
            ..
        } = self;
        let voice_call_openai::session::Protocol::Realtime(state) = &mut session.protocol else {
            return Err("Invalid voice protocol.");
        };
        let socket = &mut *session.socket;
        let responses = &mut state.responses;

        if !owner.speech.is_current() {
            return Err("Voice audio was replaced by another speech session.");
        }
        if let Some(agent) = &agent {
            agent
                .check_liveness()
                .map_err(|_| "The bound agent disconnected or changed. Please call again.")?;
        }
        if let Some(terminal) = &terminal {
            terminal.forward_feedback(owner, socket, responses).await?;
        }
        if config.preview && started.elapsed() > PREVIEW_TIMEOUT {
            return Err("Voice preview timed out. Please try again.");
        }
        if *preview_done
            && (!config.webrtc
                || owner
                    .media
                    .lock()
                    .as_ref()
                    .is_some_and(webrtc::Handle::drained))
            && {
                let output = owner.output.lock();
                output.generated == output.played
            }
        {
            if owner.output.lock().generated == 0 {
                return Err("OpenAI returned no playable voice preview audio.");
            }
            owner.view.lock().phase = "closed";
            owner.closed.store(true, Ordering::Release);
            return Ok(Flow::Stop);
        }
        if let Some(pending) = deferred.take() {
            spawn_delegation(
                tools,
                agent.as_ref().ok_or("Missing bound voice agent.")?.clone(),
                pending,
                true,
                false,
            );
        }
        if let Some(handoff) = handoff.as_mut() {
            forward_feedback(
                owner,
                socket,
                agent.as_ref().ok_or("Missing bound voice agent.")?,
                handoff,
            )
            .await?;
        }
        if {
            let output = owner.output.lock();
            output.generated == output.played
        } && let Some(event) = next_response(responses, handoff.as_mut(), Instant::now())?
        {
            send(socket, event).await?;
            responses.mark_requested();
        }
        if owner.ready.load(Ordering::Acquire) {
            let output = owner.output.lock();
            let mut view = owner.view.lock();
            view.phase = if output.generated > output.played {
                "speaking"
            } else if view.muted {
                "muted"
            } else if owner.webrtc && owner.allow_input && view.startup.first_input.is_none() {
                "starting"
            } else if !tools.is_empty() || responses.is_active() {
                "waiting"
            } else {
                "listening"
            };
            if output.generated == output.played {
                view.playback_level = 0.0;
            }
        }

        Ok(Flow::Continue)
    }
    async fn event(
        &mut self,
        session: &mut Session<'_>,
        event: Event,
    ) -> Result<Flow, &'static str> {
        let Event::Realtime(event) = event else {
            return Err("Invalid voice protocol.");
        };
        let Self {
            owner,
            config,
            costs,
            configuration_started,
            input_item,
            preview_done,
            preview_requested,
            handoff,
            last_audio_response,
            ..
        } = self;
        let voice_call_openai::session::Protocol::Realtime(state) = &mut session.protocol else {
            return Err("Invalid voice protocol.");
        };
        let socket = &mut *session.socket;
        let responses = &mut state.responses;
        let ignored = &state.ignored;
        let settings = &mut state.settings;
        owner.view.lock().server_events += 1;
        if matches!(
            event,
            ServerEvent::InputAudioBufferSpeechStarted { .. }
                | ServerEvent::InputAudioBufferSpeechStopped { .. }
                | ServerEvent::InputAudioBufferCommitted { .. }
        ) {
            owner.view.lock().input_speech_events += 1;
        }
        if matches!(
            event,
            ServerEvent::InputAudioTranscriptionDelta { .. }
                | ServerEvent::InputAudioTranscriptionCompleted { .. }
                | ServerEvent::ResponseOutputAudioTranscriptDelta { .. }
                | ServerEvent::ResponseOutputAudioTranscriptDone { .. }
        ) {
            owner.view.lock().caption_events += 1;
        }
        if let ServerEvent::SessionCreated { session, .. } = &event {
            owner.provider_expiry(session);
            return Ok(Flow::Continue);
        }
        if costs.observe(&event) {
            let mut view = owner.view.lock();
            view.estimated_usd = costs.estimated_usd();
            view.cost_incomplete = costs.is_partial();
        }
        if !config.webrtc || !matches!(event, ServerEvent::ResponseOutputAudioDone { .. }) {
            owner.output.lock().transcript.observe(&event, ignored);
        }
        if let ServerEvent::ResponseFunctionCallArgumentsDone {
            call_id,
            name,
            arguments,
            response_id,
            ..
        } = event
        {
            if ignored.contains(&response_id) {
                return Ok(Flow::Continue);
            }
            let already_spoke = last_audio_response.as_deref() == Some(response_id.as_str());
            return self
                .tool(
                    socket,
                    responses,
                    delegation::Invocation {
                        call_id,
                        name,
                        arguments,
                        response_id,
                        already_spoke,
                    },
                )
                .await;
        }
        match event {
            ServerEvent::SessionUpdated { .. } | ServerEvent::SessionCreated { .. } => {
                if !settings.is_confirmed() {
                    return Ok(Flow::Continue);
                }
                if let Some(captions) = settings.take_captions() {
                    owner.view.lock().captions = Some(captions);
                }
                owner.audio_confirmed(config, *configuration_started);
                if config.preview && !*preview_requested {
                    *preview_requested = true;
                    send(socket, preview_response(config)?).await?;
                    responses.mark_requested();
                }
            }
            ServerEvent::ResponseCreated { .. } => {
                owner.view.lock().text.clear();
            }
            ServerEvent::ResponseDone { response: done, .. }
            | ServerEvent::ResponseCancelled { response: done, .. } => {
                if let Some(usage) = done.usage {
                    let mut view = owner.view.lock();
                    view.input_tokens += u64::from(usage.input_tokens);
                    view.output_tokens += u64::from(usage.output_tokens);
                }
                if config.preview {
                    if !matches!(done.status, oai_rt_rs::ResponseStatus::Completed)
                        || (!config.webrtc && owner.output.lock().generated == 0)
                    {
                        return Err("OpenAI did not complete the voice preview. Please try again.");
                    }
                    *preview_done = true;
                }
            }
            ServerEvent::OutputAudioBufferStarted { response_id, .. }
                if config.webrtc && !ignored.contains(&response_id) =>
            {
                if let Some(handoff) = handoff.as_mut() {
                    handoff.audio(&response_id, Instant::now());
                }
                *last_audio_response = Some(response_id);
            }
            ServerEvent::ResponseOutputAudioDelta { response_id, .. } => {
                if config.webrtc || ignored.contains(&response_id) {
                    return Ok(Flow::Continue);
                }
                if let Some(handoff) = handoff.as_mut() {
                    handoff.audio(&response_id, Instant::now());
                }
                *last_audio_response = Some(response_id);
                if config.preview && owner.output.lock().generated > PREVIEW_AUDIO_LIMIT {
                    return Err("Voice preview exceeded its audio limit.");
                }
            }
            ServerEvent::InputAudioBufferSpeechStarted { item_id, .. } => {
                *input_item = item_id;
                owner.view.lock().text.clear();
                owner.view.lock().user_text.clear();
            }
            ServerEvent::ResponseOutputAudioTranscriptDelta {
                response_id, delta, ..
            } => {
                if !ignored.contains(&response_id) {
                    bounded_text(&mut owner.view.lock().text, &delta);
                }
            }
            ServerEvent::InputAudioTranscriptionCompleted {
                item_id,
                transcript,
                ..
            } => {
                if item_id == *input_item {
                    owner.view.lock().user_text = limit_text(transcript);
                }
            }
            ServerEvent::InputAudioTranscriptionFailed { .. } => {
                owner.view.lock().error =
                    Some("OpenAI could not transcribe this turn. Voice audio is still connected.");
            }

            _ => {}
        }

        Ok(Flow::Continue)
    }
}
