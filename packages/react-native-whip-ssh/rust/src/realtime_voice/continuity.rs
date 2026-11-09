//! Native logical-call owner. Neither JS polling nor UI/app-lock events drive it.
use super::{
    Arc, BoundTargets, ClientEvent, Command, Config, JoinSet, Ordering, PinnedAgent,
    RealtimeVoiceAdapter, ToolCompletion, WhipToolSession, live, mpsc, recovery, terminal,
    transcript,
};
use voice_call_openai::{
    continuity::{Reason, connection_lost},
    session::Audio,
};

impl RealtimeVoiceAdapter {
    pub(super) fn provider_expiry(&self, session: &impl serde::Serialize) {
        let expires = serde_json::to_value(session)
            .ok()
            .and_then(|value| value["expires_at"].as_u64());
        if let Some(expires) = expires {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default();
            self.continuity
                .lock()
                .expires_in(super::Duration::from_secs(expires).saturating_sub(now));
        }
    }

    pub(super) fn recovering(&self, reason: Reason) {
        {
            let mut view = self.view.lock();
            if self.closed.load(Ordering::Acquire) {
                return;
            }
            view.phase = "reconnecting";
            view.level = 0.0;
            view.playback_level = 0.0;
        }
        let mut policy = self.continuity.lock();
        if !self.closed.load(Ordering::Acquire) {
            policy.diagnostics.status = voice_call_openai::continuity::Status::Reconnecting;
            policy.diagnostics.last_reason = Some(reason);
        }
    }

