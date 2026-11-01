//! Tolerant Claude Code JSONL adaptation. Wire values never cross the native API.
//!
//! The checkpoint stores bounded normalized nodes, not Claude's unstable wire
//! schema. Keeping ancestry separate from presentation lets a later branch or
//! late parent change the projection without losing tool results or stable IDs.
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::content::{MAX_BLOCKS, MAX_TEXT_BYTES, bounded, input_fields, result_text, string};
use super::metadata::{provider_details, tool_input_json};
use super::model::{
    AgentCacheError, AgentFileDiff, AgentMessageRole, AgentNoticeLevel, AgentToolState,
    AgentToolStatus, AgentTranscriptDetails, AgentTranscriptInfo, AgentTranscriptKind,
    AgentTranscriptMessage, AgentTranscriptPart, AgentTranscriptState, AgentTranscriptStatus,
    AgentTurnOutcome, AgentTurnStatus,
};
use super::projection::{
    canonical_tool_input, image_source, normalize_user_images, project_turns, questions_from_input,
    timestamp_ms,
};

const CACHE_VERSION: u32 = 3;
fn tool_use_part(block: &Value, at: Option<u64>) -> Option<AgentTranscriptPart> {
    let call_id = string(block, "id")?;
    let tool = string(block, "name")?;
    let input = canonical_tool_input(&tool.to_ascii_lowercase(), input_fields(&block["input"]));
    Some(AgentTranscriptPart::Tool {
        id: format!("claude-tool:{call_id}"),
        call_id,
        tool,
        timestamp_ms: at,
        state: AgentToolState {
            duration_ms: None,
            input_json: tool_input_json(block.get("input")),
            status: AgentToolStatus::Running,
            questions: questions_from_input(&input),
            input,
            output: None,
            error: None,
            title: string(&block["input"], "description"),
            started_at_ms: at,
            completed_at_ms: None,
            exit_code: None,
            files: Vec::new(),
            diagnostics: Vec::new(),
            loaded: Vec::new(),
        },
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ToolCompletion {
    call_id: String,
    output: Option<String>,
    error: Option<String>,
    at: Option<u64>,
    exit_code: Option<i64>,
    interrupted: bool,
    files: Vec<AgentFileDiff>,
}

impl ToolCompletion {
    fn parse(block: &Value, rich: Option<&Value>, at: Option<u64>) -> Option<Self> {
        let call_id = string(block, "tool_use_id")?;
        let rich = rich.unwrap_or(&Value::Null);
        let output = result_text(rich).or_else(|| result_text(&block["content"]));
        let exit_code = rich
            .get("exitCode")
            .or_else(|| rich.get("exit_code"))
            .and_then(Value::as_i64);
        let interrupted = rich["interrupted"].as_bool() == Some(true);
        let failed = block["is_error"].as_bool() == Some(true)
            || exit_code.is_some_and(|code| code != 0)
            || interrupted;
        let error = failed.then(|| {
            string(rich, "stderr")
                .or_else(|| output.clone())
                .unwrap_or_else(|| {
                    if interrupted {
                        "Tool interrupted"
                    } else {
                        "Tool failed"
                    }
                    .to_owned()
                })
        });
        // Edit/Write results provide an explicit path and structured patch. Do
        // not infer file changes from prose or shell output.
        let files = string(rich, "filePath")
            .or_else(|| string(rich, "file_path"))
            .map(|file| {
                let patch = string(rich, "patch").or_else(|| structured_patch(rich));
                AgentFileDiff::normalized(file, patch, None, None, None, None)
            })
            .into_iter()
            .collect();
        Some(Self {
            call_id,
            output,
            error,
            at,
            exit_code,
            interrupted,
            files,
        })
    }
}

fn structured_patch(rich: &Value) -> Option<String> {
    let hunks = rich["structuredPatch"].as_array()?;
    let mut patch = String::new();
    for hunk in hunks.iter().take(MAX_BLOCKS) {
        let (Some(old_start), Some(old_lines), Some(new_start), Some(new_lines)) = (
            hunk["oldStart"].as_u64(),
            hunk["oldLines"].as_u64(),
            hunk["newStart"].as_u64(),
            hunk["newLines"].as_u64(),
        ) else {
            continue;
        };
        let _ = writeln!(
            patch,
            "@@ -{old_start},{old_lines} +{new_start},{new_lines} @@"
        );
        if let Some(lines) = hunk["lines"].as_array() {
            for line in lines.iter().take(MAX_BLOCKS).filter_map(Value::as_str) {
                patch.push_str(&bounded(line));
                patch.push('\n');
                if patch.len() >= MAX_TEXT_BYTES {
                    break;
                }
            }
        }
        if patch.len() >= MAX_TEXT_BYTES {
            break;
        }
    }
    (!patch.is_empty()).then(|| bounded(&patch))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ClaudeNode {
    uuid: String,
    parent: Option<String>,
    /// Missing/malformed differs from an explicit root (parentUuid: null).
    root: bool,
    sidechain: bool,
    interrupted: bool,
    order: u64,
    message: Option<AgentTranscriptMessage>,
    results: Vec<ToolCompletion>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClaudeTranscriptAdapter {
    session_id: String,
    nodes: Vec<ClaudeNode>,
    custom_title: Option<String>,
    ai_title: Option<String>,
    directory: Option<String>,
    leaf: Option<String>,
    #[serde(skip)]
    indexes: HashMap<String, usize>,
}

impl ClaudeTranscriptAdapter {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            nodes: Vec::new(),
            indexes: HashMap::new(),
            custom_title: None,
            ai_title: None,
            directory: None,
            leaf: None,
        }
    }

    /// A physical end offset is a stable fallback ID even for records lacking
    /// UUIDs. Every persisted assistant row is a completed content block; a null
    /// stop_reason does not mean this row is an SDK text delta.
    fn accept(&mut self, record: &Value, order: u64) {
        if record
            .get("sessionId")
            .and_then(Value::as_str)
            .is_some_and(|id| id != self.session_id)
        {
            return;
        }
        let sidechain = record["isSidechain"].as_bool() == Some(true);
        let kind = record["type"].as_str().unwrap_or_default();
        if !sidechain {
            if let Some(cwd) = string(record, "cwd") {
                self.directory = Some(cwd);
            }
            match kind {
                "custom-title" => {
                    self.custom_title = record["customTitle"]
                        .as_str()
                        .and_then(super::title::session_title);
                }
                "ai-title" => {
                    self.ai_title = record["aiTitle"]
                        .as_str()
                        .and_then(super::title::session_title);
                }
                "last-prompt" => self.leaf = string(record, "leafUuid"),
                "system" if record["subtype"] == "compact_boundary" => self.leaf = None,
                _ => {}
            }
        }
        let chat = matches!(kind, "user" | "assistant");
        let Some(uuid) =
            string(record, "uuid").or_else(|| chat.then(|| format!("claude-offset-{order}")))
        else {
            return;
        };
        let parent = string(record, "parentUuid");
        let root = record.get("parentUuid") == Some(&Value::Null);
        let at = timestamp_ms(record.get("timestamp"));
        let mut role = if kind == "assistant" {
            AgentMessageRole::Assistant
        } else {
            AgentMessageRole::User
        };
        let mut parts = Vec::new();
        let mut results = Vec::new();
        if chat && !sidechain {
            let content = &record["message"]["content"];
            let blocks = match content {
                Value::Array(blocks) => blocks.iter().take(MAX_BLOCKS).collect::<Vec<_>>(),
                _ => vec![content],
            };
            let result_count = blocks
                .iter()
                .filter(|block| block["type"] == "tool_result")
                .count();
            for (index, block) in blocks.into_iter().enumerate() {
                let id = format!("{uuid}:{index}");
                match block["type"].as_str().unwrap_or_default() {
                    "image" if role == AgentMessageRole::User => {
                        if let Some(source) = image_source(block) {
                            parts.push(AgentTranscriptPart::Image {
                                id,
                                source,
                                timestamp_ms: at,
                            });
                        }
                    }
                    "tool_result" => {
                        // A single rich result cannot safely be assigned to
                        // several parallel calls without an explicit call ID.
                        let rich = record.get("toolUseResult").filter(|rich| {
                            result_count == 1 || rich["tool_use_id"] == block["tool_use_id"]
                        });
                        if let Some(result) = ToolCompletion::parse(block, rich, at) {
                            results.push(result);
                        }
                    }
                    "tool_use" if role == AgentMessageRole::Assistant => {
                        if let Some(part) = tool_use_part(block, at) {
                            parts.push(part);
                        }
                    }
                    "thinking" if role == AgentMessageRole::Assistant => {
                        if let Some(text) = string(block, "thinking") {
                            parts.push(AgentTranscriptPart::Reasoning {
                                id,
                                text,
                                timestamp_ms: at,
                            });
                        }
                    }
                    "text" => {
                        if let Some(text) = string(block, "text") {
                            parts.push(AgentTranscriptPart::Text {
                                id,
                                text,
                                timestamp_ms: at,
                            });
                        }
                    }
                    "" if block.is_string() => {
                        if let Some(text) = block.as_str().filter(|text| !text.trim().is_empty()) {
                            parts.push(AgentTranscriptPart::Text {
                                id,
                                text: bounded(text),
                                timestamp_ms: at,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        // Meta prompts and tool responses (including accompanying annotations)
        // are not user input. They still participate in the ancestry graph.
        let tool_response = record["message"]["content"]
            .as_array()
            .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_result"));
        if role == AgentMessageRole::User
            && (tool_response || record["isMeta"] == true || record["isCompactSummary"] == true)
        {
            parts.clear();
        }
        // Claude persists interruption markers as structured user records.
        // They end the current turn rather than starting another user turn.
        let interruption = record["message"]["content"]
            .as_array()
            .filter(|blocks| blocks.len() == 1 && blocks[0]["type"] == "text")
            .and_then(|blocks| blocks[0]["text"].as_str())
            .filter(|text| {
                matches!(
                    *text,
                    "[Request interrupted by user]" | "[Request interrupted by user for tool use]"
                )
            })
            .filter(|_| kind == "user" && !sidechain);
        let interrupted = interruption.is_some();
        let error = (kind == "assistant" && !sidechain && record["isApiErrorMessage"] == true)
            .then(|| {
                result_text(&record["message"]["content"])
                    .unwrap_or_else(|| "Claude API error".to_owned())
            });
        let notice = error
            .clone()
            .or_else(|| interruption.map(|text| text.trim_matches(['[', ']']).to_owned()));
        if let Some(text) = notice {
            role = AgentMessageRole::Assistant;
            parts = vec![AgentTranscriptPart::Notice {
                id: format!("{uuid}:notice"),
                level: if interrupted {
                    AgentNoticeLevel::Warning
                } else {
                    AgentNoticeLevel::Error
                },
                text,
                timestamp_ms: at,
                questions: Vec::new(),
            }];
        }
        let mut details = provider_details(&record["message"], true);
        if error.is_some() || interrupted {
            details
                .get_or_insert_with(AgentTranscriptDetails::default)
                .outcome = Some(if interrupted {
                AgentTurnOutcome::Interrupted
            } else {
                AgentTurnOutcome::Failed
            });
        }
        let accounting_only = chat
            && !sidechain
            && role == AgentMessageRole::Assistant
            && details
                .as_ref()
                .is_some_and(|details| details.usage.is_some() || details.outcome.is_some());
        let message = (!parts.is_empty() || accounting_only).then(|| {
            let mut message = AgentTranscriptMessage {
                details,
                id: uuid.clone(),
                role,
                parent_id: None,
                created_at_ms: at,
                completed_at_ms: (role == AgentMessageRole::Assistant)
                    .then_some(at)
                    .flatten(),
                error,
                parts,
                diffs: Vec::new(),
            };
            normalize_user_images(&mut message);
            message
        });
        let node = ClaudeNode {
            uuid: uuid.clone(),
            parent,
            root,
            sidechain,
            interrupted,
            order,
            message,
            results,
        };
        if let Some(index) = self.indexes.get(&uuid).copied() {
            self.nodes[index] = node;
        } else {
            self.indexes.insert(uuid, self.nodes.len());
            self.nodes.push(node);
        }
    }

    fn ancestry(&self, start: usize) -> (Vec<usize>, bool) {
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        let mut current = start;
        loop {
            if !seen.insert(current) {
                return (chain, true);
            }
            chain.push(current);
            let node = &self.nodes[current];
            match node
                .parent
                .as_ref()
                .and_then(|id| self.indexes.get(id))
                .copied()
            {
                Some(parent) => current = parent,
                None => return (chain, !node.root),
            }
        }
    }

    fn main_chain(&self) -> Vec<usize> {
        let main = self
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, node)| {
                !node.sidechain && (node.message.is_some() || !node.results.is_empty())
            })
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        // Only ancestors of main chat records disqualify a leaf. Trailing
        // progress/metadata must not make an abandoned sibling become active.
        // Stop at visited ancestors so this pass remains linear in graph size.
        let parent_of = |index: usize| {
            self.nodes[index]
                .parent
                .as_ref()
                .and_then(|id| self.indexes.get(id))
                .copied()
        };
        let mut parents = HashSet::new();
        for index in &main {
            let mut parent = parent_of(*index);
            while let Some(index) = parent {
                if !parents.insert(index) {
                    break;
                }
                parent = parent_of(index);
            }
        }
        let latest = main
            .iter()
            .copied()
            .filter(|i| !parents.contains(i))
            .max_by_key(|i| self.nodes[*i].order)
            .or_else(|| main.last().copied());
        let newest = main.iter().copied().max_by_key(|i| self.nodes[*i].order);
        let latest = newest.filter(|i| self.ancestry(*i).1).or(latest);
        let Some(latest) = latest else {
            return Vec::new();
        };
        let stamped = self
            .leaf
            .as_ref()
            .and_then(|id| self.indexes.get(id))
            .copied()
            .filter(|i| !self.nodes[*i].sidechain);
        let latest_chain = self.ancestry(latest);
        let leaf = stamped
            .filter(|stamp| !latest_chain.0.contains(stamp))
            .unwrap_or(latest);
        let (mut chain, broken) = self.ancestry(leaf);
        chain.reverse();
        if !broken {
            return chain;
        }
        // Broken links must not erase otherwise usable history. Keep known
        // ancestry order, and fill gaps chronologically; prune sibling branches
        // where the active path gives an unambiguous choice.
        let chosen = chain
            .windows(2)
            .map(|pair| (pair[0], pair[1]))
            .collect::<HashMap<_, _>>();
        let mut ordered = Vec::new();
        let mut seen = HashSet::new();
        let mut candidates = main;
        candidates.sort_by_key(|i| self.nodes[*i].order);
        for index in candidates {
            let (mut ancestors, _) = self.ancestry(index);
            ancestors.reverse();
            if ancestors
                .windows(2)
                .any(|pair| chosen.get(&pair[0]).is_some_and(|child| *child != pair[1]))
            {
                continue;
            }
            for index in ancestors {
                if seen.insert(index) {
                    ordered.push(index);
                }
            }
        }
        ordered
    }

    pub fn snapshot(
        &self,
        revision: u64,
        status: AgentTranscriptStatus,
        error: Option<String>,
    ) -> AgentTranscriptState {
        let chain = self.main_chain();
        let mut messages = Vec::new();
        let mut user = None;
        let mut results = Vec::new();
        let mut interrupted = HashSet::new();
        for index in chain {
            let node = &self.nodes[index];
            if node.sidechain {
                continue;
            }
            if let Some(mut message) = node.message.clone() {
                if node.interrupted {
                    interrupted.insert(message.id.clone());
                }
                if message.role == AgentMessageRole::User {
                    user = Some(message.id.clone());
                } else {
                    message.parent_id.clone_from(&user);
                }
                messages.push(message);
            }
            results.extend(&node.results);
        }
        let mut locations = HashMap::new();
        for (mi, message) in messages.iter().enumerate() {
            for (pi, part) in message.parts.iter().enumerate() {
                if let AgentTranscriptPart::Tool { call_id, .. } = part {
                    locations.insert(call_id.clone(), (mi, pi));
                }
            }
        }
        for result in results {
            let Some(&(mi, pi)) = locations.get(&result.call_id) else {
                continue;
            };
            let message = &mut messages[mi];
            if let AgentTranscriptPart::Tool { state, .. } = &mut message.parts[pi] {
                state.status = if result.error.is_some() {
                    AgentToolStatus::Error
                } else {
                    AgentToolStatus::Completed
                };
                state.output.clone_from(&result.output);
                state.error.clone_from(&result.error);
                state.completed_at_ms = result.at;
                state.duration_ms = result
                    .at
                    .zip(state.started_at_ms)
                    .and_then(|(end, start)| end.checked_sub(start));
                state.exit_code = result.exit_code;
                state.files.clone_from(&result.files);
            }
            message.diffs.extend(result.files.iter().cloned());
            if result.interrupted {
                interrupted.insert(message.id.clone());
            }
        }
        let mut turns = project_turns(&messages);
        for turn in &mut turns {
            if turn
                .assistant_message_ids
                .iter()
                .any(|id| interrupted.contains(id))
            {
                turn.status = AgentTurnStatus::Interrupted;
                turn.details
                    .get_or_insert_with(AgentTranscriptDetails::default)
                    .outcome = Some(AgentTurnOutcome::Interrupted);
            } else if turn.assistant_message_ids.is_empty() {
                turn.status = AgentTurnStatus::Working;
            }
        }
        AgentTranscriptState {
            session_id: self.session_id.clone(),
            agent: AgentTranscriptKind::Claude,
            revision,
            status,
            error,
            info: Some(AgentTranscriptInfo {
                id: self.session_id.clone(),
                title: self.custom_title.clone().or_else(|| self.ai_title.clone()),
                directory: self.directory.clone(),
                created_at_ms: messages.first().and_then(|m| m.created_at_ms),
                updated_at_ms: messages.last().and_then(|m| m.created_at_ms),
            }),
            messages,
            turns,
        }
    }
}

pub type ClaudeSessionCore = super::file_session::JsonlSessionCore<ClaudeTranscriptAdapter>;

impl super::file_session::JsonlTranscriptAdapter for ClaudeTranscriptAdapter {
    const AGENT: AgentTranscriptKind = AgentTranscriptKind::Claude;
    const CACHE_VERSION: u32 = CACHE_VERSION;
    fn new(session_id: impl Into<String>) -> Self {
        Self::new(session_id)
    }
    fn session_id(&self) -> &str {
        &self.session_id
    }
    fn accept(&mut self, record: &Value, order: u64) {
        self.accept(record, order);
    }
    fn snapshot(
        &self,
        revision: u64,
        status: AgentTranscriptStatus,
        error: Option<String>,
    ) -> AgentTranscriptState {
        self.snapshot(revision, status, error)
    }
    fn supports_cache(version: u32) -> bool {
        matches!(version, 2 | CACHE_VERSION)
    }
    fn restore(&mut self, offset: u64) -> Result<(), AgentCacheError> {
        for (index, node) in self.nodes.iter_mut().enumerate() {
            if let Some(message) = &mut node.message {
                normalize_user_images(message);
                for part in &mut message.parts {
                    if let AgentTranscriptPart::Tool { tool, state, .. } = part {
                        state.input = canonical_tool_input(tool, std::mem::take(&mut state.input));
                        state.questions = questions_from_input(&state.input);
                    }
                }
            }
            if node.order > offset || self.indexes.insert(node.uuid.clone(), index).is_some() {
                return Err(AgentCacheError::Malformed(
                    "invalid Claude node offsets/IDs".into(),
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
