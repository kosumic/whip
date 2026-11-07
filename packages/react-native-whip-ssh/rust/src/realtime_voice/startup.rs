//! Settings acknowledgement and duration-only diagnostics. Never log payloads or credentials.
use serde::Serialize;
use std::time::Instant;

#[cfg(test)]
#[derive(Default)]
pub(super) struct Settings(voice_openai::settings::Settings);
#[cfg(test)]
impl Settings {
    pub(super) fn observe(
        &mut self,
        config: &super::Config,
        event: &oai_rt_rs::ServerEvent,
    ) -> Result<bool, &'static str> {
        self.0.observe(&config.audio_settings()?, event)
    }
    pub(super) fn is_confirmed(&self) -> bool {
        self.0.is_confirmed()
    }
    pub(super) fn take_captions(&mut self) -> Option<super::captions::Diagnostics> {
        self.0.take_captions()
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Timings {
    pub prepared_client: bool,
    #[serde(rename = "offerMs")]
    pub offer: Option<u64>,
    #[serde(rename = "negotiationMs")]
    pub negotiation: Option<u64>,
    #[serde(rename = "preparationMs")]
    pub preparation: Option<u64>,
    #[serde(rename = "credentialsMs")]
    pub credentials: Option<u64>,
    #[serde(rename = "websocketMs")]
    pub websocket: Option<u64>,
    #[serde(rename = "configurationMs")]
    pub configuration: Option<u64>,
    #[serde(rename = "settingsConfirmedMs")]
    pub settings_confirmed: Option<u64>,
    #[serde(rename = "listeningMs")]
    pub listening: Option<u64>,
    #[serde(rename = "firstInputMs")]
    pub first_input: Option<u64>,
}

pub(super) fn elapsed(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::{Settings, Timings};
    use crate::realtime_voice::Config;
    use oai_rt_rs::ServerEvent;
    use serde_json::{Value, json};

    fn config() -> Result<Config, serde_json::Error> {
        serde_json::from_value(json!({
            "webrtc":true,"voice":"cedar",
            "vad":{"type":"server_vad","threshold":0.4,"prefix_padding_ms":256,"silence_duration_ms":800}
        }))
    }

    // Server-shaped fixtures, including a default created event with captions off.
    fn event(kind: &str) -> Value {
        let updated = kind == "session.updated";
        let model = crate::realtime_voice::models::selected(None)
            .map(|model| model.id.as_str())
            .unwrap_or("catalog-unavailable");
        json!({
            "type":kind,"event_id":format!("event_{kind}"),
            "session":{
                "id":"sess_fixture","object":"realtime.session","type":"realtime",
                "expires_at":2_000_000_000_u64,"model":model,"output_modalities":["audio"],
                "audio":{
                    "input":{
                        "format":{"type":"audio/pcm","rate":24000},
                        "transcription":if updated { json!({"model":"gpt-4o-mini-transcribe","language":null,"prompt":""}) } else { Value::Null },
                        "turn_detection":{"type":"server_vad","threshold":0.4,"prefix_padding_ms":256,"silence_duration_ms":800,"create_response":true,"interrupt_response":true}
                    },
                    "output":{"format":{"type":"audio/pcm","rate":24000},"voice":if updated { "cedar" } else { "alloy" }}
                }
            }
        })
    }

    #[test]
    fn default_created_settings_do_not_fail_captions_or_confirm_configuration()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut settings = Settings::default();
        let created: ServerEvent = serde_json::from_value(event("session.created"))?;
        assert!(!settings.observe(&config()?, &created)?);
        assert!(!settings.is_confirmed());
        assert!(settings.take_captions().is_none());
        Ok(())
    }

    #[test]
    fn effective_updated_settings_confirm_audio_and_late_created_events_cannot_reset_them()
    -> Result<(), Box<dyn std::error::Error>> {
        let config = config()?;
        let mut settings = Settings::default();
        let updated = serde_json::from_value(event("session.updated"))?;
        assert!(settings.observe(&config, &updated)?);
        assert!(settings.is_confirmed());
        let captions = serde_json::to_value(settings.take_captions().ok_or("missing captions")?)?;
        assert_eq!(captions["status"], "confirmed");
        assert_eq!(captions["confirmedModel"], "gpt-4o-mini-transcribe");
        let created = serde_json::from_value(event("session.created"))?;
        assert!(!settings.observe(&config, &created)?);
        assert!(settings.is_confirmed());
        assert!(settings.take_captions().is_none());
        Ok(())
    }

    #[test]
    fn an_actual_caption_mismatch_in_updated_settings_still_rejects_media()
    -> Result<(), Box<dyn std::error::Error>> {
        for model in [json!(null), json!("whisper-1")] {
            let mut settings = Settings::default();
            let mut updated = event("session.updated");
            updated["session"]["audio"]["input"]["transcription"]["model"] = model;
            assert!(
                settings
                    .observe(&config()?, &serde_json::from_value(updated)?)
                    .is_err()
            );
            assert!(!settings.is_confirmed());
            let captions =
                serde_json::to_value(settings.take_captions().ok_or("missing diagnostics")?)?;
            assert_eq!(captions["status"], "mismatch");
        }
        Ok(())
    }

    #[test]
    fn a_subsequent_invalid_format_or_vad_update_invalidates_confirmation()
    -> Result<(), Box<dyn std::error::Error>> {
        for field in ["format", "turn_detection"] {
            let mut settings = Settings::default();
            let valid = serde_json::from_value(event("session.updated"))?;
            settings.observe(&config()?, &valid)?;
            let mut updated = event("session.updated");
            if field == "format" {
                updated["session"]["audio"]["input"][field]["rate"] = json!(48000);
            } else {
                updated["session"]["audio"]["input"][field]["interrupt_response"] = json!(false);
            }
            assert!(
                settings
                    .observe(&config()?, &serde_json::from_value(updated)?)
                    .is_err()
            );
            assert!(!settings.is_confirmed());
        }
        Ok(())
    }

    #[test]
    fn voice_preview_requires_updated_audio_settings_without_requiring_input_captions()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut config = config()?;
        config.preview = true;
        let mut updated = event("session.updated");
        updated["session"]["audio"]["input"]["transcription"] = Value::Null;
        updated["session"]["audio"]["input"]["turn_detection"]["create_response"] = json!(false);
        updated["session"]["audio"]["input"]["turn_detection"]["interrupt_response"] = json!(false);
        let mut settings = Settings::default();
        assert!(settings.observe(&config, &serde_json::from_value(updated)?)?);
        assert!(settings.is_confirmed());
        assert!(settings.take_captions().is_none());
        Ok(())
    }
    #[test]
    fn diagnostics_expose_only_optional_duration_fields() -> Result<(), serde_json::Error> {
        let value = serde_json::to_value(Timings::default())?;
        assert_eq!(
            value,
            serde_json::json!({
                "preparedClient":false,"offerMs":null,"negotiationMs":null,"preparationMs":null,"credentialsMs":null,"websocketMs":null,
                "configurationMs":null,"settingsConfirmedMs":null,"listeningMs":null,"firstInputMs":null
            })
        );
        Ok(())
    }
}
