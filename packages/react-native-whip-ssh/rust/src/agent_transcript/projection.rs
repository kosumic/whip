//! Shared wire-value normalization and transcript turn projection.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::model::*;

#[derive(Clone, Debug)]
pub(super) struct ParsedToolResult {
    pub(super) output: Option<String>,
    pub(super) error: Option<String>,
    pub(super) exit_code: Option<i64>,
    pub(super) process_id: Option<i64>,
    pub(super) running: bool,
}

pub(super) fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value?.as_object()
}
pub(super) fn nonempty(value: Option<&Value>) -> Option<&str> {
    value?.as_str().filter(|value| !value.is_empty())
}

pub(super) fn text_content(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|value| {
                let value = value.as_object()?;
                nonempty(value.get("text"))
                    .or_else(|| nonempty(value.get("content")))
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Object(value)) => {
            if let Some(content) = nonempty(value.get("content")) {
                return content.to_owned();
            }
            if let Some(items) = value.get("content_items") {
                return text_content(Some(items));
            }
            if let Some(items) = value.get("content") {
                return text_content(Some(items));
            }
            Value::Object(value.clone()).to_string()
        }
        Some(value) => value.to_string(),
        None => String::new(),
    }
}

pub(super) fn image_source(value: &Value) -> Option<String> {
    match value.get("type")?.as_str()? {
        "local_image" => nonempty(value.get("path")).map(str::to_owned),
        "input_image" => nonempty(value.get("image_url")).map(str::to_owned),
        "image" => {
            let source = value.get("source")?;
            match source.get("type")?.as_str()? {
                "base64" => Some(format!(
                    "data:{};base64,{}",
                    nonempty(source.get("media_type"))?,
                    nonempty(source.get("data"))?
                )),
                "url" => nonempty(source.get("url")).map(str::to_owned),
                _ => None,
            }
        }
        _ => None,
    }
}

pub(super) fn user_content(value: Option<&Value>) -> String {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                image_source(item).or_else(|| {
                    nonempty(item.get("text"))
                        .or_else(|| nonempty(item.get("content")))
                        .map(str::to_owned)
                })
            })
            .collect::<Vec<_>>()
            .join("\n"),
        value => text_content(value),
    }
}

/// Preserve images as separate parts, including paths pasted by Whip's composer.
/// Whole-line paths and Whip upload paths embedded in prose are attachments.
pub(crate) fn user_prompt_parts(
    id: &str,
    text: &str,
    timestamp_ms: Option<u64>,
) -> Vec<AgentTranscriptPart> {
    let mut images = Vec::new();
    let mut line_offset = 0;
    for line in text.split_inclusive('\n') {
        let source = line.trim().trim_matches(['\'', '"']);
        let quoted = matches!(line.trim().chars().next(), Some('\'' | '"'));
        if is_prompt_image(source) && (quoted || !source.contains(char::is_whitespace)) {
            images.push((line_offset, line_offset + line.len(), source));
        } else {
            let mut token_offset = 0;
            for token in line.split_inclusive(char::is_whitespace) {
                let candidate = token.trim().trim_matches(['\'', '"']);
                if candidate.contains("/.whip/uploads/") && is_prompt_image(candidate) {
                    images.push((
                        line_offset + token_offset,
                        line_offset + token_offset + token.len(),
                        candidate,
                    ));
                }
                token_offset += token.len();
            }
        }
        line_offset += line.len();
    }
    if images.is_empty() {
        return vec![AgentTranscriptPart::Text {
            id: id.to_owned(),
            text: text.to_owned(),
            timestamp_ms,
        }];
    }
    let mut parts = Vec::new();
    let mut offset = 0;
    for (start, end, source) in images {
        push_prompt_text(&mut parts, id, &text[offset..start], timestamp_ms);
        parts.push(AgentTranscriptPart::Image {
            id: format!("{id}:{}", parts.len()),
            source: source.to_owned(),
            timestamp_ms,
        });
        offset = end;
    }
    push_prompt_text(&mut parts, id, &text[offset..], timestamp_ms);
    parts
}

