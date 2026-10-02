//! Herdr terminal bridge lifecycle and recovery.

use super::*;
use std::future::Future;
use std::time::Instant;

use crate::herdr_api::{HerdrControlError, HerdrControlRequest, HerdrControlResult};
use crate::herdr_events::close_herdr_event_subscription;
use crate::herdr_terminal::{
    HerdrBridgeError, HerdrBridgeId, HerdrTerminalAttachLaunchMode,
    active_herdr_terminal_bridge_id, close_all_herdr_terminal_bridges, close_herdr_terminal_bridge,
    close_owned_herdr_terminal_bridge, herdr_terminal_input, herdr_terminal_resize,
    herdr_terminal_scroll, start_bridge_on_runtime,
};

fn terminal_scroll_read_is_current(
    state: &RuntimeState,
    terminal_id: &str,
    operation_epoch: u64,
) -> bool {
    state.connection == HostConnectionState::Connected
        && state.terminals.get(terminal_id).is_some_and(|terminal| {
            terminal.operation_epoch == operation_epoch
                && terminal.state == HostTerminalState::Attached
        })
}

pub(super) async fn refresh_terminal_scroll_using<F, Fut>(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
    operation_epoch: u64,
    send: F,
) -> Result<(), HerdrControlError>
where
    F: FnOnce(HerdrControlRequest) -> Fut,
    Fut: Future<Output = Result<HerdrControlResult, HerdrControlError>>,
{
    let token = {
        let state = inner.state.lock();
        if !terminal_scroll_read_is_current(&state, &terminal_id, operation_epoch) {
            return Ok(());
        }
        state.host_state.begin_pane_scroll_read(&terminal_id)
    };
    let Some(token) = token else { return Ok(()) };
    let result = send(HerdrControlRequest::PaneGet {
        pane_id: token.pane_id.clone(),
    })
    .await?;
    let HerdrControlResult::PaneInfo { pane } = result else {
        return Err(HerdrControlError::UnsupportedResponse(
            "pane.get returned a non-pane result".to_owned(),
        ));
    };
    let changed = {
        let mut state = inner.state.lock();
        if !terminal_scroll_read_is_current(&state, &terminal_id, operation_epoch) {
            return Ok(());
        }
        state.host_state.complete_pane_scroll_read(token, &pane)
    };
    if changed {
        emit_host_state(&inner);
    }
    Ok(())
}

fn schedule_terminal_scroll_read(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
    operation_epoch: u64,
) {
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            let started_at = Instant::now();
            let result = refresh_terminal_scroll_using(
                inner.clone(),
                terminal_id.clone(),
                operation_epoch,
                |request| {
                    // Metadata reads must not initiate host recovery or invalidate
                    // readiness. The event stream owns ongoing scroll updates.
                    let replay = request_replay(&request);
                    crate::herdr_api::request_on_runtime(inner.herdr.clone(), request, replay)
                },
            )
            .await;
            emit_slow_or_failed_diagnostic(
                &inner,
                RuntimeDiagnosticOperation::HerdrRequest,
                started_at,
                result
                    .err()
                    .map(|error| format!("scroll metadata for {terminal_id}: {error}")),
            );
        });
    }
}

pub(super) fn close_terminal_intent(inner: &Arc<RuntimeInner>, terminal_id: String) {
    // This releases the interactive renderer bridge, not the authoritative
    // terminal -> pane -> agent-session relationship. Android deliberately
    // releases renderer ownership while backgrounded, and transcript bindings
    // must survive that transport-only lifecycle. HostState reconciliation or
    // the explicit agent-chat detach operation owns transcript release.
    let bridge_id = {
        let mut state = inner.state.lock();
        state.terminal_dispatched_geometries.remove(&terminal_id);
        state
            .terminal_kitty_keyboard_report_all
            .remove(&terminal_id);
        state
            .terminals
            .remove(&terminal_id)
            .and_then(|terminal| terminal.bridge_id)
    };
    if let Some(bridge_id) = bridge_id {
        close_owned_herdr_terminal_bridge(&inner.id, &terminal_id, bridge_id);
    } else {
        close_herdr_terminal_bridge(inner.id.clone(), terminal_id.clone());
    }
    emit(HostRuntimeEvent::TerminalStateChanged {
        runtime_id: inner.id.clone(),
        terminal_id,
        state: HostTerminalState::Closed,
        reconnect_attempt: 0,
        retrying: false,
        error: None,
    });
    inner.terminal_settled.notify_waiters();
}

pub(super) fn claim_terminal_bridge(
    inner: &RuntimeInner,
    terminal_id: &str,
    operation_epoch: u64,
    bridge_id: HerdrBridgeId,
) -> Result<(), HerdrBridgeError> {
    let mut state = inner.state.lock();
    if state.connection != HostConnectionState::Connected {
        return Err(HerdrBridgeError::BridgeUnavailable(
            "host runtime disconnected while claiming terminal bridge".to_owned(),
        ));
    }
    let terminal = state.terminals.get_mut(terminal_id).ok_or_else(|| {
        HerdrBridgeError::BridgeUnavailable(format!(
            "terminal {terminal_id} closed while claiming bridge {bridge_id}"
        ))
    })?;
    if terminal.operation_epoch != operation_epoch
        || !matches!(
            terminal.state,
            HostTerminalState::Opening | HostTerminalState::Restoring
        )
    {
        return Err(HerdrBridgeError::BridgeUnavailable(format!(
            "terminal {terminal_id} no longer accepts bridge {bridge_id}"
        )));
    }
    terminal.bridge_id = Some(bridge_id);
    drop(state);
    Ok(())
}

pub(super) fn live_terminal_bridge_id(
    inner: &RuntimeInner,
    terminal_id: &str,
) -> Option<HerdrBridgeId> {
    let bridge_id = {
        let state = inner.state.lock();
        if state.connection != HostConnectionState::Connected {
            return None;
        }
        let terminal = state.terminals.get(terminal_id)?;
        if terminal.state != HostTerminalState::Attached {
            return None;
        }
        let bridge_id = terminal.bridge_id?;
        drop(state);
        bridge_id
    };
    (active_herdr_terminal_bridge_id(&inner.id, terminal_id) == Some(bridge_id))
        .then_some(bridge_id)
}

