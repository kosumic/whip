//! Neutral transcript types shared by every supported agent.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentTranscriptKind {
    Codex,
    OpenCode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentTranscriptStatus {
    /// Initial remote history is not complete yet, even if cached or partial
    /// messages exist. Presentation must wait before preparing the viewport.
    Loading,
    /// History through the boundary captured during opening has been applied.
    /// Presentation may reveal it once the initial viewport is laid out.
    Live,
    /// Previously synchronized history remains usable after a later failure.
    /// Unverified cache data and interrupted initial loads must not use this.
    Stale,
    Unavailable,
    Error,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentMessageRole {
    User,
    Assistant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentToolStatus {
    Pending,
    Running,
    Completed,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentDiagnosticSeverity {
    Error,
    Warning,
    Info,
    Hint,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentNoticeLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentTurnStatus {
    Idle,
    Working,
    Interrupted,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentScalarValue {
    String { value: String },
    Number { value: f64 },
    Boolean { value: bool },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentField {
    pub key: String,
    pub value: AgentScalarValue,
}

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
pub struct AgentFileDiff {
    pub file: String,
    pub patch: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Deserialize)]
struct UnnormalizedAgentFileDiff {
    file: String,
    patch: Option<String>,
    before: Option<String>,
    after: Option<String>,
    additions: Option<u32>,
    deletions: Option<u32>,
}

impl AgentFileDiff {
    pub(crate) fn normalized(
        file: String,
        patch: Option<String>,
        before: Option<String>,
        after: Option<String>,
        additions: Option<u32>,
        deletions: Option<u32>,
    ) -> Self {
        let (calculated_additions, calculated_deletions) = match patch.as_deref() {
            Some(patch) => diff_counts(patch),
            None => (
                after.as_deref().map(content_line_count).unwrap_or(0),
                before.as_deref().map(content_line_count).unwrap_or(0),
            ),
        };
        Self {
            file,
            patch,
            before,
            after,
            additions: additions.unwrap_or(calculated_additions),
            deletions: deletions.unwrap_or(calculated_deletions),
        }
    }
}

fn diff_counts(patch: &str) -> (u32, u32) {
    patch.lines().fold((0, 0), |(additions, deletions), line| {
        (
            additions + u32::from(line.starts_with('+') && !line.starts_with("+++")),
            deletions + u32::from(line.starts_with('-') && !line.starts_with("---")),
        )
    })
}

fn content_line_count(content: &str) -> u32 {
    u32::try_from(content.lines().count()).unwrap_or(u32::MAX)
}

impl<'de> Deserialize<'de> for AgentFileDiff {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = UnnormalizedAgentFileDiff::deserialize(deserializer)?;
        Ok(Self::normalized(
            value.file,
            value.patch,
            value.before,
            value.after,
            value.additions,
            value.deletions,
        ))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentToolDiagnostic {
    pub file: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub message: String,
    pub severity: AgentDiagnosticSeverity,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentToolState {
    pub status: AgentToolStatus,
    pub input: Vec<AgentField>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub title: Option<String>,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub exit_code: Option<i64>,
    #[serde(default)]
    pub files: Vec<AgentFileDiff>,
    #[serde(default)]
    pub diagnostics: Vec<AgentToolDiagnostic>,
    #[serde(default)]
    pub loaded: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Enum)]
#[allow(
    clippy::large_enum_variant,
    reason = "UniFFI transcript variants cannot box their typed payload records"
)]
pub enum AgentTranscriptPart {
    Text {
        id: String,
        text: String,
        timestamp_ms: Option<u64>,
    },
    Reasoning {
        id: String,
        text: String,
        timestamp_ms: Option<u64>,
    },
    Tool {
        id: String,
        call_id: String,
        tool: String,
        timestamp_ms: Option<u64>,
        state: AgentToolState,
    },
    Plan {
        id: String,
        text: String,
        timestamp_ms: Option<u64>,
    },
    Notice {
        id: String,
        level: AgentNoticeLevel,
        text: String,
        timestamp_ms: Option<u64>,
    },
}

impl AgentTranscriptPart {
    pub(super) fn id(&self) -> &str {
        match self {
            Self::Text { id, .. }
            | Self::Reasoning { id, .. }
            | Self::Tool { id, .. }
            | Self::Plan { id, .. }
            | Self::Notice { id, .. } => id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentTranscriptMessage {
    pub id: String,
    pub role: AgentMessageRole,
    pub parent_id: Option<String>,
    pub created_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub error: Option<String>,
    pub parts: Vec<AgentTranscriptPart>,
    pub diffs: Vec<AgentFileDiff>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentTranscriptTurn {
    pub id: String,
    pub user_message_id: Option<String>,
    pub assistant_message_ids: Vec<String>,
    pub status: AgentTurnStatus,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub diffs: Vec<AgentFileDiff>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentTranscriptInfo {
    pub id: String,
    pub title: Option<String>,
    pub directory: Option<String>,
    pub created_at_ms: Option<u64>,
    pub updated_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentTranscriptState {
    pub session_id: String,
    pub agent: AgentTranscriptKind,
    pub revision: u64,
    pub status: AgentTranscriptStatus,
    pub info: Option<AgentTranscriptInfo>,
    pub messages: Vec<AgentTranscriptMessage>,
    pub turns: Vec<AgentTranscriptTurn>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
#[allow(
    clippy::large_enum_variant,
    reason = "UniFFI delta variants cannot box the reset snapshot without changing the native API"
)]
pub enum AgentTranscriptDelta {
    Reset {
        state: AgentTranscriptState,
    },
    InfoChanged {
        info: Option<AgentTranscriptInfo>,
    },
    MessageUpserted {
        index: u32,
        message: AgentTranscriptMessage,
    },
    MessageRemoved {
        index: u32,
        message_id: String,
    },
    MessagesTruncated {
        length: u32,
    },
    TurnUpserted {
        index: u32,
        turn: AgentTranscriptTurn,
    },
    TurnsTruncated {
        length: u32,
    },
    StatusChanged {
        status: AgentTranscriptStatus,
        error: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AgentTranscriptUpdate {
    pub revision: u64,
    pub deltas: Vec<AgentTranscriptDelta>,
}

impl AgentTranscriptUpdate {
    pub fn reset(state: AgentTranscriptState) -> Self {
        Self {
            revision: state.revision,
            deltas: vec![AgentTranscriptDelta::Reset { state }],
        }
    }
}

impl AgentTranscriptState {
    pub fn empty(session_id: String, agent: AgentTranscriptKind) -> Self {
        Self {
            info: Some(AgentTranscriptInfo {
                id: session_id.clone(),
                title: None,
                directory: None,
                created_at_ms: None,
                updated_at_ms: None,
            }),
            session_id,
            agent,
            revision: 0,
            status: AgentTranscriptStatus::Loading,
            messages: Vec::new(),
            turns: Vec::new(),
            error: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AgentCacheError {
    #[error("agent transcript cache is malformed: {0}")]
    Malformed(String),
    #[error("agent transcript cache belongs to a different session")]
    SessionMismatch,
    #[error("agent transcript cache raw replay diverged from its projection")]
    ReplayDiverged,
}
