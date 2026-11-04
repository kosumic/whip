//! Caption recognition is independent of the speech-to-speech model. Keep its
//! requested policy and negotiated settings explicit, without logging content.
use oai_rt_rs::AudioConfig;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(super) const MODEL: &str = "gpt-4o-mini-transcribe";
const MODEL_SNAPSHOT: &str = "gpt-4o-mini-transcribe-2025-12-15";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Language {
    #[default]
    Auto,
    En,
    #[serde(alias = "zh-Hans", alias = "zh-Hant")]
    Zh,
    Ja,
    Es,
    Fr,
}

pub(super) fn settings(language: Language) -> Value {
    // Match Codex: detect language per utterance, independently of UI locale.
    let mut settings = json!({"model":MODEL});
    if language != Language::Auto {
        settings["language"] = json!(language);
    }
    settings
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Pending,
    Confirmed,
    Mismatch,
}

/// All exported strings are application constants/enums. Never include raw
/// provider fields, prompts, transcripts, session IDs, audio or credentials.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Diagnostics {
    status: Status,
    requested_language: Language,
    confirmed_language: Option<Language>,
    language_confirmed: bool,
    requested_model: &'static str,
    confirmed_model: Option<&'static str>,
    prompt_absent: bool,
}
impl Diagnostics {
    pub(super) fn pending(language: Language) -> Self {
        Self {
            status: Status::Pending,
            requested_language: language,
            confirmed_language: None,
            language_confirmed: false,
            requested_model: MODEL,
            confirmed_model: None,
            prompt_absent: false,
        }
    }
    pub(super) fn confirm(language: Language, audio: &AudioConfig) -> Self {
        let value = serde_json::to_value(audio).unwrap_or_default();
        let accepted = &value["input"]["transcription"];
        let confirmed_language = serde_json::from_value(accepted["language"].clone()).ok();
        let language_confirmed = if language == Language::Auto {
            accepted["language"].is_null() || confirmed_language == Some(Language::Auto)
        } else {
            confirmed_language == Some(language)
        };
        let confirmed_model = accepted["model"].as_str().map(|model| match model {
            MODEL => MODEL,
            MODEL_SNAPSHOT => MODEL_SNAPSHOT,
            "gpt-4o-transcribe" => "gpt-4o-transcribe",
            "whisper-1" => "whisper-1",
            _ => "other",
        });
        let prompt_absent = accepted["prompt"].is_null() || accepted["prompt"] == "";
        let matches = language_confirmed && same_model(confirmed_model);
        Self {
            status: if matches {
                Status::Confirmed
            } else {
                Status::Mismatch
            },
            requested_language: language,
            confirmed_language,
            language_confirmed,
            requested_model: MODEL,
            confirmed_model,
            prompt_absent,
        }
    }
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if !same_model(self.confirmed_model) {
            return Err("OpenAI did not confirm the caption model. Please start a new call.");
        }
        if !self.language_confirmed {
            return Err(
                "OpenAI did not confirm the selected caption language. Please start a new call.",
            );
        }
        Ok(())
    }
}
fn same_model(model: Option<&str>) -> bool {
    matches!(model, Some(MODEL | MODEL_SNAPSHOT))
}

#[cfg(test)]
mod tests {
    use super::*;
    use oai_rt_rs::ClientEvent;

    fn negotiated(language: Language) -> Result<Value, serde_json::Error> {
        let event: ClientEvent = serde_json::from_value(
            json!({"type":"session.update","session":{"type":"realtime","audio":{"input":{"transcription":settings(language)}}}}),
        )?;
        Ok(serde_json::to_value(event)?["session"]["audio"].clone())
    }

    #[test]
    fn auto_detection_matches_codex_without_language_or_prompt_bias()
    -> Result<(), Box<dyn std::error::Error>> {
        let audio = negotiated(Language::default())?;
        assert!(audio["input"]["transcription"].get("language").is_none());
        assert!(audio["input"]["transcription"].get("prompt").is_none());
        assert_eq!(audio["input"]["transcription"]["model"], MODEL);
        let diagnostics = Diagnostics::confirm(Language::Auto, &serde_json::from_value(audio)?);
        diagnostics.validate()?;
        assert!(diagnostics.prompt_absent);
        Ok(())
    }

    #[test]
    fn explicit_spoken_language_hints_remain_supported_without_translation_prompts()
    -> Result<(), Box<dyn std::error::Error>> {
        for language in [
            Language::En,
            Language::Zh,
            Language::Ja,
            Language::Es,
            Language::Fr,
        ] {
            let audio = negotiated(language)?;
            assert!(audio["input"]["transcription"].get("prompt").is_none());
            Diagnostics::confirm(language, &serde_json::from_value(audio)?).validate()?;
        }
        Ok(())
    }

    #[test]
    fn missing_or_wrong_explicit_language_and_model_are_rejected()
    -> Result<(), Box<dyn std::error::Error>> {
        for (key, value) in [
            ("language", json!(null)),
            ("language", json!("zh")),
            ("model", json!(null)),
            ("model", json!("whisper-1")),
        ] {
            let mut audio = negotiated(Language::En)?;
            audio["input"]["transcription"][key] = value;
            assert!(
                Diagnostics::confirm(Language::En, &serde_json::from_value(audio)?)
                    .validate()
                    .is_err()
            );
        }
        let empty: AudioConfig = serde_json::from_value(json!({}))?;
        assert!(
            Diagnostics::confirm(Language::Auto, &empty)
                .validate()
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn automatic_detection_rejects_an_unrequested_forced_language()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut audio = negotiated(Language::Auto)?;
        audio["input"]["transcription"]["language"] = json!("en");
        assert!(
            Diagnostics::confirm(Language::Auto, &serde_json::from_value(audio)?)
                .validate()
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn provider_prompt_is_reported_without_logging_it() -> Result<(), Box<dyn std::error::Error>> {
        let mut audio = negotiated(Language::Auto)?;
        audio["input"]["transcription"]["prompt"] = json!("private-provider-context");
        let diagnostics = Diagnostics::confirm(Language::Auto, &serde_json::from_value(audio)?);
        diagnostics.validate()?;
        assert!(!diagnostics.prompt_absent);
        Ok(())
    }

    #[test]
    fn canonical_mini_model_snapshot_is_accepted() -> Result<(), Box<dyn std::error::Error>> {
        let mut audio = negotiated(Language::Auto)?;
        audio["input"]["transcription"]["model"] = json!(MODEL_SNAPSHOT);
        let diagnostics = Diagnostics::confirm(Language::Auto, &serde_json::from_value(audio)?);
        diagnostics.validate()?;
        assert_eq!(diagnostics.confirmed_model, Some(MODEL_SNAPSHOT));
        Ok(())
    }

    #[test]
    fn diagnostics_only_serialize_whitelisted_configuration_metadata()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut audio = negotiated(Language::Auto)?;
        audio["input"]["transcription"]["model"] = json!("private-provider-field");
        audio["input"]["transcription"]["language"] = json!("private-language-field");
        audio["input"]["transcription"]["prompt"] = json!("private-transcript-or-key");
        let value = serde_json::to_value(Diagnostics::confirm(
            Language::Auto,
            &serde_json::from_value(audio)?,
        ))?;
        assert_eq!(
            value,
            json!({"status":"mismatch","requestedLanguage":"auto","confirmedLanguage":null,"languageConfirmed":false,"requestedModel":MODEL,"confirmedModel":"other","promptAbsent":false})
        );
        let pending = serde_json::to_value(Diagnostics::pending(Language::Auto))?;
        assert_eq!(pending["status"], "pending");
        Ok(())
    }
}
