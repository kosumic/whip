//! Transcript lifecycle diagnostics contain identities and cursors, never stdout.

use sha2::{Digest, Sha256};
use std::time::Instant;

use super::{AgentSessionError, AgentSessionManagerInner, TranscriptKey};

#[derive(Clone, Copy)]
pub(super) enum StartupStage {
    CacheLookup,
    CacheWorker,
    CacheRestore,
    Discovery,
    Metadata,
    History,
    HistoryCommand,
    StreamOpen,
    InitialIngest,
    BoundedRead,
    OpenCodeVersion,
    OpenCodeLog,
    OpenCodeInfo,
    OpenCodeMessages,
}

impl StartupStage {
    fn label(self) -> &'static str {
        match self {
            Self::CacheLookup => "cache-lookup",
            Self::CacheWorker => "cache-worker-queue",
            Self::CacheRestore => "cache-restore-and-snapshot",
            Self::Discovery => "discovery",
            Self::Metadata => "metadata",
            Self::History => "history",
            Self::HistoryCommand => "history-command",
            Self::StreamOpen => "stream-open",
            Self::InitialIngest => "initial-ingest",
            Self::BoundedRead => "bounded-read",
            Self::OpenCodeVersion => "opencode-version",
            Self::OpenCodeLog => "opencode-log",
            Self::OpenCodeInfo => "opencode-info",
            Self::OpenCodeMessages => "opencode-messages",
        }
    }
}

pub(super) fn timing(
    manager: &AgentSessionManagerInner,
    key: &TranscriptKey,
    epoch: u64,
    stage: StartupStage,
    started: Instant,
    detail: &str,
) {
    // Stop the clock before logging or acquiring the diagnostic state lock.
    let elapsed = started.elapsed().as_secs_f64() * 1_000.0;
    record(
        manager,
        key,
        epoch,
        "startup-timing",
        &format!("stage={} elapsed_ms={elapsed:.3} {detail}", stage.label(),),
    );
}

pub(super) async fn execute_bytes(
    manager: &AgentSessionManagerInner,
    key: &TranscriptKey,
    epoch: u64,
    stage: StartupStage,
    command: String,
) -> Result<Vec<u8>, AgentSessionError> {
    let started = Instant::now();
    let output = manager
        .connection
        .execute_with_timeout(&command, super::TRANSCRIPT_COMMAND_TIMEOUT)
        .await
        .map_err(|error| AgentSessionError::ReadFailed(format!("{error:?}")));
    let detail = output.as_ref().map_or_else(|_| String::new(), |output| {
        let ms = |duration: std::time::Duration| duration.as_secs_f64() * 1_000.0;
        let first_stdout = output.timings.first_stdout.map_or_else(
            || "none".to_owned(), |duration| format!("{:.3}", ms(duration)),
        );
        format!(
            "queue_ms={:.3} gate_ms={:.3} open_ms={:.3} exec_request_ms={:.3} first_stdout_ms={first_stdout} read_ms={:.3} close_ms={:.3} bytes={}",
            ms(output.timings.queue), ms(output.timings.open_gate), ms(output.timings.channel_open),
            ms(output.timings.exec_request), ms(output.timings.read), ms(output.timings.close), output.stdout.len(),
        )
    });
    let result = output.and_then(super::command_bytes);
    timing(
        manager,
        key,
        epoch,
        stage,
        started,
        &format!(
            "{detail} outcome={}",
            if result.is_ok() { "ok" } else { "error" }
        ),
    );
    result
}

pub(super) async fn execute(
    manager: &AgentSessionManagerInner,
    key: &TranscriptKey,
    epoch: u64,
    stage: StartupStage,
    command: String,
) -> Result<String, AgentSessionError> {
    execute_bytes(manager, key, epoch, stage, command)
        .await
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

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
