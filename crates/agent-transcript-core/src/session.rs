//! Provider-neutral access to a single transcript state owner.
use crate::{
    AgentCacheError, AgentTranscriptKind, AgentTranscriptState, AgentTranscriptStatus,
    AgentTranscriptUpdate, AgentTranscriptView, ClaudeSessionCore, CodexSessionCore,
    FileTranscriptCore, OpenCodeSessionCore, PiSessionCore,
};

#[derive(Debug)]
pub enum SessionCore {
    Claude(Box<ClaudeSessionCore>),
    Pi(Box<PiSessionCore>),
    Codex(Box<CodexSessionCore>),
    OpenCode(Box<OpenCodeSessionCore>),
}

impl SessionCore {
    pub fn new(agent: AgentTranscriptKind, session_id: impl Into<String>) -> Self {
        let session_id = session_id.into();
        match agent {
            AgentTranscriptKind::Claude => {
                Self::Claude(Box::new(ClaudeSessionCore::new(session_id)))
            }
            AgentTranscriptKind::Pi => Self::Pi(Box::new(PiSessionCore::new(session_id))),
            AgentTranscriptKind::Codex => Self::Codex(Box::new(CodexSessionCore::new(session_id))),
            AgentTranscriptKind::OpenCode => {
                Self::OpenCode(Box::new(OpenCodeSessionCore::new(session_id)))
            }
        }
    }

    pub fn bind_source(
        &mut self,
        path: String,
        file_id: String,
        size: u64,
    ) -> Result<crate::FileBindResult, TranscriptIngestError> {
        let agent = self.kind();
        let core = self
            .file()
            .ok_or(TranscriptIngestError::WrongSource(agent))?;
        Ok(core.bind_source(path, file_id, size))
    }

    /// Ingest caller-supplied source records into this provider's existing state.
    /// File generations and OpenCode cursor/history validation stay provider-owned.
    pub fn ingest(
        &mut self,
        records: SourceRecords<'_>,
    ) -> Result<TranscriptIngestResult, TranscriptIngestError> {
        let agent = self.kind();
        match records {
            SourceRecords::Jsonl { generation, bytes } => {
                let core = self
                    .file()
                    .ok_or(TranscriptIngestError::WrongSource(agent))?;
                let result = core.ingest(generation, bytes)?;
                Ok(TranscriptIngestResult {
                    update: result.update,
                    malformed_records: result.malformed_records,
                    file_progress: Some(FileProgress {
                        source_generation: result.source_generation,
                        received_offset: result.received_offset,
                        committable_offset: result.committable_offset,
                    }),
                })
            }
            SourceRecords::Export { cursor, json } => match self {
                Self::OpenCode(core) => Ok(TranscriptIngestResult::update(
                    core.bootstrap_update(cursor, json)?,
                )),
                _ => Err(TranscriptIngestError::WrongSource(agent)),
            },
            SourceRecords::Events { cursor, json } => match self {
                Self::OpenCode(core) => Ok(TranscriptIngestResult::update(
                    core.apply_events_incremental(cursor, json)?,
                )),
                _ => Err(TranscriptIngestError::WrongSource(agent)),
            },
            SourceRecords::Projected(sync) => match self {
                Self::OpenCode(core) => {
                    Ok(TranscriptIngestResult::update(core.apply_v2_sync(sync)?))
                }
                _ => Err(TranscriptIngestError::WrongSource(agent)),
            },
        }
    }

    pub fn cache_blob(&self) -> Result<Vec<u8>, AgentCacheError> {
        match self {
            Self::Pi(core) => core.cache_blob(),
            Self::Claude(core) => core.cache_blob(),
            Self::Codex(core) => core.cache_blob(),
            Self::OpenCode(core) => core.cache_blob(),
        }
    }

    pub fn file(&mut self) -> Option<&mut dyn FileTranscriptCore> {
        match self {
            Self::Pi(core) => Some(core.as_mut()),
            Self::Claude(core) => Some(core.as_mut()),
            Self::Codex(core) => Some(core.as_mut()),
            Self::OpenCode(_) => None,
        }
    }

    pub fn kind(&self) -> AgentTranscriptKind {
        match self {
            Self::Claude(_) => AgentTranscriptKind::Claude,
            Self::Pi(_) => AgentTranscriptKind::Pi,
            Self::Codex(_) => AgentTranscriptKind::Codex,
            Self::OpenCode(_) => AgentTranscriptKind::OpenCode,
        }
    }

    pub fn status(&self) -> AgentTranscriptStatus {
        match self {
            Self::Pi(core) => core.status(),
            Self::Claude(core) => core.status(),
            Self::Codex(core) => core.status(),
            Self::OpenCode(core) => core.status(),
        }
    }

