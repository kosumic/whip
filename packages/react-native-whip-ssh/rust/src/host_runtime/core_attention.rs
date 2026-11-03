//! Foreground-only Core attention effects, fenced by the current visible view.
use super::{HostRuntime, RuntimeInner, log_lifecycle};
use crate::herdr_api::HerdrControlError;
use herdr_protocol::hc::attention::{Change, Viewing};
use std::sync::Arc;

#[derive(Default)]
pub(super) struct State {
    viewing: Viewing,
    requested: Option<String>,
    running: bool,
    dirty: bool,
}
fn visible(inner: &RuntimeInner) -> bool {
    let monitoring = inner.monitoring.lock();
    monitoring.app_active && !monitoring.access_locked
}
pub(super) fn schedule(inner: &Arc<RuntimeInner>) {
    if !inner.herdr.is_core() {
        return;
    }
    let mut state = inner.core_attention.lock();
    let terminal = visible(inner).then(|| state.requested.clone()).flatten();
    state.viewing.set_terminal(terminal);
    state.dirty = true;
    if state.running {
        return;
    }
    let Ok(runtime) = crate::runtime() else {
        return;
    };
    state.running = true;
    drop(state);
    let inner = inner.clone();
    runtime.spawn(async move {
        loop {
            let target = {
                let mut state = inner.core_attention.lock();
                if !state.dirty {
                    state.running = false;
                    return;
                }
                state.dirty = false;
                state
                    .viewing
                    .terminal()
                    .map(|terminal| (terminal.to_owned(), state.viewing.epoch()))
            };
            let Some((terminal, epoch)) = target else {
                continue;
            };
            let result = async {
                let core = inner.herdr.core().await?;
                let turn = {
                    let mut state = inner.core_attention.lock();
                    if state.viewing.epoch() != epoch {
                        return Ok(());
                    }
                    let turn = core
                        .attention(&terminal)
                        .and_then(|attention| state.viewing.observe(attention));
                    drop(state);
                    turn
                };
                if let Some(turn) = turn {
                    core.update_attention(&terminal, Change::Seen(turn), || {
                        visible(&inner) && inner.core_attention.lock().viewing.epoch() == epoch
                    })
                    .await?;
                }
                Ok::<_, HerdrControlError>(())
            }
            .await;
            if let Err(error) = result {
                log_lifecycle(format_args!("Core attention: {error}"));
            }
        }
    });
}

#[uniffi::export]
impl HostRuntime {
    /// The caller supplies only the terminal actually displayed in the foreground.
    /// Monitoring state independently gates background/locked-app writes.
    pub fn set_viewed_agent(&self, terminal_id: Option<String>) {
        self.inner.core_attention.lock().requested = terminal_id;
        schedule(&self.inner);
    }
    pub async fn set_agent_pinned(
        &self,
        terminal_id: String,
        pinned: bool,
    ) -> Result<(), HerdrControlError> {
        update(self.inner.clone(), terminal_id, Some(pinned)).await
    }
    pub async fn mark_agent_unread(&self, terminal_id: String) -> Result<(), HerdrControlError> {
        update(self.inner.clone(), terminal_id, None).await
    }
}

async fn update(
    inner: Arc<RuntimeInner>,
    terminal: String,
    pinned: Option<bool>,
) -> Result<(), HerdrControlError> {
    if !inner.herdr.is_core() {
        return Err(HerdrControlError::UnsupportedResponse(
            "Shared attention requires Herdr Core".into(),
        ));
    }
    crate::runtime()
        .map_err(HerdrControlError::TransportDisconnected)?
        .spawn(async move {
            let core = inner.herdr.core().await?;
            let change = pinned
                .map(Change::Pinned)
                .or_else(|| core.attention(&terminal).map(Change::Unread));
            if let Some(change) = change {
                core.update_attention(&terminal, change, || true).await?;
            }
            Ok(())
        })
        .await
        .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_attention_controls_are_rejected_before_any_core_transport_is_opened()
    -> Result<(), Box<dyn std::error::Error>> {
        let (inner, _) = super::super::tests::agent_view_test_core();
        assert!(!inner.herdr.is_core());
        let runtime = HostRuntime { inner };
        let before = runtime.host_state();
        runtime.set_viewed_agent(Some("terminal-pane-1".into()));
        assert_eq!(runtime.host_state(), before);
        crate::runtime()?.block_on(async {
            assert!(matches!(
                runtime
                    .set_agent_pinned("terminal-pane-1".into(), true)
                    .await,
                Err(HerdrControlError::UnsupportedResponse(_))
            ));
            assert!(matches!(
                runtime.mark_agent_unread("terminal-pane-1".into()).await,
                Err(HerdrControlError::UnsupportedResponse(_))
            ));
        });
        Ok(())
    }
}