pub(super) async fn open_terminal_inner(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
    operation_epoch: u64,
    restoring: bool,
) -> Result<(), HostRuntimeError> {
    let started_at = Instant::now();
    let operation = if restoring {
        RuntimeDiagnosticOperation::TerminalRecovery
    } else {
        RuntimeDiagnosticOperation::TerminalAttach
    };
    ensure_herdr_server(&inner).await?;
    let (protocol, terminal) = {
        let state = inner.state.lock();
        if state.connection != HostConnectionState::Connected {
            return Err(HostRuntimeError::RuntimeDisconnected(
                "host runtime is not connected".to_owned(),
            ));
        }
        let terminal = state.terminals.get(&terminal_id).cloned().ok_or_else(|| {
            HostRuntimeError::TerminalUnavailable(format!(
                "terminal {terminal_id} is not registered"
            ))
        })?;
        (
            state.protocol.ok_or_else(|| {
                HostRuntimeError::HerdrUnavailable("Herdr protocol is unknown".to_owned())
            })?,
            terminal,
        )
    };
    let claim_inner = inner.clone();
    let claim_terminal_id = terminal_id.clone();
    let mut result = start_bridge_on_runtime(
        inner.herdr.clone(),
        protocol,
        terminal_id.clone(),
        terminal.takeover,
        terminal.columns,
        terminal.rows,
        terminal.cell_width_px,
        terminal.cell_height_px,
        HerdrTerminalAttachLaunchMode::for_protocol(protocol),
        move |bridge_id| {
            claim_terminal_bridge(
                claim_inner.as_ref(),
                &claim_terminal_id,
                operation_epoch,
                bridge_id,
            )
        },
    )
    .await;
    let opened_bridge_id = result.as_ref().ok().copied();
    let mut state = inner.state.lock();
    let Some(current) = state.terminals.get_mut(&terminal_id) else {
        drop(state);
        if let Some(bridge_id) = opened_bridge_id {
            close_owned_herdr_terminal_bridge(&inner.id, &terminal_id, bridge_id);
        }
        inner.terminal_settled.notify_waiters();
        return Err(HostRuntimeError::StaleOperation(format!(
            "terminal {terminal_id} was closed while opening"
        )));
    };
    if current.operation_epoch != operation_epoch || current.state == HostTerminalState::Closed {
        drop(state);
        if let Some(bridge_id) = opened_bridge_id {
            close_owned_herdr_terminal_bridge(&inner.id, &terminal_id, bridge_id);
        }
        inner.terminal_settled.notify_waiters();
        return Err(HostRuntimeError::StaleOperation(format!(
            "stale open completed for terminal {terminal_id}"
        )));
    }
    if let Ok(&bridge_id) = result.as_ref()
        && (current.bridge_id != Some(bridge_id)
            || !matches!(
                current.state,
                HostTerminalState::Opening | HostTerminalState::Restoring
            )
            || active_herdr_terminal_bridge_id(&inner.id, &terminal_id) != Some(bridge_id))
    {
        result = Err(HerdrBridgeError::BridgeClosed(format!(
            "terminal {terminal_id} bridge {bridge_id} closed before attachment committed"
        )));
    }
    match result {
        Ok(bridge_id) => {
            debug_assert_eq!(current.bridge_id, Some(bridge_id));
            current.state = HostTerminalState::Attached;
            current.reconnect_attempt = 0;
            let geometry = HostTerminalGeometry::normalized(
                terminal.columns,
                terminal.rows,
                terminal.cell_width_px,
                terminal.cell_height_px,
            );
            let latest_geometry = HostTerminalGeometry::normalized(
                current.columns,
                current.rows,
                current.cell_width_px,
                current.cell_height_px,
            );
            state
                .terminal_dispatched_geometries
                .insert(terminal_id.clone(), geometry);
            drop(state);
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: inner.id.clone(),
                terminal_id: terminal_id.clone(),
                state: HostTerminalState::Attached,
                reconnect_attempt: 0,
                retrying: false,
                error: None,
            });
            if latest_geometry != geometry {
                match herdr_terminal_resize(
                    inner.id.clone(),
                    terminal_id.clone(),
                    latest_geometry.columns,
                    latest_geometry.rows,
                    latest_geometry.cell_width_px,
                    latest_geometry.cell_height_px,
                ) {
                    Ok(()) => {
                        inner
                            .state
                            .lock()
                            .terminal_dispatched_geometries
                            .insert(terminal_id.clone(), latest_geometry);
                    }
                    Err(error) => {
                        schedule_terminal_retry(
                            inner.clone(),
                            terminal_id.clone(),
                            Some(bridge_id),
                            error.to_string(),
                        );
                    }
                }
            }
            emit_diagnostic(
                &inner,
                operation,
                started_at,
                None,
                Some(terminal_id.clone()),
                None,
            );
            inner.terminal_settled.notify_waiters();
            schedule_terminal_scroll_read(inner.clone(), terminal_id, operation_epoch);
            Ok(())
        }
        Err(error) => {
            let failed_bridge_id = current.bridge_id.take().or(opened_bridge_id);
            current.state = HostTerminalState::Failed;
            let reconnect_attempt = current.reconnect_attempt;
            let retrying = current.retry_running;
            state.terminal_dispatched_geometries.remove(&terminal_id);
            drop(state);
            let message = if restoring {
                format!("Terminal reattach failed: {error}")
            } else {
                error.to_string()
            };
            if let Some(bridge_id) = failed_bridge_id {
                close_owned_herdr_terminal_bridge(&inner.id, &terminal_id, bridge_id);
            }
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: inner.id.clone(),
                terminal_id: terminal_id.clone(),
                state: HostTerminalState::Failed,
                reconnect_attempt,
                retrying,
                error: Some(message.clone()),
            });
            emit_diagnostic(
                &inner,
                operation,
                started_at,
                None,
                Some(terminal_id.clone()),
                Some(message.clone()),
            );
            inner.terminal_settled.notify_waiters();
            Err(HostRuntimeError::TerminalUnavailable(message))
        }
    }
}

