//! Bounded content shared by file transcript adapters.
use super::model::{AgentField, AgentScalarValue};
use serde_json::Value;

pub(super) const MAX_TEXT_BYTES: usize = 64 * 1024;
pub(super) const MAX_BLOCKS: usize = 256;
const MAX_FIELDS: usize = 64;
const MAX_DEPTH: usize = 8;

pub(super) fn bounded(text: &str) -> String {
    if text.len() <= MAX_TEXT_BYTES {
        return text.to_owned();
    }
    let mut end = MAX_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated]", &text[..end])
}

pub(super) fn string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(bounded)
}

/// Only traverse known textual containers. In particular, never serialize an
/// arbitrary result object: it can contain megabytes of image/document data.
pub(super) fn result_text(value: &Value) -> Option<String> {
    fn append(value: &Value, out: &mut String, depth: usize) {
        if depth > MAX_DEPTH || out.len() >= MAX_TEXT_BYTES {
            return;
        }
        match value {
            Value::String(text) => {
                if text.is_empty() {
                    return;
                }
                if !out.is_empty() {
                    out.push('\n');
                }
                let remaining = MAX_TEXT_BYTES.saturating_sub(out.len());
                let mut end = text.len().min(remaining);
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                out.push_str(&text[..end]);
            }
            Value::Array(items) => {
                for item in items.iter().take(MAX_BLOCKS) {
                    append(item, out, depth + 1);
                }
            }
            Value::Object(object) => {
                if object
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| !matches!(kind, "text" | "tool_result"))
                {
                    return;
                }
                for key in ["text", "content", "stdout", "stderr", "output"] {
                    if let Some(value) = object.get(key) {
                        append(value, out, depth + 1);
                    }
                }
            }
            _ => {}
        }
    }
    let mut output = String::new();
    append(value, &mut output, 0);
    (!output.is_empty()).then_some(output)
}

pub(super) fn input_fields(input: &Value) -> Vec<AgentField> {
    input
        .as_object()
        .into_iter()
        .flatten()
        .take(MAX_FIELDS)
        .filter_map(|(key, value)| {
            let value = match value {
                Value::String(text) => AgentScalarValue::String {
                    value: bounded(text),
                },
                Value::Bool(value) => AgentScalarValue::Boolean { value: *value },
                Value::Number(value) => AgentScalarValue::Number {
                    value: value.as_f64()?,
                },
                // Nested tool arguments (e.g. TodoWrite.todos) remain useful, but
                // share the same per-field bound as strings.
                Value::Array(_) | Value::Object(_) => AgentScalarValue::String {
                    value: bounded(&value.to_string()),
                },
                Value::Null => return None,
            };
            Some(AgentField {
                key: bounded(key),
                value,
            })
        })
        .collect()
}
