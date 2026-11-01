//! One canonical type schema, also consumed by Whip's remote FFI declarations.
// The callback either defines the Rust type or registers an existing remote type.
#[doc(hidden)]
#[macro_export]
macro_rules! transcript_type_schema {
    ($apply:ident) => {
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentTranscriptKind {
    Claude,
    Codex,
    OpenCode,
    Pi,
}
        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentMessageRole {
    User,
    Assistant,
}
        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentToolStatus {
    Pending,
    Running,
    Completed,
    Error,
}
        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentDiagnosticSeverity {
    Error,
    Warning,
    Info,
    Hint,
}
        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentNoticeLevel {
    Info,
    Warning,
    Error,
}
        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentTurnStatus {
    Idle,
    Working,
    Interrupted,
    Error,
}
        );
        $apply!(Enum,
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentTurnOutcome {
    Completed,
    Interrupted,
    Failed,
}
        );
        $apply!(Record,
/// Inclusive input/output counts: cache reads/writes are subsets of input;
/// reasoning is a subset of output. Missing counts remain unknown.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentTokenUsage {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub reasoning: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
    pub total: Option<u64>,
}
        );
        $apply!(Record,
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentTranscriptDetails {
    pub model: Option<String>,
    pub provider: Option<String>,
    pub usage: Option<AgentTokenUsage>,
    /// Provider response identity, used to deduplicate split Claude records.
    pub usage_id: Option<String>,
    pub outcome: Option<AgentTurnOutcome>,
}
        );
        $apply!(Enum,
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum AgentScalarValue {
    String { value: String },
    Number { value: f64 },
    Boolean { value: bool },
}
        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentField {
    pub key: String,
    pub value: AgentScalarValue,
}
        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AgentFileDiff {
    pub file: String,
    pub patch: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub additions: u32,
    pub deletions: u32,
}
        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentToolDiagnostic {
    pub file: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub message: String,
    pub severity: AgentDiagnosticSeverity,
}
        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentQuestionOption {
    pub label: String,
    pub description: Option<String>,
}
        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentQuestion {
    pub header: Option<String>,
    pub question: String,
    pub multiple: bool,
    pub options: Vec<AgentQuestionOption>,
}
        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentToolState {
    pub status: AgentToolStatus,
    pub input: Vec<AgentField>,
    #[serde(default)]
    pub input_json: Option<String>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub title: Option<String>,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub exit_code: Option<i64>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub files: Vec<AgentFileDiff>,
    #[serde(default)]
    pub diagnostics: Vec<AgentToolDiagnostic>,
    #[serde(default)]
    pub loaded: Vec<String>,
    #[serde(default)]
    pub questions: Vec<AgentQuestion>,
}
        );
        $apply!(Enum,
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[allow(
    clippy::large_enum_variant,
    reason = "Keep inline payloads compatible with existing canonical and native representations"
)]
pub enum AgentTranscriptPart {
    Text {
        id: String,
        text: String,
        timestamp_ms: Option<u64>,
    },
    Image {
        id: String,
        source: String,
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
        #[serde(default)]
        questions: Vec<AgentQuestion>,
    },
}
        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentTranscriptMessage {
    pub id: String,
    pub role: AgentMessageRole,
    pub parent_id: Option<String>,
    pub created_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub error: Option<String>,
    pub parts: Vec<AgentTranscriptPart>,
    pub diffs: Vec<AgentFileDiff>,
    #[serde(default)]
    pub details: Option<AgentTranscriptDetails>,
}
        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentTranscriptTurn {
    pub id: String,
    pub user_message_id: Option<String>,
    pub assistant_message_ids: Vec<String>,
    /// Ordered messages for turns with multiple user prompts. An empty list
    /// falls back to the singular user and assistant references.
    #[serde(default)]
    pub message_ids: Vec<String>,
    pub status: AgentTurnStatus,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub diffs: Vec<AgentFileDiff>,
    #[serde(default)]
    pub details: Option<AgentTranscriptDetails>,
}
        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentTranscriptInfo {
    pub id: String,
    pub title: Option<String>,
    pub directory: Option<String>,
    pub created_at_ms: Option<u64>,
    pub updated_at_ms: Option<u64>,
}
        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
        );
        $apply!(Enum,
#[derive(Clone, Debug, PartialEq)]
#[allow(
    clippy::large_enum_variant,
    reason = "Keep reset snapshots compatible with the existing native API"
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
        );
        $apply!(Record,
#[derive(Clone, Debug, PartialEq)]
pub struct AgentTranscriptUpdate {
    pub revision: u64,
    pub deltas: Vec<AgentTranscriptDelta>,
}
        );
    };
}