pub(super) async fn wait_for_terminal_open(
    inner: &RuntimeInner,
    terminal_id: &str,
    operation_epoch: u64,
) -> Result<(), HostRuntimeError> {
    loop {
        let notified = inner.terminal_settled.notified();
        let should_wait = {
            let state = inner.state.lock();
            let terminal = state.terminals.get(terminal_id).ok_or_else(|| {
                HostRuntimeError::StaleOperation(format!(
                    "terminal {terminal_id} was closed while opening"
                ))
            })?;
            if terminal.operation_epoch != operation_epoch {
                return Err(HostRuntimeError::StaleOperation(format!(
                    "terminal {terminal_id} open was superseded"
                )));
            }
            let should_wait = match terminal.state {
                HostTerminalState::Attached => false,
                HostTerminalState::Failed if terminal.retry_running => true,
                HostTerminalState::Failed => {
                    return Err(HostRuntimeError::TerminalUnavailable(format!(
                        "terminal {terminal_id} failed to open"
                    )));
                }
                HostTerminalState::Closed => {
                    return Err(HostRuntimeError::StaleOperation(format!(
                        "terminal {terminal_id} was closed while opening"
                    )));
                }
                HostTerminalState::Opening | HostTerminalState::Restoring => true,
            };
            drop(state);
            should_wait
        };
        if !should_wait {
            return Ok(());
        }
        notified.await;
    }
}

pub(super) async fn wait_for_ssh_shell_open(
    inner: &RuntimeInner,
    terminal_id: &str,
    operation_epoch: u64,
) -> Result<(), HostRuntimeError> {
    loop {
        let notified = inner.terminal_settled.notified();
        let (shell_epoch, shell_state, retry_running) = {
            let state = inner.state.lock();
            let shell = state.ssh_shells.get(terminal_id).ok_or_else(|| {
                HostRuntimeError::StaleOperation(format!(
                    "SSH shell {terminal_id} was closed while opening"
                ))
            })?;
            let result = (shell.operation_epoch, shell.state, shell.retry_running);
            drop(state);
            result
        };
        if shell_epoch != operation_epoch {
            return Err(HostRuntimeError::StaleOperation(format!(
                "SSH shell {terminal_id} open was superseded"
            )));
        }
        let should_wait = match shell_state {
            HostTerminalState::Attached => false,
            HostTerminalState::Opening | HostTerminalState::Restoring => true,
            HostTerminalState::Failed if retry_running => true,
            HostTerminalState::Failed => {
                return Err(HostRuntimeError::TerminalUnavailable(format!(
                    "SSH shell {terminal_id} failed to open"
                )));
            }
            HostTerminalState::Closed => {
                return Err(HostRuntimeError::StaleOperation(format!(
                    "SSH shell {terminal_id} was closed while opening"
                )));
            }
        };
        if !should_wait {
            return Ok(());
        }
        notified.await;
    }
}

pub(super) fn ssh_shell_closed(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
    generation: u64,
    operation_epoch: u64,
    close: SshShellClose,
) {
    let reason = close.reason().to_owned();
    let transport_lost = matches!(close, SshShellClose::TransportDisconnected(_));
    let disposition = {
        let mut state = inner.state.lock();
        apply_ssh_shell_close(&mut state, &terminal_id, operation_epoch, transport_lost)
    };
    if disposition == SshShellCloseDisposition::Ignored {
        return;
    }
    inner.terminal_settled.notify_waiters();
    if disposition == SshShellCloseDisposition::Restore {
        emit(HostRuntimeEvent::TerminalStateChanged {
            runtime_id: inner.id.clone(),
            terminal_id,
            state: HostTerminalState::Restoring,
            reconnect_attempt: 0,
            retrying: true,
            error: Some(reason.clone()),
        });
        begin_reconnect_for_generation(inner, Some(generation), reason, true);
    } else {
        emit(HostRuntimeEvent::SshShellClosed {
            runtime_id: inner.id.clone(),
            terminal_id,
            reason,
        });
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SshShellCloseDisposition {
    Ignored,
    Restore,
    Closed,
}

pub(super) fn apply_ssh_shell_close(
    state: &mut RuntimeState,
    terminal_id: &str,
    operation_epoch: u64,
    transport_lost: bool,
) -> SshShellCloseDisposition {
    let Some(shell) = state.ssh_shells.get_mut(terminal_id) else {
        return SshShellCloseDisposition::Ignored;
    };
    if shell.operation_epoch != operation_epoch {
        return SshShellCloseDisposition::Ignored;
    }
    shell.dispatched_geometry = None;
    shell.retry_running = false;
    if transport_lost && shell.desired_open {
        shell.state = HostTerminalState::Restoring;
        SshShellCloseDisposition::Restore
    } else {
        shell.desired_open = false;
        shell.state = HostTerminalState::Closed;
        SshShellCloseDisposition::Closed
    }
}

pub(super) fn ssh_shell_open_is_current(
    state: &RuntimeState,
    terminal_id: &str,
    epoch: u64,
    generation: u64,
    operation_epoch: u64,
) -> bool {
    state.epoch == epoch
        && state.generation == generation
        && state.connection == HostConnectionState::Connected
        && state.ssh_shells.get(terminal_id).is_some_and(|shell| {
            shell.desired_open
                && shell.operation_epoch == operation_epoch
                && matches!(
                    shell.state,
                    HostTerminalState::Opening | HostTerminalState::Restoring
                )
        })
}

pub(super) async fn open_ssh_shell_inner(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
    epoch: u64,
    generation: u64,
    operation_epoch: u64,
    geometry: HostTerminalGeometry,
    restoring: bool,
) -> Result<(), HostRuntimeError> {
    let started_at = Instant::now();
    let operation = if restoring {
        RuntimeDiagnosticOperation::SshShellRecovery
    } else {
        RuntimeDiagnosticOperation::TerminalAttach
    };
    let ssh = current_ssh(&inner)?;
    let runtime_id = inner.id.clone();
    let data_terminal_id = terminal_id.clone();
    let data_inner = Arc::downgrade(&inner);
    let data = Arc::new(move |bytes| {
        let Some(inner) = data_inner.upgrade() else {
            return;
        };
        let current = {
            let state = inner.state.lock();
            state.epoch == epoch
                && state.generation == generation
                && state.connection == HostConnectionState::Connected
                && state
                    .ssh_shells
                    .get(&data_terminal_id)
                    .is_some_and(|shell| {
                        shell.desired_open
                            && shell.operation_epoch == operation_epoch
                            && matches!(
                                shell.state,
                                HostTerminalState::Opening
                                    | HostTerminalState::Attached
                                    | HostTerminalState::Restoring
                            )
                    })
        };
        if current {
            emit(HostRuntimeEvent::SshShellData {
                runtime_id: runtime_id.clone(),
                terminal_id: data_terminal_id.clone(),
                bytes,
            });
        }
    });
    let closed_terminal_id = terminal_id.clone();
    let closed_inner = Arc::downgrade(&inner);
    let closed = Arc::new(move |close| {
        if let Some(inner) = closed_inner.upgrade() {
            ssh_shell_closed(
                inner,
                closed_terminal_id.clone(),
                generation,
                operation_epoch,
                close,
            );
        }
    });
    let result = ssh
        .open_shell(
            &terminal_id,
            "xterm-256color",
            geometry.columns,
            geometry.rows,
            data,
            closed,
        )
        .await;
    match result {
        Ok(()) => {
            let latest_geometry = {
                let mut state = inner.state.lock();
                if !ssh_shell_open_is_current(
                    &state,
                    &terminal_id,
                    epoch,
                    generation,
                    operation_epoch,
                ) {
                    None
                } else if let Some(shell) = state.ssh_shells.get_mut(&terminal_id) {
                    shell.state = HostTerminalState::Attached;
                    shell.dispatched_geometry = Some(geometry);
                    shell.reconnect_attempt = 0;
                    shell.retry_running = false;
                    Some(shell.geometry)
                } else {
                    None
                }
            };
            let Some(latest_geometry) = latest_geometry else {
                let _ = ssh.close_shell(&terminal_id);
                inner.terminal_settled.notify_waiters();
                return Err(HostRuntimeError::StaleOperation(format!(
                    "SSH shell {terminal_id} opened after its connection was replaced"
                )));
            };
            if latest_geometry != geometry {
                ssh.resize_shell(&terminal_id, latest_geometry.columns, latest_geometry.rows)?;
                if let Some(shell) = inner.state.lock().ssh_shells.get_mut(&terminal_id)
                    && shell.operation_epoch == operation_epoch
                    && shell.state == HostTerminalState::Attached
                {
                    shell.dispatched_geometry = Some(latest_geometry);
                }
            }
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: inner.id.clone(),
                terminal_id: terminal_id.clone(),
                state: HostTerminalState::Attached,
                reconnect_attempt: 0,
                retrying: false,
                error: None,
            });
            emit_diagnostic(&inner, operation, started_at, None, Some(terminal_id), None);
            inner.terminal_settled.notify_waiters();
            Ok(())
        }
        Err(error) => {
            if let Some(shell) = inner.state.lock().ssh_shells.get_mut(&terminal_id)
                && shell.desired_open
                && shell.operation_epoch == operation_epoch
            {
                shell.state = HostTerminalState::Failed;
                shell.dispatched_geometry = None;
                if !restoring {
                    shell.retry_running = false;
                }
            }
            let error = HostRuntimeError::from(error);
            emit_diagnostic(
                &inner,
                operation,
                started_at,
                None,
                Some(terminal_id.clone()),
                Some(error.to_string()),
            );
            inner.terminal_settled.notify_waiters();
            Err(error)
        }
    }
}

