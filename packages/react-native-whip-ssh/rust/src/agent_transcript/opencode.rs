//! OpenCode export/event adaptation, mutation reduction, indexes, and caching.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::history_gate::InitialHistoryGate;
use super::model::*;
use super::projection::*;

const OPENCODE_CACHE_SCHEMA_VERSION: u32 = 3;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedOpenCodeSession {
    schema_version: u32,
    session_id: String,
    cursor: u64,
    transcript: AgentTranscriptState,
}

#[derive(Serialize)]
struct AgentTranscriptInfoRef<'a> {
    id: &'a str,
    title: Option<&'a str>,
    directory: Option<&'a str>,
    created_at_ms: Option<u64>,
    updated_at_ms: Option<u64>,
}

impl<'a> From<&'a AgentTranscriptInfo> for AgentTranscriptInfoRef<'a> {
    fn from(info: &'a AgentTranscriptInfo) -> Self {
        Self {
            id: &info.id,
            title: info.title.as_deref(),
            directory: info.directory.as_deref(),
            created_at_ms: info.created_at_ms,
            updated_at_ms: info.updated_at_ms,
        }
    }
}

#[derive(Serialize)]
struct AgentTranscriptStateRef<'a> {
    session_id: &'a str,
    agent: AgentTranscriptKind,
    revision: u64,
    status: AgentTranscriptStatus,
    info: Option<AgentTranscriptInfoRef<'a>>,
    messages: &'a [AgentTranscriptMessage],
    turns: &'a [AgentTranscriptTurn],
    error: Option<&'a str>,
}

#[derive(Serialize)]
struct CachedOpenCodeSessionRef<'a> {
    schema_version: u32,
    session_id: &'a str,
    cursor: u64,
    transcript: AgentTranscriptStateRef<'a>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum OpenCodeTranscriptError {
    #[error("OpenCode returned an invalid session export")]
    InvalidExport,
    #[error("OpenCode returned an invalid event cursor")]
    InvalidCursor,
    #[error("OpenCode returned invalid session events")]
    InvalidEvents,
    #[error("OpenCode part event references a missing message")]
    MissingMessage,
    #[error("OpenCode event database is behind the cached cursor")]
    CursorDiverged,
    #[error("OpenCode incremental events did not reach the remote cursor")]
    IncompleteEvents,
}

#[derive(Clone, Debug)]
enum OpenCodeMutation {
    Info(AgentTranscriptInfo),
    Message(AgentTranscriptMessage),
    RemoveMessage(String),
    Part {
        message_id: String,
        part: AgentTranscriptPart,
    },
    RemovePart {
        message_id: String,
        part_id: String,
    },
}

/// Compares the metadata from `message.updated` that does not determine turn
/// structure. Message identity is matched by `message_indexes`, while parts
/// have their own mutations.
fn same_open_code_nonstructural_message_metadata(
    current: &AgentTranscriptMessage,
    incoming: &AgentTranscriptMessage,
) -> bool {
    current.created_at_ms == incoming.created_at_ms
        && current.completed_at_ms == incoming.completed_at_ms
        && current.error == incoming.error
        && current.diffs == incoming.diffs
}

/// OpenCode export/event adapter with an opaque, cursor-bearing cache. Remote
/// I/O stays in `AgentSessionManager`; this type is deterministic and testable.
#[derive(Clone, Debug)]
pub struct OpenCodeSessionCore {
    session_id: String,
    source_generation: u64,
    cursor: Option<u64>,
    committed_cursor: Option<u64>,
    revision: u64,
    info: Option<AgentTranscriptInfo>,
    messages: Vec<AgentTranscriptMessage>,
    message_indexes: HashMap<String, usize>,
    turns: Vec<AgentTranscriptTurn>,
    turn_indexes: HashMap<String, usize>,
    message_turns: HashMap<String, usize>,
    history_gate: InitialHistoryGate,
}

impl OpenCodeSessionCore {
    pub fn new(session_id: impl Into<String>) -> Self {
        let session_id = session_id.into();
        Self {
            info: Some(AgentTranscriptInfo {
                id: session_id.clone(),
                title: None,
                directory: None,
                created_at_ms: None,
                updated_at_ms: None,
            }),
            session_id,
            source_generation: 0,
            cursor: None,
            committed_cursor: None,
            revision: 0,
            messages: Vec::new(),
            message_indexes: HashMap::new(),
            turns: Vec::new(),
            turn_indexes: HashMap::new(),
            message_turns: HashMap::new(),
            history_gate: InitialHistoryGate::default(),
        }
    }

    pub fn source_generation(&self) -> u64 {
        self.source_generation
    }

    pub fn begin_sync_generation(&mut self) -> u64 {
        self.source_generation = self.source_generation.saturating_add(1);
        self.source_generation
    }

