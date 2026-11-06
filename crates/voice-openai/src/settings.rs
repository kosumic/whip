//! Validate effective session.updated settings before accepting native capture.
use crate::captions::Language;
pub struct AudioSettings {
    pub voice: String,
    pub turn_detection: Option<oai_rt_rs::protocol::models::TurnDetection>,
    pub preview: bool,
    pub language: Language,
}
impl AudioSettings {
    pub fn validate_audio(&self, audio: oai_rt_rs::AudioConfig) -> Result<(), &'static str> {
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
        let requested = serde_json::to_value(&self.turn_detection)
            .map_err(|_| "Invalid Realtime VAD settings.")?;
        if requested.is_null() {
            return if accepted.is_null() {
                Ok(())
            } else {
                Err("OpenAI did not accept the selected Realtime VAD settings.")
            };
        }
        // Unspecified flags retain the adapter's automatic-turn defaults. Hosts
        // can explicitly disable either policy without being treated as previews.
        let creates_response = requested["create_response"].as_bool().unwrap_or(true);
        let interrupts_response = requested["interrupt_response"].as_bool().unwrap_or(true);
        if !requested.as_object().is_some_and(|fields| {
            fields
                .iter()
                .all(|(key, value)| accepted.get(key) == Some(value))
        }) || accepted["create_response"].as_bool() != Some(creates_response)
            || accepted["interrupt_response"].as_bool() != Some(interrupts_response)
        {
            return Err("OpenAI did not accept the selected Realtime VAD settings.");
        }
        Ok(())
    }
}
/// Only session.updated confirms effective settings. A transport's initial
/// session.created can still contain defaults with transcription disabled.
#[derive(Default)]
pub struct Settings {
    confirmed: bool,
    captions: Option<super::captions::Diagnostics>,
}

impl Settings {
    pub fn observe(
        &mut self,
        config: &AudioSettings,
        event: &oai_rt_rs::ServerEvent,
    ) -> Result<bool, &'static str> {
        let oai_rt_rs::ServerEvent::SessionUpdated { session, .. } = event else {
            return Ok(false);
        };
        self.confirmed = false;
        let audio = session
            .config
            .audio
            .clone()
            .ok_or("OpenAI did not negotiate audio.")?;
        if !config.preview {
            let captions = super::captions::Diagnostics::confirm(config.language, &audio);
            let accepted = captions.validate();
            self.captions = Some(captions);
            accepted?;
        }
        config.validate_audio(audio)?;
        self.confirmed = true;
        Ok(true)
    }

    pub fn is_confirmed(&self) -> bool {
        self.confirmed
    }

    pub fn take_captions(&mut self) -> Option<super::captions::Diagnostics> {
        self.captions.take()
    }
}