pub(super) async fn open_terminal_with_retry(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
    operation_epoch: u64,
) -> Result<(), HostRuntimeError> {
    let mut last_error = None;
    for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
        if attempt > 1 {
            if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                terminal.state = HostTerminalState::Opening;
                terminal.reconnect_attempt = attempt - 1;
                terminal.bridge_id = None;
            }
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: inner.id.clone(),
                terminal_id: terminal_id.clone(),
                state: HostTerminalState::Opening,
                reconnect_attempt: attempt - 1,
                retrying: true,
                error: last_error.as_ref().map(ToString::to_string),
            });
            tokio::time::sleep(Duration::from_millis(reconnect_delay(
                attempt - 1,
                runtime_jitter(&inner, attempt - 1),
            )))
            .await;
        }
        {
            let state = inner.state.lock();
            if state.explicit_disconnect
                || state.connection != HostConnectionState::Connected
                || state.terminals.get(&terminal_id).is_none_or(|terminal| {
                    terminal.operation_epoch != operation_epoch
                        || terminal.state == HostTerminalState::Closed
                })
            {
                return Err(HostRuntimeError::StaleOperation(format!(
                    "terminal {terminal_id} open was cancelled"
                )));
            }
        }
        match open_terminal_inner(inner.clone(), terminal_id.clone(), operation_epoch, false).await
        {
            Ok(()) => {
                if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                    terminal.retry_running = false;
                }
                return Ok(());
            }
            Err(error @ HostRuntimeError::StaleOperation(_)) => return Err(error),
            Err(error) => last_error = Some(error),
        }
    }
    if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
        terminal.retry_running = false;
    }
    inner.terminal_settled.notify_waiters();
    let error = last_error.unwrap_or_else(|| {
        HostRuntimeError::TerminalUnavailable(format!("terminal {terminal_id} failed to open"))
    });
    emit(HostRuntimeEvent::TerminalStateChanged {
        runtime_id: inner.id.clone(),
        terminal_id: terminal_id.clone(),
        state: HostTerminalState::Failed,
        reconnect_attempt: MAX_RECONNECT_ATTEMPTS,
        retrying: false,
        error: Some(format!("terminal recovery exhausted: {error}")),
    });
    Err(error)
}

pub(super) async fn restore_ssh_shells(inner: Arc<RuntimeInner>, epoch: u64) -> u32 {
    let (generation, shells) = {
        let mut state = inner.state.lock();
        let generation = state.generation;
        let shells = state
            .ssh_shells
            .iter_mut()
            .filter_map(|(id, shell)| {
                if !shell.desired_open {
                    return None;
                }
                shell.state = HostTerminalState::Restoring;
                shell.dispatched_geometry = None;
                shell.reconnect_attempt = 0;
                shell.retry_running = true;
                Some((id.clone(), shell.operation_epoch, shell.geometry))
            })
            .collect::<Vec<_>>();
        drop(state);
        (generation, shells)
    };
    let mut restored = 0;
    for (terminal_id, operation_epoch, geometry) in shells {
        emit(HostRuntimeEvent::TerminalStateChanged {
            runtime_id: inner.id.clone(),
            terminal_id: terminal_id.clone(),
            state: HostTerminalState::Restoring,
            reconnect_attempt: 0,
            retrying: true,
            error: None,
        });
        match open_ssh_shell_inner(
            inner.clone(),
            terminal_id.clone(),
            epoch,
            generation,
            operation_epoch,
            geometry,
            true,
        )
        .await
        {
            Ok(()) => restored += 1,
            Err(HostRuntimeError::StaleOperation(_)) => {}
            Err(error) => {
                if let Some(shell) = inner.state.lock().ssh_shells.get_mut(&terminal_id)
                    && shell.operation_epoch == operation_epoch
                {
                    shell.retry_running = false;
                }
                schedule_ssh_shell_retry(inner.clone(), terminal_id, error.to_string());
            }
        }
    }
    restored
}