    pub fn cursor(&self) -> Option<u64> {
        self.cursor
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn committed_cursor(&self) -> Option<u64> {
        self.committed_cursor
    }

    pub fn state(&self) -> AgentTranscriptState {
        AgentTranscriptState {
            session_id: self.session_id.clone(),
            agent: AgentTranscriptKind::OpenCode,
            revision: self.revision,
            status: self.history_gate.status(),
            info: self.info.clone(),
            messages: self.messages.clone(),
            turns: self.turns.clone(),
            error: self.history_gate.error().map(str::to_owned),
        }
    }

    pub fn mark_stale(&mut self, error: impl Into<String>) -> AgentTranscriptState {
        self.mark_stale_update(error);
        self.state()
    }

    pub fn mark_stale_update(&mut self, error: impl Into<String>) -> AgentTranscriptUpdate {
        self.history_gate.mark_stale(error);
        self.bump_revision();
        self.status_update()
    }

    pub fn mark_restarting_update(&mut self, reason: impl Into<String>) -> AgentTranscriptUpdate {
        self.history_gate.restart(reason);
        self.bump_revision();
        self.status_update()
    }

    pub fn mark_unavailable(&mut self, error: impl Into<String>) -> AgentTranscriptState {
        self.mark_unavailable_update(error);
        self.state()
    }

    pub fn mark_unavailable_update(&mut self, error: impl Into<String>) -> AgentTranscriptUpdate {
        self.history_gate.mark_unavailable(error);
        self.bump_revision();
        self.status_update()
    }

    pub fn mark_live(&mut self) -> bool {
        if self.cursor.is_some() && self.history_gate.complete() {
            self.bump_revision();
            true
        } else {
            false
        }
    }

    pub fn mark_live_update(&mut self) -> Option<AgentTranscriptUpdate> {
        self.mark_live().then(|| self.status_update())
    }

    pub fn finish_live_update(
        &mut self,
        update: Option<AgentTranscriptUpdate>,
    ) -> Option<AgentTranscriptUpdate> {
        if self.cursor.is_none() || !self.history_gate.complete() {
            return update;
        }
        if let Some(mut update) = update {
            update.deltas.push(self.history_gate.status_delta());
            update.revision = self.revision;
            return Some(update);
        }
        self.bump_revision();
        Some(self.status_update())
    }

    pub fn close(&mut self) -> AgentTranscriptState {
        self.close_update();
        self.state()
    }

    pub fn close_update(&mut self) -> AgentTranscriptUpdate {
        self.source_generation = self.source_generation.saturating_add(1);
        self.history_gate.close();
        self.bump_revision();
        self.status_update()
    }

    pub fn restore_cache(&mut self, bytes: &[u8]) -> Result<AgentTranscriptState, AgentCacheError> {
        let cached: CachedOpenCodeSession = serde_json::from_slice(bytes)
            .map_err(|error| AgentCacheError::Malformed(error.to_string()))?;
        if cached.schema_version != OPENCODE_CACHE_SCHEMA_VERSION {
            return Err(AgentCacheError::Malformed("unsupported schema".to_owned()));
        }
        if cached.session_id != self.session_id
            || cached.transcript.session_id != self.session_id
            || cached.transcript.agent != AgentTranscriptKind::OpenCode
        {
            return Err(AgentCacheError::SessionMismatch);
        }
        if cached.transcript.turns != project_turns(&cached.transcript.messages) {
            return Err(AgentCacheError::ReplayDiverged);
        }
        if cached
            .transcript
            .info
            .as_ref()
            .is_some_and(|info| info.id != self.session_id)
        {
            return Err(AgentCacheError::SessionMismatch);
        }
        self.cursor = Some(cached.cursor);
        self.committed_cursor = Some(cached.cursor);
        self.info = cached.transcript.info;
        self.messages = cached.transcript.messages;
        self.turns = cached.transcript.turns;
        self.rebuild_indexes();
        self.revision = cached.transcript.revision;
        // A local cursor is not proof that the opening history is complete.
        // Only remote cursor verification or a successful full/event sync can
        // make restored history usable by the shared viewport reveal gate.
        self.history_gate.reset();
        self.bump_revision();
        Ok(self.state())
    }

    pub fn cache_blob(&self) -> Result<Vec<u8>, AgentCacheError> {
        let cursor = self.cursor.ok_or_else(|| {
            AgentCacheError::Malformed("OpenCode cursor is unavailable".to_owned())
        })?;
        serde_json::to_vec(&CachedOpenCodeSessionRef {
            schema_version: OPENCODE_CACHE_SCHEMA_VERSION,
            session_id: &self.session_id,
            cursor,
            transcript: AgentTranscriptStateRef {
                session_id: &self.session_id,
                agent: AgentTranscriptKind::OpenCode,
                revision: self.revision,
                status: self.history_gate.status(),
                info: self.info.as_ref().map(AgentTranscriptInfoRef::from),
                messages: &self.messages,
                turns: &self.turns,
                error: self.history_gate.error(),
            },
        })
        .map_err(|error| AgentCacheError::Malformed(error.to_string()))
    }

    pub fn confirm_cache(&mut self, source_generation: u64, cursor: u64) -> bool {
        if source_generation != self.source_generation
            || self.cursor.is_none_or(|current| cursor > current)
            || self
                .committed_cursor
                .is_some_and(|committed| cursor < committed)
        {
            return false;
        }
        self.committed_cursor = Some(cursor);
        true
    }

    /// Installs an authoritative export at the cursor read immediately before
    /// it. Events committed during the export are intentionally replayed by the
    /// next incremental query.
    pub fn bootstrap(
        &mut self,
        cursor: u64,
        export_json: &str,
    ) -> Result<bool, OpenCodeTranscriptError> {
        let value: Value = serde_json::from_str(export_json)
            .map_err(|_| OpenCodeTranscriptError::InvalidExport)?;
        let (info, messages) = parse_open_code_export(&value, &self.session_id)?;
        let changed = self.info.as_ref() != Some(&info) || self.messages != messages;
        self.cursor = Some(cursor);
        self.info = Some(info);
        self.messages = messages;
        self.turns = project_turns(&self.messages);
        self.rebuild_indexes();
        if changed {
            self.bump_revision();
        }
        Ok(changed)
    }

    pub fn bootstrap_update(
        &mut self,
        cursor: u64,
        export_json: &str,
    ) -> Result<Option<AgentTranscriptUpdate>, OpenCodeTranscriptError> {
        let changed = self.bootstrap(cursor, export_json)?;
        Ok(changed.then(|| AgentTranscriptUpdate::reset(self.state())))
    }

    pub fn apply_events(
        &mut self,
        remote_cursor: u64,
        events_json: &str,
    ) -> Result<bool, OpenCodeTranscriptError> {
        Ok(self
            .apply_events_incremental(remote_cursor, events_json)?
            .is_some())
    }

    pub fn apply_events_incremental(
        &mut self,
        remote_cursor: u64,
        events_json: &str,
    ) -> Result<Option<AgentTranscriptUpdate>, OpenCodeTranscriptError> {
        let local_cursor = self.cursor.ok_or(OpenCodeTranscriptError::InvalidCursor)?;
        if remote_cursor < local_cursor {
            return Err(OpenCodeTranscriptError::CursorDiverged);
        }
        let value: Value = serde_json::from_str(events_json)
            .map_err(|_| OpenCodeTranscriptError::InvalidEvents)?;
        let rows = value
            .as_array()
            .ok_or(OpenCodeTranscriptError::InvalidEvents)?;
        let mut cursor = local_cursor;
        let mut plan = Vec::new();
        let mut planned_messages = HashMap::<String, bool>::new();
        for row in rows {
            let row = row
                .as_object()
                .ok_or(OpenCodeTranscriptError::InvalidEvents)?;
            let sequence =
                open_code_u64(row.get("seq")).ok_or(OpenCodeTranscriptError::InvalidEvents)?;
            let raw_type =
                nonempty(row.get("type")).ok_or(OpenCodeTranscriptError::InvalidEvents)?;
            let event_type = strip_open_code_event_version(raw_type);
            let data = decoded_open_code_object(row.get("data"))
                .ok_or(OpenCodeTranscriptError::InvalidEvents)?;
            if sequence <= cursor {
                continue;
            }
            cursor = sequence;
            match event_type {
                "session.created" | "session.updated" => {
                    if let Some(next) = object(data.get("info"))
                        && nonempty(next.get("id")) == Some(self.session_id.as_str())
                    {
                        let next = open_code_session_info(next);
                        plan.push(OpenCodeMutation::Info(next));
                    }
                }
                "message.updated" => {
                    let Some(next_info) = data.get("info") else {
                        continue;
                    };
                    let Some(next) = open_code_message_from_parts(next_info, &[]) else {
                        continue;
                    };
                    planned_messages.insert(next.id.clone(), true);
                    plan.push(OpenCodeMutation::Message(next));
                }
                "message.removed" => {
                    let Some(message_id) = nonempty(data.get("messageID")) else {
                        continue;
                    };
                    planned_messages.insert(message_id.to_owned(), false);
                    plan.push(OpenCodeMutation::RemoveMessage(message_id.to_owned()));
                }
                "message.part.updated" => {
                    let Some(raw_part) = object(data.get("part")) else {
                        continue;
                    };
                    let Some(message_id) = nonempty(raw_part.get("messageID")) else {
                        continue;
                    };
                    let Some(next) = open_code_part(raw_part) else {
                        continue;
                    };
                    let exists = planned_messages
                        .get(message_id)
                        .copied()
                        .unwrap_or_else(|| self.message_indexes.contains_key(message_id));
                    if !exists {
                        return Err(OpenCodeTranscriptError::MissingMessage);
                    }
                    plan.push(OpenCodeMutation::Part {
                        message_id: message_id.to_owned(),
                        part: next,
                    });
                }
                "message.part.removed" => {
                    let Some(message_id) = nonempty(data.get("messageID")) else {
                        continue;
                    };
                    let Some(part_id) = nonempty(data.get("partID")) else {
                        continue;
                    };
                    plan.push(OpenCodeMutation::RemovePart {
                        message_id: message_id.to_owned(),
                        part_id: part_id.to_owned(),
                    });
                }
                _ => {}
            }
        }
        if cursor < remote_cursor {
            return Err(OpenCodeTranscriptError::IncompleteEvents);
        }
        let deltas = self.apply_open_code_plan(plan);
        let changed = !deltas.is_empty();
        self.cursor = Some(cursor);
        if changed {
            self.bump_revision();
        }
        Ok(changed.then_some(AgentTranscriptUpdate {
            revision: self.revision,
            deltas,
        }))
    }

    fn apply_open_code_plan(&mut self, plan: Vec<OpenCodeMutation>) -> Vec<AgentTranscriptDelta> {
        let mut deltas = Vec::new();
        let mut affected_turns = Vec::new();
        let mut structural = false;
        for mutation in plan {
            match mutation {
                OpenCodeMutation::Info(info) => {
                    if self.info.as_ref() != Some(&info) {
                        self.info = Some(info.clone());
                        deltas.push(AgentTranscriptDelta::InfoChanged { info: Some(info) });
                    }
                }
                OpenCodeMutation::Message(message) => {
                    if let Some(index) = self.message_indexes.get(&message.id).copied() {
                        let current = &mut self.messages[index];
                        debug_assert_eq!(current.id, message.id);
                        let structural_changed =
                            current.role != message.role || current.parent_id != message.parent_id;
                        if !structural_changed
                            && same_open_code_nonstructural_message_metadata(current, &message)
                        {
                            continue;
                        }

                        structural |= structural_changed;
                        current.role = message.role;
                        current.parent_id = message.parent_id;
                        current.created_at_ms = message.created_at_ms;
                        current.completed_at_ms = message.completed_at_ms;
                        current.error = message.error;
                        current.diffs = message.diffs;
                        let message = current.clone();
                        if let Some(turn) = self.message_turns.get(&message.id).copied() {
                            affected_turns.push(turn);
                        }
                        deltas.push(AgentTranscriptDelta::MessageUpserted {
                            index: u32::try_from(index).unwrap_or(u32::MAX),
                            message,
                        });
                    } else {
                        let index = self.messages.len();
                        self.message_indexes.insert(message.id.clone(), index);
                        self.messages.push(message.clone());
                        self.append_message_turn(index, &mut affected_turns);
                        deltas.push(AgentTranscriptDelta::MessageUpserted {
                            index: u32::try_from(index).unwrap_or(u32::MAX),
                            message,
                        });
                    }
                }
                OpenCodeMutation::RemoveMessage(message_id) => {
                    if let Some(index) = self.message_indexes.get(&message_id).copied() {
                        self.messages.remove(index);
                        deltas.push(AgentTranscriptDelta::MessageRemoved {
                            index: u32::try_from(index).unwrap_or(u32::MAX),
                            message_id,
                        });
                        structural = true;
                        self.rebuild_message_indexes();
                    }
                }
                OpenCodeMutation::Part { message_id, part } => {
                    let Some(index) = self.message_indexes.get(&message_id).copied() else {
                        continue;
                    };
                    let message = &mut self.messages[index];
                    if let Some(part_index) = message
                        .parts
                        .iter()
                        .position(|current| current.id() == part.id())
                    {
                        if message.parts[part_index] == part {
                            continue;
                        }
                        message.parts[part_index] = part;
                    } else {
                        message.parts.push(part);
                    }
                    if let Some(turn) = self.message_turns.get(&message_id).copied() {
                        affected_turns.push(turn);
                    }
                    deltas.push(AgentTranscriptDelta::MessageUpserted {
                        index: u32::try_from(index).unwrap_or(u32::MAX),
                        message: message.clone(),
                    });
                }
                OpenCodeMutation::RemovePart {
                    message_id,
                    part_id,
                } => {
                    let Some(index) = self.message_indexes.get(&message_id).copied() else {
                        continue;
                    };
                    let message = &mut self.messages[index];
                    let before = message.parts.len();
                    message.parts.retain(|part| part.id() != part_id);
                    if message.parts.len() == before {
                        continue;
                    }
                    if let Some(turn) = self.message_turns.get(&message_id).copied() {
                        affected_turns.push(turn);
                    }
                    deltas.push(AgentTranscriptDelta::MessageUpserted {
                        index: u32::try_from(index).unwrap_or(u32::MAX),
                        message: message.clone(),
                    });
                }
            }
        }
        if structural {
            self.rebuild_turns_with_deltas(&mut deltas);
        } else {
            affected_turns.sort_unstable();
            affected_turns.dedup();
            for index in affected_turns {
                self.recompute_turn(index);
                if let Some(turn) = self.turns.get(index) {
                    deltas.push(AgentTranscriptDelta::TurnUpserted {
                        index: u32::try_from(index).unwrap_or(u32::MAX),
                        turn: turn.clone(),
                    });
                }
            }
        }
        deltas
    }

    fn append_message_turn(&mut self, message_index: usize, affected_turns: &mut Vec<usize>) {
        let message = &self.messages[message_index];
        let turn_index = if message.role == AgentMessageRole::User {
            let index = self.turns.len();
            self.turns.push(AgentTranscriptTurn {
                id: message.id.clone(),
                user_message_id: Some(message.id.clone()),
                assistant_message_ids: Vec::new(),
                status: AgentTurnStatus::Idle,
                started_at_ms: message.created_at_ms,
                completed_at_ms: message.completed_at_ms,
                diffs: message.diffs.clone(),
            });
            self.turn_indexes.insert(message.id.clone(), index);
            index
        } else if let Some(index) = message
            .parent_id
            .as_ref()
            .and_then(|parent| self.turn_indexes.get(parent).copied())
            .or_else(|| self.turns.len().checked_sub(1))
        {
            self.turns[index]
                .assistant_message_ids
                .push(message.id.clone());
            index
        } else {
            let index = self.turns.len();
            let id = message
                .parent_id
                .clone()
                .unwrap_or_else(|| message.id.clone());
            self.turns.push(AgentTranscriptTurn {
                id: id.clone(),
                user_message_id: None,
                assistant_message_ids: vec![message.id.clone()],
                status: AgentTurnStatus::Idle,
                started_at_ms: message.created_at_ms,
                completed_at_ms: None,
                diffs: Vec::new(),
            });
            self.turn_indexes.insert(id, index);
            index
        };
        self.message_turns.insert(message.id.clone(), turn_index);
        affected_turns.push(turn_index);
    }

    fn recompute_turn(&mut self, index: usize) {
        let Some(turn) = self.turns.get_mut(index) else {
            return;
        };
        let user = turn
            .user_message_id
            .as_ref()
            .and_then(|id| self.message_indexes.get(id))
            .and_then(|index| self.messages.get(*index));
        turn.started_at_ms = user.and_then(|message| message.created_at_ms);
        turn.completed_at_ms = user.and_then(|message| message.completed_at_ms);
        turn.diffs = user
            .map(|message| message.diffs.clone())
            .unwrap_or_default();
        let mut running = false;
        let mut failed = false;
        for message_id in &turn.assistant_message_ids {
            let Some(message) = self
                .message_indexes
                .get(message_id)
                .and_then(|index| self.messages.get(*index))
            else {
                continue;
            };
            turn.started_at_ms = turn.started_at_ms.or(message.created_at_ms);
            if let Some(completed) = message.completed_at_ms {
                turn.completed_at_ms = Some(turn.completed_at_ms.unwrap_or(0).max(completed));
            }
            failed |= message.error.is_some();
            for diff in &message.diffs {
                if let Some(current) = turn
                    .diffs
                    .iter_mut()
                    .find(|current| current.file == diff.file)
                {
                    *current = diff.clone();
                } else {
                    turn.diffs.push(diff.clone());
                }
            }
            for part in &message.parts {
                if let AgentTranscriptPart::Tool { state, .. } = part {
                    running |= matches!(
                        state.status,
                        AgentToolStatus::Pending | AgentToolStatus::Running
                    );
                    failed |= state.status == AgentToolStatus::Error;
                    if let Some(completed) = state.completed_at_ms {
                        turn.completed_at_ms =
                            Some(turn.completed_at_ms.unwrap_or(0).max(completed));
                    }
                }
            }
        }
        turn.status = if failed {
            AgentTurnStatus::Error
        } else if running {
            AgentTurnStatus::Working
        } else {
            AgentTurnStatus::Idle
        };
    }

    fn rebuild_message_indexes(&mut self) {
        self.message_indexes = self
            .messages
            .iter()
            .enumerate()
            .map(|(index, message)| (message.id.clone(), index))
            .collect();
    }

    fn rebuild_indexes(&mut self) {
        self.rebuild_message_indexes();
        self.turn_indexes = self
            .turns
            .iter()
            .enumerate()
            .map(|(index, turn)| (turn.id.clone(), index))
            .collect();
        self.message_turns.clear();
        for (index, turn) in self.turns.iter().enumerate() {
            if let Some(id) = &turn.user_message_id {
                self.message_turns.insert(id.clone(), index);
            }
            for id in &turn.assistant_message_ids {
                self.message_turns.insert(id.clone(), index);
            }
        }
    }

    fn rebuild_turns_with_deltas(&mut self, deltas: &mut Vec<AgentTranscriptDelta>) {
        let next = project_turns(&self.messages);
        let first_changed = self
            .turns
            .iter()
            .zip(&next)
            .position(|(current, next)| current != next)
            .unwrap_or(self.turns.len().min(next.len()));
        let previous_len = self.turns.len();
        self.turns = next;
        self.rebuild_indexes();
        if first_changed < previous_len {
            deltas.push(AgentTranscriptDelta::TurnsTruncated {
                length: u32::try_from(first_changed).unwrap_or(u32::MAX),
            });
        }
        for (index, turn) in self.turns.iter().enumerate().skip(first_changed) {
            deltas.push(AgentTranscriptDelta::TurnUpserted {
                index: u32::try_from(index).unwrap_or(u32::MAX),
                turn: turn.clone(),
            });
        }
    }

    fn status_update(&self) -> AgentTranscriptUpdate {
        AgentTranscriptUpdate {
            revision: self.revision,
            deltas: vec![self.history_gate.status_delta()],
        }
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }
}

pub fn parse_open_code_cursor(value: &str) -> Result<u64, OpenCodeTranscriptError> {
    let value: Value =
        serde_json::from_str(value).map_err(|_| OpenCodeTranscriptError::InvalidCursor)?;
    value
        .as_array()
        .and_then(|rows| rows.first())
        .and_then(Value::as_object)
        .and_then(|row| open_code_u64(row.get("seq")))
        .ok_or(OpenCodeTranscriptError::InvalidCursor)
}

fn parse_open_code_export(
    value: &Value,
    expected_session_id: &str,
) -> Result<(AgentTranscriptInfo, Vec<AgentTranscriptMessage>), OpenCodeTranscriptError> {
    let export = value
        .as_object()
        .ok_or(OpenCodeTranscriptError::InvalidExport)?;
    let info = object(export.get("info")).ok_or(OpenCodeTranscriptError::InvalidExport)?;
    if nonempty(info.get("id")) != Some(expected_session_id) {
        return Err(OpenCodeTranscriptError::InvalidExport);
    }
    let messages = export
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(OpenCodeTranscriptError::InvalidExport)?
        .iter()
        .filter_map(|value| {
            let wrapper = value.as_object()?;
            let info = wrapper.get("info")?;
            let parts = wrapper
                .get("parts")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            open_code_message_from_parts(info, parts)
        })
        .collect();
    Ok((open_code_session_info(info), messages))
}

fn open_code_session_info(info: &Map<String, Value>) -> AgentTranscriptInfo {
    let time = object(info.get("time"));
    AgentTranscriptInfo {
        id: nonempty(info.get("id")).unwrap_or_default().to_owned(),
        title: nonempty(info.get("title")).map(str::to_owned),
        directory: nonempty(info.get("directory")).map(str::to_owned),
        created_at_ms: time.and_then(|time| timestamp_ms(time.get("created"))),
        updated_at_ms: time.and_then(|time| timestamp_ms(time.get("updated"))),
    }
}

fn open_code_message_from_parts(
    info: &Value,
    raw_parts: &[Value],
) -> Option<AgentTranscriptMessage> {
    let info = info.as_object()?;
    let id = nonempty(info.get("id"))?.to_owned();
    let role = match nonempty(info.get("role"))? {
        "user" => AgentMessageRole::User,
        "assistant" => AgentMessageRole::Assistant,
        _ => return None,
    };
    let time = object(info.get("time"));
    let summary = object(info.get("summary"));
    Some(AgentTranscriptMessage {
        id,
        role,
        parent_id: nonempty(info.get("parentID")).map(str::to_owned),
        created_at_ms: time.and_then(|time| timestamp_ms(time.get("created"))),
        completed_at_ms: time.and_then(|time| timestamp_ms(time.get("completed"))),
        error: info.get("error").and_then(|value| detail(Some(value))),
        parts: raw_parts
            .iter()
            .filter_map(Value::as_object)
            .filter_map(open_code_part)
            .collect(),
        diffs: summary
            .and_then(|summary| summary.get("diffs"))
            .map(open_code_diffs)
            .unwrap_or_default(),
    })
}

fn open_code_part(part: &Map<String, Value>) -> Option<AgentTranscriptPart> {
    if part.get("synthetic").and_then(Value::as_bool) == Some(true)
        || part.get("ignored").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let id = nonempty(part.get("id"))?.to_owned();
    let part_type = nonempty(part.get("type"))?;
    let time = object(part.get("time"));
    let at = time
        .and_then(|time| timestamp_ms(time.get("start")))
        .or_else(|| timestamp_ms(part.get("timestamp")));
    match part_type {
        "text" => Some(AgentTranscriptPart::Text {
            id,
            text: part
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            timestamp_ms: at,
        }),
        "reasoning" => Some(AgentTranscriptPart::Reasoning {
            id,
            text: part
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            timestamp_ms: at,
        }),
        "tool" => {
            let state = object(part.get("state"));
            let state_time = state.and_then(|state| object(state.get("time")));
            let tool = canonical_tool_name(nonempty(part.get("tool")).unwrap_or("tool"));
            if tool == "todowrite"
                && let Some(text) = open_code_todo_plan(state)
            {
                return Some(AgentTranscriptPart::Plan {
                    id,
                    text,
                    timestamp_ms: state_time
                        .and_then(|time| timestamp_ms(time.get("start")))
                        .or(at),
                });
            }
            let status = parse_tool_status(
                state.and_then(|state| state.get("status")),
                AgentToolStatus::Pending,
            );
            let metadata = state.and_then(|state| object(state.get("metadata")));
            let input = tool_input(&tool, state.and_then(|state| state.get("input")));
            Some(AgentTranscriptPart::Tool {
                call_id: nonempty(part.get("callID")).unwrap_or(&id).to_owned(),
                tool,
                timestamp_ms: state_time
                    .and_then(|time| timestamp_ms(time.get("start")))
                    .or(at),
                state: AgentToolState {
                    status,
                    input,
                    output: state.and_then(|state| detail(state.get("output"))),
                    error: state.and_then(|state| detail(state.get("error"))),
                    title: state
                        .and_then(|state| nonempty(state.get("title")))
                        .map(str::to_owned),
                    started_at_ms: state_time.and_then(|time| timestamp_ms(time.get("start"))),
                    completed_at_ms: state_time.and_then(|time| timestamp_ms(time.get("end"))),
                    exit_code: metadata
                        .and_then(|metadata| {
                            metadata
                                .get("exitCode")
                                .or_else(|| metadata.get("exit_code"))
                        })
                        .and_then(Value::as_i64),
                    files: open_code_tool_files(state),
                    diagnostics: open_code_tool_diagnostics(state),
                    loaded: metadata
                        .and_then(|metadata| metadata.get("loaded"))
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                },
                id,
            })
        }
        "subtask" => Some(AgentTranscriptPart::Plan {
            id,
            text: [
                nonempty(part.get("description")),
                nonempty(part.get("prompt")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n\n"),
            timestamp_ms: at,
        }),
        _ => None,
    }
}

fn open_code_todo_plan(state: Option<&Map<String, Value>>) -> Option<String> {
    let todos = state
        .and_then(|state| object(state.get("input")))
        .and_then(|input| input.get("todos"))
        .and_then(Value::as_array)
        .or_else(|| {
            state
                .and_then(|state| object(state.get("metadata")))
                .and_then(|metadata| metadata.get("todos"))
                .and_then(Value::as_array)
        })?;
    let lines = todos
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|todo| {
            let content = nonempty(todo.get("content"))?;
            let completed = nonempty(todo.get("status")) == Some("completed");
            Some(format!(
                "- [{}] {content}",
                if completed { "x" } else { " " }
            ))
        })
        .collect::<Vec<_>>();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn open_code_diffs(value: &Value) -> Vec<AgentFileDiff> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|diff| {
            Some(AgentFileDiff::normalized(
                ["file", "relativePath", "filePath", "path"]
                    .into_iter()
                    .find_map(|key| nonempty(diff.get(key)))?
                    .to_owned(),
                ["patch", "diff", "unifiedDiff"]
                    .into_iter()
                    .find_map(|key| nonempty(diff.get(key)))
                    .map(str::to_owned),
                nonempty(diff.get("before")).map(str::to_owned),
                nonempty(diff.get("after")).map(str::to_owned),
                diff.get("additions")
                    .and_then(Value::as_u64)
                    .and_then(|value| value.try_into().ok()),
                diff.get("deletions")
                    .and_then(Value::as_u64)
                    .and_then(|value| value.try_into().ok()),
            ))
        })
        .collect()
}

fn open_code_tool_files(state: Option<&Map<String, Value>>) -> Vec<AgentFileDiff> {
    let Some(state) = state else {
        return Vec::new();
    };
    let metadata = object(state.get("metadata"));
    if let Some(files) = metadata.and_then(|metadata| metadata.get("files")) {
        let files = open_code_diffs(files);
        if !files.is_empty() {
            return files;
        }
    }
    if let Some(diff) = metadata.and_then(|metadata| {
        nonempty(metadata.get("unifiedDiff")).or_else(|| nonempty(metadata.get("unified_diff")))
    }) {
        return unified_diff_files(Some(diff));
    }
    if let Some(diff) = metadata.and_then(|metadata| {
        object(metadata.get("filediff")).or_else(|| object(metadata.get("fileDiff")))
    }) {
        let mut diff = diff.clone();
        if ["file", "relativePath", "filePath", "path"]
            .into_iter()
            .all(|key| nonempty(diff.get(key)).is_none())
        {
            diff.insert("file".to_owned(), Value::String("Changes".to_owned()));
        }
        let files = open_code_diffs(&Value::Array(vec![Value::Object(diff)]));
        if !files.is_empty() {
            return files;
        }
    }
    state
        .get("input")
        .and_then(Value::as_object)
        .map(|input| legacy_change_files(input.get("changes")))
        .unwrap_or_default()
}

fn open_code_tool_diagnostics(state: Option<&Map<String, Value>>) -> Vec<AgentToolDiagnostic> {
    let diagnostics = state
        .and_then(|state| {
            object(state.get("metadata"))
                .and_then(|metadata| metadata.get("diagnostics"))
                .or_else(|| state.get("diagnostics"))
        })
        .and_then(Value::as_object);
    let Some(diagnostics) = diagnostics else {
        return Vec::new();
    };
    diagnostics
        .iter()
        .flat_map(|(file, entries)| {
            entries
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|entry| open_code_diagnostic(file, entry))
        })
        .collect()
}

