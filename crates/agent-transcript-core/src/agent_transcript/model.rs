//! Neutral transcript types shared by every supported agent.

use serde::{Deserialize, Serialize};
use serde_json::Value;

macro_rules! define_type {
    ($kind:ident, $item:item) => {
        $item
    };
}
crate::transcript_type_schema!(define_type);

impl AgentScalarValue {
    pub(crate) fn from_json_primitive(value: &Value) -> Option<Self> {
        match value {
            Value::String(value) => Some(Self::String {
                value: value.clone(),
            }),
            Value::Number(value) => value.as_f64().map(|value| Self::Number { value }),
            Value::Bool(value) => Some(Self::Boolean { value: *value }),
            _ => None,
        }
    }
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
    pub fn normalized(
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

impl AgentTranscriptPart {
    pub fn id(&self) -> &str {
        match self {
            Self::Text { id, .. }
            | Self::Image { id, .. }
            | Self::Reasoning { id, .. }
            | Self::Tool { id, .. }
            | Self::Plan { id, .. }
            | Self::Notice { id, .. } => id,
        }
    }
}

/// Borrowed input for projection without copying the full transcript state.
#[derive(Clone, Copy)]
pub struct AgentTranscriptView<'a> {
    pub revision: u64,
    pub messages: &'a [AgentTranscriptMessage],
    pub turns: &'a [AgentTranscriptTurn],
}

impl<'a> From<&'a AgentTranscriptState> for AgentTranscriptView<'a> {
    fn from(state: &'a AgentTranscriptState) -> Self {
        Self {
            revision: state.revision,
            messages: &state.messages,
            turns: &state.turns,
        }
    }
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