fn push_prompt_text(
    parts: &mut Vec<AgentTranscriptPart>,
    id: &str,
    text: &str,
    timestamp_ms: Option<u64>,
) {
    if !text.trim().is_empty() {
        parts.push(AgentTranscriptPart::Text {
            id: format!("{id}:{}", parts.len()),
            text: text.trim().to_owned(),
            timestamp_ms,
        });
    }
}

fn is_prompt_image(source: &str) -> bool {
    if source.starts_with("data:image/") {
        return true;
    }
    let path = source.strip_prefix("file://").unwrap_or(source);
    let external = path.starts_with("https://") || path.starts_with("http://");
    if !(path.starts_with('/') || path.starts_with("~/") || path.starts_with("./") || external) {
        return false;
    }
    let path = if external {
        path.split(['?', '#']).next().unwrap_or(path)
    } else {
        path
    };
    path.rsplit_once('.').is_some_and(|(_, extension)| {
        matches!(
            extension.to_ascii_lowercase().as_str(),
            "bmp" | "gif" | "heic" | "heif" | "jpeg" | "jpg" | "png" | "webp"
        )
    })
}

pub(super) fn normalize_user_images(message: &mut AgentTranscriptMessage) {
    if message.role != AgentMessageRole::User {
        return;
    }
    message.parts = std::mem::take(&mut message.parts)
        .into_iter()
        .flat_map(|part| match part {
            AgentTranscriptPart::Text {
                id,
                text,
                timestamp_ms,
            } => user_prompt_parts(&id, &text, timestamp_ms),
            part => vec![part],
        })
        .collect();
}

pub(super) fn detail(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        value => serde_json::to_string_pretty(value).ok(),
    }
}

pub(super) fn timestamp_ms(value: Option<&Value>) -> Option<u64> {
    if let Some(number) = value.and_then(Value::as_u64) {
        return Some(number);
    }
    let text = value?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()?
        .timestamp_millis()
        .try_into()
        .ok()
}

pub(crate) fn injected_user_context(value: &str) -> bool {
    let value = value.trim_start();
    (value.starts_with("# AGENTS.md instructions for ") && value.contains("\n\n<INSTRUCTIONS>"))
        || (value.starts_with("<environment_context>") && value.ends_with("</environment_context>"))
}

pub(super) fn canonical_tool_name(value: &str) -> String {
    match value.to_ascii_lowercase().as_str() {
        "exec" | "exec_command" | "command_execution" | "local_shell_call" | "bash" => {
            "shell".to_owned()
        }
        "apply_patch" | "turn_diff" => "patch".to_owned(),
        "web_search" | "web_search_call" => "websearch".to_owned(),
        "update_plan" => "todowrite".to_owned(),
        "" => "tool".to_owned(),
        value => value.to_owned(),
    }
}

pub(crate) fn command_title(value: Option<&Value>) -> String {
    match value {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        Some(Value::String(value)) if !value.is_empty() => value.clone(),
        _ => "Command".to_owned(),
    }
}

pub(super) fn parse_tool_status(
    value: Option<&Value>,
    fallback: AgentToolStatus,
) -> AgentToolStatus {
    let value = value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["fail", "error", "declin", "incomplete"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        AgentToolStatus::Error
    } else if ["complete", "done", "success"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        AgentToolStatus::Completed
    } else if ["running", "progress"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        AgentToolStatus::Running
    } else if ["pending", "queued"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        AgentToolStatus::Pending
    } else {
        fallback
    }
}

