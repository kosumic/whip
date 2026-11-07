use super::{Audio, Event, Result};
use crate::live::{Control, Selection, usage::DurationUsage};
use base64::{Engine, engine::general_purpose::STANDARD};
use oai_rt_rs::live as api;
use std::time::Instant;

pub struct LiveConfig {
    pub model: String,
    pub voice: String,
    pub backend_model: Option<String>,
    pub session_id: Option<String>,
}
pub struct Live {
    config: LiveConfig,
    pub control: Control,
    pub usage: DurationUsage,
    pub(super) started: Instant,
}
impl Live {
    pub(super) fn new(mut config: LiveConfig) -> Self {
        Self {
            control: Control::new(config.session_id.take()),
            config,
            usage: DurationUsage::default(),
            started: Instant::now(),
        }
    }
    pub fn pin_session(&mut self, session: &api::SessionSnapshot) -> Result {
        self.control.pin_session(
            session,
            &Selection {
                model: &self.config.model,
                voice: &self.config.voice,
                backend_model: self.config.backend_model.as_deref(),
            },
        )
    }
    pub(super) fn check_deadline(&self) -> Result {
        if !self.control.started && self.started.elapsed() > crate::IO_TIMEOUT {
            return Err("GPT-Live session startup timed out.");
        }
        if self
            .control
            .muted
            .as_ref()
            .is_some_and(|(_, _, at)| at.elapsed() > crate::IO_TIMEOUT)
        {
            return Err("GPT-Live did not confirm the microphone state.");
        }
        Ok(())
    }
    pub(super) fn receive(
        &mut self,
        text: &str,
        webrtc: bool,
        audio: &impl Audio,
    ) -> Result<Option<Event>> {
        let frame = crate::live::codec()
            .decode_server(text)
            .map_err(|_| "GPT-Live returned an invalid session event.")?;
        if !self.control.unique(&frame)? {
            return Ok(None);
        }
        match &frame.event {
            api::ServerEvent::Started { session, .. } => {
                if self.control.started {
                    return Err("GPT-Live session started more than once.");
                }
                self.pin_session(session)?;
                self.control.started = true;
            }
            api::ServerEvent::Updated { session, .. } => self.pin_session(session)?,
            api::ServerEvent::Closed {
                session,
                usage,
                reason,
                ..
            } => {
                self.pin_session(session)?;
                self.usage
                    .observe(usage.seconds, *reason != api::CloseReason::ConnectionLost)?;
                self.control.started = false;
                audio.confirm_live_closed();
            }
            api::ServerEvent::Error { error, .. } => {
                return Err(crate::live::errors::rejected(
                    error,
                    self.config.backend_model.is_some(),
                ));
            }
            _ if !self.control.started => return Err("GPT-Live session did not start correctly."),
            api::ServerEvent::UsageUpdated { usage, .. } => {
                self.usage.observe(usage.seconds, false)?
            }
            api::ServerEvent::InputTranscriptDelta { end_ms, .. } => {
                if self.control.input_caption(*end_ms) {
                    audio.resume_live_audio();
                }
            }
            api::ServerEvent::OutputAudioDelta { delta, .. }
                if !webrtc && self.control.suppress_output_after.is_none() =>
            {
                let pcm = STANDARD
                    .decode(delta)
                    .map_err(|_| "GPT-Live returned invalid audio.")?;
                audio.render_pcm("live-stream".into(), 0, pcm)?;
            }
            api::ServerEvent::InputAudioMuted { .. } => {
                if !self
                    .control
                    .confirm_mute(frame.client_event_id.as_deref(), true)
                {
                    return Ok(None);
                }
                audio.set_muted(true)?;
            }
            api::ServerEvent::InputAudioUnmuted { .. } => {
                if !self
                    .control
                    .confirm_mute(frame.client_event_id.as_deref(), false)
                {
                    return Ok(None);
                }
                audio.set_muted(false)?;
            }
            _ => {}
        }
        Ok(Some(Event::Live(frame)))
    }
}
