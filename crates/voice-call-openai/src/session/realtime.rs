use super::{Audio, Event, Result};
use crate::{
    ClientEvent, ServerEvent,
    response::ResponseCreateQueue,
    settings::{AudioSettings, Settings},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

pub struct RealtimeConfig {
    pub model: String,
    pub audio: AudioSettings,
}
pub struct Realtime {
    config: RealtimeConfig,
    pub settings: Settings,
    pub responses: ResponseCreateQueue,
    pub ignored: HashSet<String>,
    seen: crate::wire::Seen,
    started: Instant,
    pub(super) truncate: Option<ClientEvent>,
}
impl Realtime {
    pub(super) fn new(config: RealtimeConfig) -> Self {
        Self {
            config,
            settings: Settings::default(),
            responses: ResponseCreateQueue::default(),
            ignored: HashSet::new(),
            seen: crate::wire::Seen::default(),
            started: Instant::now(),
            truncate: None,
        }
    }
    pub(super) fn ignore(&mut self, id: String) -> Result {
        if self.ignored.len() >= crate::tools::MAX_CALLS && !self.ignored.contains(&id) {
            return Err("Realtime interruption limit reached. Start a new call.");
        }
        self.ignored.insert(id);
        Ok(())
    }
    pub(super) fn check_deadline(&self) -> Result {
        if !self.settings.is_confirmed() && self.started.elapsed() > crate::IO_TIMEOUT {
            return Err("OpenAI did not confirm the Realtime session settings.");
        }
        if self.started.elapsed() > Duration::from_mins(55) {
            return Err("Realtime call time limit reached. Start a new call.");
        }
        Ok(())
    }
    pub(super) fn receive(
        &mut self,
        text: &str,
        webrtc: bool,
        audio: &impl Audio,
        prefix: &str,
    ) -> Result<Option<Event>> {
        if webrtc && !self.seen.accept(text)? {
            return Ok(None);
        }
        let event: ServerEvent = serde_json::from_str(text)
            .map_err(|_| "OpenAI returned an unsupported Realtime event.")?;
        match &event {
            ServerEvent::SessionCreated { session, .. }
            | ServerEvent::SessionUpdated { session, .. } => {
                let confirmed = &session.config.model;
                if confirmed != &self.config.model
                    && !crate::models::selected(Some(&self.config.model))
                        .is_ok_and(|model| model.accepts(confirmed))
                {
                    return Err(crate::models::MISMATCH);
                }
                self.settings.observe(&self.config.audio, &event)?;
            }
            ServerEvent::ResponseCreated { response, .. } => {
                self.responses.mark_started(response.id.clone())
            }
            ServerEvent::Error { error, .. } => {
                if error.is_response_cancel_not_active() {
                    return Ok(None);
                }
                if crate::response::is_active_response_error_for(error, prefix) {
                    self.responses.defer_active_response();
                    return Ok(None);
                }
                return Err(crate::response::provider_error_message_for(error, prefix));
            }
            ServerEvent::ResponseDone { response, .. }
            | ServerEvent::ResponseCancelled { response, .. } => {
                self.responses.mark_finished(&response.id);
            }
            ServerEvent::InputAudioBufferSpeechStarted { .. } => {
                self.responses.speech_started();
                if let Some(id) = self.responses.active().cloned() {
                    self.ignore(id)?;
                }
                self.truncate = audio.interrupt();
            }
            ServerEvent::InputAudioBufferSpeechStopped { .. } => self.responses.speech_stopped(),
            ServerEvent::ResponseOutputAudioDelta {
                response_id,
                item_id,
                content_index,
                delta,
                ..
            } if !webrtc && !self.ignored.contains(response_id) => {
                let pcm = STANDARD
                    .decode(delta)
                    .map_err(|_| "OpenAI returned invalid audio.")?;
                audio.render_pcm(item_id.clone(), *content_index, pcm)?;
            }
            _ => {}
        }
        Ok(Some(Event::Realtime(event)))
    }
}