pub(super) async fn restore_resources(inner: Arc<RuntimeInner>, epoch: u64) -> u32 {
    let event_requested = inner.state.lock().event.is_some();
    if event_requested {
        close_herdr_event_subscription(inner.id.clone());
        if let Err(error) = start_desired_events(inner.clone(), epoch).await {
            emit(HostRuntimeEvent::EventSubscriptionClosed {
                runtime_id: inner.id.clone(),
                reason: error.to_string(),
            });
            schedule_event_retry(inner.clone(), error.to_string());
        }
    }
    // Direct shells depend only on SSH, so do not delay them behind Herdr
    // readiness or terminal-bridge recovery.
    let mut restored = restore_ssh_shells(inner.clone(), epoch).await;
    let terminals = {
        let mut state = inner.state.lock();
        state
            .terminals
            .iter_mut()
            .filter_map(|(id, terminal)| {
                if terminal.state == HostTerminalState::Closed {
                    None
                } else {
                    terminal.state = HostTerminalState::Restoring;
                    terminal.reconnect_attempt = 0;
                    terminal.retry_running = true;
                    terminal.bridge_id = None;
                    Some((id.clone(), terminal.operation_epoch))
                }
            })
            .collect::<Vec<_>>()
    };
    for (terminal_id, operation_epoch) in terminals {
        emit(HostRuntimeEvent::TerminalStateChanged {
            runtime_id: inner.id.clone(),
            terminal_id: terminal_id.clone(),
            state: HostTerminalState::Restoring,
            reconnect_attempt: 0,
            retrying: true,
            error: None,
        });
        match open_terminal_inner(inner.clone(), terminal_id.clone(), operation_epoch, true).await {
            Ok(()) => {
                if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                    terminal.retry_running = false;
                }
                restored += 1;
            }
            Err(error) => {
                if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                    terminal.retry_running = false;
                }
                schedule_terminal_retry(inner.clone(), terminal_id, None, error.to_string());
            }
        }
    }
    restored
}

pub(super) fn schedule_ssh_shell_retry(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
    reason: String,
) {
    let (epoch, generation, operation_epoch, start_worker) = {
        let mut state = inner.state.lock();
        let epoch = state.epoch;
        let generation = state.generation;
        let connected = state.connection == HostConnectionState::Connected;
        let explicit_disconnect = state.explicit_disconnect;
        let Some(shell) = state.ssh_shells.get_mut(&terminal_id) else {
            return;
        };
        if !connected || explicit_disconnect || !shell.desired_open {
            return;
        }
        shell.state = HostTerminalState::Failed;
        let start_worker = !shell.retry_running;
        if start_worker {
            shell.retry_running = true;
            shell.reconnect_attempt = 0;
        }
        let operation_epoch = shell.operation_epoch;
        drop(state);
        (epoch, generation, operation_epoch, start_worker)
    };
    emit(HostRuntimeEvent::TerminalStateChanged {
        runtime_id: inner.id.clone(),
        terminal_id: terminal_id.clone(),
        state: HostTerminalState::Failed,
        reconnect_attempt: 0,
        retrying: true,
        error: Some(format!("SSH shell restore failed: {reason}")),
    });
    if !start_worker {
        return;
    }
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            let mut cancellation = inner.cancellation.subscribe();
            let mut last_error = reason;
            for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
                let delay_ms = reconnect_delay(attempt, runtime_jitter(&inner, attempt));
                {
                    let mut state = inner.state.lock();
                    let valid_host = state.epoch == epoch
                        && state.generation == generation
                        && state.connection == HostConnectionState::Connected
                        && !state.explicit_disconnect;
                    let Some(shell) = state.ssh_shells.get_mut(&terminal_id) else {
                        return;
                    };
                    if !valid_host
                        || !shell.desired_open
                        || shell.operation_epoch != operation_epoch
                    {
                        return;
                    }
                    shell.state = HostTerminalState::Restoring;
                    shell.reconnect_attempt = attempt;
                    shell.dispatched_geometry = None;
                    drop(state);
                }
                emit(HostRuntimeEvent::TerminalStateChanged {
                    runtime_id: inner.id.clone(),
                    terminal_id: terminal_id.clone(),
                    state: HostTerminalState::Restoring,
                    reconnect_attempt: attempt,
                    retrying: true,
                    error: Some(last_error.clone()),
                });
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                    changed = cancellation.changed() => {
                        let _ = changed;
                        return;
                    }
                }
                let geometry = {
                    let state = inner.state.lock();
                    if state.epoch != epoch
                        || state.generation != generation
                        || state.connection != HostConnectionState::Connected
                        || state.explicit_disconnect
                    {
                        return;
                    }
                    let Some(shell) = state.ssh_shells.get(&terminal_id) else {
                        return;
                    };
                    if !shell.desired_open || shell.operation_epoch != operation_epoch {
                        return;
                    }
                    let geometry = shell.geometry;
                    drop(state);
                    geometry
                };
                match open_ssh_shell_inner(
                    inner.clone(),
                    terminal_id.clone(),
                    epoch,
                    generation,
                    operation_epoch,
                    geometry,
                    true,
                )
                .await
                {
                    Ok(()) | Err(HostRuntimeError::StaleOperation(_)) => return,
                    Err(error) => last_error = error.to_string(),
                }
            }
            let retry_state = {
                let mut state = inner.state.lock();
                state.ssh_shells.get_mut(&terminal_id).and_then(|shell| {
                    (shell.desired_open && shell.operation_epoch == operation_epoch).then(|| {
                        shell.state = HostTerminalState::Failed;
                        shell.retry_running = false;
                        shell.reconnect_attempt = MAX_RECONNECT_ATTEMPTS;
                    })
                })
            };
            if retry_state.is_some() {
                inner.terminal_settled.notify_waiters();
                emit(HostRuntimeEvent::TerminalStateChanged {
                    runtime_id: inner.id.clone(),
                    terminal_id,
                    state: HostTerminalState::Failed,
                    reconnect_attempt: MAX_RECONNECT_ATTEMPTS,
                    retrying: false,
                    error: Some(format!("SSH shell recovery exhausted: {last_error}")),
                });
            }
        });
    }
}

