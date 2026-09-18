//! SSH and Herdr connection lifecycle, recovery, and readiness.

use super::*;
use std::future::Future;
use std::time::Instant;

use crate::herdr_api::{
    HerdrControlError, HerdrControlRequest, HerdrControlResult, HerdrSessionSnapshot,
    request_on_runtime,
};
use crate::herdr_codec::{MAX_PROTOCOL, MIN_PROTOCOL};
use crate::herdr_connection::HerdrRequestReplay;
use crate::herdr_events::close_herdr_event_subscription;
use crate::herdr_terminal::close_all_herdr_terminal_bridges;
use crate::host_state::{ApplyResult, SnapshotToken, now_ms};
use crate::remote_ops::shell_quote;
use crate::ssh::{SshConnectionConfig, SshCredential, SshSession};

pub(super) fn validate_config(config: &HostRuntimeConfig) -> Result<(), HostRuntimeError> {
    for ssh in std::iter::once(&config.ssh).chain(config.jump_hosts.iter()) {
        if ssh.host.trim().is_empty() || ssh.username.trim().is_empty() || ssh.port == 0 {
            return Err(HostRuntimeError::InvalidConfiguration(
                "SSH host, username, and port are required".to_owned(),
            ));
        }
    }
    if let Some(path) = config.socket_path.as_deref()
        && !path.starts_with('/')
    {
        return Err(HostRuntimeError::InvalidConfiguration(
            "Herdr API socket override must be absolute".to_owned(),
        ));
    }
    Ok(())
}

pub(super) fn current_ssh(inner: &RuntimeInner) -> Result<Arc<SshSession>, HostRuntimeError> {
    inner.herdr.current_ssh().map_err(|error| {
        HostRuntimeError::RuntimeDisconnected(format!("host SSH transport is unavailable: {error}"))
    })
}

pub(super) fn current_generation(inner: &RuntimeInner) -> Result<u64, HostRuntimeError> {
    let state = inner.state.lock();
    if state.connection != HostConnectionState::Connected {
        return Err(HostRuntimeError::RuntimeDisconnected(
            "host runtime is not connected".to_owned(),
        ));
    }
    Ok(state.generation)
}

pub(super) fn validate_generation(
    inner: &RuntimeInner,
    generation: u64,
) -> Result<(), HostRuntimeError> {
    let state = inner.state.lock();
    if state.connection != HostConnectionState::Connected || state.generation != generation {
        return Err(HostRuntimeError::StaleOperation(
            "remote operation completed after its host connection was replaced".to_owned(),
        ));
    }
    drop(state);
    Ok(())
}

pub(super) fn ssh_config(config: &HostSshConfig) -> SshConnectionConfig {
    SshConnectionConfig {
        host: config.host.trim().to_owned(),
        port: config.port,
        username: config.username.trim().to_owned(),
        credential: match &config.credential {
            HostSshCredential::Password { password } => SshCredential::Password(password.clone()),
            HostSshCredential::Key {
                private_key,
                passphrase,
            } => SshCredential::Key {
                private_key: private_key.clone(),
                passphrase: passphrase.clone(),
            },
        },
        forward_agent: config.forward_agent,
    }
}

pub(super) async fn disconnect_sessions(sessions: Vec<Arc<SshSession>>) {
    for session in sessions.into_iter().rev() {
        session.disconnect().await;
    }
}

pub(super) fn observe_transport_lifecycle(
    inner: &Arc<RuntimeInner>,
    generation: u64,
    session: Arc<SshSession>,
) {
    let inner = Arc::downgrade(inner);
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            let reason = session.disconnected().await;
            if let Some(inner) = inner.upgrade() {
                begin_reconnect_for_generation(inner, Some(generation), reason, true);
            }
        });
    }
}

pub(super) async fn connect_chain(
    inner: &RuntimeInner,
) -> Result<(Arc<SshSession>, Vec<Arc<SshSession>>), HostRuntimeError> {
    let mut jumps: Vec<Arc<SshSession>> = Vec::new();
    for jump in &inner.config.jump_hosts {
        match SshSession::connect(&ssh_config(jump), jumps.last().map(Arc::as_ref)).await {
            Ok(session) => jumps.push(session),
            Err(error) => {
                disconnect_sessions(jumps).await;
                return Err(error.into());
            }
        }
    }
    match SshSession::connect(
        &ssh_config(&inner.config.ssh),
        jumps.last().map(Arc::as_ref),
    )
    .await
    {
        Ok(session) => Ok((session, jumps)),
        Err(error) => {
            disconnect_sessions(jumps).await;
            Err(error.into())
        }
    }
}