    pub(super) fn global_session(
        self: &Arc<Self>,
        shizuku: bool,
    ) -> Result<Arc<WhipToolSession>, &'static str> {
        if self.closed.load(Ordering::Acquire) || self.retiring.load(Ordering::Acquire) {
            return Err(recovery::CANCELLED);
        }
        let mut global = self.global.lock();
        if self.closed.load(Ordering::Acquire) || self.retiring.load(Ordering::Acquire) {
            return Err(recovery::CANCELLED);
        }
        if global.is_none() {
            // Fresh authority only when an action is requested while unlocked.
            // Rotation itself needs no protected UI or capability admission.
            let session = WhipToolSession::new(shizuku)?;
            session.bind_microphone(self);
            *global = Some(session);
        }
        global
            .clone()
            .ok_or("Global call controls are unavailable.")
    }

    pub(super) fn retire_session(&self) {
        self.retiring.store(true, Ordering::Release);
        // Intent, the absolute mute deadline and native transition speech belong
        // to the logical call, which may outlive this provider generation.
        self.ready.store(false, Ordering::Release);
        self.input.set_muted(true);
        if let Some(global) = self.global.lock().take() {
            global.close();
        }
        if let Some(media) = self.media.lock().as_ref() {
            media.cancel_audio(None);
        }
        self.view.lock().media_ready = false;
        // Bump the device playback epoch so submitted audio cannot be acknowledged
        // in a new generation. The native recorder/service remains the sole owner.
        self.output.lock().clear();
    }

    pub(super) fn continuity_tick(&self, idle: bool) -> Result<bool, &'static str> {
        if let Some(error) = *self.failure.lock() {
            return Err(error.message);
        }
        if !self.continuity_enabled {
            self.microphone_tick(std::time::Instant::now());
            return Ok(false);
        }
        let mut policy = self.continuity.lock();
        if self.ready.load(Ordering::Acquire) {
            policy.connected();
        }
        if let Some(reason) = policy.rotation(idle) {
            drop(policy);
            *self.replacement.lock() = Some(reason);
            self.recovering(reason);
            return Ok(true);
        }
        drop(policy);
        self.microphone_tick(std::time::Instant::now());
        Ok(false)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "The logical owner retains native resources and scope across provider generations."
    )]
    pub(super) async fn run_call(
        self: &Arc<Self>,
        mut config: Config,
        key: native_credentials::NativeCredential,
        update: Option<ClientEvent>,
        agent: Option<Arc<PinnedAgent>>,
        terminal: Option<Arc<terminal::Session>>,
        mut commands: mpsc::Receiver<Command>,
        tools: &mut JoinSet<ToolCompletion>,
    ) -> Result<(), &'static str> {
        config.restore_history().await?;
        self.view.lock().resumed_context_truncated = config
            .continuation
            .as_ref()
            .map(|context| context.truncated);
        let update = serde_json::to_value(config.history_update(update)?)
            .map_err(|_| "Invalid voice session.")?;
        let mut retrying = false;
        let mut established = false;
        loop {
            if self.closed.load(Ordering::Acquire) {
                return Ok(());
            }
            if !self.credentials_current() {
                return Err("Voice credentials were revoked.");
            }
            if !self.speech.is_current() {
                return Err("Voice audio was replaced by another speech session.");
            }
            if retrying {
                let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]) * 2;
                let delay = self.continuity.lock().retry(jitter)?;
                let mut cancel = self.cancel.subscribe();
                if *cancel.borrow() {
                    return Ok(());
                }
                tokio::select! { biased;
                    _ = cancel.changed() => return Ok(()),
                    () = tokio::time::sleep(delay) => {}
                }
                if !self.credentials_current() {
                    return Err("Voice credentials were revoked.");
                }
                // An anonymous, non-creating request avoids POSTs while offline.
                let reachable = tokio::select! { biased;
                    _ = cancel.changed() => return Ok(()),
                    reachable = voice_call_openai::prepared::reachable() => reachable,
                };
                if !reachable {
                    continue;
                }
            }
            if agent
                .as_ref()
                .is_some_and(|agent| agent.check_liveness().is_err())
            {
                return Err("The bound agent disconnected or changed. Please call again.");
            }
            if terminal
                .as_ref()
                .is_some_and(|terminal| terminal.target.check().is_err())
            {
                return Err(crate::host_runtime::realtime_terminal::CHANGED);
            }
            while commands.try_recv().is_ok() {} // Never replay queued work.
            self.retiring.store(false, Ordering::Release);
            *self.failure.lock() = None;
            *self.replacement.lock() = None;
            let started = tokio::time::Instant::now();
            let result = if config.live {
                live::LiveVoiceAdapter::run(
                    self.clone(),
                    config.clone(),
                    &key,
                    agent.clone(),
                    &mut commands,
                )
                .await
            } else {
                let update =
                    serde_json::from_value(update.clone()).map_err(|_| "Invalid voice session.")?;
                // A POST is never dropped on cancellation: read its returned ID
                // and hang up before releasing ownership or creating anything else.
                match self
                    .prepare_connection(&config, &key, update, agent.as_ref(), terminal.as_ref())
                    .await
                {
                    Ok((socket, at)) if !self.closed.load(Ordering::Acquire) => {
                        let targets = BoundTargets {
                            agent: agent.clone(),
                            terminal: terminal
                                .as_ref()
                                .map(|session| terminal::Session::new(session.target.clone())),
                        };
                        self.run(config.clone(), socket, at, targets, &mut commands, tools)
                            .await
                    }
                    Ok(_) => Ok(()),
                    Err(error) => {
                        *self.failure.lock() = Some(error);
                        Err(error.message)
                    }
                }
            };
            let connected = self.view.lock().startup.settings_confirmed.is_some();
            established |= connected;
            self.retire_session();
            tools.shutdown().await;
            let media = self.media.lock().take();
            let clean = if let Some(media) = media {
                media.close().await
            } else {
                Ok(())
            };
            self.continuity.lock().attempt(
                self.attempt.load(Ordering::Acquire),
                started.elapsed(),
                connected,
            );
            if self.closed.load(Ordering::Acquire) {
                return Ok(());
            }
            clean?; // A failed/uncertain hangup never admits a new session.
            let reason = self.replacement.lock().take();
            let reason = match (reason, result) {
                (Some(reason), Ok(())) if self.continuity_enabled => reason,
                (_, Err(error))
                    if self.continuity_enabled
                        && established
                        && (connection_lost(error)
                            || self.failure.lock().is_some_and(|failure| failure.retryable)) =>
                {
                    Reason::ConnectionLost
                }
                (_, result) => {
                    if result.is_ok() {
                        self.close();
                    }
                    return result;
                }
            };
            let stable = self.continuity.lock().replacing(reason);
            {
                let mut view = self.view.lock();
                view.phase = "reconnecting";
                view.level = 0.0;
                view.playback_level = 0.0;
                view.text.clear();
                view.user_text.clear();
                view.startup.first_input = None;
                view.startup.settings_confirmed = None;
                view.usage_finalized = false;
                view.input_tokens = 0;
                view.output_tokens = 0;
                view.estimated_usd = None;
                view.cost_incomplete = false;
                view.backend_text = None;
                view.live_seconds = None;
                view.tool = None;
            }
            // Captions and function IDs belong to their saved session, never to
            // replacement prompts. Persisted per-session costs remain separate.
            {
                let mut output = self.output.lock();
                output.transcript = transcript::Transcript::default();
                output.live_transcript = config.live.then(live::captions::Transcript::default);
            }
            // Bad/expired server clocks must not create unlimited short sessions.
            retrying = reason == Reason::ConnectionLost || !stable;
        }
    }
}