pub(super) fn schedule_terminal_retry(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
    closed_bridge_id: Option<HerdrBridgeId>,
    reason: String,
) {
    let (epoch, operation_epoch, start_worker, reconnect_attempt, bridge_to_close) = {
        let mut state = inner.state.lock();
        let epoch = state.epoch;
        let explicit_disconnect = state.explicit_disconnect;
        let Some(terminal) = state.terminals.get_mut(&terminal_id) else {
            return;
        };
        if terminal.state == HostTerminalState::Closed || explicit_disconnect {
            return;
        }
        if closed_bridge_id.is_some_and(|bridge_id| terminal.bridge_id != Some(bridge_id)) {
            return;
        }
        let bridge_to_close = closed_bridge_id
            .is_none()
            .then_some(terminal.bridge_id)
            .flatten();
        terminal.bridge_id = None;
        terminal.state = HostTerminalState::Failed;
        let start_worker = !terminal.retry_running;
        if start_worker {
            terminal.retry_running = true;
            terminal.reconnect_attempt = 0;
        }
        let retry_state = (
            epoch,
            terminal.operation_epoch,
            start_worker,
            terminal.reconnect_attempt,
            bridge_to_close,
        );
        drop(state);
        retry_state
    };
    if let Some(bridge_id) = bridge_to_close {
        close_owned_herdr_terminal_bridge(&inner.id, &terminal_id, bridge_id);
    }
    emit(HostRuntimeEvent::TerminalStateChanged {
        runtime_id: inner.id.clone(),
        terminal_id: terminal_id.clone(),
        state: HostTerminalState::Failed,
        reconnect_attempt,
        retrying: true,
        error: Some(reason.clone()),
    });
    inner.terminal_settled.notify_waiters();
    if !start_worker {
        return;
    }
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            let mut last_error = reason;
            for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
                if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                    terminal.state = HostTerminalState::Restoring;
                    terminal.reconnect_attempt = attempt;
                    terminal.bridge_id = None;
                }
                emit(HostRuntimeEvent::TerminalStateChanged {
                    runtime_id: inner.id.clone(),
                    terminal_id: terminal_id.clone(),
                    state: HostTerminalState::Restoring,
                    reconnect_attempt: attempt,
                    retrying: true,
                    error: Some(last_error.clone()),
                });
                tokio::time::sleep(Duration::from_millis(reconnect_delay(
                    attempt,
                    runtime_jitter(&inner, attempt),
                )))
                .await;
                {
                    let state = inner.state.lock();
                    if state.epoch != epoch
                        || state.explicit_disconnect
                        || state.terminals.get(&terminal_id).is_none_or(|terminal| {
                            terminal.operation_epoch != operation_epoch
                                || terminal.state == HostTerminalState::Closed
                        })
                    {
                        return;
                    }
                }
                match open_terminal_inner(inner.clone(), terminal_id.clone(), operation_epoch, true)
                    .await
                {
                    Ok(()) => {
                        if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                            terminal.retry_running = false;
                        }
                        return;
                    }
                    Err(error) => last_error = error.to_string(),
                }
            }
            if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                terminal.retry_running = false;
            }
            inner.terminal_settled.notify_waiters();
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: inner.id.clone(),
                terminal_id,
                state: HostTerminalState::Failed,
                reconnect_attempt: MAX_RECONNECT_ATTEMPTS,
                retrying: false,
                error: Some(format!("terminal recovery exhausted: {last_error}")),
            });
        });
    }
}