pub(super) fn scalar_fields(value: Option<&Value>) -> Vec<AgentField> {
    object(value)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    Some(AgentField {
                        key: key.clone(),
                        value: AgentScalarValue::from_json_primitive(value)?,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn canonical_tool_input(tool: &str, mut fields: Vec<AgentField>) -> Vec<AgentField> {
    canonicalize_field(&mut fields, "command", &["command", "cmd"]);
    canonicalize_field(&mut fields, "path", &["path", "filePath", "file_path"]);
    canonicalize_field(&mut fields, "query", &["query", "pattern"]);
    canonicalize_field(&mut fields, "description", &["description", "name"]);
    canonicalize_field(&mut fields, "agent", &["agent", "subagent_type"]);
    canonicalize_field(&mut fields, "old_string", &["old_string", "oldString"]);
    canonicalize_field(&mut fields, "new_string", &["new_string", "newString"]);

    if tool == "shell" {
        canonicalize_field(&mut fields, "cwd", &["cwd", "workdir"]);
    }
    question_tool_input(tool, fields)
}

pub(crate) fn question_tool_input(tool: &str, mut fields: Vec<AgentField>) -> Vec<AgentField> {
    if is_question_tool(tool)
        && let Some(questions) = fields.iter().find_map(|field| match &field.value {
            AgentScalarValue::String { value } if field.key == "questions" => {
                serde_json::from_str::<Value>(value).ok()
            }
            _ => None,
        })
        && let Some(summary) = question_summary(Some(&questions))
    {
        put_field(
            &mut fields,
            "question_summary",
            AgentScalarValue::String { value: summary },
        );
    }
    fields
}

pub(super) fn tool_input(tool: &str, raw: Option<&Value>) -> Vec<AgentField> {
    let decoded = raw
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let raw = decoded.as_ref().or(raw);
    let mut fields = scalar_fields(raw);
    if is_question_tool(tool)
        && let Some(questions) = raw.and_then(|raw| raw.get("questions"))
        && questions.is_array()
    {
        put_field(
            &mut fields,
            "questions",
            AgentScalarValue::String {
                value: questions.to_string(),
            },
        );
    }
    if tool == "shell"
        && !fields
            .iter()
            .any(|field| field.key == "command" || field.key == "cmd")
        && let Some(command) =
            object(raw).and_then(|value| value.get("command").or_else(|| value.get("cmd")))
    {
        put_field(
            &mut fields,
            "command",
            AgentScalarValue::String {
                value: command_title(Some(command)),
            },
        );
    }
    canonical_tool_input(tool, fields)
}

fn is_question_tool(tool: &str) -> bool {
    let tool = tool.rsplit(" · ").next().unwrap_or(tool);
    matches!(
        tool.rsplit('.')
            .next()
            .unwrap_or(tool)
            .to_ascii_lowercase()
            .as_str(),
        "question" | "askuserquestion" | "request_user_input" | "request_user_input_async"
    )
}

/// Historical question content only; it carries no pending-request authority.
pub(crate) fn transcript_questions(questions: Option<&Value>) -> Vec<AgentQuestion> {
    questions
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|question| {
            Some(AgentQuestion {
                header: nonempty(question.get("header")).map(str::to_owned),
                question: nonempty(question.get("question"))
                    .or_else(|| nonempty(question.get("title")))?
                    .to_owned(),
                multiple: question.get("multiSelect").and_then(Value::as_bool) == Some(true)
                    || question.get("multiple").and_then(Value::as_bool) == Some(true),
                options: question
                    .get("options")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|option| {
                        Some(AgentQuestionOption {
                            label: nonempty(option.get("label"))
                                .or_else(|| nonempty(Some(option)))?
                                .to_owned(),
                            description: nonempty(option.get("description")).map(str::to_owned),
                        })
                    })
                    .collect(),
            })
        })
        .collect()
}

pub(crate) fn questions_from_input(input: &[AgentField]) -> Vec<AgentQuestion> {
    let raw = input.iter().find_map(|field| match &field.value {
        AgentScalarValue::String { value } if field.key == "questions" => {
            serde_json::from_str::<Value>(value).ok()
        }
        _ => None,
    });
    transcript_questions(raw.as_ref())
}

fn question_summary(questions: Option<&Value>) -> Option<String> {
    let summaries = transcript_questions(questions)
        .into_iter()
        .map(|question| {
            let mut lines = Vec::new();
            if let Some(header) = question.header {
                lines.push(header);
            }
            lines.push(question.question);
            if question.multiple {
                lines.push("Choose one or more.".to_owned());
            }
            for option in question.options {
                lines.push(match option.description {
                    Some(description) => format!("• {}: {description}", option.label),
                    None => format!("• {}", option.label),
                });
            }
            lines.join("\n")
        })
        .collect::<Vec<_>>();
    (!summaries.is_empty()).then(|| summaries.join("\n\n"))
}

fn canonicalize_field(fields: &mut Vec<AgentField>, canonical: &str, aliases: &[&str]) {
    let value = aliases.iter().find_map(|key| {
        fields
            .iter()
            .find(|field| field.key == *key)
            .map(|field| field.value.clone())
    });
    fields.retain(|field| !aliases.contains(&field.key.as_str()));
    if let Some(value) = value {
        put_field(fields, canonical, value);
    }
}

pub(super) fn fields<const N: usize>(values: [(&str, String); N]) -> Vec<AgentField> {
    values
        .into_iter()
        .map(|(key, value)| AgentField {
            key: key.to_owned(),
            value: AgentScalarValue::String { value },
        })
        .collect()
}

pub(super) fn put_field(fields: &mut Vec<AgentField>, key: &str, value: AgentScalarValue) {
    if let Some(field) = fields.iter_mut().find(|field| field.key == key) {
        field.value = value;
    } else {
        fields.push(AgentField {
            key: key.to_owned(),
            value,
        });
    }
}

pub(super) fn fields_with_cwd(payload: &Map<String, Value>) -> Vec<AgentField> {
    let mut fields = fields([("command", command_title(payload.get("command")))]);
    if let Some(cwd) = nonempty(payload.get("cwd")) {
        put_field(
            &mut fields,
            "cwd",
            AgentScalarValue::String {
                value: cwd.to_owned(),
            },
        );
    }
    fields
}

fn source_tool_name(source: &str) -> Option<&str> {
    let marker = "tools.";
    let start = source.find(marker)? + marker.len();
    let rest = &source[start..];
    let end =
        rest.find(|character: char| !character.is_ascii_alphanumeric() && character != '_')?;
    Some(&rest[..end])
}

fn quoted_field(source: &str, key: &str) -> Option<String> {
    for prefix in [format!("\"{key}\":"), format!("{key}:")] {
        let mut rest = source.split_once(&prefix)?.1.trim_start();
        if !rest.starts_with('"') {
            continue;
        }
        rest = &rest[1..];
        let mut escaped = false;
        for (index, character) in rest.char_indices() {
            if character == '"' && !escaped {
                return serde_json::from_str::<String>(&format!("\"{}\"", &rest[..index])).ok();
            }
            escaped = character == '\\' && !escaped;
            if character != '\\' {
                escaped = false;
            }
        }
    }
    None
}

fn numeric_field(source: &str, key: &str) -> Option<i64> {
    let (_, rest) = source.split_once(&format!("{key}:"))?;
    rest.trim_start()
        .split(|character: char| !character.is_ascii_digit() && character != '-')
        .next()?
        .parse()
        .ok()
}

pub(super) fn translate_tool(
    name: &str,
    raw: Option<&Value>,
) -> (
    String,
    Vec<AgentField>,
    Option<i64>,
    bool,
    Vec<AgentFileDiff>,
) {
    if name != "exec" || !matches!(raw, Some(Value::String(_))) {
        let tool = canonical_tool_name(name);
        return (
            tool.clone(),
            tool_input(&tool, raw),
            None,
            false,
            Vec::new(),
        );
    }
    let source = raw.and_then(Value::as_str).unwrap_or_default();
    match source_tool_name(source).unwrap_or(name) {
        "exec_command" => {
            let mut input = Vec::new();
            if let Some(command) = quoted_field(source, "cmd") {
                put_field(
                    &mut input,
                    "command",
                    AgentScalarValue::String { value: command },
                );
            }
            if let Some(cwd) = quoted_field(source, "workdir") {
                put_field(&mut input, "cwd", AgentScalarValue::String { value: cwd });
            }
            ("shell".to_owned(), input, None, false, Vec::new())
        }
        "write_stdin" => (
            "shell".to_owned(),
            Vec::new(),
            numeric_field(source, "session_id"),
            true,
            Vec::new(),
        ),
        "apply_patch" => (
            "patch".to_owned(),
            Vec::new(),
            None,
            false,
            apply_patch_files(source),
        ),
        "update_plan" => ("todowrite".to_owned(), Vec::new(), None, false, Vec::new()),
        "web__run" => {
            let query = quoted_field(source, "q").unwrap_or_else(|| "Web search".to_owned());
            (
                "websearch".to_owned(),
                fields([("query", query)]),
                None,
                false,
                Vec::new(),
            )
        }
        nested => (
            canonical_tool_name(nested),
            scalar_fields(raw),
            None,
            false,
            Vec::new(),
        ),
    }
}

pub(super) fn tool_result(value: Option<&Value>) -> ParsedToolResult {
    let texts = match value {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|value| {
                object(Some(value))
                    .and_then(|value| nonempty(value.get("text")))
                    .map(str::to_owned)
            })
            .collect(),
        _ => vec![text_content(value)],
    };
    for text in &texts {
        if let Ok(Value::Object(result)) = serde_json::from_str::<Value>(text) {
            let exit_code = result.get("exit_code").and_then(Value::as_i64);
            let process_id = result.get("session_id").and_then(Value::as_i64);
            return ParsedToolResult {
                output: nonempty(result.get("output")).map(str::to_owned),
                error: exit_code
                    .filter(|code| *code != 0)
                    .map(|code| format!("Exited with code {code}")),
                exit_code,
                process_id,
                running: process_id.is_some() && exit_code.is_none(),
            };
        }
    }
    let joined = texts.join("");
    let failed = joined.contains("Script failed") || joined.contains("Script error:");
    let output = joined
        .split_once("Output:\n")
        .map(|(_, output)| output)
        .unwrap_or(&joined)
        .trim()
        .to_owned();
    ParsedToolResult {
        output: (!output.is_empty() && output != "{}").then_some(output.clone()),
        error: failed.then_some(if output.is_empty() {
            "Tool failed".to_owned()
        } else {
            output
        }),
        exit_code: None,
        process_id: None,
        running: false,
    }
}

