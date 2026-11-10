//! Retain protocol identifiers, never provider prose or user content.
use oai_rt_rs::live::ProviderError;
use serde::Serialize;

pub const COMMAND_REJECTED: &str = "GPT-Live could not complete that request. The call is still connected; no request was replayed.";
pub const MICROPHONE_REJECTED: &str =
    "GPT-Live rejected the microphone change. The microphone remains muted. Start a new call.";
pub const CONTENT_ENDED: &str = "GPT-Live ended the call because of a content restriction.";

/// Safe protocol metadata for a host's diagnostics, never provider prose.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub error_type: String,
    pub code: String,
    pub param: String,
    pub client_event_id: Option<String>,
}
impl Diagnostic {
    pub fn new(error: &ProviderError, outer_id: Option<&str>, prefix: &str) -> Self {
        Self {
            error_type: identifier(Some(&error.error_type)).into(),
            code: identifier(error.code.as_deref()).into(),
            param: identifier(error.param.as_deref()).into(),
            client_event_id: client_event_id(error, outer_id)
                .filter(|value| {
                    value
                        .strip_prefix(prefix)
                        .and_then(|id| id.strip_prefix(':'))
                        .is_some_and(|id| {
                            !id.is_empty()
                                && id.len() <= 20
                                && id.bytes().all(|byte| byte.is_ascii_digit())
                        })
                })
                .map(str::to_owned),
        }
    }
}

pub fn client_event_id<'a>(error: &'a ProviderError, outer_id: Option<&'a str>) -> Option<&'a str> {
    match (error.client_event_id.as_deref(), outer_id) {
        (Some(nested), Some(outer)) if nested != outer => None,
        (nested, outer) => nested.or(outer),
    }
}

/// Auth/access/usage failures remain terminal. A generic command or speech
/// error in an established session is reported separately from session.closed.
pub fn terminal(error: &ProviderError) -> bool {
    terminal_message(error).is_some()
}

fn terminal_message(error: &ProviderError) -> Option<&'static str> {
    [Some(error.error_type.as_str()), error.code.as_deref()]
        .into_iter().flatten().find_map(|value| match value {
            "invalid_api_key" | "authentication_error" => Some(
                "GPT-Live rejected the API key. Check the saved OpenAI API key."
            ),
            "model_not_found" | "permission_denied" => Some(
                "GPT-Live model access was denied. Check the OpenAI project's model permissions."
            ),
            "insufficient_quota" | "rate_limit_exceeded" | "rate_limit_error" => Some(
                "GPT-Live reached an OpenAI usage limit. Check the project's quota and rate limits."
            ),
            _ => None,
        })
}

fn identifier(value: Option<&str>) -> &str {
    value
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && !value.starts_with("sk-")
                && value.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_.:[]-".contains(&byte)
                })
        })
        .unwrap_or("unknown")
}

pub fn rejected(error: &ProviderError, global: bool) -> &'static str {
    rejected_for(error, global, super::EVENT_PREFIX)
}

pub fn rejected_for(error: &ProviderError, global: bool, prefix: &str) -> &'static str {
    let diagnostic = Diagnostic::new(error, None, prefix);
    tracing::info!(
        "{}",
        format_args!(
            "GPT-Live rejected type={} code={} param={} client_event_id={}",
            diagnostic.error_type,
            diagnostic.code,
            diagnostic.param,
            diagnostic.client_event_id.as_deref().unwrap_or("unknown"),
        )
    );
    if let Some(message) = terminal_message(error) {
        return message;
    }
    match error.code.as_deref().unwrap_or(&error.error_type) {
        "server_error" => "GPT-Live reported a server error. Start a new call when ready.",
        _ if global => {
            "GPT-Live rejected a session command. Start a new global call; no request will be replayed."
        }
        _ => {
            "GPT-Live rejected a session command. Please use the agent chat; no request will be replayed."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_preserve_only_safe_metadata_and_consistent_command_ids()
    -> Result<(), serde_json::Error> {
        let mut error: ProviderError = serde_json::from_value(serde_json::json!({
            "type":"invalid_request_error", "code":"sk-secret", "param":"private prompt",
            "message":"private transcript and credentials", "client_event_id":"whip-live:42"
        }))?;
        let diagnostic = Diagnostic::new(&error, None, "whip-live");
        let value = serde_json::to_value(&diagnostic)?;
        assert_eq!(value["code"], "unknown");
        assert_eq!(value["param"], "unknown");
        assert_eq!(value["clientEventId"], "whip-live:42");
        assert!(value.get("message").is_none());
        assert!(!value.to_string().contains("private"));
        assert!(
            Diagnostic::new(&error, Some("whip-live:43"), "whip-live")
                .client_event_id
                .is_none()
        );
        error.client_event_id = None;
        assert_eq!(
            Diagnostic::new(&error, Some("whip-live:43"), "whip-live")
                .client_event_id
                .as_deref(),
            Some("whip-live:43")
        );
        assert!(
            Diagnostic::new(&error, Some("sk-secret"), "whip-live")
                .client_event_id
                .is_none()
        );
        Ok(())
    }

    #[test]
    fn protocol_diagnostics_reject_prose_credentials_and_unbounded_values() {
        for value in [
            "private message",
            "bad\nforged",
            "sk-private",
            &"x".repeat(129),
        ] {
            assert_eq!(identifier(Some(value)), "unknown");
        }
        assert_eq!(identifier(None), "unknown");
        assert_eq!(
            identifier(Some("session.delegation.responses.tools[0]")),
            "session.delegation.responses.tools[0]"
        );
        assert_eq!(
            identifier(Some("responses_validation_failed")),
            "responses_validation_failed"
        );
    }
}
