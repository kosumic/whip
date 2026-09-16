//! Rust-owned lifecycle for one connected Whip/Herdr host.

mod agents;
mod connection;
mod diagnostics;
mod events;
mod monitoring;
mod remote_files;
mod terminal;

use std::collections::HashMap;
use std::sync::{
    Arc, OnceLock, Weak,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use tokio::sync::{Mutex as AsyncMutex, Notify, watch};

use crate::agent_sessions::{
    AgentSessionManager, AgentTranscriptRetention, AuthoritativeAgentChatIdentity,
};
use crate::agent_transcript::AgentTranscriptKind;
use crate::herdr_api::{HerdrAgentSessionKind, HerdrPaneInfo};
use crate::herdr_connection::HerdrConnection;
use crate::herdr_events::close_herdr_event_subscription;
use crate::herdr_terminal::{HerdrBridgeId, close_all_herdr_terminal_bridges};
use crate::host_state::{
    AgentStatusTransition, HostFreshness, HostState, HostStateSnapshot, HostSyncStatus,
};
use crate::remote_ops::{PreviewState, RemoteOperationManager, TransferProgress};
use crate::ssh::{SshErrorCode, SshFailure, SshSession, SshShellClose};
#[cfg(test)]
use agents::*;
use connection::*;
use diagnostics::*;
use events::*;
pub(crate) use events::{
    deliver_herdr_events, event_subscription_closed, terminal_bridge_closed,
    terminal_kitty_keyboard_report_all_changed,
};
use monitoring::*;
use remote_files::*;
use terminal::*;

const MAX_RECONNECT_ATTEMPTS: u32 = 5;
const INITIAL_RECONNECT_DELAY_MS: u64 = 750;
const MAX_RECONNECT_DELAY_MS: u64 = 8_000;
const INITIAL_PERSISTENT_RECONNECT_DELAY_MS: u64 = 15_000;
const MAX_PERSISTENT_RECONNECT_DELAY_MS: u64 = 60_000;
const HERDR_READINESS_TIMEOUT: Duration = Duration::from_secs(12);
const HERDR_READINESS_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(2);
const HERDR_READINESS_INITIAL_BACKOFF: Duration = Duration::from_millis(75);
const HERDR_READINESS_MAX_BACKOFF: Duration = Duration::from_millis(600);
const SLOW_RUNTIME_DIAGNOSTIC_MS: f64 = 200.0;
const MIN_TERMINAL_COLUMNS: u32 = 20;
const MIN_TERMINAL_ROWS: u32 = 8;
static NEXT_RUNTIME_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_RUNTIME_INCARNATION: AtomicU64 = AtomicU64::new(1);
static RUNTIMES: OnceLock<RwLock<HashMap<String, Weak<RuntimeInner>>>> = OnceLock::new();
static EVENT_SINK: OnceLock<RwLock<Option<Arc<dyn HostRuntimeEventSink>>>> = OnceLock::new();

fn runtimes() -> &'static RwLock<HashMap<String, Weak<RuntimeInner>>> {
    RUNTIMES.get_or_init(|| RwLock::new(HashMap::new()))
}

fn unregister_runtime(inner: &Arc<RuntimeInner>) {
    let mut registered = runtimes().write();
    let owns_registration = registered
        .get(&inner.id)
        .and_then(Weak::upgrade)
        .is_some_and(|runtime| Arc::ptr_eq(&runtime, inner));
    if owns_registration {
        registered.remove(&inner.id);
    }
}