pub(super) async fn connect_chain_until_cancelled(
    inner: &RuntimeInner,
    cancellation: &mut watch::Receiver<u64>,
) -> Option<Result<(Arc<SshSession>, Vec<Arc<SshSession>>), HostRuntimeError>> {
    let mut jumps: Vec<Arc<SshSession>> = Vec::new();
    for jump in &inner.config.jump_hosts {
        let jump_config = ssh_config(jump);
        let connected = tokio::select! {
            biased;
            changed = cancellation.changed() => {
                let _ = changed;
                disconnect_sessions(jumps).await;
                return None;
            }
            result = SshSession::connect(&jump_config, jumps.last().map(Arc::as_ref)) => result,
        };
        match connected {
            Ok(session) => jumps.push(session),
            Err(error) => {
                disconnect_sessions(jumps).await;
                return Some(Err(error.into()));
            }
        }
    }
    let target_config = ssh_config(&inner.config.ssh);
    let connected = tokio::select! {
        biased;
        changed = cancellation.changed() => {
            let _ = changed;
            disconnect_sessions(jumps).await;
            return None;
        }
        result = SshSession::connect(
            &target_config,
            jumps.last().map(Arc::as_ref),
        ) => result,
    };
    Some(match connected {
        Ok(session) => Ok((session, jumps)),
        Err(error) => {
            disconnect_sessions(jumps).await;
            Err(error.into())
        }
    })
}

pub(super) async fn finish_connection(
    inner: Arc<RuntimeInner>,
    epoch: u64,
    ssh: Arc<SshSession>,
    jumps: Vec<Arc<SshSession>>,
    restoring: bool,
) -> Result<u32, HostRuntimeError> {
    let installed = {
        let mut state = inner.state.lock();
        if !state.install_connection(epoch) {
            None
        } else {
            let generation = state.generation;
            let old_ssh = inner.herdr.install(generation, ssh.clone());
            drop(state);
            let old_jumps = std::mem::replace(&mut *inner.jump_sessions.lock(), jumps.clone());
            Some((old_ssh, old_jumps))
        }
    };
    let Some((old_ssh, old_jumps)) = installed else {
        ssh.disconnect().await;
        disconnect_sessions(jumps).await;
        return Err(HostRuntimeError::StaleOperation(
            "stale host connection completed after a newer lifecycle operation".to_owned(),
        ));
    };
    if let Some(old_ssh) = old_ssh {
        old_ssh.disconnect().await;
    }
    disconnect_sessions(old_jumps).await;
    let generation = inner.state.lock().generation;
    observe_transport_lifecycle(&inner, generation, ssh);
    for jump in jumps {
        observe_transport_lifecycle(&inner, generation, jump);
    }
    inner.agents.connected();
    publish_lifecycle_status(&inner);
    emit_host_state(&inner);
    let restored = if restoring {
        restore_resources(inner.clone(), epoch).await
    } else {
        0
    };
    let _ = refresh_host_state_inner(inner.clone()).await;
    {
        let state = inner.state.lock();
        if state.epoch != epoch || state.connection != HostConnectionState::Connected {
            return Err(HostRuntimeError::StaleOperation(
                "host state sync was superseded by another lifecycle operation".to_owned(),
            ));
        }
    }
    Ok(restored)
}

pub(super) async fn initial_connect(inner: Arc<RuntimeInner>) -> Result<(), HostRuntimeError> {
    let (epoch, existing) = {
        let mut state = inner.state.lock();
        match state.connection {
            HostConnectionState::Connected => return Ok(()),
            HostConnectionState::Connecting | HostConnectionState::Reconnecting => {
                (state.epoch, Some(inner.status_tx.subscribe()))
            }
            _ => {
                let epoch = state.begin_connect()?;
                inner.status_tx.send_replace(state.status());
                drop(state);
                (epoch, None)
            }
        }
    };
    if let Some(status) = existing {
        return wait_for_reconnect(status).await;
    }
    let _ = inner.cancellation.send(epoch);
    publish_lifecycle_status(&inner);
    let started_at = Instant::now();
    match connect_chain(&inner).await {
        Ok((ssh, jumps)) => {
            emit_diagnostic(
                &inner,
                RuntimeDiagnosticOperation::SshConnect,
                started_at,
                None,
                None,
                None,
            );
            finish_connection(inner.clone(), epoch, ssh, jumps, false)
                .await
                .map(|_| ())
        }
        Err(error) => {
            let mut state = inner.state.lock();
            if state.epoch == epoch {
                state.connection = HostConnectionState::Failed;
                state.last_error = Some(error.to_string());
                state.host_state.mark_reconnecting(error.to_string());
            }
            drop(state);
            publish_lifecycle_status(&inner);
            emit_host_state(&inner);
            emit_diagnostic(
                &inner,
                RuntimeDiagnosticOperation::SshConnect,
                started_at,
                None,
                None,
                Some(error.to_string()),
            );
            Err(error)
        }
    }
}

pub(super) fn backoff_upper_bound(attempt: u32) -> u64 {
    INITIAL_RECONNECT_DELAY_MS
        .saturating_mul(1_u64 << attempt.saturating_sub(1).min(20))
        .min(MAX_RECONNECT_DELAY_MS)
}

pub(super) fn reconnect_delay(attempt: u32, random_unit: f64) -> u64 {
    let random_unit = random_unit.clamp(0.0, 1.0);
    let delay = Duration::from_millis(backoff_upper_bound(attempt))
        .mul_f64(0.5 + random_unit * 0.5)
        .saturating_add(Duration::from_micros(500));
    u64::try_from(delay.as_millis()).unwrap_or(MAX_RECONNECT_DELAY_MS)
}