#[uniffi::export]
impl HostRuntime {
    #[allow(
        clippy::too_many_arguments,
        reason = "the native terminal API keeps geometry fields explicit for UniFFI callers"
    )]
    pub async fn open_terminal(
        &self,
        terminal_id: String,
        takeover: bool,
        columns: u32,
        rows: u32,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let requested_geometry =
                    HostTerminalGeometry::normalized(columns, rows, cell_width_px, cell_height_px);
                let (operation_epoch, wait_for_existing) = {
                    let mut state = inner.state.lock();
                    let open_state = if let Some(terminal) = state.terminals.get_mut(&terminal_id) {
                        terminal.takeover = takeover;
                        terminal.columns = requested_geometry.columns;
                        terminal.rows = requested_geometry.rows;
                        terminal.cell_width_px = requested_geometry.cell_width_px;
                        terminal.cell_height_px = requested_geometry.cell_height_px;
                        if terminal.state == HostTerminalState::Attached {
                            let bridge_is_live = terminal.bridge_id.is_some_and(|bridge_id| {
                                active_herdr_terminal_bridge_id(&inner.id, &terminal_id)
                                    == Some(bridge_id)
                            });
                            if bridge_is_live {
                                return Ok(());
                            }
                            terminal.bridge_id = None;
                        }
                        if matches!(
                            terminal.state,
                            HostTerminalState::Opening | HostTerminalState::Restoring
                        ) {
                            (terminal.operation_epoch, true, false)
                        } else {
                            terminal.operation_epoch = terminal.operation_epoch.wrapping_add(1);
                            terminal.state = HostTerminalState::Opening;
                            terminal.reconnect_attempt = 0;
                            terminal.retry_running = true;
                            terminal.bridge_id = None;
                            (terminal.operation_epoch, false, true)
                        }
                    } else {
                        state.terminals.insert(
                            terminal_id.clone(),
                            TerminalRuntime {
                                state: HostTerminalState::Opening,
                                takeover,
                                columns: requested_geometry.columns,
                                rows: requested_geometry.rows,
                                cell_width_px: requested_geometry.cell_width_px,
                                cell_height_px: requested_geometry.cell_height_px,
                                operation_epoch: 1,
                                reconnect_attempt: 0,
                                retry_running: true,
                                bridge_id: None,
                            },
                        );
                        (1, false, true)
                    };
                    if open_state.2 {
                        state.terminal_dispatched_geometries.remove(&terminal_id);
                        state
                            .terminal_kitty_keyboard_report_all
                            .insert(terminal_id.clone(), false);
                    }
                    drop(state);
                    (open_state.0, open_state.1)
                };
                if wait_for_existing {
                    return wait_for_terminal_open(&inner, &terminal_id, operation_epoch).await;
                }
                emit(HostRuntimeEvent::TerminalStateChanged {
                    runtime_id: inner.id.clone(),
                    terminal_id: terminal_id.clone(),
                    state: HostTerminalState::Opening,
                    reconnect_attempt: 0,
                    retrying: true,
                    error: None,
                });
                open_terminal_with_retry(inner, terminal_id, operation_epoch).await
            })
            .await
            .map_err(|error| {
                HostRuntimeError::TerminalUnavailable(format!("terminal open task failed: {error}"))
            })?
    }

    pub fn terminal_input(
        &self,
        terminal_id: String,
        text: String,
    ) -> Result<(), HostRuntimeError> {
        if live_terminal_bridge_id(&self.inner, &terminal_id).is_none() {
            let reason = format!("terminal {terminal_id} has no live bridge");
            schedule_terminal_retry(
                self.inner.clone(),
                terminal_id.clone(),
                None,
                reason.clone(),
            );
            return Err(HostRuntimeError::TerminalUnavailable(format!(
                "terminal {terminal_id} is unavailable: {reason}"
            )));
        }
        herdr_terminal_input(self.inner.id.clone(), terminal_id.clone(), text).map_err(|error| {
            let reason = error.to_string();
            schedule_terminal_retry(
                self.inner.clone(),
                terminal_id.clone(),
                None,
                reason.clone(),
            );
            HostRuntimeError::TerminalUnavailable(reason)
        })
    }

    pub fn resize_terminal(
        &self,
        terminal_id: String,
        columns: u32,
        rows: u32,
        cell_width_px: u32,
        cell_height_px: u32,
        force_dispatch: bool,
    ) -> Result<HostTerminalResizeOutcome, HostRuntimeError> {
        let geometry =
            HostTerminalGeometry::normalized(columns, rows, cell_width_px, cell_height_px);
        let (attached, operation_epoch, deduplicated) = {
            let mut state = self.inner.state.lock();
            let terminal = state
                .terminals
                .entry(terminal_id.clone())
                .or_insert_with(|| TerminalRuntime {
                    state: HostTerminalState::Closed,
                    takeover: true,
                    columns: geometry.columns,
                    rows: geometry.rows,
                    cell_width_px: geometry.cell_width_px,
                    cell_height_px: geometry.cell_height_px,
                    operation_epoch: 0,
                    reconnect_attempt: 0,
                    retry_running: false,
                    bridge_id: None,
                });
            terminal.columns = geometry.columns;
            terminal.rows = geometry.rows;
            terminal.cell_width_px = geometry.cell_width_px;
            terminal.cell_height_px = geometry.cell_height_px;
            let attached = terminal.state == HostTerminalState::Attached;
            let operation_epoch = terminal.operation_epoch;
            let deduplicated = !force_dispatch
                && state.terminal_dispatched_geometries.get(&terminal_id) == Some(&geometry);
            drop(state);
            (attached, operation_epoch, deduplicated)
        };
        if !attached {
            return Ok(HostTerminalResizeOutcome::Deferred);
        }
        if deduplicated {
            return Ok(HostTerminalResizeOutcome::Deduplicated);
        }
        if live_terminal_bridge_id(&self.inner, &terminal_id).is_none() {
            let reason = format!("terminal {terminal_id} has no live bridge while resizing");
            schedule_terminal_retry(self.inner.clone(), terminal_id, None, reason.clone());
            return Err(HostRuntimeError::TerminalUnavailable(reason));
        }
        herdr_terminal_resize(
            self.inner.id.clone(),
            terminal_id.clone(),
            geometry.columns,
            geometry.rows,
            geometry.cell_width_px,
            geometry.cell_height_px,
        )
        .map_err(|error| {
            let reason = error.to_string();
            schedule_terminal_retry(
                self.inner.clone(),
                terminal_id.clone(),
                None,
                reason.clone(),
            );
            HostRuntimeError::TerminalUnavailable(reason)
        })?;
        let mut state = self.inner.state.lock();
        if state.terminals.get(&terminal_id).is_some_and(|terminal| {
            terminal.operation_epoch == operation_epoch
                && terminal.state == HostTerminalState::Attached
        }) {
            state
                .terminal_dispatched_geometries
                .insert(terminal_id, geometry);
        }
        drop(state);
        Ok(HostTerminalResizeOutcome::Dispatched)
    }

    pub fn terminal_geometry(&self, terminal_id: String) -> Option<HostTerminalGeometry> {
        self.inner
            .state
            .lock()
            .terminals
            .get(&terminal_id)
            .map(|terminal| {
                HostTerminalGeometry::normalized(
                    terminal.columns,
                    terminal.rows,
                    terminal.cell_width_px,
                    terminal.cell_height_px,
                )
            })
    }

    pub fn terminal_kitty_keyboard_report_all(&self, terminal_id: String) -> bool {
        self.inner
            .state
            .lock()
            .terminal_kitty_keyboard_report_all
            .get(&terminal_id)
            .copied()
            .unwrap_or(false)
    }

    pub fn scroll_terminal(
        &self,
        terminal_id: String,
        up: bool,
        lines: u32,
        column: Option<f64>,
        row: Option<f64>,
        modifiers: u8,
    ) -> Result<(), HostRuntimeError> {
        if live_terminal_bridge_id(&self.inner, &terminal_id).is_none() {
            let reason = format!("terminal {terminal_id} has no live bridge while scrolling");
            schedule_terminal_retry(self.inner.clone(), terminal_id, None, reason.clone());
            return Err(HostRuntimeError::TerminalUnavailable(reason));
        }
        herdr_terminal_scroll(
            self.inner.id.clone(),
            terminal_id.clone(),
            up,
            lines,
            column,
            row,
            modifiers,
        )
        .map_err(|error| {
            let reason = error.to_string();
            schedule_terminal_retry(self.inner.clone(), terminal_id, None, reason.clone());
            HostRuntimeError::TerminalUnavailable(reason)
        })
    }

    pub fn close_terminal(&self, terminal_id: String) {
        close_terminal_intent(&self.inner, terminal_id);
    }

    pub fn close_all_terminals(&self) {
        let terminal_ids = {
            let mut state = self.inner.state.lock();
            state.terminal_dispatched_geometries.clear();
            state.terminal_kitty_keyboard_report_all.clear();
            state
                .terminals
                .drain()
                .map(|(terminal_id, _)| terminal_id)
                .collect::<Vec<_>>()
        };
        close_all_herdr_terminal_bridges(self.inner.id.clone());
        for terminal_id in terminal_ids {
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: self.inner.id.clone(),
                terminal_id,
                state: HostTerminalState::Closed,
                reconnect_attempt: 0,
                retrying: false,
                error: None,
            });
        }
        self.inner.terminal_settled.notify_waiters();
    }

    pub fn has_terminal(&self, terminal_id: String) -> bool {
        live_terminal_bridge_id(&self.inner, &terminal_id).is_some()
    }

    pub fn is_terminal_opening(&self, terminal_id: String) -> bool {
        self.inner
            .state
            .lock()
            .terminals
            .get(&terminal_id)
            .is_some_and(|terminal| {
                matches!(
                    terminal.state,
                    HostTerminalState::Opening | HostTerminalState::Restoring
                )
            })
    }

    pub async fn open_ssh_shell(
        &self,
        terminal_id: String,
        columns: u32,
        rows: u32,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let requested_geometry =
                    HostTerminalGeometry::normalized(columns, rows, cell_width_px, cell_height_px);
                let (epoch, generation, operation_epoch, geometry, wait_for_existing) = {
                    let mut state = inner.state.lock();
                    if state.connection != HostConnectionState::Connected {
                        return Err(HostRuntimeError::RuntimeDisconnected(
                            "host runtime is not connected".to_owned(),
                        ));
                    }
                    let epoch = state.epoch;
                    let generation = state.generation;
                    let shell_is_live = state.ssh_shells.get(&terminal_id).is_some_and(|shell| {
                        shell.desired_open && shell.state == HostTerminalState::Attached
                    }) && current_ssh(&inner)
                        .is_ok_and(|ssh| ssh.has_shell(&terminal_id));
                    if shell_is_live {
                        return Ok(());
                    }
                    let shell = state
                        .ssh_shells
                        .entry(terminal_id.clone())
                        .or_insert_with(|| SshShellRuntime {
                            desired_open: true,
                            state: HostTerminalState::Closed,
                            geometry: requested_geometry,
                            dispatched_geometry: None,
                            operation_epoch: 0,
                            reconnect_attempt: 0,
                            retry_running: false,
                        });
                    shell.desired_open = true;
                    shell.geometry = requested_geometry;
                    let result = if matches!(
                        shell.state,
                        HostTerminalState::Opening | HostTerminalState::Restoring
                    ) || shell.retry_running
                    {
                        (
                            epoch,
                            generation,
                            shell.operation_epoch,
                            shell.geometry,
                            true,
                        )
                    } else {
                        shell.operation_epoch = shell.operation_epoch.wrapping_add(1);
                        shell.state = HostTerminalState::Opening;
                        shell.dispatched_geometry = None;
                        shell.reconnect_attempt = 0;
                        shell.retry_running = true;
                        (
                            epoch,
                            generation,
                            shell.operation_epoch,
                            shell.geometry,
                            false,
                        )
                    };
                    drop(state);
                    result
                };
                if wait_for_existing {
                    return wait_for_ssh_shell_open(&inner, &terminal_id, operation_epoch).await;
                }
                open_ssh_shell_inner(
                    inner.clone(),
                    terminal_id,
                    epoch,
                    generation,
                    operation_epoch,
                    geometry,
                    false,
                )
                .await
            })
            .await
            .map_err(|error| {
                HostRuntimeError::TerminalUnavailable(format!(
                    "SSH shell open task failed: {error}"
                ))
            })?
    }

    pub fn ssh_shell_input(
        &self,
        terminal_id: String,
        bytes: Vec<u8>,
    ) -> Result<(), HostRuntimeError> {
        current_ssh(&self.inner)?.shell_input(&terminal_id, bytes)?;
        Ok(())
    }

    pub fn resize_ssh_shell(
        &self,
        terminal_id: String,
        columns: u32,
        rows: u32,
        cell_width_px: u32,
        cell_height_px: u32,
        force_dispatch: bool,
    ) -> Result<HostTerminalResizeOutcome, HostRuntimeError> {
        let geometry =
            HostTerminalGeometry::normalized(columns, rows, cell_width_px, cell_height_px);
        let (attached, operation_epoch, deduplicated) = {
            let mut state = self.inner.state.lock();
            let shell = state
                .ssh_shells
                .entry(terminal_id.clone())
                .or_insert_with(|| SshShellRuntime {
                    desired_open: false,
                    state: HostTerminalState::Closed,
                    geometry,
                    dispatched_geometry: None,
                    operation_epoch: 0,
                    reconnect_attempt: 0,
                    retry_running: false,
                });
            shell.geometry = geometry;
            let result = (
                shell.state == HostTerminalState::Attached,
                shell.operation_epoch,
                !force_dispatch && shell.dispatched_geometry == Some(geometry),
            );
            drop(state);
            result
        };
        if !attached {
            return Ok(HostTerminalResizeOutcome::Deferred);
        }
        if deduplicated {
            return Ok(HostTerminalResizeOutcome::Deduplicated);
        }
        current_ssh(&self.inner)?.resize_shell(&terminal_id, geometry.columns, geometry.rows)?;
        if let Some(shell) = self.inner.state.lock().ssh_shells.get_mut(&terminal_id)
            && shell.operation_epoch == operation_epoch
            && shell.state == HostTerminalState::Attached
        {
            shell.dispatched_geometry = Some(geometry);
        }
        Ok(HostTerminalResizeOutcome::Dispatched)
    }

    pub fn close_ssh_shell(&self, terminal_id: String) {
        self.inner.state.lock().ssh_shells.remove(&terminal_id);
        if let Ok(ssh) = current_ssh(&self.inner) {
            let _ = ssh.close_shell(&terminal_id);
        }
        self.inner.terminal_settled.notify_waiters();
    }

    pub fn has_ssh_shell(&self, terminal_id: String) -> bool {
        self.inner
            .state
            .lock()
            .ssh_shells
            .get(&terminal_id)
            .is_some_and(|shell| shell.state == HostTerminalState::Attached)
            && current_ssh(&self.inner).is_ok_and(|ssh| ssh.has_shell(&terminal_id))
    }

    pub fn ssh_shell_geometry(&self, terminal_id: String) -> Option<HostTerminalGeometry> {
        self.inner
            .state
            .lock()
            .ssh_shells
            .get(&terminal_id)
            .map(|shell| shell.geometry)
    }
}