fn event_sink() -> &'static RwLock<Option<Arc<dyn HostRuntimeEventSink>>> {
    EVENT_SINK.get_or_init(|| RwLock::new(None))
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HostSshCredential {
    Password {
        password: String,
    },
    Key {
        private_key: String,
        passphrase: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostSshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub credential: HostSshCredential,
    pub forward_agent: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostRuntimeConfig {
    pub runtime_id: String,
    pub ssh: HostSshConfig,
    pub jump_hosts: Vec<HostSshConfig>,
    pub session_name: String,
    pub herdr_command: String,
    pub socket_path: Option<String>,
    pub cached_socket_path: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum AgentIntegrationStatus {
    NotInstalled,
    Current,
    Outdated,
    NeedsRepair,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HostConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Disconnecting,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HostTerminalState {
    Opening,
    Attached,
    Restoring,
    Closed,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HostTerminalResizeOutcome {
    Deferred,
    Deduplicated,
    Dispatched,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostTerminalGeometry {
    pub columns: u32,
    pub rows: u32,
    pub cell_width_px: u32,
    pub cell_height_px: u32,
}

impl HostTerminalGeometry {
    fn normalized(columns: u32, rows: u32, cell_width_px: u32, cell_height_px: u32) -> Self {
        Self {
            columns: columns.max(MIN_TERMINAL_COLUMNS),
            rows: rows.max(MIN_TERMINAL_ROWS),
            cell_width_px,
            cell_height_px,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostRuntimeStatus {
    pub state: HostConnectionState,
    pub generation: u64,
    pub reconnect_attempt: u32,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum RuntimeDiagnosticOperation {
    SshConnect,
    SshReconnect,
    SshReconnectFast,
    SshReconnectPersistent,
    HostLatencyProbe,
    HerdrRequest,
    HerdrRecovery,
    TerminalAttach,
    TerminalRecovery,
    SshShellRecovery,
    EventStreamRecovery,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum RuntimeDiagnosticOutcome {
    Succeeded,
    Failed,
    Started,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RuntimeDiagnostic {
    pub operation: RuntimeDiagnosticOperation,
    pub duration_ms: f64,
    pub transport_duration_ms: Option<f64>,
    pub outcome: RuntimeDiagnosticOutcome,
    pub terminal_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Record)]
pub struct HostLatencyMeasurement {
    pub ssh_rtt_ms: f64,
    pub total_ms: f64,
    pub runtime_overhead_ms: f64,
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
// UniFFI data enums cannot box an associated record. Herdr events remain typed
// instead of crossing the native boundary as serialized JSON.
#[allow(
    clippy::large_enum_variant,
    reason = "UniFFI data enums cannot box associated records without changing the native API"
)]
pub enum HostRuntimeEvent {
    ConnectionStateChanged {
        runtime_id: String,
        status: HostRuntimeStatus,
    },
    ReconnectScheduled {
        runtime_id: String,
        attempt: u32,
        delay_ms: u64,
        reason: String,
    },
    Reconnected {
        runtime_id: String,
        generation: u64,
        restored_terminals: u32,
    },
    TerminalStateChanged {
        runtime_id: String,
        terminal_id: String,
        state: HostTerminalState,
        reconnect_attempt: u32,
        retrying: bool,
        error: Option<String>,
    },
    SshShellData {
        runtime_id: String,
        terminal_id: String,
        bytes: Vec<u8>,
    },
    SshShellClosed {
        runtime_id: String,
        terminal_id: String,
        reason: String,
    },
    HostStateChanged {
        runtime_id: String,
        state: HostStateSnapshot,
        agent_status_transitions: Vec<AgentStatusTransition>,
        transcript_retention: Option<AgentTranscriptRetention>,
    },
    LatencyMeasured {
        runtime_id: String,
        measurement: HostLatencyMeasurement,
    },
    EventSubscriptionClosed {
        runtime_id: String,
        reason: String,
    },
    EventSubscriptionRestored {
        runtime_id: String,
        generation: u64,
    },
    TransferProgressChanged {
        runtime_id: String,
        progress: TransferProgress,
    },
    PreviewStateChanged {
        runtime_id: String,
        preview_id: String,
        state: PreviewState,
        error: Option<String>,
    },
    Diagnostic {
        runtime_id: String,
        diagnostic: RuntimeDiagnostic,
    },
    FatalError {
        runtime_id: String,
        message: String,
    },
}

#[uniffi::export(with_foreign)]
pub trait HostRuntimeEventSink: Send + Sync {
    fn event(&self, event: HostRuntimeEvent);
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum HostRuntimeError {
    #[error("{0}")]
    AuthenticationFailure(String),
    #[error("unknown SSH host key")]
    HostKeyUnknown(crate::ssh::HostKeyChallenge),
    #[error("SSH host key changed")]
    HostKeyChanged(crate::ssh::HostKeyChallenge),
    #[error("SSH host certificates are not supported")]
    UnsupportedHostCertificate,
    #[error("{0}")]
    SshTransportFailure(String),
    #[error("{message}")]
    SshConnectionFailure { code: SshErrorCode, message: String },
    #[error("{0}")]
    HerdrUnavailable(String),
    #[error("Herdr protocol mismatch: Whip supports {expected}, server reports {received}")]
    HerdrProtocolMismatch { expected: String, received: u32 },
    #[error("Herdr did not become ready within {timeout_ms} ms: {last_error}")]
    HerdrReadinessTimeout { timeout_ms: u64, last_error: String },
    #[error("{0}")]
    ControlConnectionFailure(String),
    #[error("{0}")]
    ReconnectExhausted(String),
    #[error("{0}")]
    RuntimeDisconnected(String),
    #[error("{0}")]
    TerminalUnavailable(String),
    #[error("{0}")]
    StaleOperation(String),
    #[error("{0}")]
    InvalidConfiguration(String),
    #[error("{0}")]
    RemoteFileFailure(String),
    #[error("{0}")]
    TransferFailure(String),
    #[error("{0}")]
    TransferCancelled(String),
    #[error("{0}")]
    GitFailure(String),
    #[error("{0}")]
    PreviewFailure(String),
    #[error("pane submission failed after {submitted_parts} completed paste parts: {message}")]
    PaneSubmissionFailure {
        submitted_parts: u32,
        message: String,
    },
}

impl From<SshFailure> for HostRuntimeError {
    fn from(error: SshFailure) -> Self {
        match error {
            SshFailure::Authentication(message) => Self::AuthenticationFailure(message),
            SshFailure::HostKeyUnknown(challenge) => Self::HostKeyUnknown(*challenge),
            SshFailure::HostKeyChanged(challenge) => Self::HostKeyChanged(*challenge),
            SshFailure::UnsupportedHostCertificate => Self::UnsupportedHostCertificate,
            SshFailure::Transport { code, message } => Self::SshConnectionFailure { code, message },
        }
    }
}

#[derive(Clone, Debug)]
struct TerminalRuntime {
    state: HostTerminalState,
    takeover: bool,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
    operation_epoch: u64,
    reconnect_attempt: u32,
    retry_running: bool,
    bridge_id: Option<HerdrBridgeId>,
}

#[derive(Clone, Debug)]
struct SshShellRuntime {
    desired_open: bool,
    state: HostTerminalState,
    geometry: HostTerminalGeometry,
    dispatched_geometry: Option<HostTerminalGeometry>,
    operation_epoch: u64,
    reconnect_attempt: u32,
    retry_running: bool,
}

#[derive(Clone, Debug)]
struct EventSubscriptionRuntime {
    pane_ids: Vec<String>,
    operation_epoch: u64,
    retry_running: bool,
}

#[derive(Debug)]
struct RuntimeState {
    connection: HostConnectionState,
    generation: u64,
    epoch: u64,
    reconnect_attempt: u32,
    reconnect_running: bool,
    herdr_recovery_revision: u64,
    herdr_recovery_error: Option<String>,
    explicit_disconnect: bool,
    last_error: Option<String>,
    protocol: Option<u32>,
    event: Option<EventSubscriptionRuntime>,
    terminals: HashMap<String, TerminalRuntime>,
    terminal_dispatched_geometries: HashMap<String, HostTerminalGeometry>,
    terminal_kitty_keyboard_report_all: HashMap<String, bool>,
    ssh_shells: HashMap<String, SshShellRuntime>,
    host_state: HostState,
}

impl RuntimeState {
    fn new(_config: &HostRuntimeConfig) -> Self {
        Self {
            connection: HostConnectionState::Disconnected,
            generation: 0,
            epoch: 0,
            reconnect_attempt: 0,
            reconnect_running: false,
            herdr_recovery_revision: 0,
            herdr_recovery_error: None,
            explicit_disconnect: false,
            last_error: None,
            protocol: None,
            event: None,
            terminals: HashMap::new(),
            terminal_dispatched_geometries: HashMap::new(),
            terminal_kitty_keyboard_report_all: HashMap::new(),
            ssh_shells: HashMap::new(),
            host_state: HostState::default(),
        }
    }

    fn status(&self) -> HostRuntimeStatus {
        HostRuntimeStatus {
            state: self.connection,
            generation: self.generation,
            reconnect_attempt: self.reconnect_attempt,
            error: self.last_error.clone(),
        }
    }

    fn begin_connect(&mut self) -> Result<u64, HostRuntimeError> {
        match self.connection {
            HostConnectionState::Connecting | HostConnectionState::Reconnecting => {
                return Err(HostRuntimeError::StaleOperation(
                    "a host connection operation is already active".to_owned(),
                ));
            }
            HostConnectionState::Connected => return Ok(self.epoch),
            _ => {}
        }
        self.epoch = self.epoch.wrapping_add(1);
        self.connection = HostConnectionState::Connecting;
        self.explicit_disconnect = false;
        self.last_error = None;
        Ok(self.epoch)
    }

    fn install_connection(&mut self, epoch: u64) -> bool {
        if self.epoch != epoch || self.explicit_disconnect {
            return false;
        }
        self.generation = self.generation.wrapping_add(1);
        self.connection = HostConnectionState::Connected;
        self.reconnect_attempt = 0;
        self.reconnect_running = false;
        self.last_error = None;
        self.host_state.connection_installed(self.generation);
        true
    }

    fn begin_reconnect(
        &mut self,
        expected_generation: Option<u64>,
        reason: &str,
    ) -> Option<(u64, u64)> {
        if self.explicit_disconnect || self.reconnect_running {
            return None;
        }
        if expected_generation.is_some_and(|generation| {
            self.connection != HostConnectionState::Connected || self.generation != generation
        }) {
            return None;
        }
        self.epoch = self.epoch.wrapping_add(1);
        self.connection = HostConnectionState::Reconnecting;
        self.reconnect_running = true;
        self.reconnect_attempt = 0;
        self.last_error = Some(reason.to_owned());
        self.host_state.mark_reconnecting(reason.to_owned());
        self.terminal_dispatched_geometries.clear();
        for terminal_id in self.terminals.keys() {
            self.terminal_kitty_keyboard_report_all
                .insert(terminal_id.clone(), false);
        }
        for shell in self.ssh_shells.values_mut() {
            if shell.desired_open {
                shell.operation_epoch = shell.operation_epoch.wrapping_add(1);
                shell.state = HostTerminalState::Restoring;
                shell.dispatched_geometry = None;
                shell.reconnect_attempt = 0;
                shell.retry_running = false;
            }
        }
        Some((self.epoch, self.generation))
    }

    fn disconnect(&mut self) -> u64 {
        self.epoch = self.epoch.wrapping_add(1);
        self.connection = HostConnectionState::Disconnecting;
        self.explicit_disconnect = true;
        self.reconnect_running = false;
        self.reconnect_attempt = 0;
        self.event = None;
        for terminal in self.terminals.values_mut() {
            terminal.operation_epoch = terminal.operation_epoch.wrapping_add(1);
            terminal.state = HostTerminalState::Closed;
            terminal.reconnect_attempt = 0;
            terminal.retry_running = false;
            terminal.bridge_id = None;
        }
        self.terminal_dispatched_geometries.clear();
        self.terminal_kitty_keyboard_report_all.clear();
        for shell in self.ssh_shells.values_mut() {
            shell.desired_open = false;
            shell.operation_epoch = shell.operation_epoch.wrapping_add(1);
            shell.state = HostTerminalState::Closed;
            shell.dispatched_geometry = None;
            shell.reconnect_attempt = 0;
            shell.retry_running = false;
        }
        self.host_state.mark_disconnected();
        self.epoch
    }
}

struct RuntimeInner {
    id: String,
    incarnation: u64,
    config: HostRuntimeConfig,
    state: Mutex<RuntimeState>,
    herdr: Arc<HerdrConnection>,
    jump_sessions: Mutex<Vec<Arc<SshSession>>>,
    agents: AgentSessionManager,
    operations: RemoteOperationManager,
    herdr_startup: AsyncMutex<()>,
    herdr_recovery: AsyncMutex<()>,
    cancellation: watch::Sender<u64>,
    status_tx: watch::Sender<HostRuntimeStatus>,
    terminal_settled: Notify,
    monitoring: Mutex<MonitoringState>,
    monitoring_changed: Arc<Notify>,
    reconnect_wakeup: Arc<Notify>,
}

impl Drop for RuntimeInner {
    fn drop(&mut self) {
        self.monitoring_changed.notify_one();
        self.reconnect_wakeup.notify_one();
    }
}

#[derive(uniffi::Object)]
pub struct HostRuntime {
    inner: Arc<RuntimeInner>,
}

fn emit(event: HostRuntimeEvent) {
    // Foreign callbacks may synchronously re-enter HostRuntime. Never retain
    // either the sink registry lock or a runtime-state lock across the call.
    let sink = event_sink().read().clone();
    if let Some(sink) = sink {
        sink.event(event);
    }
}

fn publish_lifecycle_status(inner: &RuntimeInner) {
    let status = inner.state.lock().status();
    inner.status_tx.send_replace(status.clone());
    emit(HostRuntimeEvent::ConnectionStateChanged {
        runtime_id: inner.id.clone(),
        status,
    });
}

fn authoritative_agent_chat_identity(
    pane: &HerdrPaneInfo,
) -> Option<AuthoritativeAgentChatIdentity> {
    let session = pane.agent_session.as_ref()?;
    if session.kind != HerdrAgentSessionKind::Id {
        return None;
    }
    let agent = if session.agent.eq_ignore_ascii_case("codex") {
        AgentTranscriptKind::Codex
    } else if session.agent.eq_ignore_ascii_case("opencode") {
        AgentTranscriptKind::OpenCode
    } else {
        return None;
    };
    Some(AuthoritativeAgentChatIdentity {
        terminal_id: pane.terminal_id.clone(),
        pane_id: pane.pane_id.clone(),
        agent,
        session_id: session.value.trim().to_owned(),
    })
}

fn emit_host_state(inner: &RuntimeInner) {
    let (state, agent_status_transitions) = {
        let mut runtime = inner.state.lock();
        let state = runtime.host_state.projection();
        let transitions = runtime.host_state.take_agent_status_transitions();
        drop(runtime);
        (state, transitions)
    };
    let transcript_retention = if state.sync_status == HostSyncStatus::Synced
        && state.freshness == HostFreshness::Fresh
        && let Some(snapshot) = state.snapshot.as_ref()
    {
        let identities = snapshot
            .panes
            .iter()
            .filter_map(|pane| {
                authoritative_agent_chat_identity(pane)
                    .map(|identity| (pane.terminal_id.clone(), identity))
            })
            .collect::<HashMap<_, _>>();
        inner
            .agents
            .reconcile_authoritative_bindings(&identities, state.revision)
    } else {
        None
    };
    emit(HostRuntimeEvent::HostStateChanged {
        runtime_id: inner.id.clone(),
        state,
        agent_status_transitions,
        transcript_retention,
    });
}

#[uniffi::export]
pub fn set_host_runtime_event_sink(sink: Arc<dyn HostRuntimeEventSink>) {
    *event_sink().write() = Some(sink);
}

#[uniffi::export]
pub fn clear_host_runtime_event_sink() {
    *event_sink().write() = None;
}

#[uniffi::export]
pub fn create_host_runtime(
    config: HostRuntimeConfig,
) -> Result<Arc<HostRuntime>, HostRuntimeError> {
    validate_config(&config)?;
    let id = if config.runtime_id.trim().is_empty() {
        format!(
            "host-runtime-{}",
            NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed)
        )
    } else {
        config.runtime_id.clone()
    };
    if runtimes().read().get(&id).and_then(Weak::upgrade).is_some() {
        return Err(HostRuntimeError::InvalidConfiguration(format!(
            "host runtime {id} already exists"
        )));
    }
    let state = RuntimeState::new(&config);
    let incarnation = NEXT_RUNTIME_INCARNATION.fetch_add(1, Ordering::Relaxed);
    let (cancellation, _) = watch::channel(0);
    let (status_tx, _) = watch::channel(state.status());
    let herdr = HerdrConnection::new(
        id.clone(),
        config.session_name.clone(),
        config.socket_path.clone(),
        config.cached_socket_path.clone(),
    );
    let inner = Arc::new(RuntimeInner {
        id: id.clone(),
        incarnation,
        state: Mutex::new(state),
        agents: AgentSessionManager::new(id.clone(), incarnation, herdr.clone()),
        operations: RemoteOperationManager::default(),
        herdr,
        jump_sessions: Mutex::new(Vec::new()),
        herdr_startup: AsyncMutex::new(()),
        herdr_recovery: AsyncMutex::new(()),
        config,
        cancellation,
        status_tx,
        terminal_settled: Notify::new(),
        monitoring: Mutex::new(MonitoringState::default()),
        monitoring_changed: Arc::new(Notify::new()),
        reconnect_wakeup: Arc::new(Notify::new()),
    });
    runtimes().write().insert(id, Arc::downgrade(&inner));
    Ok(Arc::new(HostRuntime { inner }))
}

#[uniffi::export]
impl HostRuntime {
    pub fn runtime_id(&self) -> String {
        self.inner.id.clone()
    }

    pub fn runtime_incarnation(&self) -> u64 {
        self.inner.incarnation
    }

    pub fn status(&self) -> HostRuntimeStatus {
        self.inner.status_tx.borrow().clone()
    }

    pub fn host_state(&self) -> HostStateSnapshot {
        self.inner.state.lock().host_state.projection()
    }

    pub fn set_monitoring_state(&self, app_active: bool, hosts_visible: bool, access_locked: bool) {
        monitoring::set_monitoring_state(&self.inner, app_active, hosts_visible, access_locked);
    }
}

impl Drop for HostRuntime {
    fn drop(&mut self) {
        let inner = self.inner.clone();
        unregister_runtime(&inner);
        let (epoch, generation) = {
            let mut state = inner.state.lock();
            let generation = state.generation;
            (state.disconnect(), generation)
        };
        let _ = inner.cancellation.send(epoch);
        invalidate_remote_operations(&inner, generation, "Host runtime dropped");
        inner.agents.disconnected(true, "Host runtime dropped");
        close_herdr_event_subscription(inner.id.clone());
        close_all_herdr_terminal_bridges(inner.id.clone());
        let ssh = inner.herdr.clear(generation);
        if let Ok(runtime) = crate::runtime() {
            runtime.spawn(async move {
                let jumps = std::mem::take(&mut *inner.jump_sessions.lock());
                if let Some(ssh) = ssh {
                    ssh.disconnect().await;
                }
                disconnect_sessions(jumps).await;
            });
        }
    }
}

#[cfg(test)]
mod tests;
