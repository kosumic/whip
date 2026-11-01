//! Offline transcript parsing, normalization, updates, and provider checkpoints.
//!
//! The crate performs no transport, discovery, database access, or scheduling.
//! [`SessionCore`] owns one provider's state; callers supply source records.
#![doc = include_str!("../README.md")]

mod agent_transcript;
mod codex;
mod schema;
mod session;

pub use agent_transcript::*;
pub use codex::rollout_wire::{CodexHistoryMode, HistoryPosition, SessionMeta};
pub use session::*;

#[cfg(test)]
mod test_allocations;

/// Decode a validated checkpoint for offline viewing, without opening a source.
/// Live cores still require source revalidation before their history is ready.
pub fn decode_cached_transcript(
    agent: AgentTranscriptKind,
    session_id: impl Into<String>,
    bytes: &[u8],
) -> Result<AgentTranscriptState, AgentCacheError> {
    let session_id = session_id.into();
    let mut state = match agent {
        AgentTranscriptKind::Claude => ClaudeSessionCore::new(session_id).restore_cache(bytes)?,
        AgentTranscriptKind::Pi => PiSessionCore::new(session_id).restore_cache(bytes)?,
        AgentTranscriptKind::Codex => CodexSessionCore::new(session_id).restore_cache(bytes)?,
        AgentTranscriptKind::OpenCode => {
            OpenCodeSessionCore::new(session_id).restore_cache(bytes)?
        }
    };
    state.status = AgentTranscriptStatus::Stale;
    state.error = None;
    Ok(state)
}
