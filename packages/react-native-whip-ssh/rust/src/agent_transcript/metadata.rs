//! Provider accounting and bounded presentation metadata, independent of UI.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::model::*;

const MAX_INPUT_BYTES: usize = 64 * 1024;
const CLAUDE_SYNTHETIC_MODEL: &str = "<synthetic>";

pub(crate) fn tool_input_json(raw: Option<&Value>) -> Option<String> {
    let raw = raw.filter(|value| !value.is_null())?;
    let decoded = raw
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let text = match decoded.as_ref().unwrap_or(raw) {
        Value::String(text) => text.clone(),
        value => serde_json::to_string_pretty(value).ok()?,
    };
    if text.len() <= MAX_INPUT_BYTES {
        return Some(text);
    }
    let mut end = MAX_INPUT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(format!("{}\n[truncated]", &text[..end]))
}

pub(crate) fn tool_duration(value: &Value) -> Option<u64> {
    value
        .get("duration_ms")
        .or_else(|| value.get("durationMs"))
        .and_then(Value::as_u64)
        .or_else(|| {
            let duration = value.get("duration")?;
            let seconds = duration.get("secs")?.as_u64()?;
            let nanos = duration.get("nanos").and_then(Value::as_u64).unwrap_or(0);
            seconds.checked_mul(1_000)?.checked_add(nanos / 1_000_000)
        })
}

fn count(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

fn sum(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.saturating_add(b)),
        (a, b) => a.or(b),
    }
}

impl AgentTokenUsage {
    pub(crate) fn add(&mut self, other: &Self) {
        self.input = sum(self.input, other.input);
        self.output = sum(self.output, other.output);
        self.reasoning = sum(self.reasoning, other.reasoning);
        self.cache_read = sum(self.cache_read, other.cache_read);
        self.cache_write = sum(self.cache_write, other.cache_write);
        self.total = sum(self.total, other.total);
    }

    fn merge_response(&mut self, other: &Self) {
        self.input = self.input.max(other.input);
        self.output = self.output.max(other.output);
        self.reasoning = self.reasoning.max(other.reasoning);
        self.cache_read = self.cache_read.max(other.cache_read);
        self.cache_write = self.cache_write.max(other.cache_write);
        self.total = self
            .input
            .zip(self.output)
            .map(|(input, output)| input.saturating_add(output))
            .or(self.total.max(other.total));
    }

    fn present(self) -> Option<Self> {
        (self.input.is_some()
            || self.output.is_some()
            || self.total.is_some()
            || self.reasoning.is_some()
            || self.cache_read.is_some()
            || self.cache_write.is_some())
        .then_some(self)
    }
}

pub(crate) fn codex_usage(value: &Value) -> Option<AgentTokenUsage> {
    AgentTokenUsage {
        input: count(value, "input_tokens"),
        output: count(value, "output_tokens"),
        reasoning: count(value, "reasoning_output_tokens"),
        cache_read: count(value, "cached_input_tokens"),
        cache_write: count(value, "cache_write_input_tokens"),
        total: count(value, "total_tokens").or_else(|| {
            count(value, "input_tokens")
                .zip(count(value, "output_tokens"))
                .map(|(input, output)| input.saturating_add(output))
        }),
    }
    .present()
}

pub(crate) fn provider_details(value: &Value, claude: bool) -> Option<AgentTranscriptDetails> {
    let model = value.get("model");
    let usage = value.get(if claude { "usage" } else { "tokens" });
    let usage = usage.and_then(|usage| {
        let (input, output, reasoning, read, write) = if claude {
            (
                count(usage, "input_tokens"),
                count(usage, "output_tokens"),
                count(usage, "reasoning_output_tokens"),
                count(usage, "cache_read_input_tokens"),
                count(usage, "cache_creation_input_tokens"),
            )
        } else {
            (
                count(usage, "input"),
                count(usage, "output"),
                count(usage, "reasoning"),
                count(&usage["cache"], "read"),
                count(&usage["cache"], "write"),
            )
        };
        let input = input.map(|input| {
            input
                .saturating_add(read.unwrap_or(0))
                .saturating_add(write.unwrap_or(0))
        });
        let output = if claude {
            output
        } else {
            output.map(|output| output.saturating_add(reasoning.unwrap_or(0)))
        };
        AgentTokenUsage {
            input,
            output,
            reasoning,
            cache_read: read,
            cache_write: write,
            total: input
                .zip(output)
                .map(|(input, output)| input.saturating_add(output)),
        }
        .present()
    });
    let finish = value
        .get(if claude { "stop_reason" } else { "finish" })
        .and_then(Value::as_str);
    let outcome = match finish {
        Some("end_turn" | "stop_sequence" | "stop" | "length" | "max_tokens") => {
            Some(AgentTurnOutcome::Completed)
        }
        Some("error") => Some(AgentTurnOutcome::Failed),
        _ => None,
    };
    let outcome = if value.get("error").is_some_and(|error| !error.is_null()) {
        let error = &value["error"];
        Some(
            if error["type"] == "aborted" || error["name"] == "MessageAbortedError" {
                AgentTurnOutcome::Interrupted
            } else {
                AgentTurnOutcome::Failed
            },
        )
    } else {
        outcome
    };
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let mut details = AgentTranscriptDetails {
        model: text(model.filter(|value| value.is_string()))
            .or_else(|| {
                text(model.and_then(|model| model.get("id").or_else(|| model.get("modelID"))))
            })
            .or_else(|| text(value.get("modelID"))),
        provider: text(model.and_then(|model| model.get("providerID")))
            .or_else(|| text(value.get("providerID")))
            .or_else(|| text(value.get("provider"))),
        usage,
        usage_id: text(value.get("id")),
        outcome,
    };
    // Claude's local error messages use a placeholder model and zero usage;
    // neither describes a provider response or the model that actually failed.
    if claude && details.model.as_deref() == Some(CLAUDE_SYNTHETIC_MODEL) {
        details.model = None;
        details.provider = None;
        details.usage = None;
        details.outcome = None;
    }
    (details.model.is_some()
        || details.provider.is_some()
        || details.usage.is_some()
        || details.outcome.is_some())
    .then_some(details)
}

