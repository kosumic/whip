//! Shared lifecycle and normalized checkpoints for tree-based JSONL sessions.
use super::history_gate::{InitialHistoryGate, advance_revision};
use super::jsonl::{
    FileBindResult, FileIngestResult, FileSourceCursor, FileSourceIdentity, TranscriptParseError,
};
use super::model::{
    AgentCacheError, AgentTranscriptDelta, AgentTranscriptKind, AgentTranscriptState,
    AgentTranscriptStatus, AgentTranscriptUpdate,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

pub trait JsonlTranscriptAdapter: Clone + std::fmt::Debug + Serialize + DeserializeOwned {
    const AGENT: AgentTranscriptKind;
    const CACHE_VERSION: u32;
    fn new(session_id: impl Into<String>) -> Self;
    fn session_id(&self) -> &str;
    fn accept(&mut self, record: &Value, order: u64);
    fn snapshot(
        &self,
        revision: u64,
        status: AgentTranscriptStatus,
        error: Option<String>,
    ) -> AgentTranscriptState;
    fn restore(&mut self, offset: u64) -> Result<(), AgentCacheError>;
    fn supports_cache(version: u32) -> bool {
        version == Self::CACHE_VERSION
    }
}

#[derive(Serialize, Deserialize)]
pub(super) struct JsonlCheckpoint<A> {
    pub(super) schema_version: u32,
    pub(super) agent: AgentTranscriptKind,
    pub(super) source: Option<FileSourceIdentity>,
    pub(super) offset: u64,
    pub(super) revision: u64,
    pub(super) adapter: A,
}

#[derive(Clone, Debug)]
pub struct JsonlSessionCore<A> {
    pub(super) adapter: A,
    cursor: FileSourceCursor,
    history_gate: InitialHistoryGate,
    revision: u64,
}

impl<A: JsonlTranscriptAdapter> JsonlSessionCore<A> {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            adapter: A::new(session_id),
            cursor: FileSourceCursor::default(),
            history_gate: InitialHistoryGate::default(),
            revision: 0,
        }
    }
    pub fn status(&self) -> AgentTranscriptStatus {
        self.history_gate.status()
    }
    pub fn state(&self) -> AgentTranscriptState {
        self.adapter.snapshot(
            self.revision,
            self.status(),
            self.history_gate.error().map(str::to_owned),
        )
    }
    pub fn source_generation(&self) -> u64 {
        self.cursor.generation
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn committed_offset(&self) -> u64 {
        self.cursor.committed
    }
    pub fn committable_offset(&self) -> u64 {
        self.cursor.framer.committable_offset()
    }
    pub fn received_offset(&self) -> u64 {
        self.cursor.framer.received_offset()
    }
    pub fn invalidate_source(&mut self) {
        self.cursor.source = None;
    }
    pub fn initial_history_caught_up(&self) -> bool {
        self.cursor.caught_up()
    }
    pub fn confirm_cache(&mut self, generation: u64, offset: u64) -> bool {
        self.cursor.confirm(generation, offset)
    }
    pub fn mark_stale_update(&mut self, reason: impl Into<String>) -> AgentTranscriptUpdate {
        self.history_gate.mark_stale(reason);
        self.history_gate.next_status_update(&mut self.revision)
    }
    pub fn mark_restarting_update(&mut self, reason: impl Into<String>) -> AgentTranscriptUpdate {
        self.history_gate.restart(reason);
        self.history_gate.next_status_update(&mut self.revision)
    }
    pub fn mark_unavailable_update(&mut self, reason: impl Into<String>) -> AgentTranscriptUpdate {
        self.history_gate.mark_unavailable(reason);
        self.history_gate.next_status_update(&mut self.revision)
    }
    pub fn close_update(&mut self) -> AgentTranscriptUpdate {
        self.cursor.generation = self.cursor.generation.saturating_add(1);
        self.history_gate.close();
        self.history_gate.next_status_update(&mut self.revision)
    }
    pub fn mark_live_update(&mut self) -> Option<AgentTranscriptUpdate> {
        (self.cursor.caught_up() && self.history_gate.complete_revision(&mut self.revision))
            .then(|| self.history_gate.status_update(self.revision))
    }
    pub fn bind_source(&mut self, path: String, file_id: String, size: u64) -> FileBindResult {
        let binding = self
            .cursor
            .bind(self.adapter.session_id(), path, file_id, size);
        if binding.rebuilt {
            self.adapter = A::new(self.adapter.session_id().to_owned());
            advance_revision(&mut self.revision);
        }
        self.history_gate.reset();
        binding
    }
    pub fn ingest(
        &mut self,
        generation: u64,
        bytes: &[u8],
    ) -> Result<FileIngestResult, TranscriptParseError> {
        let mut malformed_records = 0;
        let mut update = None;
        if generation == self.cursor.generation {
            let before = self.state();
            for line in self.cursor.framer.push(bytes)? {
                match line.parsed {
                    Ok(value) => self.adapter.accept(&value, line.end_offset),
                    Err(_) => malformed_records += 1,
                }
                // File adapters tolerate malformed complete rows. Their physical byte
                // boundaries are safe to checkpoint, unlike partial tails.
                self.cursor.framer.commit_complete_line(line.end_offset);
            }
            if self.cursor.caught_up() {
                self.history_gate.complete();
            }
            let after = self.state();
            let deltas = projection_delta(&before, &after);
            if !deltas.is_empty() {
                advance_revision(&mut self.revision);
                update = Some(AgentTranscriptUpdate {
                    revision: self.revision,
                    deltas,
                });
            }
        }
        Ok(FileIngestResult {
            source_generation: generation,
            received_offset: self.received_offset(),
            committable_offset: self.committable_offset(),
            malformed_records,
            changed: update.is_some(),
            update,
        })
    }
    pub fn cache_blob(&self) -> Result<Vec<u8>, AgentCacheError> {
        serde_json::to_vec(&JsonlCheckpoint {
            schema_version: A::CACHE_VERSION,
            agent: A::AGENT,
            source: self.cursor.source.clone(),
            offset: self.committable_offset(),
            revision: self.revision,
            adapter: self.adapter.clone(),
        })
        .map_err(|error| AgentCacheError::Malformed(error.to_string()))
    }
    pub fn restore_cache(&mut self, bytes: &[u8]) -> Result<AgentTranscriptState, AgentCacheError> {
        let mut cached: JsonlCheckpoint<A> = serde_json::from_slice(bytes)
            .map_err(|error| AgentCacheError::Malformed(error.to_string()))?;
        if !A::supports_cache(cached.schema_version) || cached.agent != A::AGENT {
            return Err(AgentCacheError::Malformed(
                "unsupported JSONL transcript cache".into(),
            ));
        }
        if cached.adapter.session_id() != self.adapter.session_id()
            || cached
                .source
                .as_ref()
                .is_some_and(|s| s.requested_session_id != self.adapter.session_id())
        {
            return Err(AgentCacheError::SessionMismatch);
        }
        cached.adapter.restore(cached.offset)?;
        self.adapter = cached.adapter;
        // Older checkpoints remain readable offline; rebind their source to recover
        // metadata absent from the earlier normalized representation.
        self.cursor.source = if cached.schema_version < A::CACHE_VERSION {
            None
        } else {
            cached.source
        };
        self.cursor.committed = cached.offset;
        self.cursor.framer.reset(cached.offset);
        self.cursor.initial_history_end = None;
        self.revision = cached.revision.saturating_add(1);
        self.history_gate.reset();
        Ok(self.state())
    }
}

