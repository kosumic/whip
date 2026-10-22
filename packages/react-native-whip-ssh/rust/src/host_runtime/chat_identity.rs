//! Recover Codex session-only changes that Herdr event streams can omit.

use super::*;
use std::future::Future;

use crate::herdr_api::{HerdrControlError, HerdrControlRequest, HerdrControlResult};

pub(super) async fn read_pane_identity_using<F, Fut>(
    inner: Arc<RuntimeInner>,
    pane_id: &str,
    send: F,
) -> Result<HerdrControlResult, HerdrControlError>
where
    F: FnOnce(HerdrControlRequest) -> Fut,
    Fut: Future<Output = Result<HerdrControlResult, HerdrControlError>>,
{
    let identity_read = {
        let state = inner.state.lock();
        if state.connection != HostConnectionState::Connected {
            return Err(HerdrControlError::TransportDisconnected(format!(
                "host runtime is {:?}",
                state.connection
            )));
        }
        state
            .host_state
            .terminal_id_for_pane(pane_id)
            .and_then(|terminal_id| {
                if !inner
                    .agents
                    .has_terminal_binding(&terminal_id.as_str().into())
                {
                    return None;
                }
                state
                    .host_state
                    .begin_agent_session_read(&terminal_id)
                    .map(|token| (terminal_id, token))
            })
    };
    let result = send(HerdrControlRequest::PaneGet {
        pane_id: pane_id.to_owned(),
    })
    .await?;
    if let Some((terminal_id, token)) = identity_read
        && let HerdrControlResult::PaneInfo { pane } = &result
    {
        let changed = {
            let mut state = inner.state.lock();
            state.connection == HostConnectionState::Connected
                && inner
                    .agents
                    .has_terminal_binding(&terminal_id.as_str().into())
                && state.host_state.complete_agent_session_read(token, pane)
        };
        if changed {
            emit_host_state(&inner);
        }
    }
    Ok(result)
}