pub(crate) fn aggregate_details<'a>(
    messages: impl IntoIterator<Item = &'a AgentTranscriptMessage>,
) -> Option<AgentTranscriptDetails> {
    let mut result = AgentTranscriptDetails::default();
    let mut usage_by_id = HashMap::<&str, AgentTokenUsage>::new();
    for message in messages {
        // A later assistant segment reopens the turn after an earlier outcome.
        if !message.parts.is_empty() {
            result.outcome = None;
        }
        if message.error.is_some() {
            result.outcome = Some(AgentTurnOutcome::Failed);
        }
        let Some(details) = &message.details else {
            continue;
        };
        if details.model.is_some() {
            if details.model != result.model {
                result.provider.clone_from(&details.provider);
            }
            result.model.clone_from(&details.model);
        }
        if details.provider.is_some() {
            result.provider.clone_from(&details.provider);
        }
        if details.outcome.is_some() {
            result.outcome = details.outcome;
        }
        if let Some(usage) = &details.usage {
            usage_by_id
                .entry(details.usage_id.as_deref().unwrap_or(&message.id))
                .and_modify(|current| current.merge_response(usage))
                .or_insert_with(|| usage.clone());
        }
    }
    for usage in usage_by_id.values() {
        result
            .usage
            .get_or_insert_with(AgentTokenUsage::default)
            .add(usage);
    }
    (result != AgentTranscriptDetails::default()).then_some(result)
}

/// TokenCount contains repeated cumulative snapshots, not independent charges.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct CodexUsageTracker {
    previous: Option<AgentTokenUsage>,
}

impl CodexUsageTracker {
    pub(crate) fn accept(&mut self, payload: &Value) -> Option<AgentTokenUsage> {
        let info = payload.get("info")?;
        let total = codex_usage(&info["total_token_usage"])?;
        if self.previous.as_ref() == Some(&total) {
            return None;
        }
        let previous = self.previous.replace(total.clone());
        let Some(previous) = previous else {
            return codex_usage(&info["last_token_usage"]);
        };
        // A compacted/reset counter cannot establish the charge for a response.
        if total.total.zip(previous.total).is_some_and(|(a, b)| a < b) {
            return codex_usage(&info["last_token_usage"]);
        }
        let difference = |current: Option<u64>, previous: Option<u64>| {
            current.zip(previous).map(|(a, b)| a.saturating_sub(b))
        };
        AgentTokenUsage {
            input: difference(total.input, previous.input),
            output: difference(total.output, previous.output),
            reasoning: difference(total.reasoning, previous.reasoning),
            cache_read: difference(total.cache_read, previous.cache_read),
            cache_write: difference(total.cache_write, previous.cache_write),
            total: difference(total.total, previous.total),
        }
        .present()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_accounting_normalizes_inclusive_totals_and_retains_unknowns() {
        let open_code = provider_details(&json!({"tokens": {"input": 10, "output": 20, "reasoning": 5, "cache": {"read": 30, "write": 2}}}), false).unwrap().usage.unwrap();
        assert_eq!(open_code.input, Some(42));
        assert_eq!(open_code.output, Some(25));
        assert_eq!(open_code.total, Some(67));
        let claude = provider_details(&json!({"usage": {"input_tokens": 10, "output_tokens": 25, "cache_read_input_tokens": 30, "cache_creation_input_tokens": 2}}), true).unwrap().usage.unwrap();
        assert_eq!(claude.total, Some(67));
        assert_eq!(claude.reasoning, None);
        assert!(
            provider_details(
                &json!({"usage": {"input_tokens": -1, "output_tokens": "unknown"}}),
                true
            )
            .is_none()
        );
    }

    #[test]
    fn repeated_codex_counters_are_not_charged_twice() {
        let event = |input, output| json!({"info": {"total_token_usage": {"input_tokens": input, "output_tokens": output, "total_tokens": input + output}, "last_token_usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}});
        let mut tracker = CodexUsageTracker::default();
        assert_eq!(tracker.accept(&event(100, 50)).unwrap().total, Some(15));
        assert!(tracker.accept(&event(100, 50)).is_none());
        assert_eq!(tracker.accept(&event(110, 55)).unwrap().total, Some(15));
        assert_eq!(tracker.accept(&event(10, 5)).unwrap().total, Some(15));
        assert!(tracker.accept(&event(10, 5)).is_none());
    }

    #[test]
    fn bounded_tool_inputs_keep_nested_objects_and_multibyte_text() {
        let raw = json!({"options": {"paths": ["src", "tests"], "enabled": false}, "limit": 0});
        let encoded = tool_input_json(Some(&Value::String(raw.to_string()))).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&encoded).unwrap(), raw);
        let large = Value::String("汉".repeat(MAX_INPUT_BYTES));
        let bounded = tool_input_json(Some(&large)).unwrap();
        assert!(bounded.len() <= MAX_INPUT_BYTES + "\n[truncated]".len());
        assert!(bounded.ends_with("[truncated]"));
    }
}