    pub fn state(&self) -> AgentTranscriptState {
        match self {
            Self::Pi(core) => core.state(),
            Self::Claude(core) => core.state(),
            Self::Codex(core) => core.state(),
            Self::OpenCode(core) => core.state(),
        }
    }

    pub fn projection_view(&self) -> Option<AgentTranscriptView<'_>> {
        match self {
            Self::Claude(_) | Self::Pi(_) => None,
            Self::Codex(core) => core.projection_view(),
            Self::OpenCode(core) => Some(core.projection_view()),
        }
    }

    pub fn revision(&self) -> u64 {
        match self {
            Self::Pi(core) => core.revision(),
            Self::Claude(core) => core.revision(),
            Self::Codex(core) => core.revision(),
            Self::OpenCode(core) => core.revision(),
        }
    }

    pub fn mark_stale_update(&mut self, reason: impl Into<String>) -> AgentTranscriptUpdate {
        let reason = reason.into();
        match self {
            Self::Pi(core) => core.mark_stale_update(reason),
            Self::Claude(core) => core.mark_stale_update(reason),
            Self::Codex(core) => core.mark_stale_update(reason),
            Self::OpenCode(core) => core.mark_stale_update(reason),
        }
    }

    pub fn mark_restarting_update(&mut self, reason: impl Into<String>) -> AgentTranscriptUpdate {
        let reason = reason.into();
        match self {
            Self::Pi(core) => core.mark_restarting_update(reason),
            Self::Claude(core) => core.mark_restarting_update(reason),
            Self::Codex(core) => core.mark_restarting_update(reason),
            Self::OpenCode(core) => core.mark_restarting_update(reason),
        }
    }

    pub fn mark_unavailable_update(&mut self, reason: impl Into<String>) -> AgentTranscriptUpdate {
        let reason = reason.into();
        match self {
            Self::Pi(core) => core.mark_unavailable_update(reason),
            Self::Claude(core) => core.mark_unavailable_update(reason),
            Self::Codex(core) => core.mark_unavailable_update(reason),
            Self::OpenCode(core) => core.mark_unavailable_update(reason),
        }
    }

    pub fn close_update(&mut self) -> AgentTranscriptUpdate {
        match self {
            Self::Pi(core) => core.close_update(),
            Self::Claude(core) => core.close_update(),
            Self::Codex(core) => core.close_update(),
            Self::OpenCode(core) => core.close_update(),
        }
    }

    pub fn restore_cache(&mut self, bytes: &[u8]) -> Result<AgentTranscriptState, AgentCacheError> {
        match self {
            Self::Pi(core) => core.restore_cache(bytes),
            Self::Claude(core) => core.restore_cache(bytes),
            Self::Codex(core) => core.restore_cache(bytes),
            Self::OpenCode(core) => core.restore_cache(bytes),
        }
    }

    pub fn confirm_cache(&mut self, source_generation: u64, position: u64) -> bool {
        match self {
            Self::Pi(core) => core.confirm_cache(source_generation, position),
            Self::Claude(core) => core.confirm_cache(source_generation, position),
            Self::Codex(core) => core.confirm_cache(source_generation, position),
            Self::OpenCode(core) => core.confirm_cache(source_generation, position),
        }
    }

    pub fn source_generation(&self) -> u64 {
        match self {
            Self::Pi(core) => core.source_generation(),
            Self::Claude(core) => core.source_generation(),
            Self::Codex(core) => core.source_generation(),
            Self::OpenCode(core) => core.source_generation(),
        }
    }
}

/// Source formats are explicit: file bytes cannot be mistaken for database events.
pub enum SourceRecords<'a> {
    Jsonl { generation: u64, bytes: &'a [u8] },
    Export { cursor: u64, json: &'a str },
    Events { cursor: u64, json: &'a str },
    Projected(crate::OpenCodeV2Sync),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileProgress {
    pub source_generation: u64,
    pub received_offset: u64,
    pub committable_offset: u64,
}

#[derive(Clone, Debug)]
pub struct TranscriptIngestResult {
    pub update: Option<AgentTranscriptUpdate>,
    pub malformed_records: u32,
    pub file_progress: Option<FileProgress>,
}

impl TranscriptIngestResult {
    fn update(update: Option<AgentTranscriptUpdate>) -> Self {
        Self {
            update,
            malformed_records: 0,
            file_progress: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TranscriptIngestError {
    #[error("Source records are incompatible with {0:?}")]
    WrongSource(AgentTranscriptKind),
    #[error(transparent)]
    Jsonl(#[from] crate::TranscriptParseError),
    #[error(transparent)]
    OpenCode(#[from] crate::OpenCodeTranscriptError),
}
