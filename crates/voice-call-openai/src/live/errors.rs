//! Retain protocol identifiers, never provider prose or user content.
use oai_rt_rs::live::ProviderError;

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
    tracing::info!(
        "{}",
        format_args!(
            "GPT-Live rejected type={} code={} param={} client_event_id={}",
            identifier(Some(&error.error_type)),
            identifier(error.code.as_deref()),
            identifier(error.param.as_deref()),
            error
                .client_event_id
                .as_deref()
                .filter(|value| value
                    .strip_prefix(prefix)
                    .and_then(|id| id.strip_prefix(':'))
                    .is_some_and(|id| {
                        !id.is_empty()
                            && id.len() <= 20
                            && id.bytes().all(|byte| byte.is_ascii_digit())
                    }))
                .unwrap_or("unknown"),
        )
    );
    match error.code.as_deref().unwrap_or(&error.error_type) {
        "invalid_api_key" | "authentication_error" => {
            "GPT-Live rejected the API key. Check the saved OpenAI API key."
        }
        "model_not_found" | "permission_denied" => {
            "GPT-Live model access was denied. Check the OpenAI project's model permissions."
        }
        "insufficient_quota" | "rate_limit_exceeded" | "rate_limit_error" => {
            "GPT-Live reached an OpenAI usage limit. Check the project's quota and rate limits."
        }
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
