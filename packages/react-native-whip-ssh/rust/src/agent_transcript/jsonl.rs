//! Shared byte framing and source cursors for file-backed agent transcripts.

use super::model::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_TRANSCRIPT_LINE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileSourceIdentity {
    pub requested_session_id: String,
    pub rollout_path: String,
    pub file_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FramedLine {
    pub raw_line: String,
    pub end_offset: u64,
    pub parsed: Result<Value, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TranscriptParseError {
    #[error("transcript record exceeded {MAX_TRANSCRIPT_LINE_BYTES} bytes")]
    LineTooLarge,
    #[error("transcript contained invalid UTF-8")]
    InvalidUtf8,
}

/// Incremental byte-oriented JSONL framer. Its committed cursor never includes
/// an incomplete physical line. Malformed lines require an explicit consumer
/// decision to skip before their boundaries can be committed.
#[derive(Clone, Debug, Default)]
pub struct TranscriptJsonlFramer {
    buffer: Vec<u8>,
    received_offset: u64,
    committable_offset: u64,
    discarding_oversized_line: bool,
}

impl TranscriptJsonlFramer {
    pub fn with_offset(offset: u64) -> Self {
        Self {
            buffer: Vec::new(),
            received_offset: offset,
            committable_offset: offset,
            discarding_oversized_line: false,
        }
    }

    pub fn received_offset(&self) -> u64 {
        self.received_offset
    }

    pub fn committable_offset(&self) -> u64 {
        self.committable_offset
    }

    pub fn partial_len(&self) -> usize {
        self.buffer.len()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<FramedLine>, TranscriptParseError> {
        self.received_offset = self
            .received_offset
            .saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
        let mut lines = Vec::new();
        let chunk = if self.discarding_oversized_line {
            let Some(relative) = chunk.iter().position(|byte| *byte == b'\n') else {
                return Ok(lines);
            };
            let consumed = relative + 1;
            let end_offset = self
                .received_offset
                .saturating_sub(u64::try_from(chunk.len() - consumed).unwrap_or(0));
            lines.push(FramedLine {
                raw_line: String::new(),
                end_offset,
                parsed: Err(TranscriptParseError::LineTooLarge.to_string()),
            });
            self.discarding_oversized_line = false;
            &chunk[consumed..]
        } else {
            chunk
        };
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() > MAX_TRANSCRIPT_LINE_BYTES && !self.buffer.contains(&b'\n') {
            self.buffer.clear();
            self.discarding_oversized_line = true;
            return Ok(lines);
        }
        let mut consumed = 0usize;
        while let Some(relative) = self.buffer[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let end = consumed + relative + 1;
            if end - consumed > MAX_TRANSCRIPT_LINE_BYTES {
                let end_offset = self
                    .received_offset
                    .saturating_sub(u64::try_from(self.buffer.len() - end).unwrap_or(0));
                lines.push(FramedLine {
                    raw_line: String::new(),
                    end_offset,
                    parsed: Err(TranscriptParseError::LineTooLarge.to_string()),
                });
                consumed = end;
                continue;
            }
            let physical = &self.buffer[consumed..end];
            let mut content = &physical[..physical.len() - 1];
            if content.last() == Some(&b'\r') {
                content = &content[..content.len() - 1];
            }
            let end_offset = self
                .received_offset
                .saturating_sub(u64::try_from(self.buffer.len() - end).unwrap_or(0));
            let (raw_line, parsed) = match std::str::from_utf8(content) {
                Ok(raw_line) if content.is_empty() => (raw_line.to_owned(), Ok(Value::Null)),
                Ok(raw_line) => (
                    raw_line.to_owned(),
                    serde_json::from_slice(content).map_err(|error| error.to_string()),
                ),
                Err(_) => (
                    String::new(),
                    Err(TranscriptParseError::InvalidUtf8.to_string()),
                ),
            };
            if parsed.is_ok() {
                self.committable_offset = end_offset;
            }
            lines.push(FramedLine {
                raw_line,
                end_offset,
                parsed,
            });
            consumed = end;
        }
        if consumed > 0 {
            self.buffer.drain(..consumed);
        }
        if self.buffer.len() > MAX_TRANSCRIPT_LINE_BYTES {
            self.buffer.clear();
            self.discarding_oversized_line = true;
        }
        Ok(lines)
    }

    pub(super) fn commit_complete_line(&mut self, offset: u64) {
        self.committable_offset = self.committable_offset.max(offset);
    }

    pub fn reset(&mut self, offset: u64) {
        *self = Self::with_offset(offset);
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileBindResult {
    pub source_generation: u64,
    pub start_offset: u64,
    pub rebuilt: bool,
}

#[derive(Clone, Debug)]
pub struct FileIngestResult {
    pub source_generation: u64,
    pub received_offset: u64,
    pub committable_offset: u64,
    pub malformed_records: u32,
    pub changed: bool,
    pub update: Option<AgentTranscriptUpdate>,
}

/// The byte cursor is independent of either agent's record format. A durable
/// cursor advances only after the platform confirms a checkpoint.
#[derive(Clone, Debug, Default)]
pub(super) struct FileSourceCursor {
    pub source: Option<FileSourceIdentity>,
    pub generation: u64,
    pub framer: TranscriptJsonlFramer,
    pub committed: u64,
    pub initial_history_end: Option<u64>,
}

impl FileSourceCursor {
    pub fn bind(
        &mut self,
        session_id: &str,
        path: String,
        file_id: String,
        size: u64,
    ) -> FileBindResult {
        let source = FileSourceIdentity {
            requested_session_id: session_id.to_owned(),
            rollout_path: path,
            file_id,
        };
        self.generation = self.generation.saturating_add(1);
        let resume = self.framer.committable_offset();
        let warm = self.source.as_ref() == Some(&source) && size >= resume;
        let start_offset = if warm {
            resume
        } else {
            self.committed = 0;
            0
        };
        self.framer.reset(start_offset);
        self.source = Some(source);
        self.initial_history_end = Some(size);
        FileBindResult {
            source_generation: self.generation,
            start_offset,
            rebuilt: !warm,
        }
    }

    pub fn confirm(&mut self, generation: u64, offset: u64) -> bool {
        if generation != self.generation
            || offset < self.committed
            || offset > self.framer.committable_offset()
        {
            return false;
        }
        self.committed = offset;
        true
    }

    pub fn caught_up(&self) -> bool {
        self.initial_history_end
            .is_some_and(|end| self.framer.received_offset() >= end)
    }
}

// Preserve the existing Codex public API and cache field names.
pub type CodexSourceIdentity = FileSourceIdentity;
pub type CodexBindResult = FileBindResult;
pub type CodexIngestResult = FileIngestResult;

/// Shared transport contract; OpenCode's database cursor deliberately stays out
/// of this file-backed lifecycle.
pub(crate) trait FileTranscriptCore {
    fn state(&self) -> AgentTranscriptState;
    fn source_generation(&self) -> u64;
    fn revision(&self) -> u64;
    fn committed_offset(&self) -> u64;
    fn received_offset(&self) -> u64;
    fn invalidate_source(&mut self);
    fn initial_history_caught_up(&self) -> bool;
    fn bind_source(&mut self, path: String, file_id: String, size: u64) -> FileBindResult;
    fn ingest(
        &mut self,
        generation: u64,
        bytes: &[u8],
    ) -> Result<FileIngestResult, TranscriptParseError>;
    fn mark_live_update(&mut self) -> Option<AgentTranscriptUpdate>;
    fn cache_blob(&self) -> Result<Vec<u8>, AgentCacheError>;
}

macro_rules! file_core {
    ($core:ty) => {
        impl FileTranscriptCore for $core {
            fn state(&self) -> AgentTranscriptState {
                self.state()
            }
            fn source_generation(&self) -> u64 {
                self.source_generation()
            }
            fn revision(&self) -> u64 {
                self.revision()
            }
            fn committed_offset(&self) -> u64 {
                self.committed_offset()
            }
            fn received_offset(&self) -> u64 {
                self.received_offset()
            }
            fn invalidate_source(&mut self) {
                self.invalidate_source();
            }
            fn initial_history_caught_up(&self) -> bool {
                self.initial_history_caught_up()
            }
            fn bind_source(&mut self, path: String, file_id: String, size: u64) -> FileBindResult {
                self.bind_source(path, file_id, size)
            }
            fn ingest(
                &mut self,
                generation: u64,
                bytes: &[u8],
            ) -> Result<FileIngestResult, TranscriptParseError> {
                self.ingest(generation, bytes)
            }
            fn mark_live_update(&mut self) -> Option<AgentTranscriptUpdate> {
                self.mark_live_update()
            }
            fn cache_blob(&self) -> Result<Vec<u8>, AgentCacheError> {
                self.cache_blob()
            }
        }
    };
}
file_core!(super::codex::CodexSessionCore);
file_core!(super::claude::ClaudeSessionCore);