fn open_code_diagnostic(file: &str, value: &Value) -> Option<AgentToolDiagnostic> {
    let value = value.as_object()?;
    let start = object(value.get("range")).and_then(|range| object(range.get("start")));
    let one_based = |value: Option<&Value>| {
        value
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .map(|value| value.saturating_add(1))
    };
    let severity = match value.get("severity") {
        Some(Value::Number(value)) if value.as_u64() == Some(2) => AgentDiagnosticSeverity::Warning,
        Some(Value::Number(value)) if value.as_u64() == Some(3) => AgentDiagnosticSeverity::Info,
        Some(Value::Number(value)) if value.as_u64() == Some(4) => AgentDiagnosticSeverity::Hint,
        Some(Value::String(value)) if value.eq_ignore_ascii_case("warning") => {
            AgentDiagnosticSeverity::Warning
        }
        Some(Value::String(value)) if value.eq_ignore_ascii_case("info") => {
            AgentDiagnosticSeverity::Info
        }
        Some(Value::String(value)) if value.eq_ignore_ascii_case("hint") => {
            AgentDiagnosticSeverity::Hint
        }
        _ => AgentDiagnosticSeverity::Error,
    };
    Some(AgentToolDiagnostic {
        file: file.to_owned(),
        line: one_based(start.and_then(|start| start.get("line"))),
        column: one_based(start.and_then(|start| start.get("character"))),
        message: nonempty(value.get("message"))?.to_owned(),
        severity,
    })
}

