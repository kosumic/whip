//! A failed observation must not revoke a healthy file stream.

use super::{
    AgentSessionError, AgentSessionManager, FILE_SOURCE_POLL_DELAY, FileSourceMetadata,
    SessionFailureKind, SessionId, TranscriptKey, current_session_mut, diagnostics, execute,
    file_source_poll_command, parse_file_source_poll, shell_quote,
};
use std::time::{Duration, Instant};

const MAX_POLL_DELAY: Duration = Duration::from_secs(30);
const MISSING_SOURCE: &str = "__WHIP_TRANSCRIPT_SOURCE_MISSING__";

pub(super) struct Monitor {
    path: String,
    file_id: String,
    previous_size: u64,
    title_stamp: Option<String>,
    retry_delay: Duration,
}

impl Monitor {
    pub(super) fn new(path: String, metadata: FileSourceMetadata) -> Self {
        Self {
            path,
            file_id: metadata.file_id,
            previous_size: metadata.size,
            title_stamp: metadata.codex_title.map(|title| title.stamp),
            retry_delay: FILE_SOURCE_POLL_DELAY,
        }
    }

    async fn poll(
        &self,
        manager: &AgentSessionManager,
        key: &TranscriptKey,
        epoch: u64,
        session_id: Option<&SessionId>,
    ) -> Result<Option<FileSourceMetadata>, AgentSessionError> {
        let command = file_source_poll_command(&self.path, session_id.map(SessionId::as_str));
        let command = if let Some(id) = session_id {
            super::codex_title::with_title_read(
                command,
                &self.path,
                id.as_str(),
                self.title_stamp.as_deref(),
            )
        } else {
            command
        };
        // A successful observation of a missing source differs from an SSH or
        // stat failure. Use POSIX sh explicitly even with a Fish login shell.
        let script = format!(
            "if [ -e {} ]; then {command}; else printf '%s\\n' {MISSING_SOURCE}; fi",
            shell_quote(&self.path),
        );
        let output = execute(
            &manager.inner.connection,
            format!("sh -c {}", shell_quote(&script)),
        )
        .await
        .map_err(|error| {
            diagnostics::read_error(
                &manager.inner,
                key,
                epoch,
                diagnostics::ReadPhase::PollExec,
                error,
            )
        })?;
        if output.trim() == MISSING_SOURCE {
            return Ok(None);
        }
        parse_file_source_poll(&output, session_id.map(SessionId::as_str))
            .map(Some)
            .map_err(|error| {
                diagnostics::read_error(
                    &manager.inner,
                    key,
                    epoch,
                    diagnostics::ReadPhase::PollParse,
                    error,
                )
            })
    }

    pub(super) async fn run(
        mut self,
        manager: AgentSessionManager,
        key: TranscriptKey,
        epoch: u64,
        session_id: Option<SessionId>,
    ) {
        loop {
            let delay = {
                let mut state = manager.inner.state.lock();
                let Some(session) = current_session_mut(&mut state, &key, epoch) else {
                    return;
                };
                session.activity.poll_delay(self.retry_delay)
            };
            tokio::time::sleep(delay).await;
            // Capture BEFORE stat: appends during the request are not truncation.
            let (received, paused) = {
                let mut state = manager.inner.state.lock();
                let Some(session) = current_session_mut(&mut state, &key, epoch) else {
                    return;
                };
                if session.retry_running || session.terminals.is_empty() {
                    return;
                }
                let paused = session.activity.paused;
                let Some(core) = session.core.file() else {
                    return;
                };
                (core.received_offset(), paused)
            };
            let metadata = match self.poll(&manager, &key, epoch, session_id.as_ref()).await {
                Ok(Some(metadata)) => metadata,
                Ok(None) => {
                    manager.restart_operation(
                        key,
                        "Transcript source disappeared".into(),
                        Some(epoch),
                    );
                    return;
                }
                Err(error) => {
                    if !retry_independently(&manager, &key, epoch) {
                        manager.fail_session(
                            key,
                            epoch,
                            error.to_string(),
                            SessionFailureKind::Transient,
                        );
                        return;
                    }
                    self.retry_delay = self.retry_delay.saturating_mul(2).min(MAX_POLL_DELAY);
                    continue;
                }
            };
            if self.retry_delay > FILE_SOURCE_POLL_DELAY {
                diagnostics::record(
                    &manager.inner,
                    &key,
                    epoch,
                    "poll-recovered",
                    "metadata available; stream retained",
                );
            }
            self.retry_delay = FILE_SOURCE_POLL_DELAY;
            if metadata.changed(&self.path, &self.file_id, self.previous_size, received)
                || (paused && metadata.size > received)
            {
                let invalidate = metadata.file_changed(&self.file_id, self.previous_size, received);
                let current = {
                    let mut state = manager.inner.state.lock();
                    current_session_mut(&mut state, &key, epoch)
                        .and_then(|session| session.core.file())
                        .map(|core| invalidate.then(|| core.invalidate_source()))
                        .is_some()
                };
                if current {
                    manager.restart_operation(
                        key,
                        "Transcript source changed or received new bytes".into(),
                        Some(epoch),
                    );
                }
                return;
            }
            if let (Some(id), Some(title)) = (&session_id, metadata.codex_title) {
                manager.update_codex_title(&key, epoch, id, title.title.as_deref());
                self.title_stamp = Some(title.stamp);
            }
            self.previous_size = metadata.size;
            let mut state = manager.inner.state.lock();
            if let Some(session) = current_session_mut(&mut state, &key, epoch) {
                session.pause_file_if_quiet(metadata.size, Instant::now());
            }
        }
    }
}

fn retry_independently(manager: &AgentSessionManager, key: &TranscriptKey, epoch: u64) -> bool {
    let mut state = manager.inner.state.lock();
    let Some(session) = current_session_mut(&mut state, key, epoch) else {
        return false;
    };
    session.activity.paused
        || (session.stream_context.is_some()
            && session
                .stream
                .as_ref()
                .is_some_and(|stream| stream.is_current()))
}

#[cfg(test)]
mod tests;