pub(super) fn runtime_jitter(inner: &RuntimeInner, attempt: u32) -> f64 {
    let value = inner.id.bytes().fold(
        u64::from(attempt).wrapping_mul(0x9e37_79b9),
        |hash, byte| hash.rotate_left(5) ^ u64::from(byte),
    );
    f64::from(u32::try_from(value % 10_000).unwrap_or_default()) / 9_999.0
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ReconnectPhase {
    Fast,
    Persistent,
}

impl ReconnectPhase {
    fn label(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Persistent => "persistent",
        }
    }

    fn diagnostic_operation(self) -> RuntimeDiagnosticOperation {
        match self {
            Self::Fast => RuntimeDiagnosticOperation::SshReconnectFast,
            Self::Persistent => RuntimeDiagnosticOperation::SshReconnectPersistent,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ReconnectAttempt {
    pub(super) total: u32,
    pub(super) phase: ReconnectPhase,
    pub(super) phase_attempt: u32,
    pub(super) delay_ms: u64,
}

pub(super) fn persistent_reconnect_delay(attempt: u32, random_unit: f64) -> u64 {
    let upper_bound = INITIAL_PERSISTENT_RECONNECT_DELAY_MS
        .saturating_mul(1_u64 << attempt.saturating_sub(1).min(2))
        .min(MAX_PERSISTENT_RECONNECT_DELAY_MS);
    let random_unit = random_unit.clamp(0.0, 1.0);
    let delay = Duration::from_millis(upper_bound)
        .mul_f64(0.75 + random_unit * 0.25)
        .saturating_add(Duration::from_micros(500));
    u64::try_from(delay.as_millis()).unwrap_or(MAX_PERSISTENT_RECONNECT_DELAY_MS)
}

pub(super) fn reconnect_attempt(total: u32, immediate: bool, random_unit: f64) -> ReconnectAttempt {
    if total <= MAX_RECONNECT_ATTEMPTS {
        ReconnectAttempt {
            total,
            phase: ReconnectPhase::Fast,
            phase_attempt: total,
            delay_ms: if immediate && total == 1 {
                0
            } else {
                reconnect_delay(total, random_unit)
            },
        }
    } else {
        let phase_attempt = total.saturating_sub(MAX_RECONNECT_ATTEMPTS);
        ReconnectAttempt {
            total,
            phase: ReconnectPhase::Persistent,
            phase_attempt,
            delay_ms: persistent_reconnect_delay(phase_attempt, random_unit),
        }
    }
}

pub(super) async fn wait_for_reconnect_delay(
    inner: &RuntimeInner,
    delay_ms: u64,
    cancellation: &mut watch::Receiver<u64>,
) -> bool {
    if delay_ms == 0 {
        return true;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(delay_ms);
    loop {
        tokio::select! {
            () = tokio::time::sleep_until(deadline) => return true,
            changed = cancellation.changed() => {
                let _ = changed;
                return false;
            }
            () = inner.reconnect_wakeup.notified() => {
                if inner.monitoring.lock().health_enabled() {
                    return true;
                }
            }
        }
    }
}

pub(super) fn begin_reconnect_for_generation(
    inner: Arc<RuntimeInner>,
    expected_generation: Option<u64>,
    reason: String,
    immediate: bool,
) -> bool {
    let Some((epoch, generation)) = ({
        let mut state = inner.state.lock();
        state.begin_reconnect(expected_generation, &reason)
    }) else {
        return false;
    };
    let ssh = inner.herdr.clear(generation);
    let jumps = std::mem::take(&mut *inner.jump_sessions.lock());
    invalidate_remote_operations(&inner, generation, &reason);
    let _ = inner.cancellation.send(epoch);
    inner.agents.disconnected(false, &reason);
    publish_lifecycle_status(&inner);
    emit_host_state(&inner);
    crate::runtime()
        .ok()
        .map(|runtime| {
            runtime.spawn(async move {
                if let Some(ssh) = ssh {
                    ssh.disconnect().await;
                }
                disconnect_sessions(jumps).await;
                reconnect_loop(inner, epoch, reason, immediate).await;
            });
        })
        .is_some()
}

pub(super) fn begin_reconnect(inner: Arc<RuntimeInner>, reason: String, immediate: bool) -> bool {
    begin_reconnect_for_generation(inner, None, reason, immediate)
}

pub(super) fn record_reconnect_failure(
    inner: &RuntimeInner,
    epoch: u64,
    attempt: u32,
    error: &str,
) -> bool {
    let mut state = inner.state.lock();
    if state.epoch != epoch || state.explicit_disconnect || !state.reconnect_running {
        return false;
    }
    state.connection = HostConnectionState::Reconnecting;
    state.reconnect_attempt = attempt;
    state.last_error = Some(error.to_owned());
    state.host_state.mark_reconnecting(error.to_owned());
    true
}

pub(super) async fn reconnect_loop(
    inner: Arc<RuntimeInner>,
    epoch: u64,
    initial_reason: String,
    immediate: bool,
) {
    let started_at = Instant::now();
    close_herdr_event_subscription(inner.id.clone());
    close_all_herdr_terminal_bridges(inner.id.clone());
    let mut cancellation = inner.cancellation.subscribe();
    let mut last_error = initial_reason;
    let mut total_attempt = 1_u32;
    loop {
        let attempt = reconnect_attempt(
            total_attempt,
            immediate,
            runtime_jitter(&inner, total_attempt),
        );
        {
            let mut state = inner.state.lock();
            if state.epoch != epoch || state.explicit_disconnect {
                return;
            }
            state.reconnect_attempt = attempt.total;
            state.last_error = Some(last_error.clone());
        }
        publish_lifecycle_status(&inner);
        let scheduled_reason = format!(
            "{} SSH reconnect attempt {}: {}",
            attempt.phase.label(),
            attempt.phase_attempt,
            last_error
        );
        emit(HostRuntimeEvent::ReconnectScheduled {
            runtime_id: inner.id.clone(),
            attempt: attempt.total,
            delay_ms: attempt.delay_ms,
            reason: scheduled_reason,
        });
        if !wait_for_reconnect_delay(&inner, attempt.delay_ms, &mut cancellation).await {
            return;
        }
        let attempt_started_at = Instant::now();
        let Some(connection) = connect_chain_until_cancelled(&inner, &mut cancellation).await
        else {
            return;
        };
        match connection {
            Ok((ssh, jumps)) => {
                match finish_connection(inner.clone(), epoch, ssh, jumps, true).await {
                    Ok(restored) => {
                        let generation = inner.state.lock().generation;
                        emit(HostRuntimeEvent::Reconnected {
                            runtime_id: inner.id.clone(),
                            generation,
                            restored_terminals: restored,
                        });
                        emit_diagnostic(
                            &inner,
                            RuntimeDiagnosticOperation::SshReconnect,
                            started_at,
                            None,
                            None,
                            None,
                        );
                        return;
                    }
                    Err(_) => return,
                }
            }
            Err(error) => {
                last_error = error.to_string();
                if !record_reconnect_failure(&inner, epoch, attempt.total, &last_error) {
                    return;
                }
                publish_lifecycle_status(&inner);
                emit_host_state(&inner);
                emit_diagnostic(
                    &inner,
                    attempt.phase.diagnostic_operation(),
                    attempt_started_at,
                    None,
                    None,
                    Some(format!(
                        "{} SSH reconnect attempt {} failed: {last_error}",
                        attempt.phase.label(),
                        attempt.phase_attempt
                    )),
                );
            }
        }
        total_attempt = total_attempt.saturating_add(1);
    }
}

pub(super) async fn wait_for_reconnect(
    mut status_rx: watch::Receiver<HostRuntimeStatus>,
) -> Result<(), HostRuntimeError> {
    loop {
        let status = status_rx.borrow_and_update().clone();
        match status.state {
            HostConnectionState::Connected => return Ok(()),
            HostConnectionState::Reconnecting | HostConnectionState::Connecting => {}
            HostConnectionState::Failed => {
                return Err(HostRuntimeError::ReconnectExhausted(
                    status
                        .error
                        .unwrap_or_else(|| "host reconnect failed".to_owned()),
                ));
            }
            _ => {
                return Err(HostRuntimeError::RuntimeDisconnected(
                    "host runtime is disconnected".to_owned(),
                ));
            }
        }
        status_rx.changed().await.map_err(|_| {
            HostRuntimeError::RuntimeDisconnected(
                "host runtime lifecycle ended while waiting for reconnect".to_owned(),
            )
        })?;
    }
}

pub(super) fn is_transport_control_error(error: &HerdrControlError) -> bool {
    matches!(
        error,
        HerdrControlError::TransportDisconnected(_) | HerdrControlError::RequestTimeout(_)
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RecoveryScope {
    Herdr,
    Ssh,
}

pub(super) fn recovery_scope_for_transport_state(
    error: &HerdrControlError,
    ssh_alive: bool,
) -> RecoveryScope {
    match error {
        HerdrControlError::RequestTimeout(_) | HerdrControlError::TransportDisconnected(_)
            if ssh_alive =>
        {
            RecoveryScope::Herdr
        }
        _ => RecoveryScope::Ssh,
    }
}

pub(super) async fn confirm_ssh_health(
    inner: &Arc<RuntimeInner>,
    generation: u64,
) -> Result<(), HostRuntimeError> {
    let started_at = Instant::now();
    let result = match current_ssh(inner) {
        Ok(ssh) => ssh.latency_ms().await.map(|_| ()).map_err(Into::into),
        Err(error) => Err(error),
    }
    .and_then(|()| validate_generation(inner, generation));
    emit_diagnostic(
        inner,
        RuntimeDiagnosticOperation::HostLatencyProbe,
        started_at,
        None,
        None,
        result.as_ref().err().map(ToString::to_string),
    );
    result
}

pub(super) async fn recover_herdr_only(
    inner: Arc<RuntimeInner>,
    generation: u64,
    observed_revision: u64,
) -> Result<(), HostRuntimeError> {
    let _recovery = inner.herdr_recovery.lock().await;
    validate_generation(&inner, generation)?;
    {
        let state = inner.state.lock();
        if state.herdr_recovery_revision != observed_revision {
            return state.herdr_recovery_error.clone().map_or(Ok(()), |error| {
                Err(HostRuntimeError::HerdrUnavailable(error))
            });
        }
    }

    let started_at = Instant::now();
    emit_diagnostic_started(&inner, RuntimeDiagnosticOperation::HerdrRecovery, None);
    let result = start_herdr_server_inner(inner.clone()).await;
    {
        let mut state = inner.state.lock();
        if state.connection == HostConnectionState::Connected && state.generation == generation {
            state.herdr_recovery_revision = state.herdr_recovery_revision.wrapping_add(1);
            state.herdr_recovery_error = result.as_ref().err().map(ToString::to_string);
        }
    }
    emit_diagnostic(
        &inner,
        RuntimeDiagnosticOperation::HerdrRecovery,
        started_at,
        None,
        None,
        result.as_ref().err().map(|error| {
            format!("Herdr-only recovery failed while SSH remained installed: {error}")
        }),
    );
    result
}

async fn recover_control_failure(
    inner: Arc<RuntimeInner>,
    generation: u64,
    error: &HerdrControlError,
) -> RecoveryScope {
    let ssh_alive = current_ssh(&inner).is_ok_and(|ssh| ssh.is_alive());
    let mut scope = recovery_scope_for_transport_state(error, ssh_alive);
    if matches!(error, HerdrControlError::RequestTimeout(_)) && scope == RecoveryScope::Herdr {
        scope = if confirm_ssh_health(&inner, generation).await.is_ok() {
            RecoveryScope::Herdr
        } else {
            RecoveryScope::Ssh
        };
    }
    scope
}

pub(super) fn idempotent_replay(request: &HerdrControlRequest) -> bool {
    matches!(
        request,
        HerdrControlRequest::WorkspaceFocus { .. }
            | HerdrControlRequest::TabFocus { .. }
            | HerdrControlRequest::PaneFocus { .. }
            | HerdrControlRequest::AgentFocus { .. }
    )
}

pub(super) fn safe_control_replay(request: &HerdrControlRequest) -> bool {
    idempotent_replay(request)
        || matches!(
            request,
            HerdrControlRequest::Ping
                | HerdrControlRequest::SessionSnapshot
                | HerdrControlRequest::PaneRead { .. }
        )
}

pub(super) fn request_replay(request: &HerdrControlRequest) -> HerdrRequestReplay {
    if safe_control_replay(request) {
        HerdrRequestReplay::AfterSocketRediscovery
    } else {
        HerdrRequestReplay::Never
    }
}

pub(super) fn update_server_from_result(inner: &RuntimeInner, result: &HerdrControlResult) {
    let protocol = match result {
        HerdrControlResult::Pong { protocol, .. } => Some(*protocol),
        HerdrControlResult::SessionSnapshot { snapshot } => Some(snapshot.protocol),
        _ => None,
    };
    if let Some(protocol) = protocol {
        inner.state.lock().protocol = Some(protocol);
    }
}

pub(super) async fn ensure_herdr_server(inner: &Arc<RuntimeInner>) -> Result<(), HostRuntimeError> {
    if inner.state.lock().protocol.is_some() {
        return Ok(());
    }
    let result = request_on_runtime(
        inner.herdr.clone(),
        HerdrControlRequest::Ping,
        HerdrRequestReplay::AfterSocketRediscovery,
    )
    .await;
    let result = result.map_err(|error| HostRuntimeError::HerdrUnavailable(error.to_string()))?;
    update_server_from_result(inner, &result);
    if inner.state.lock().protocol.is_none() {
        return Err(HostRuntimeError::HerdrUnavailable(
            "Herdr ping response did not include a protocol".to_owned(),
        ));
    }
    Ok(())
}

pub(super) async fn control_request_inner(
    inner: Arc<RuntimeInner>,
    request: HerdrControlRequest,
) -> Result<HerdrControlResult, HerdrControlError> {
    let request_for_state = request.clone();
    let pane_close_terminal_id = match &request {
        HerdrControlRequest::PaneClose { pane_id } => {
            inner.state.lock().host_state.terminal_id_for_pane(pane_id)
        }
        _ => None,
    };
    let generation = {
        let state = inner.state.lock();
        if state.connection != HostConnectionState::Connected {
            return Err(HerdrControlError::TransportDisconnected(format!(
                "host runtime is {:?}",
                state.connection
            )));
        }
        state.generation
    };
    let started_at = Instant::now();
    let result = request_on_runtime(
        inner.herdr.clone(),
        request.clone(),
        request_replay(&request),
    )
    .await;
    emit_slow_or_failed_diagnostic(
        &inner,
        RuntimeDiagnosticOperation::HerdrRequest,
        started_at,
        result.as_ref().err().map(ToString::to_string),
    );
    match result {
        Ok(result) => {
            update_server_from_result(&inner, &result);
            reconcile_control_result(
                &inner,
                &request_for_state,
                &result,
                pane_close_terminal_id.as_deref(),
            );
            Ok(result)
        }
        Err(error) if is_transport_control_error(&error) => {
            // Snapshot reads are authoritative but side-effect free. Preserve
            // the last known host state and let the caller's existing resync
            // policy decide when to retry; in particular, do not recursively
            // enter Herdr recovery while recovery itself reconciles events.
            if matches!(request_for_state, HerdrControlRequest::SessionSnapshot) {
                return Err(error);
            }
            let reason = error.to_string();
            match recover_control_failure(inner.clone(), generation, &error).await {
                RecoveryScope::Herdr => {
                    let recovery_revision = inner.state.lock().herdr_recovery_revision;
                    let recovered = Box::pin(recover_herdr_only(
                        inner.clone(),
                        generation,
                        recovery_revision,
                    ))
                    .await;
                    if recovered.is_err() && current_ssh(&inner).is_err() {
                        begin_reconnect_for_generation(
                            inner.clone(),
                            Some(generation),
                            format!(
                                "confirmed SSH transport failure after Herdr recovery: {reason}"
                            ),
                            true,
                        );
                    }
                    if recovered.is_ok() && idempotent_replay(&request) {
                        let result = request_on_runtime(
                            inner.herdr.clone(),
                            request,
                            request_replay(&request_for_state),
                        )
                        .await?;
                        update_server_from_result(&inner, &result);
                        reconcile_control_result(
                            &inner,
                            &request_for_state,
                            &result,
                            pane_close_terminal_id.as_deref(),
                        );
                        Ok(result)
                    } else {
                        Err(error)
                    }
                }
                RecoveryScope::Ssh => {
                    let status_rx = inner.status_tx.subscribe();
                    begin_reconnect_for_generation(
                        inner.clone(),
                        Some(generation),
                        format!("confirmed SSH transport failure: {reason}"),
                        true,
                    );
                    if idempotent_replay(&request) {
                        wait_for_reconnect(status_rx).await.map_err(|error| {
                            HerdrControlError::TransportDisconnected(error.to_string())
                        })?;
                        let result = request_on_runtime(
                            inner.herdr.clone(),
                            request,
                            request_replay(&request_for_state),
                        )
                        .await?;
                        update_server_from_result(&inner, &result);
                        reconcile_control_result(
                            &inner,
                            &request_for_state,
                            &result,
                            pane_close_terminal_id.as_deref(),
                        );
                        Ok(result)
                    } else {
                        Err(error)
                    }
                }
            }
        }
        Err(error) => Err(error),
    }
}

pub(super) fn start_herdr_server_command(herdr_command: &str, session_name: &str) -> String {
    let herdr_command = herdr_command.trim();
    let mut base = shell_quote(if herdr_command.is_empty() {
        "herdr"
    } else {
        herdr_command
    });
    if !session_name.trim().is_empty() {
        base.push_str(" --session ");
        base.push_str(&shell_quote(session_name.trim()));
    }
    let command = format!("nohup {base} server >/tmp/whip-herdr-server.log 2>&1 </dev/null &");
    let bootstrap = r#"exec "${SHELL:-/bin/sh}" -lc "$1""#;
    format!(
        "exec /bin/sh -c {} whip {}",
        shell_quote(bootstrap),
        shell_quote(&command)
    )
}

pub(super) struct ReadyHerdrSnapshot {
    pub(super) snapshot: HerdrSessionSnapshot,
}

pub(super) enum HerdrReadinessProbeError {
    Retryable(String),
    Permanent(HostRuntimeError),
}

pub(super) enum HerdrReadinessPollError {
    Timeout(String),
    Permanent(HostRuntimeError),
}

pub(super) fn herdr_protocol_label() -> String {
    format!("{MIN_PROTOCOL}\u{2013}{MAX_PROTOCOL}")
}

pub(super) fn herdr_readiness_timeout(last_error: impl Into<String>) -> HostRuntimeError {
    HostRuntimeError::HerdrReadinessTimeout {
        timeout_ms: u64::try_from(HERDR_READINESS_TIMEOUT.as_millis()).unwrap_or(u64::MAX),
        last_error: last_error.into(),
    }
}

pub(super) fn validate_herdr_protocol(protocol: u32) -> Result<(), HostRuntimeError> {
    if (MIN_PROTOCOL..=MAX_PROTOCOL).contains(&protocol) {
        Ok(())
    } else {
        Err(HostRuntimeError::HerdrProtocolMismatch {
            expected: herdr_protocol_label(),
            received: protocol,
        })
    }
}

pub(super) fn readiness_probe_error(
    inner: &RuntimeInner,
    generation: u64,
    error: HerdrControlError,
) -> HerdrReadinessProbeError {
    if let Err(error) = validate_generation(inner, generation) {
        return HerdrReadinessProbeError::Permanent(error);
    }
    if let Err(error) = current_ssh(inner) {
        return HerdrReadinessProbeError::Permanent(error);
    }
    match error {
        HerdrControlError::TransportDisconnected(message)
        | HerdrControlError::RequestTimeout(message) => {
            HerdrReadinessProbeError::Retryable(message)
        }
        error => HerdrReadinessProbeError::Permanent(HostRuntimeError::ControlConnectionFailure(
            error.to_string(),
        )),
    }
}

pub(super) async fn probe_herdr_readiness(
    inner: Arc<RuntimeInner>,
    generation: u64,
) -> Result<ReadyHerdrSnapshot, HerdrReadinessProbeError> {
    validate_generation(&inner, generation).map_err(HerdrReadinessProbeError::Permanent)?;
    let request = HerdrControlRequest::SessionSnapshot;
    let result = request_on_runtime(
        inner.herdr.clone(),
        request,
        HerdrRequestReplay::AfterSocketRediscovery,
    )
    .await;
    validate_generation(&inner, generation).map_err(HerdrReadinessProbeError::Permanent)?;
    let result = result.map_err(|error| readiness_probe_error(&inner, generation, error))?;
    let HerdrControlResult::SessionSnapshot { snapshot } = result else {
        return Err(HerdrReadinessProbeError::Permanent(
            HostRuntimeError::ControlConnectionFailure(
                "Herdr returned an unexpected result for session.snapshot".to_owned(),
            ),
        ));
    };
    validate_herdr_protocol(snapshot.protocol).map_err(HerdrReadinessProbeError::Permanent)?;
    Ok(ReadyHerdrSnapshot { snapshot })
}

pub(super) async fn bounded_readiness_probe(
    inner: Arc<RuntimeInner>,
    generation: u64,
    deadline: Instant,
) -> Result<ReadyHerdrSnapshot, HerdrReadinessProbeError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(HerdrReadinessProbeError::Retryable(
            "Herdr readiness deadline expired".to_owned(),
        ));
    }
    match tokio::time::timeout(
        remaining.min(HERDR_READINESS_ATTEMPT_TIMEOUT),
        probe_herdr_readiness(inner, generation),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(HerdrReadinessProbeError::Retryable(
            "Herdr readiness probe timed out".to_owned(),
        )),
    }
}

pub(super) async fn poll_herdr_readiness<F, Fut>(
    deadline: Instant,
    initial_backoff: Duration,
    max_backoff: Duration,
    mut probe: F,
) -> Result<ReadyHerdrSnapshot, HerdrReadinessPollError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<ReadyHerdrSnapshot, HerdrReadinessProbeError>>,
{
    let mut backoff = initial_backoff;
    loop {
        let last_error = match probe().await {
            Ok(ready) => return Ok(ready),
            Err(HerdrReadinessProbeError::Permanent(error)) => {
                return Err(HerdrReadinessPollError::Permanent(error));
            }
            Err(HerdrReadinessProbeError::Retryable(error)) => error,
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(HerdrReadinessPollError::Timeout(last_error));
        }
        tokio::time::sleep(backoff.min(remaining)).await;
        backoff = backoff.saturating_mul(2).min(max_backoff);
    }
}

pub(super) fn fail_herdr_startup_sync(
    inner: &RuntimeInner,
    token: SnapshotToken,
    error: &HostRuntimeError,
) {
    inner
        .state
        .lock()
        .host_state
        .fail_sync(token, error.to_string());
    emit_host_state(inner);
}

pub(super) async fn complete_herdr_startup_sync(
    inner: Arc<RuntimeInner>,
    generation: u64,
    token: SnapshotToken,
    ready: ReadyHerdrSnapshot,
) -> Result<(), HostRuntimeError> {
    let outcome = {
        let mut state = inner.state.lock();
        if state.connection != HostConnectionState::Connected || state.generation != generation {
            return Err(HostRuntimeError::StaleOperation(
                "Herdr startup completed after its host connection was replaced".to_owned(),
            ));
        }
        state.protocol = Some(ready.snapshot.protocol);
        state
            .host_state
            .complete_sync(token, ready.snapshot, now_ms())
    };
    emit_host_state(&inner);
    if matches!(outcome, ApplyResult::IgnoredStale) {
        return Err(HostRuntimeError::StaleOperation(
            "Herdr startup state sync was superseded by a newer host-state operation".to_owned(),
        ));
    }
    reconcile_host_state_subscription(inner.clone(), generation, outcome).await;
    validate_generation(&inner, generation)?;
    let projection = inner.state.lock().host_state.projection();
    if projection.snapshot.is_none() {
        return Err(HostRuntimeError::HerdrUnavailable(
            projection
                .error
                .unwrap_or_else(|| "Herdr startup did not produce host state".to_owned()),
        ));
    }
    Ok(())
}

pub(super) async fn start_herdr_server_inner(
    inner: Arc<RuntimeInner>,
) -> Result<(), HostRuntimeError> {
    let _startup = inner.herdr_startup.lock().await;
    let generation = current_generation(&inner)?;
    let (_, token) = begin_host_state_sync(&inner);
    let deadline = Instant::now() + HERDR_READINESS_TIMEOUT;

    match bounded_readiness_probe(inner.clone(), generation, deadline).await {
        Ok(ready) => {
            return complete_herdr_startup_sync(inner.clone(), generation, token, ready).await;
        }
        Err(HerdrReadinessProbeError::Permanent(error)) => {
            fail_herdr_startup_sync(&inner, token, &error);
            return Err(error);
        }
        Err(HerdrReadinessProbeError::Retryable(_)) => {}
    }

    validate_generation(&inner, generation)?;
    let command =
        start_herdr_server_command(&inner.config.herdr_command, &inner.config.session_name);
    let ssh = current_ssh(&inner)?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    let output = match tokio::time::timeout(remaining, ssh.execute(&command)).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            let error = current_ssh(&inner)
                .err()
                .unwrap_or_else(|| HostRuntimeError::from(error));
            fail_herdr_startup_sync(&inner, token, &error);
            return Err(error);
        }
        Err(_) => {
            let error = herdr_readiness_timeout("Herdr server start command did not complete");
            fail_herdr_startup_sync(&inner, token, &error);
            return Err(error);
        }
    };
    validate_generation(&inner, generation)?;
    if output.exit_status.is_some_and(|status| status != 0) {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let error = HostRuntimeError::HerdrUnavailable(if detail.is_empty() {
            format!(
                "Herdr server start command exited with status {}",
                output.exit_status.unwrap_or_default()
            )
        } else {
            format!(
                "Herdr server start command exited with status {}: {detail}",
                output.exit_status.unwrap_or_default()
            )
        });
        fail_herdr_startup_sync(&inner, token, &error);
        return Err(error);
    }

    let readiness = poll_herdr_readiness(
        deadline,
        HERDR_READINESS_INITIAL_BACKOFF,
        HERDR_READINESS_MAX_BACKOFF,
        || bounded_readiness_probe(inner.clone(), generation, deadline),
    )
    .await;
    match readiness {
        Ok(ready) => complete_herdr_startup_sync(inner.clone(), generation, token, ready).await,
        Err(HerdrReadinessPollError::Permanent(error)) => {
            fail_herdr_startup_sync(&inner, token, &error);
            Err(error)
        }
        Err(HerdrReadinessPollError::Timeout(last_error)) => {
            let error = herdr_readiness_timeout(last_error);
            fail_herdr_startup_sync(&inner, token, &error);
            Err(error)
        }
    }
}
#[uniffi::export]
impl HostRuntime {
    pub fn resolved_socket_path(&self) -> Option<String> {
        self.inner.herdr.resolved_socket_path()
    }

    pub async fn resolve_control_socket(&self) -> Result<String, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                inner
                    .herdr
                    .resolve_control_socket()
                    .await
                    .map_err(|error| HostRuntimeError::ControlConnectionFailure(error.to_string()))
            })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "host socket resolution task failed: {error}"
                ))
            })?
    }

    pub async fn connect(&self) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(initial_connect(inner))
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("host runtime task failed: {error}"))
            })?
    }

    pub async fn disconnect(&self) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let _shutdown = inner.shutdown.lock().await;
                let generation = {
                    let mut state = inner.state.lock();
                    if state.explicit_disconnect {
                        return Ok(());
                    }
                    let epoch = state.disconnect();
                    let _ = inner.cancellation.send(epoch);
                    state.generation
                };
                log_lifecycle(format_args!(
                    "runtime explicitly disconnected: {} incarnation={}",
                    inner.id, inner.incarnation
                ));
                inner.monitoring_changed.notify_one();
                inner.reconnect_wakeup.notify_one();
                invalidate_remote_operations(&inner, generation, "Host runtime disconnected");
                publish_lifecycle_status(&inner);
                emit_host_state(&inner);
                inner.terminal_settled.notify_waiters();
                inner.agents.disconnected(true, "Host runtime disconnected");
                close_herdr_event_subscription(inner.id.clone());
                close_all_herdr_terminal_bridges(inner.id.clone());
                let ssh = inner.herdr.clear(generation);
                let jumps = std::mem::take(&mut *inner.jump_sessions.lock());
                if let Some(ssh) = ssh {
                    ssh.disconnect().await;
                }
                disconnect_sessions(jumps).await;
                {
                    let mut state = inner.state.lock();
                    state.connection = HostConnectionState::Disconnected;
                    state.last_error = None;
                }
                publish_lifecycle_status(&inner);
                emit_host_state(&inner);
                unregister_runtime(&inner);
                Ok(())
            })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "host disconnect task failed: {error}"
                ))
            })?
    }

    pub async fn recover(&self, immediate: bool, reason: String) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let connected = {
                    let state = inner.state.lock();
                    (state.connection == HostConnectionState::Connected)
                        .then_some((state.generation, state.herdr_recovery_revision))
                };
                if let Some((generation, recovery_revision)) = connected
                    && confirm_ssh_health(&inner, generation).await.is_ok()
                {
                    return recover_herdr_only(inner, generation, recovery_revision).await;
                }
                let status_rx = inner.status_tx.subscribe();
                begin_reconnect(inner.clone(), reason, immediate);
                wait_for_reconnect(status_rx).await
            })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("host recovery task failed: {error}"))
            })?
    }

    pub async fn control_request(
        &self,
        request: HerdrControlRequest,
    ) -> Result<HerdrControlResult, HerdrControlError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HerdrControlError::TransportDisconnected)?
            .spawn(control_request_inner(inner, request))
            .await
            .map_err(|error| {
                HerdrControlError::RequestCancelled(format!("host control task failed: {error}"))
            })?
    }

    pub async fn start_herdr_server(&self) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(start_herdr_server_inner(inner))
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "Herdr server startup task failed: {error}"
                ))
            })?
    }

    pub async fn execute(&self, command: String) -> Result<String, HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        let output = crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { ssh.execute(&command).await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("SSH command task failed: {error}"))
            })??;
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    pub async fn remote_home(&self) -> Result<String, HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        let home = crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { ssh.remote_home().await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "remote home discovery task failed: {error}"
                ))
            })??;
        Ok(home)
    }
}
