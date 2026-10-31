//! Generation-pinned writes used only by native composer permits.

use std::sync::Arc;

use super::{HostConnectionState, HostRuntime, HostTerminalState, RuntimeState, get_host_runtime};
use crate::terminal_submissions::{
    SubmissionTransport, TerminalSubmissionPermit, TerminalSubmissionTarget, WriteOutcome,
};

struct Transport {
    runtime: Arc<HostRuntime>,
    target: TerminalSubmissionTarget,
    generation: u64,
    shell_epoch: Option<u64>,
}

pub(crate) fn submission_transport(
    target: &TerminalSubmissionTarget,
) -> Option<Arc<dyn SubmissionTransport>> {
    let runtime = get_host_runtime(target.runtime_id.clone())?;
    if runtime.inner.incarnation != target.runtime_incarnation {
        return None;
    }
    let (generation, shell_epoch) = {
        let state = runtime.inner.state.lock();
        (
            state.generation,
            state
                .ssh_shells
                .get(&target.terminal_id)
                .map(|shell| shell.operation_epoch),
        )
    };
    Some(Arc::new(Transport {
        runtime,
        target: target.clone(),
        generation,
        shell_epoch,
    }))
}

impl Transport {
    fn current(&self, state: &RuntimeState) -> bool {
        if state.connection != HostConnectionState::Connected || state.generation != self.generation
        {
            return false;
        }
        if self.target.ssh {
            state
                .ssh_shells
                .get(&self.target.terminal_id)
                .is_some_and(|shell| {
                    Some(shell.operation_epoch) == self.shell_epoch
                        && shell.state == HostTerminalState::Attached
                })
        } else {
            state
                .host_state
                .begin_agent_session_read(&self.target.terminal_id)
                .is_some()
                && state
                    .host_state
                    .terminal_id_for_pane(&self.target.pane_id)
                    .as_deref()
                    == Some(&self.target.terminal_id)
        }
    }
}

#[async_trait::async_trait]
impl SubmissionTransport for Transport {
    fn valid(&self) -> bool {
        self.current(&self.runtime.inner.state.lock())
    }

    async fn send(&self, parts: Vec<String>, permit: &TerminalSubmissionPermit) -> WriteOutcome {
        if !permit.active() {
            return WriteOutcome::Unsent;
        }
        if self.target.ssh {
            // One native shell command preserves the encoded paste boundaries,
            // separators and Enter without allowing keyboard input between them.
            let bytes = format!("{}\r", parts.join(" ")).into_bytes();
            let state = self.runtime.inner.state.lock();
            if !self.current(&state) {
                return WriteOutcome::Unsent;
            }
            let Ok(ssh) = self.runtime.inner.herdr.current_ssh() else {
                return WriteOutcome::Unsent;
            };
            return if ssh.shell_input(&self.target.terminal_id, bytes).is_ok() {
                // Accepted by the native transport queue, not proof of execution.
                WriteOutcome::Accepted
            } else {
                WriteOutcome::Unsent
            };
        }
        let mut accepted = 0;
        for (request, completes_part) in
            super::agents::pane_submission_requests(self.target.pane_id.clone(), parts)
        {
            if !permit.active() || !self.valid() {
                return if accepted == 0 {
                    WriteOutcome::Unsent
                } else {
                    WriteOutcome::Ambiguous(accepted)
                };
            }
            let Ok(bytes) = request.encode(&uuid::Uuid::new_v4().to_string()) else {
                return if accepted == 0 {
                    WriteOutcome::Unsent
                } else {
                    WriteOutcome::Ambiguous(accepted)
                };
            };
            self.runtime.inner.agents.wake_pane(&self.target.pane_id);
            let result = self
                .runtime
                .inner
                .herdr
                .submission_request(self.generation, &bytes, &|| permit.active() && self.valid())
                .await;
            if matches!(
                result,
                Err(crate::herdr_connection::SubmissionRequestFailure::Unsent)
            ) && accepted == 0
            {
                return WriteOutcome::Unsent;
            }
            if !result
                .is_ok_and(|response| crate::herdr_api::parse_response(&request, &response).is_ok())
            {
                // Dispatch has begun. A lost response, partial paste or rejected
                // final Enter must never cause an automatic replay.
                return WriteOutcome::Ambiguous(accepted);
            }
            if completes_part {
                accepted += 1;
            }
        }
        WriteOutcome::Accepted
    }
}
