//! Register the canonical types in Whip's existing UniFFI namespace.
//! The schema defines each type once; remote declarations add no state or copies.
use agent_transcript_core::{
    AgentDiagnosticSeverity, AgentField, AgentFileDiff, AgentMessageRole, AgentNoticeLevel,
    AgentQuestion, AgentQuestionOption, AgentScalarValue, AgentTokenUsage, AgentToolDiagnostic,
    AgentToolState, AgentToolStatus, AgentTranscriptDelta, AgentTranscriptDetails,
    AgentTranscriptInfo, AgentTranscriptKind, AgentTranscriptMessage, AgentTranscriptPart,
    AgentTranscriptState, AgentTranscriptStatus, AgentTranscriptTurn, AgentTranscriptUpdate,
    AgentTurnOutcome, AgentTurnStatus,
};

macro_rules! native_type {
    ($kind:ident, $item:item) => {
        #[uniffi::remote($kind)]
        $item
    };
}
agent_transcript_core::transcript_type_schema!(native_type);
