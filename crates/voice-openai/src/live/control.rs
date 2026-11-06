//! Provider session identity, duplicate detection, mute and interruption gates.
use api::Field;
use oai_rt_rs::live as api;
use serde_json::Value;
use std::{collections::HashSet, time::Instant};
const MAX_EVENTS: usize = 16_384;
pub struct Selection<'a> {
    pub model: &'a str,
    pub voice: &'a str,
    pub backend_model: Option<&'a str>,
}
#[derive(Default)]
pub struct Control {
    pub session_id: Option<String>,
    pub started: bool,
    seen: HashSet<String>,
    pub muted: Option<(String, bool, Instant)>,
    pub suppress_output_after: Option<f64>,
}
impl Control {
    pub fn new(session_id: Option<String>) -> Self {
        Self {
            session_id,
            ..Self::default()
        }
    }
    pub fn interrupted(&mut self, offset: f64) {
        self.suppress_output_after = Some(offset);
    }
    pub fn input_caption(&mut self, end: f64) -> bool {
        if self.suppress_output_after.is_some_and(|after| end > after) {
            self.suppress_output_after = None;
            return true;
        }
        false
    }
    pub fn confirm_mute(&mut self, id: Option<&str>, muted: bool) -> bool {
        if self.muted.as_ref().is_some_and(|(pending_id, pending, _)| {
            Some(pending_id.as_str()) == id && *pending == muted
        }) {
            self.muted = None;
            true
        } else {
            false
        }
    }
    pub fn unique(&mut self, frame: &api::ServerFrame) -> Result<bool, &'static str> {
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
    pub fn pin_session(
        &mut self,
        session: &api::SessionSnapshot,
        config: &Selection<'_>,
    ) -> Result<(), &'static str> {
        if session.model != config.model
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
                        .is_some_and(|voice| voice != &api::Voice::Named(config.voice.to_owned()))
            })
            || match &session.delegation {
                Field::Value(api::DelegationConfig::Responses { responses }) => {
                    config.backend_model != Some(responses.model.as_str())
                }
                _ => config.backend_model.is_some(),
            }
        {
            return Err("OpenAI did not accept the selected GPT-Live session configuration.");
        }
        self.session_id = Some(session.id.clone());
        Ok(())
    }
}