pub(super) fn projection_delta(
    before: &AgentTranscriptState,
    after: &AgentTranscriptState,
) -> Vec<AgentTranscriptDelta> {
    let mut deltas = Vec::new();
    let messages_kept = before
        .messages
        .iter()
        .zip(&after.messages)
        .take_while(|(a, b)| a.id == b.id)
        .count();
    let turns_kept = before
        .turns
        .iter()
        .zip(&after.turns)
        .take_while(|(a, b)| a.id == b.id)
        .count();
    if messages_kept < before.messages.len() {
        deltas.push(AgentTranscriptDelta::MessagesTruncated {
            length: u32::try_from(messages_kept).unwrap_or(u32::MAX),
        });
    }
    if turns_kept < before.turns.len() {
        deltas.push(AgentTranscriptDelta::TurnsTruncated {
            length: u32::try_from(turns_kept).unwrap_or(u32::MAX),
        });
    }
    if before.info != after.info {
        deltas.push(AgentTranscriptDelta::InfoChanged {
            info: after.info.clone(),
        });
    }
    for (index, message) in after.messages.iter().enumerate() {
        if index >= messages_kept || before.messages.get(index) != Some(message) {
            deltas.push(AgentTranscriptDelta::MessageUpserted {
                index: u32::try_from(index).unwrap_or(u32::MAX),
                message: message.clone(),
            });
        }
    }
    for (index, turn) in after.turns.iter().enumerate() {
        if index >= turns_kept || before.turns.get(index) != Some(turn) {
            deltas.push(AgentTranscriptDelta::TurnUpserted {
                index: u32::try_from(index).unwrap_or(u32::MAX),
                turn: turn.clone(),
            });
        }
    }
    if before.status != after.status || before.error != after.error {
        deltas.push(AgentTranscriptDelta::StatusChanged {
            status: after.status,
            error: after.error.clone(),
        });
    }
    deltas
}