pub(super) fn format_plan(payload: &Map<String, Value>) -> String {
    let mut parts = nonempty(payload.get("explanation"))
        .map(str::to_owned)
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(plan) = payload.get("plan").and_then(Value::as_array) {
        parts.extend(plan.iter().filter_map(|value| {
            let value = value.as_object()?;
            let step = nonempty(value.get("step"))?;
            Some(format!(
                "- [{}] {step}",
                if value.get("status").and_then(Value::as_str) == Some("completed") {
                    "x"
                } else {
                    " "
                }
            ))
        }));
    }
    parts.join("\n\n")
}

pub(super) fn legacy_change_files(value: Option<&Value>) -> Vec<AgentFileDiff> {
    object(value)
        .map(|changes| {
            changes
                .iter()
                .map(|(file, value)| {
                    let object = value.as_object();
                    let patch = object
                        .and_then(|value| {
                            nonempty(value.get("diff")).or_else(|| nonempty(value.get("patch")))
                        })
                        .map(str::to_owned)
                        .or_else(|| match value {
                            Value::Null | Value::Object(_) => None,
                            Value::String(value) if !value.is_empty() => Some(value.clone()),
                            value => detail(Some(value)),
                        });
                    AgentFileDiff::normalized(
                        file.clone(),
                        patch,
                        object
                            .and_then(|value| nonempty(value.get("before")))
                            .map(str::to_owned),
                        object
                            .and_then(|value| nonempty(value.get("after")))
                            .map(str::to_owned),
                        object
                            .and_then(|value| value.get("additions"))
                            .and_then(Value::as_u64)
                            .and_then(|value| value.try_into().ok()),
                        object
                            .and_then(|value| value.get("deletions"))
                            .and_then(Value::as_u64)
                            .and_then(|value| value.try_into().ok()),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn unified_diff_files(value: Option<&str>) -> Vec<AgentFileDiff> {
    let Some(value) = value else {
        return Vec::new();
    };
    let mut starts = value.match_indices("diff --git a/").collect::<Vec<_>>();
    if starts.is_empty() {
        let file = value
            .lines()
            .find_map(|line| {
                line.strip_prefix("+++ b/")
                    .or_else(|| line.strip_prefix("--- a/"))
            })
            .unwrap_or("Changes");
        return vec![AgentFileDiff::normalized(
            file.to_owned(),
            Some(value.to_owned()),
            None,
            None,
            None,
            None,
        )];
    }
    starts.push((value.len(), ""));
    starts
        .windows(2)
        .filter_map(|window| {
            let start = window[0].0;
            let end = window[1].0;
            let patch = value[start..end].trim_end().to_owned();
            let first = patch.lines().next()?;
            let file = first.split_once(" b/")?.1.to_owned();
            Some(AgentFileDiff::normalized(
                file,
                Some(patch),
                None,
                None,
                None,
                None,
            ))
        })
        .collect()
}

fn apply_patch_files(source: &str) -> Vec<AgentFileDiff> {
    let Some(begin) = source.find("*** Begin Patch") else {
        return Vec::new();
    };
    let decoded = source[begin..].replace("\\n", "\n").replace("\\\"", "\"");
    let mut result = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in decoded.lines() {
        if let Some(file) = line
            .strip_prefix("*** Update File: ")
            .or_else(|| line.strip_prefix("*** Add File: "))
            .or_else(|| line.strip_prefix("*** Delete File: "))
        {
            if let Some((file, patch)) = current.take() {
                result.push(AgentFileDiff::normalized(
                    file,
                    Some(patch.trim_end().to_owned()),
                    None,
                    None,
                    None,
                    None,
                ));
            }
            current = Some((file.trim().to_owned(), String::new()));
        } else if let Some((_, patch)) = current.as_mut() {
            patch.push_str(line);
            patch.push('\n');
        }
    }
    if let Some((file, patch)) = current {
        result.push(AgentFileDiff::normalized(
            file,
            Some(patch.trim_end().to_owned()),
            None,
            None,
            None,
            None,
        ));
    }
    result
}

pub(super) struct TurnAggregation<'a> {
    status: AgentTurnStatus,
    started_at_ms: Option<u64>,
    completed_at_ms: Option<u64>,
    diffs: Vec<&'a AgentFileDiff>,
}

impl TurnAggregation<'_> {
    pub(super) fn apply_to(self, turn: &mut AgentTranscriptTurn) {
        turn.status = self.status;
        turn.started_at_ms = self.started_at_ms;
        turn.completed_at_ms = self.completed_at_ms;
        turn.diffs = self.diffs.into_iter().cloned().collect();
    }
}

/// Aggregate messages resolved through the caller's index. Recompute from scratch
/// so removal of an error, running tool, timestamp, or diff cannot leave stale state.
pub(super) fn aggregate_turn<'a>(
    user: Option<&'a AgentTranscriptMessage>,
    assistants: impl IntoIterator<Item = &'a AgentTranscriptMessage>,
) -> TurnAggregation<'a> {
    let mut aggregation = TurnAggregation {
        status: AgentTurnStatus::Idle,
        started_at_ms: user.and_then(|message| message.created_at_ms),
        completed_at_ms: user.and_then(|message| message.completed_at_ms),
        diffs: user
            .map(|message| message.diffs.iter().collect())
            .unwrap_or_default(),
    };
    let mut running = false;
    let mut failed = false;
    for message in assistants {
        aggregation.started_at_ms = aggregation.started_at_ms.or(message.created_at_ms);
        aggregation.completed_at_ms = aggregation.completed_at_ms.max(message.completed_at_ms);
        failed |= message.error.is_some();
        for diff in &message.diffs {
            if let Some(current) = aggregation
                .diffs
                .iter_mut()
                .find(|current| current.file == diff.file)
            {
                *current = diff;
            } else {
                aggregation.diffs.push(diff);
            }
        }
        for part in &message.parts {
            if let AgentTranscriptPart::Tool { state, .. } = part {
                running |= matches!(
                    state.status,
                    AgentToolStatus::Pending | AgentToolStatus::Running
                );
                failed |= state.status == AgentToolStatus::Error;
                aggregation.completed_at_ms =
                    aggregation.completed_at_ms.max(state.completed_at_ms);
            }
        }
    }
    aggregation.status = if failed {
        AgentTurnStatus::Error
    } else if running {
        AgentTurnStatus::Working
    } else {
        AgentTurnStatus::Idle
    };
    aggregation
}

pub(super) fn project_turns(messages: &[AgentTranscriptMessage]) -> Vec<AgentTranscriptTurn> {
    let message_indexes: HashMap<&str, usize> = messages
        .iter()
        .enumerate()
        .map(|(index, message)| (message.id.as_str(), index))
        .collect();
    let mut turns = Vec::<AgentTranscriptTurn>::new();
    let mut by_user = HashMap::<&str, usize>::new();
    let mut latest = None;
    for message in messages {
        if message.role == AgentMessageRole::User {
            let index = turns.len();
            turns.push(AgentTranscriptTurn {
                id: message.id.clone(),
                user_message_id: Some(message.id.clone()),
                assistant_message_ids: Vec::new(),
                status: AgentTurnStatus::Idle,
                started_at_ms: None,
                completed_at_ms: None,
                diffs: Vec::new(),
            });
            by_user.insert(&message.id, index);
            latest = Some(index);
            continue;
        }
        let index = message
            .parent_id
            .as_ref()
            .and_then(|parent| by_user.get(parent.as_str()).copied())
            .or(latest)
            .unwrap_or_else(|| {
                let index = turns.len();
                turns.push(AgentTranscriptTurn {
                    id: message
                        .parent_id
                        .clone()
                        .unwrap_or_else(|| message.id.clone()),
                    user_message_id: None,
                    assistant_message_ids: Vec::new(),
                    status: AgentTurnStatus::Idle,
                    started_at_ms: None,
                    completed_at_ms: None,
                    diffs: Vec::new(),
                });
                index
            });
        latest = Some(index);
        turns[index].assistant_message_ids.push(message.id.clone());
    }
    for turn in &mut turns {
        let lookup = |id: &str| {
            message_indexes
                .get(id)
                .and_then(|index| messages.get(*index))
        };
        let user = turn.user_message_id.as_deref().and_then(lookup);
        let assistants = turn
            .assistant_message_ids
            .iter()
            .filter_map(|id| lookup(id));
        aggregate_turn(user, assistants).apply_to(turn);
    }
    turns
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_fields_convert_primitives_and_skip_nested_json() {
        let input = serde_json::json!({
            "text": "hello",
            "empty": "",
            "integer": -42,
            "fraction": 1.5,
            "enabled": true,
            "disabled": false,
            "array": [1, "two"],
            "object": {"nested": true},
            "null": null,
        });
        let fields = scalar_fields(Some(&input));
        let expected = [
            (
                "text",
                AgentScalarValue::String {
                    value: "hello".to_owned(),
                },
            ),
            (
                "empty",
                AgentScalarValue::String {
                    value: String::new(),
                },
            ),
            ("integer", AgentScalarValue::Number { value: -42.0 }),
            ("fraction", AgentScalarValue::Number { value: 1.5 }),
            ("enabled", AgentScalarValue::Boolean { value: true }),
            ("disabled", AgentScalarValue::Boolean { value: false }),
        ];
        assert_eq!(fields.len(), expected.len());
        for (key, value) in expected {
            assert!(fields.contains(&AgentField {
                key: key.to_owned(),
                value
            }));
        }
    }

    #[test]
    fn scalar_fields_ignore_missing_and_non_object_payloads() {
        assert!(scalar_fields(None).is_empty());
        for input in [
            serde_json::json!("hello"),
            serde_json::json!(42),
            serde_json::json!(true),
            serde_json::json!([1, "two"]),
            Value::Null,
        ] {
            assert!(scalar_fields(Some(&input)).is_empty());
        }
    }

    #[test]
    fn prompt_images_preserve_text_and_multiple_uploaded_paths() {
        let parts = user_prompt_parts(
            "prompt",
            "请看 /home/me/.whip/uploads/cat.png /home/me/.whip/uploads/dog.JPG thanks",
            Some(42),
        );
        assert_eq!(parts.len(), 4);
        assert!(matches!(&parts[0], AgentTranscriptPart::Text { text, .. } if text == "请看"));
        assert!(
            matches!(&parts[1], AgentTranscriptPart::Image { source, timestamp_ms: Some(42), .. } if source == "/home/me/.whip/uploads/cat.png")
        );
        assert!(
            matches!(&parts[2], AgentTranscriptPart::Image { source, .. } if source == "/home/me/.whip/uploads/dog.JPG")
        );
        assert!(matches!(&parts[3], AgentTranscriptPart::Text { text, .. } if text == "thanks"));
        let ids = parts
            .iter()
            .map(AgentTranscriptPart::id)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), parts.len());
    }

    #[test]
    fn prompt_images_accept_whole_paths_and_leave_file_discussion_unchanged() {
        for text in [
            "Fix src/image.png please",
            "See /repo/image.png for details",
            "/home/me/.whip/uploads/report.pdf",
        ] {
            let parts = user_prompt_parts("prompt", text, None);
            assert!(
                matches!(&parts[..], [AgentTranscriptPart::Text { id, text: actual, .. }] if id == "prompt" && actual == text)
            );
        }
        for text in [
            "/repo/image.png",
            "\"/repo/my image.png\"",
            "./image.webp",
            "~/image.gif",
        ] {
            let parts = user_prompt_parts("prompt", text, None);
            assert!(
                matches!(&parts[..], [AgentTranscriptPart::Image { source, .. }] if source == text.trim_matches('"'))
            );
        }
    }

    #[test]
    fn question_inputs_preserve_nested_options_across_agent_tool_names() {
        let questions = serde_json::json!([
            {"header":"Database", "question":"Which database?", "options":[
                {"label":"SQLite: local ✓", "description":"Local storage"},
                {"label":"Postgres", "description":"Shared storage"}
            ]},
            {"question":"Which features?", "multiple":true, "options":["Sync", "Search"]}
        ]);
        let expected = "Database\nWhich database?\n• SQLite: local ✓: Local storage\n• Postgres: Shared storage\n\nWhich features?\nChoose one or more.\n• Sync\n• Search";
        let raw = serde_json::json!({"questions":questions});
        for name in [
            "AskUserQuestion",
            "functions.request_user_input",
            "functions · request_user_input_async",
            "question",
        ] {
            let input = tool_input(name, Some(&raw));
            assert!(input.contains(&AgentField {
                key: "questions".into(),
                value: AgentScalarValue::String {
                    value: questions.to_string()
                },
            }));
            assert!(input.contains(&AgentField {
                key: "question_summary".into(),
                value: AgentScalarValue::String {
                    value: expected.into()
                },
            }));
            let parsed = questions_from_input(&input);
            assert_eq!(parsed[0].question, "Which database?");
            assert_eq!(parsed[0].options[0].label, "SQLite: local ✓");
            assert_eq!(
                parsed[0].options[0].description.as_deref(),
                Some("Local storage")
            );
            assert_eq!(parsed[1].options[0].label, "Sync");
            assert!(parsed[1].multiple);
            // Claude caches already retain the nested questions as JSON strings.
            let serialized = fields([("questions", questions.to_string())]);
            assert_eq!(canonical_tool_input(name, serialized), input);
        }
        assert!(question_summary(Some(&serde_json::json!([{"future_field":"unknown"}]))).is_none());
        assert!(tool_input("shell", Some(&raw)).is_empty());
        assert!(
            transcript_questions(Some(
                &serde_json::json!([{"question":"Why?", "options":[{}, "", {"label":""}]}])
            ))[0]
                .options
                .is_empty()
        );
    }

    #[test]
    fn canonical_tool_input_collapses_wire_aliases() {
        let input = scalar_fields(Some(&serde_json::json!({
            "cmd": "cargo test",
            "workdir": "/repo",
            "file_path": "src/lib.rs",
            "pattern": "AgentToolState",
            "subagent_type": "reviewer"
        })));

        assert_eq!(
            canonical_tool_input("shell", input),
            [
                AgentField {
                    key: "command".to_owned(),
                    value: AgentScalarValue::String {
                        value: "cargo test".to_owned()
                    },
                },
                AgentField {
                    key: "path".to_owned(),
                    value: AgentScalarValue::String {
                        value: "src/lib.rs".to_owned()
                    },
                },
                AgentField {
                    key: "query".to_owned(),
                    value: AgentScalarValue::String {
                        value: "AgentToolState".to_owned()
                    },
                },
                AgentField {
                    key: "agent".to_owned(),
                    value: AgentScalarValue::String {
                        value: "reviewer".to_owned()
                    },
                },
                AgentField {
                    key: "cwd".to_owned(),
                    value: AgentScalarValue::String {
                        value: "/repo".to_owned()
                    },
                },
            ]
        );
        assert_eq!(
            tool_input(
                "shell",
                Some(&serde_json::json!({ "cmd": ["cargo", "test"] })),
            ),
            fields([("command", "cargo test".to_owned())])
        );
    }
}