fn decoded_open_code_object(value: Option<&Value>) -> Option<Map<String, Value>> {
    match value? {
        Value::Object(value) => Some(value.clone()),
        Value::String(value) => serde_json::from_str::<Value>(value)
            .ok()?
            .as_object()
            .cloned(),
        _ => None,
    }
}

fn strip_open_code_event_version(value: &str) -> &str {
    let Some((prefix, suffix)) = value.rsplit_once('.') else {
        return value;
    };
    if suffix.chars().all(|character| character.is_ascii_digit()) {
        prefix
    } else {
        value
    }
}

fn open_code_u64(value: Option<&Value>) -> Option<u64> {
    value?
        .as_u64()
        .or_else(|| value?.as_i64().and_then(|value| u64::try_from(value).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_parts(state: &AgentTranscriptState, role: AgentMessageRole) -> Vec<String> {
        state
            .messages
            .iter()
            .filter(|message| message.role == role)
            .flat_map(|message| message.parts.iter())
            .filter_map(|part| match part {
                AgentTranscriptPart::Text { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    fn open_code_message_test_core() -> OpenCodeSessionCore {
        let export = serde_json::json!({
            "info": { "id": "ses_messages" },
            "messages": [
                {
                    "info": { "id": "user-1", "role": "user", "time": { "created": 1_u64 } },
                    "parts": [{ "id": "prompt-1", "type": "text", "text": "First" }]
                },
                {
                    "info": { "id": "user-2", "role": "user", "time": { "created": 3_u64 } },
                    "parts": [{ "id": "prompt-2", "type": "text", "text": "Second" }]
                },
                {
                    "info": {
                        "id": "assistant", "role": "assistant", "parentID": "user-1",
                        "time": { "created": 2_u64 }
                    },
                    "parts": [{ "id": "answer", "type": "text", "text": "Original" }]
                }
            ]
        });
        let mut core = OpenCodeSessionCore::new("ses_messages");
        core.bootstrap(0, &export.to_string()).unwrap();
        core
    }

    fn open_code_message_updated_event(sequence: u64, info: Value) -> String {
        serde_json::json!([{
            "seq": sequence,
            "type": "message.updated.1",
            "data": { "info": info }
        }])
        .to_string()
    }

    #[test]
    fn file_diff_normalization_fills_counts_per_file() {
        let diffs = open_code_diffs(&serde_json::json!([
            {
                "file": "explicit.rs",
                "patch": "@@ -1 +1 @@\n-old\n+new\n",
                "additions": 2
            },
            {
                "file": "patch.rs",
                "patch": "@@ -0,0 +1,5 @@\n+one\n+two\n+three\n+four\n+five\n"
            }
        ]));

        assert_eq!(diffs.len(), 2);
        assert_eq!((diffs[0].additions, diffs[0].deletions), (2, 1));
        assert_eq!((diffs[1].additions, diffs[1].deletions), (5, 0));
        assert_eq!(diffs.iter().map(|diff| diff.additions).sum::<u32>(), 7);
    }

    #[test]
    fn deserialized_file_diffs_normalize_legacy_missing_counts() {
        let diff: AgentFileDiff = serde_json::from_value(serde_json::json!({
            "file": "cached.rs",
            "patch": "@@ -1 +1,2 @@\n-old\n+new\n+more\n",
            "additions": 9
        }))
        .unwrap();

        assert_eq!((diff.additions, diff.deletions), (9, 1));
    }

    #[test]
    fn open_code_tools_normalize_input_files_diagnostics_and_loaded_paths() {
        let value = serde_json::json!({
            "id": "tool-1",
            "type": "tool",
            "tool": "apply_patch",
            "state": {
                "status": "completed",
                "input": { "filePath": "src/main.rs" },
                "metadata": {
                    "files": [{
                        "relativePath": "src/main.rs",
                        "diff": "@@ -1 +1 @@\n-old\n+new\n"
                    }],
                    "diagnostics": {
                        "src/main.rs": [{
                            "severity": 1,
                            "message": "expected `;`",
                            "range": { "start": { "line": 4, "character": 8 } }
                        }]
                    },
                    "loaded": ["AGENTS.md"]
                }
            }
        });
        let AgentTranscriptPart::Tool { tool, state, .. } =
            open_code_part(value.as_object().unwrap()).unwrap()
        else {
            panic!("expected a tool part");
        };

        assert_eq!(tool, "patch");
        assert_eq!(state.input, fields([("path", "src/main.rs".to_owned())]));
        assert_eq!(state.files.len(), 1);
        assert_eq!(state.files[0].file, "src/main.rs");
        assert_eq!((state.files[0].additions, state.files[0].deletions), (1, 1));
        assert_eq!(
            state.diagnostics,
            [AgentToolDiagnostic {
                file: "src/main.rs".to_owned(),
                line: Some(5),
                column: Some(9),
                message: "expected `;`".to_owned(),
                severity: AgentDiagnosticSeverity::Error,
            }]
        );
        assert_eq!(state.loaded, ["AGENTS.md"]);
    }

    #[test]
    fn opencode_export_and_events_are_projected_incrementally() {
        let export = serde_json::json!({
            "info": {
                "id": "ses_abc123", "title": "Fix chat view", "directory": "/repo",
                "time": { "created": 1_700_000_000_000_u64, "updated": 1_700_000_001_000_u64 }
            },
            "messages": [
                {
                    "info": { "id": "msg_user", "role": "user", "time": { "created": 1_u64 } },
                    "parts": [
                        { "id": "hidden", "type": "text", "text": "context", "synthetic": true },
                        { "id": "prompt", "type": "text", "text": "Fix it" }
                    ]
                },
                {
                    "info": { "id": "msg_assistant", "role": "assistant", "parentID": "msg_user", "time": { "created": 2_u64 } },
                    "parts": [
                        { "id": "reasoning", "type": "reasoning", "text": "Inspecting." },
                        { "id": "tool", "type": "tool", "callID": "call_1", "tool": "bash",
                          "state": { "status": "completed", "input": { "command": "npm test" }, "output": "ok" } }
                    ]
                }
            ]
        });
        let mut core = OpenCodeSessionCore::new("ses_abc123");
        core.begin_sync_generation();
        core.bootstrap(7, &export.to_string()).unwrap();
        assert!(core.mark_live());
        let state = core.state();
        assert_eq!(state.agent, AgentTranscriptKind::OpenCode);
        assert_eq!(
            state.info.as_ref().unwrap().directory.as_deref(),
            Some("/repo")
        );
        assert_eq!(text_parts(&state, AgentMessageRole::User), ["Fix it"]);
        assert_eq!(state.turns.len(), 1);

        let events = serde_json::json!([
            {
                "seq": 8_u64, "type": "message.part.updated.1",
                "data": serde_json::json!({
                    "part": { "id": "tool", "messageID": "msg_assistant", "type": "tool",
                              "callID": "call_1", "tool": "bash",
                              "state": { "status": "error", "input": { "command": "npm test" }, "error": "failed" } }
                }).to_string()
            },
            {
                "seq": 9_u64, "type": "message.part.removed.1",
                "data": { "messageID": "msg_assistant", "partID": "reasoning" }
            }
        ]);
        let update = core
            .apply_events_incremental(9, &events.to_string())
            .unwrap()
            .expect("tool update is visible");
        assert!(update.deltas.iter().all(|delta| match delta {
            AgentTranscriptDelta::MessageUpserted { message, .. } => {
                message.id == "msg_assistant"
            }
            AgentTranscriptDelta::TurnUpserted { turn, .. } => turn.id == "msg_user",
            _ => false,
        }));
        let state = core.state();
        assert_eq!(core.cursor(), Some(9));
        assert_eq!(state.turns[0].status, AgentTurnStatus::Error);
        assert!(
            !state.messages[1]
                .parts
                .iter()
                .any(|part| part.id() == "reasoning")
        );
    }

    #[test]
    fn opencode_identical_message_metadata_is_a_noop() {
        let mut core = open_code_message_test_core();
        let before = core.state();
        let revision = core.revision();
        let parts_ptr = core.messages[2].parts.as_ptr();
        let events = open_code_message_updated_event(
            1,
            serde_json::json!({
                "id": "assistant", "role": "assistant", "parentID": "user-1",
                "time": { "created": 2_u64 }
            }),
        );

        assert!(core.apply_events_incremental(1, &events).unwrap().is_none());
        assert_eq!(core.revision(), revision);
        assert_eq!(core.state(), before);
        assert_eq!(core.messages[2].parts.as_ptr(), parts_ptr);
    }

    #[test]
    fn opencode_message_metadata_update_preserves_existing_parts() {
        let mut core = open_code_message_test_core();
        let before = core.messages[2].clone();
        let parts_ptr = core.messages[2].parts.as_ptr();
        let events = open_code_message_updated_event(
            1,
            serde_json::json!({
                "id": "assistant", "role": "assistant", "parentID": "user-1",
                "time": { "created": 2_u64, "completed": 20_u64 }
            }),
        );

        let update = core
            .apply_events_incremental(1, &events)
            .unwrap()
            .expect("completion metadata changes the message");
        assert_eq!(update.deltas.len(), 2);
        assert!(matches!(
            &update.deltas[0],
            AgentTranscriptDelta::MessageUpserted { index: 2, message }
                if message.completed_at_ms == Some(20) && message.parts == before.parts
        ));
        assert!(matches!(
            &update.deltas[1],
            AgentTranscriptDelta::TurnUpserted { index: 0, turn }
                if turn.id == "user-1" && turn.completed_at_ms == Some(20)
        ));

        let current = &core.messages[2];
        assert_eq!(current.id, before.id);
        assert_eq!(current.role, before.role);
        assert_eq!(current.parent_id, before.parent_id);
        assert_eq!(current.created_at_ms, before.created_at_ms);
        assert_eq!(current.completed_at_ms, Some(20));
        assert_eq!(current.error, before.error);
        assert_eq!(current.diffs, before.diffs);
        assert_eq!(current.parts, before.parts);
        assert_eq!(current.parts.as_ptr(), parts_ptr);
    }

    #[test]
    fn opencode_parent_change_rebuilds_turns_and_indexes() {
        let mut core = open_code_message_test_core();
        let parts_ptr = core.messages[2].parts.as_ptr();
        let events = open_code_message_updated_event(
            1,
            serde_json::json!({
                "id": "assistant", "role": "assistant", "parentID": "user-2",
                "time": { "created": 2_u64 }
            }),
        );

        let update = core
            .apply_events_incremental(1, &events)
            .unwrap()
            .expect("parent metadata changes the turn structure");
        assert_eq!(update.deltas.len(), 4);
        assert!(matches!(
            &update.deltas[0],
            AgentTranscriptDelta::MessageUpserted { index: 2, message }
                if message.parent_id.as_deref() == Some("user-2")
        ));
        assert!(matches!(
            &update.deltas[1],
            AgentTranscriptDelta::TurnsTruncated { length: 0 }
        ));
        assert_eq!(core.turns[0].assistant_message_ids, Vec::<String>::new());
        assert_eq!(core.turns[1].assistant_message_ids, ["assistant"]);
        assert_eq!(core.message_indexes.get("assistant"), Some(&2));
        assert_eq!(core.message_turns.get("assistant"), Some(&1));
        assert_eq!(core.messages[2].parts.as_ptr(), parts_ptr);
    }

    #[test]
    fn opencode_part_update_still_replaces_the_matching_part() {
        let mut core = open_code_message_test_core();
        let events = serde_json::json!([{
            "seq": 1_u64,
            "type": "message.part.updated.1",
            "data": {
                "part": {
                    "id": "answer", "messageID": "assistant",
                    "type": "text", "text": "Updated"
                }
            }
        }]);

        let update = core
            .apply_events_incremental(1, &events.to_string())
            .unwrap()
            .expect("part text changes the message");
        assert_eq!(update.deltas.len(), 2);
        assert!(matches!(
            &update.deltas[0],
            AgentTranscriptDelta::MessageUpserted { index: 2, message }
                if message.parts.len() == 1
                    && matches!(&message.parts[0], AgentTranscriptPart::Text { id, text, .. }
                        if id == "answer" && text == "Updated")
        ));
        assert!(matches!(
            &update.deltas[1],
            AgentTranscriptDelta::TurnUpserted { index: 0, turn }
                if turn.id == "user-1"
        ));
        assert_eq!(core.messages[2].parts.len(), 1);
        assert!(matches!(
            &core.messages[2].parts[0],
            AgentTranscriptPart::Text { id, text, .. }
                if id == "answer" && text == "Updated"
        ));
    }

    #[test]
    fn opencode_todowrite_is_projected_as_a_task_plan() {
        let raw = serde_json::json!({
            "id": "todo-part",
            "type": "tool",
            "callID": "todo-call",
            "tool": "todowrite",
            "state": {
                "status": "completed",
                "input": {
                    "todos": [
                        { "content": "Inspect the parser", "status": "completed", "priority": "high" },
                        { "content": "Render the task list", "status": "in_progress", "priority": "high" },
                        { "content": "Run the tests", "status": "pending", "priority": "medium" }
                    ]
                },
                "time": { "start": 1_700_000_000_000_u64 }
            }
        });
        assert_eq!(
            open_code_part(raw.as_object().unwrap()),
            Some(AgentTranscriptPart::Plan {
                id: "todo-part".to_owned(),
                text: concat!(
                    "- [x] Inspect the parser\n",
                    "- [ ] Render the task list\n",
                    "- [ ] Run the tests"
                )
                .to_owned(),
                timestamp_ms: Some(1_700_000_000_000),
            })
        );

        let pending = serde_json::json!({
            "id": "todo-pending",
            "type": "tool",
            "callID": "todo-pending-call",
            "tool": "todowrite",
            "state": { "status": "pending", "input": {} }
        });
        assert!(matches!(
            open_code_part(pending.as_object().unwrap()),
            Some(AgentTranscriptPart::Tool { tool, .. }) if tool == "todowrite"
        ));
    }

    #[test]
    fn opencode_cache_restores_cursor_and_rejects_divergence() {
        let export = serde_json::json!({
            "info": { "id": "ses_cache" },
            "messages": [{
                "info": { "id": "user", "role": "user" },
                "parts": [{ "id": "text", "type": "text", "text": "cached" }]
            }]
        });
        let mut core = OpenCodeSessionCore::new("ses_cache");
        let generation = core.begin_sync_generation();
        core.bootstrap(4, &export.to_string()).unwrap();
        core.mark_live();
        let blob = core.cache_blob().unwrap();
        assert!(core.confirm_cache(generation, 4));
        let cached: Value = serde_json::from_slice(&blob).unwrap();
        assert_eq!(
            cached.get("schema_version").and_then(Value::as_u64),
            Some(u64::from(OPENCODE_CACHE_SCHEMA_VERSION))
        );

        let mut legacy = cached;
        legacy["schema_version"] = serde_json::json!(1);
        assert!(matches!(
            OpenCodeSessionCore::new("ses_cache")
                .restore_cache(&serde_json::to_vec(&legacy).unwrap()),
            Err(AgentCacheError::Malformed(_))
        ));

        let mut restored = OpenCodeSessionCore::new("ses_cache");
        let state = restored.restore_cache(&blob).unwrap();
        assert_eq!(state.status, AgentTranscriptStatus::Loading);
        assert_eq!(restored.cursor(), Some(4));
        assert_eq!(text_parts(&state, AgentMessageRole::User), ["cached"]);
        assert_eq!(
            restored.apply_events(3, "[]").unwrap_err(),
            OpenCodeTranscriptError::CursorDiverged
        );
    }

    #[test]
    fn restored_history_waits_for_the_complete_opening_event_batch() {
        let original = open_code_message_test_core();
        let mut core = OpenCodeSessionCore::new("ses_messages");
        core.restore_cache(&original.cache_blob().unwrap()).unwrap();
        core.begin_sync_generation();
        core.mark_restarting_update("Opening OpenCode transcript");
        assert_eq!(core.state().status, AgentTranscriptStatus::Loading);

        let events = serde_json::json!([
            { "seq": 1, "type": "session.updated.1",
              "data": { "info": { "id": "ses_messages", "title": "early" } } },
            { "seq": 2, "type": "session.updated.1",
              "data": { "info": { "id": "ses_messages", "title": "at opening" } } }
        ]);
        let before = core.state();
        assert_eq!(
            core.apply_events_incremental(2, &serde_json::json!([events[0]]).to_string())
                .unwrap_err(),
            OpenCodeTranscriptError::IncompleteEvents
        );
        assert_eq!(core.state(), before);
        assert_eq!(
            core.mark_stale("incomplete sync").status,
            AgentTranscriptStatus::Error
        );
        core.mark_restarting_update("retrying");
        assert_eq!(core.state().status, AgentTranscriptStatus::Loading);
        assert_eq!(
            core.mark_unavailable("export unavailable").status,
            AgentTranscriptStatus::Unavailable
        );
        core.mark_restarting_update("retrying");

        let update = core
            .apply_events_incremental(2, &events.to_string())
            .unwrap();
        assert_eq!(core.state().status, AgentTranscriptStatus::Loading);
        let revision = core.revision();
        let update = core.finish_live_update(update).unwrap();
        assert_eq!(update.revision, revision);
        assert_eq!(core.state().status, AgentTranscriptStatus::Live);
        assert_eq!(
            core.state().info.unwrap().title.as_deref(),
            Some("at opening")
        );
        assert!(update.deltas.iter().any(|delta| matches!(
            delta,
            AgentTranscriptDelta::StatusChanged {
                status: AgentTranscriptStatus::Live,
                ..
            }
        )));

        // A later event is applied after opening without another loading gate.
        let incoming = serde_json::json!([
            { "seq": 3, "type": "session.updated.1",
              "data": { "info": { "id": "ses_messages", "title": "new message" } } }
        ]);
        let update = core
            .apply_events_incremental(3, &incoming.to_string())
            .unwrap();
        core.finish_live_update(update);
        assert_eq!(core.state().status, AgentTranscriptStatus::Live);
        assert_eq!(core.cursor(), Some(3));
        assert_eq!(
            core.mark_stale("disconnected after opening").status,
            AgentTranscriptStatus::Stale
        );
    }

    #[test]
    fn unchanged_cached_history_becomes_live_after_remote_cursor_verification() {
        let original = open_code_message_test_core();
        let mut core = OpenCodeSessionCore::new("ses_messages");
        core.restore_cache(&original.cache_blob().unwrap()).unwrap();
        assert_eq!(core.state().status, AgentTranscriptStatus::Loading);
        assert_eq!(core.cursor(), original.cursor());
        // The manager calls this only after comparing the remote and local cursors.
        assert!(core.mark_live_update().is_some());
        assert_eq!(core.state().status, AgentTranscriptStatus::Live);
        assert_eq!(core.state().messages, original.state().messages);
        assert_eq!(
            core.mark_stale("disconnected").status,
            AgentTranscriptStatus::Stale
        );
    }

    #[test]
    fn empty_history_waits_for_a_successful_export() {
        let mut core = OpenCodeSessionCore::new("ses_empty");
        assert!(core.mark_live_update().is_none());
        assert!(core.finish_live_update(None).is_none());
        assert_eq!(core.state().status, AgentTranscriptStatus::Loading);
        let export = serde_json::json!({"info": {"id": "ses_empty"}, "messages": []});
        let update = core.bootstrap_update(0, &export.to_string()).unwrap();
        assert_eq!(core.state().status, AgentTranscriptStatus::Loading);
        assert!(core.finish_live_update(update).is_some());
        assert_eq!(core.state().status, AgentTranscriptStatus::Live);
        assert!(core.state().turns.is_empty());
    }

    #[test]
    fn opencode_small_event_on_one_thousand_messages_stays_small() {
        let messages = (0..1_000)
            .map(|index| {
                serde_json::json!({
                    "info": { "id": format!("message-{index}"), "role": "user" },
                    "parts": []
                })
            })
            .collect::<Vec<_>>();
        let export = serde_json::json!({
            "info": { "id": "ses_scale" },
            "messages": messages
        });
        let mut core = OpenCodeSessionCore::new("ses_scale");
        core.bootstrap(0, &export.to_string()).unwrap();
        let events = serde_json::json!([{
            "seq": 1_u64,
            "type": "message.part.updated.1",
            "data": {
                "part": {
                    "id": "part-999", "messageID": "message-999",
                    "type": "text", "text": "incremental"
                }
            }
        }]);

        let update = core
            .apply_events_incremental(1, &events.to_string())
            .unwrap()
            .expect("part update changes state");
        assert_eq!(update.deltas.len(), 2);
        assert!(matches!(
            &update.deltas[0],
            AgentTranscriptDelta::MessageUpserted { index: 999, message }
                if message.id == "message-999" && message.parts.len() == 1
        ));
        assert!(matches!(
            &update.deltas[1],
            AgentTranscriptDelta::TurnUpserted { index: 999, turn }
                if turn.id == "message-999"
        ));
        assert_eq!(core.messages.len(), 1_000);
        assert_eq!(core.turns.len(), 1_000);
    }

    #[test]
    fn opencode_invalid_batch_is_atomic_without_a_history_clone() {
        let export = serde_json::json!({
            "info": { "id": "ses_atomic" },
            "messages": [{
                "info": { "id": "message", "role": "assistant" },
                "parts": []
            }]
        });
        let mut core = OpenCodeSessionCore::new("ses_atomic");
        core.bootstrap(0, &export.to_string()).unwrap();
        let events = serde_json::json!([
            {
                "seq": 1_u64, "type": "message.part.updated.1",
                "data": { "part": {
                    "id": "would-apply", "messageID": "message",
                    "type": "text", "text": "partial mutation"
                }}
            },
            {
                "seq": 2_u64, "type": "message.part.updated.1",
                "data": { "part": {
                    "id": "invalid", "messageID": "missing",
                    "type": "text", "text": "invalid reference"
                }}
            }
        ]);

        assert_eq!(
            core.apply_events_incremental(2, &events.to_string())
                .unwrap_err(),
            OpenCodeTranscriptError::MissingMessage
        );
        assert_eq!(core.cursor(), Some(0));
        assert!(core.messages[0].parts.is_empty());
    }
}
