//! Transcript lifecycle diagnostics contain identities and cursors, never stdout.

use sha2::{Digest, Sha256};

use super::{AgentSessionError, AgentSessionManagerInner, TranscriptKey};

// Leave room for correlation fields in the runtime logger's 1,024-character record.
const DETAIL_CHARS: usize = 512;

#[derive(Clone, Copy)]
pub(super) enum ReadPhase {
    DiscoveryExec,
    DiscoveryParse,
    MetadataExec,
    MetadataParse,
    HistoryRead,
    StreamOpen,
    PollExec,
    PollParse,
}

impl ReadPhase {
    fn labels(self) -> (&'static str, &'static str) {
        match self {
            Self::DiscoveryExec => ("discovery-exec", "Transcript discovery"),
            Self::DiscoveryParse => ("discovery-parse", "Transcript discovery"),
            Self::MetadataExec => ("metadata-exec", "Transcript metadata lookup"),
            Self::MetadataParse => ("metadata-parse", "Transcript metadata lookup"),
            Self::HistoryRead => ("history-read", "Transcript history read"),
            Self::StreamOpen => ("stream-open", "Transcript stream connection"),
            Self::PollExec => ("poll-exec", "Transcript metadata check"),
            Self::PollParse => ("poll-parse", "Transcript metadata check"),
        }
    }
}

pub(super) fn record(
    manager: &AgentSessionManagerInner,
    key: &TranscriptKey,
    epoch: u64,
    phase: &str,
    detail: &str,
) {
    let progress = {
        let mut state = manager.state.lock();
        state.sessions.get_mut(key).map_or_else(
            || "session=removed".to_owned(),
            |session| {
                let status = session.core.status();
                let paused = session.activity.paused;
                let stream = session.stream_context;
                let cursor = session.core.file().map(|core| {
                    (
                        core.source_generation(),
                        core.received_offset(),
                        core.committed_offset(),
                    )
                });
                format!("status={status:?} paused={paused} stream={stream:?} cursor={cursor:?}")
            },
        )
    };
    // Keys contain the namespace and session ID separated by newlines. Hashing
    // keeps correlation stable without exposing host labels or breaking records.
    let key = format!("{:x}", Sha256::digest(key.as_str().as_bytes()));
    let parts = detail.chars().count().max(1).div_ceil(DETAIL_CHARS);
    let mut chars = detail.chars();
    for part in 1..=parts {
        let detail: String = chars.by_ref().take(DETAIL_CHARS).collect();
        crate::host_runtime::diagnostics::log_lifecycle(format_args!(
            "transcript key={key} epoch={epoch} phase={phase} {progress} part={part}/{parts} detail={detail}"
        ));
    }
}

pub(super) fn read_error(
    manager: &AgentSessionManagerInner,
    key: &TranscriptKey,
    epoch: u64,
    phase: ReadPhase,
    error: impl std::fmt::Display,
) -> AgentSessionError {
    let (phase, operation) = phase.labels();
    record(manager, key, epoch, phase, &error.to_string());
    AgentSessionError::ReadFailed(format!("{operation} failed; retrying automatically"))
}
