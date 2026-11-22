//! Coalesced Core model projection. Core owns a continuous, sequenced stream;
//! changing the projected pane set does not replace that stream.
use super::{HostConnectionState, RuntimeInner, agent_view, emit_host_state};
use crate::host_state::{ApplyResult, now_ms};
use std::sync::Arc;

#[derive(Default)]
pub(super) struct State {
    running: bool,
    dirty: bool,
}

pub(super) fn schedule(inner: &Arc<RuntimeInner>) {
    let mut pending = inner.core_projection.lock();
    pending.dirty = true;
    if pending.running {
        return;
    }
    let Ok(runtime) = crate::runtime() else {
        return;
    };
    pending.running = true;
    drop(pending);
    let inner = inner.clone();
    runtime.spawn(async move {
        loop {
            {
                let mut pending = inner.core_projection.lock();
                if !pending.dirty {
                    pending.running = false;
                    return;
                }
                pending.dirty = false;
            }
            // Let an in-flight recovery snapshot commit before reading the
            // model again. Publishing while its older RPC result is pending
            // could let that result erase a newer create or external edit.
            if inner.state.lock().host_state.is_syncing() {
                inner.core_projection.lock().dirty = true;
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                continue;
            }
            let generation = {
                let state = inner.state.lock();
                if state.connection != HostConnectionState::Connected {
                    continue;
                }
                state.generation
            };
            let revision = inner.herdr.revision();
            let started_at = std::time::Instant::now();
            let result = async {
                let core = inner.herdr.core().await?;
                core.project_host_state(|snapshot| {
                    let outcome = {
                        let mut state = inner.state.lock();
                        if state.generation != generation
                            || state.connection != HostConnectionState::Connected
                            || inner.herdr.revision() != revision
                        {
                            return;
                        }
                        if state.host_state.is_syncing() {
                            inner.core_projection.lock().dirty = true;
                            return;
                        }
                        let outcome =
                            state
                                .host_state
                                .apply_core_projection(generation, snapshot, now_ms());
                        // Subscription bookkeeping only: Core already observes all
                        // terminals on the same channel, including new terminals.
                        let pane_ids = state.host_state.pane_ids();
                        if let Some(event) = state.event.as_mut() {
                            event.pane_ids = pane_ids;
                        }
                        drop(state);
                        outcome
                    };
                    match outcome {
                        ApplyResult::Applied => {
                            emit_host_state(&inner);
                            agent_view::request_refresh(&inner);
                        }
                        ApplyResult::NeedsResync(reason) => {
                            super::events::schedule_state_resync(inner.clone(), reason);
                        }
                        ApplyResult::IgnoredStale => {}
                    }
                })
                .await
            }
            .await;
            super::log_lifecycle(format_args!("tab-benchmark phase=projection runtime={} backend=core duration_ms={:.3} success={}",
                inner.id, started_at.elapsed().as_secs_f64() * 1000.0, result.is_ok()));
            if let Err(error) = result {
                // Unknown documents, partial writes and transport/gap failures
                // retain the existing authoritative recovery path.
                if inner.state.lock().generation == generation && inner.herdr.revision() == revision
                {
                    super::events::schedule_state_resync(
                        inner.clone(),
                        format!("Core projection unavailable: {error}"),
                    );
                }
            }
        }
    });
}
