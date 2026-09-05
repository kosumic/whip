//! Rust-owned lifecycle for remote coding-agent transcript sessions.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use chrono::NaiveDateTime;
use parking_lot::{Mutex, RwLock};
use tokio::task::AbortHandle;

use crate::agent_transcript::{
    AgentCacheError, AgentTranscriptDelta, AgentTranscriptKind, AgentTranscriptState,
    AgentTranscriptStatus, AgentTranscriptUpdate, AgentTurnStatus, CodexSessionCore,
    OpenCodeSessionCore, parse_open_code_cursor,
};
use crate::herdr_connection::{ConnectionExecStream, HerdrConnection};

const RETRY_DELAY: Duration = Duration::from_millis(1_500);
const OPENCODE_POLL_DELAY: Duration = Duration::from_millis(1_200);
const CODEX_CHECKPOINT_BYTES: u64 = 256 * 1024;
const OPENCODE_CHECKPOINT_EVENTS: u64 = 64;
static NEXT_STREAM_CONTEXT: AtomicU64 = AtomicU64::new(1);
static STREAMS: OnceLock<RwLock<HashMap<u64, StreamContext>>> = OnceLock::new();
static EVENT_SINK: OnceLock<RwLock<Option<Arc<dyn AgentTranscriptEventSink>>>> = OnceLock::new();

fn streams() -> &'static RwLock<HashMap<u64, StreamContext>> {
    STREAMS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn event_sink() -> &'static RwLock<Option<Arc<dyn AgentTranscriptEventSink>>> {
    EVENT_SINK.get_or_init(|| RwLock::new(None))
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AgentTranscriptCacheWrite {
    pub namespace: String,
    pub key: String,
    pub blob: Vec<u8>,
    pub confirmation_token: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AgentTranscriptEvent {
    pub runtime_id: String,
    pub runtime_incarnation: u64,
    pub key: String,
    pub update: AgentTranscriptUpdate,
    pub cache_write: Option<AgentTranscriptCacheWrite>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AgentChatBinding {
    pub runtime_incarnation: u64,
    pub binding_token: String,
    pub binding_generation: u64,
    pub terminal_id: String,
    pub pane_id: String,
    pub agent: AgentTranscriptKind,
    pub session_id: String,
    pub transcript_key: String,
    pub state: AgentTranscriptState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum AgentChatUnavailableReason {
    HostStateUnavailable,
    TerminalNotFound,
    UnsupportedPane,
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
#[allow(
    clippy::large_enum_variant,
    reason = "UniFFI records cannot be boxed across the generated mobile boundary"
)]
pub enum AgentChatOpenResult {
    Bound {
        binding: AgentChatBinding,
    },
    NoChat {
        terminal_id: String,
        reason: AgentChatUnavailableReason,
    },
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
#[allow(
    clippy::large_enum_variant,
    reason = "UniFFI records cannot be boxed across the generated mobile boundary"
)]
pub enum AgentChatStartResult {
    Started { state: AgentTranscriptState },
    StaleBinding,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AuthoritativeAgentChatIdentity {
    pub terminal_id: String,
    pub pane_id: String,
    pub agent: AgentTranscriptKind,
    pub session_id: String,
}

#[uniffi::export(with_foreign)]
pub trait AgentTranscriptEventSink: Send + Sync {
    fn event(&self, event: AgentTranscriptEvent);
}

#[uniffi::export]
pub fn set_agent_transcript_event_sink(sink: Arc<dyn AgentTranscriptEventSink>) {
    *event_sink().write() = Some(sink);
}

#[uniffi::export]
pub fn clear_agent_transcript_event_sink() {
    *event_sink().write() = None;
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum AgentSessionError {
    #[error("unsupported agent session: {0}")]
    UnsupportedAgent(String),
    #[error("invalid agent session: {0}")]
    InvalidSession(String),
    #[error("agent transcript source is unavailable: {0}")]
    SourceUnavailable(String),
    #[error("agent transcript read failed: {0}")]
    ReadFailed(String),
    #[error("agent transcript cache is corrupt: {0}")]
    CorruptedCache(String),
    #[error("agent transcript session is closed: {0}")]
    SessionClosed(String),
    #[error("agent transcript operation is stale: {0}")]
    StaleGeneration(String),
    #[error("host transport is disconnected: {0}")]
    TransportDisconnected(String),
}

impl From<AgentCacheError> for AgentSessionError {
    fn from(error: AgentCacheError) -> Self {
        Self::CorruptedCache(error.to_string())
    }
}

#[derive(Debug)]
struct SessionRuntime {
    key: String,
    session_id: String,
    terminals: HashSet<String>,
    core: AgentSessionCore,
    operation_epoch: u64,
    stream_context: Option<u64>,
    stream: Option<Arc<ConnectionExecStream>>,
    retry_running: bool,
    pending_cache_offset: Option<u64>,
    started: bool,
    closed: bool,
    explicit_restart_pending: bool,
    worker: Option<AbortHandle>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TerminalBinding {
    token: String,
    generation: u64,
    key: String,
    pane_id: String,
    agent: AgentTranscriptKind,
    session_id: String,
}

#[derive(Debug)]
enum AgentSessionCore {
    Codex(Box<CodexSessionCore>),
    OpenCode(Box<OpenCodeSessionCore>),
}

impl AgentSessionCore {
    fn kind(&self) -> AgentTranscriptKind {
        match self {
            Self::Codex(_) => AgentTranscriptKind::Codex,
            Self::OpenCode(_) => AgentTranscriptKind::OpenCode,
        }
    }

    fn state(&self) -> AgentTranscriptState {
        match self {
            Self::Codex(core) => core.state(),
            Self::OpenCode(core) => core.state(),
        }
    }

    fn mark_stale_update(&mut self, reason: impl Into<String>) -> AgentTranscriptUpdate {
        let reason = reason.into();
        match self {
            Self::Codex(core) => core.mark_stale_update(reason),
            Self::OpenCode(core) => core.mark_stale_update(reason),
        }
    }

    fn mark_restarting_update(&mut self, reason: impl Into<String>) -> AgentTranscriptUpdate {
        let reason = reason.into();
        match self {
            Self::Codex(core) => core.mark_restarting_update(reason),
            Self::OpenCode(core) => core.mark_restarting_update(reason),
        }
    }

    fn mark_unavailable_update(&mut self, reason: impl Into<String>) -> AgentTranscriptUpdate {
        let reason = reason.into();
        match self {
            Self::Codex(core) => core.mark_unavailable_update(reason),
            Self::OpenCode(core) => core.mark_unavailable_update(reason),
        }
    }

    fn close_update(&mut self) -> AgentTranscriptUpdate {
        match self {
            Self::Codex(core) => core.close_update(),
            Self::OpenCode(core) => core.close_update(),
        }
    }

    fn restore_cache(&mut self, bytes: &[u8]) -> Result<AgentTranscriptState, AgentCacheError> {
        match self {
            Self::Codex(core) => core.restore_cache(bytes),
            Self::OpenCode(core) => core.restore_cache(bytes),
        }
    }

    fn confirm_cache(&mut self, source_generation: u64, position: u64) -> bool {
        match self {
            Self::Codex(core) => core.confirm_cache(source_generation, position),
            Self::OpenCode(core) => core.confirm_cache(source_generation, position),
        }
    }
}

#[derive(Clone, Debug)]
struct PendingCheckpoint {
    session_key: String,
    source_generation: u64,
    offset: u64,
}

#[derive(Debug)]
struct ManagerState {
    // Invariants:
    // - one terminal has at most one binding;
    // - every binding token names exactly one runtime incarnation, terminal,
    //   pane, agent kind, and agent session;
    // - operations may mutate only the session epoch that created them;
    // - authoritative HostState replacement invalidates or replaces bindings;
    // - release closes resources, while only explicit bind/start reopens them.
    connected: bool,
    foreground: bool,
    sessions: HashMap<String, SessionRuntime>,
    terminal_bindings: HashMap<String, TerminalBinding>,
    checkpoints: HashMap<String, PendingCheckpoint>,
    next_checkpoint: u64,
    next_binding_generation: u64,
    closed: bool,
}

struct AgentSessionManagerInner {
    runtime_id: String,
    runtime_incarnation: u64,
    connection: Arc<HerdrConnection>,
    state: Mutex<ManagerState>,
}

#[derive(Clone)]
pub(crate) struct AgentSessionManager {
    inner: Arc<AgentSessionManagerInner>,
}

#[derive(Clone)]
struct StreamContext {
    manager: Weak<AgentSessionManagerInner>,
    session_key: String,
    source_generation: u64,
    operation_epoch: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionFailureKind {
    SourceUnavailable,
    Transient,
}

impl AgentSessionManager {
    pub(crate) fn new(
        runtime_id: String,
        runtime_incarnation: u64,
        connection: Arc<HerdrConnection>,
    ) -> Self {
        Self {
            inner: Arc::new(AgentSessionManagerInner {
                runtime_id,
                runtime_incarnation,
                connection,
                state: Mutex::new(ManagerState {
                    connected: false,
                    foreground: false,
                    sessions: HashMap::new(),
                    terminal_bindings: HashMap::new(),
                    checkpoints: HashMap::new(),
                    next_checkpoint: 1,
                    next_binding_generation: 1,
                    closed: false,
                }),
            }),
        }
    }

    pub(crate) fn connected(&self) {
        let keys = {
            let mut state = self.inner.state.lock();
            state.connected = true;
            state.closed = false;
            state
                .sessions
                .iter()
                .filter(|(_, session)| session.started)
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>()
        };
        for key in keys {
            self.restart(key, "Host connection was replaced".to_owned());
        }
    }

    /// Pause only transcript readers, never the remote agent or host transport.
    /// Binding identity and reducer cursors survive so resume can catch up.
    pub(crate) fn set_foreground(&self, foreground: bool) {
        let keys = {
            let mut state = self.inner.state.lock();
            if state.foreground == foreground {
                return;
            }
            state.foreground = foreground;
            if !foreground {
                for session in state.sessions.values_mut() {
                    if session.core.state().status == AgentTranscriptStatus::Unavailable {
                        continue;
                    }
                    cancel_session_work(session);
                    if session.started && !session.closed {
                        let _ = session
                            .core
                            .mark_stale_update("Transcript paused in background");
                    }
                }
                return;
            }
            state
                .sessions
                .iter()
                .filter(|(_, session)| {
                    session.core.state().status != AgentTranscriptStatus::Unavailable
                        || session.explicit_restart_pending
                })
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>()
        };
        for key in keys {
            self.restart(key, "Resuming foreground transcript".to_owned());
        }
    }

    pub(crate) fn disconnected(&self, closed: bool, reason: &str) {
        let emissions = {
            let mut state = self.inner.state.lock();
            state.connected = false;
            state.closed = closed;
            let mut emissions = Vec::new();
            for session in state.sessions.values_mut() {
                cancel_session_work(session);
                let update = if closed {
                    session.closed = true;
                    session.core.close_update()
                } else {
                    session.core.mark_stale_update(reason)
                };
                emissions.push((session.key.clone(), update));
            }
            drop(state);
            emissions
        };
        for (key, update) in emissions {
            emit(&self.inner, key, update, None);
        }
    }

    #[cfg(test)]
    pub(crate) fn bind_codex(
        &self,
        terminal_id: String,
        session_id: String,
    ) -> Result<AgentChatBinding, AgentSessionError> {
        self.bind_authoritative(AuthoritativeAgentChatIdentity {
            pane_id: format!("pane-{terminal_id}"),
            terminal_id,
            agent: AgentTranscriptKind::Codex,
            session_id,
        })
    }

    #[cfg(test)]
    pub(crate) fn bind_opencode(
        &self,
        terminal_id: String,
        session_id: String,
    ) -> Result<AgentChatBinding, AgentSessionError> {
        self.bind_authoritative(AuthoritativeAgentChatIdentity {
            pane_id: format!("pane-{terminal_id}"),
            terminal_id,
            agent: AgentTranscriptKind::OpenCode,
            session_id,
        })
    }

    pub(crate) fn bind_authoritative(
        &self,
        identity: AuthoritativeAgentChatIdentity,
    ) -> Result<AgentChatBinding, AgentSessionError> {
        match identity.agent {
            AgentTranscriptKind::Codex => validate_codex_session_id(&identity.session_id)?,
            AgentTranscriptKind::OpenCode => validate_opencode_session_id(&identity.session_id)?,
        }
        let prefix = match identity.agent {
            AgentTranscriptKind::Codex => "codex",
            AgentTranscriptKind::OpenCode => "opencode",
        };
        // This is both the native session key and the opaque platform cache
        // identity. Including the stable HostRuntime id prevents otherwise
        // identical agent session ids on different hosts from colliding.
        let key = format!(
            "{}\n{prefix}\n{}",
            self.inner.runtime_id, identity.session_id
        );
        let (binding, state_snapshot, orphaned) = {
            let mut state = self.inner.state.lock();
            if state.closed {
                return Err(AgentSessionError::SessionClosed(
                    "host runtime is closed".to_owned(),
                ));
            }
            let retained = state
                .terminal_bindings
                .get(&identity.terminal_id)
                .filter(|binding| {
                    binding.key == key
                        && binding.pane_id == identity.pane_id
                        && binding.agent == identity.agent
                        && binding.session_id == identity.session_id
                })
                .cloned();
            let old_binding = if retained.is_none() {
                state.terminal_bindings.remove(&identity.terminal_id)
            } else {
                None
            };
            let orphaned = old_binding.and_then(|old_binding| {
                let old = state.sessions.get_mut(&old_binding.key)?;
                old.terminals.remove(&identity.terminal_id);
                old.terminals.is_empty().then_some(old_binding.key)
            });
            let binding = retained.unwrap_or_else(|| {
                let generation = state.next_binding_generation;
                state.next_binding_generation = state.next_binding_generation.saturating_add(1);
                TerminalBinding {
                    token: format!("agent-chat-{}-{generation}", self.inner.runtime_incarnation),
                    generation,
                    key: key.clone(),
                    pane_id: identity.pane_id.clone(),
                    agent: identity.agent,
                    session_id: identity.session_id.clone(),
                }
            });
            let session = state.sessions.entry(key.clone()).or_insert_with(|| {
                let core = match identity.agent {
                    AgentTranscriptKind::Codex => AgentSessionCore::Codex(Box::new(
                        CodexSessionCore::new(identity.session_id.clone()),
                    )),
                    AgentTranscriptKind::OpenCode => AgentSessionCore::OpenCode(Box::new(
                        OpenCodeSessionCore::new(identity.session_id.clone()),
                    )),
                };
                SessionRuntime {
                    key: key.clone(),
                    session_id: identity.session_id.clone(),
                    terminals: HashSet::new(),
                    core,
                    operation_epoch: 0,
                    stream_context: None,
                    stream: None,
                    retry_running: false,
                    pending_cache_offset: None,
                    started: false,
                    closed: false,
                    explicit_restart_pending: false,
                    worker: None,
                }
            });
            session.terminals.insert(identity.terminal_id.clone());
            if session.closed || session.core.state().status == AgentTranscriptStatus::Closed {
                session.closed = false;
                session.explicit_restart_pending = true;
                let _ = session
                    .core
                    .mark_restarting_update("Reopening released transcript");
            }
            let state_snapshot = session.core.state();
            state
                .terminal_bindings
                .insert(identity.terminal_id.clone(), binding.clone());
            drop(state);
            (binding, state_snapshot, orphaned)
        };
        if let Some(orphaned) = orphaned {
            self.release_session(&orphaned);
        }
        Ok(AgentChatBinding {
            runtime_incarnation: self.inner.runtime_incarnation,
            binding_token: binding.token,
            binding_generation: binding.generation,
            terminal_id: identity.terminal_id,
            pane_id: identity.pane_id,
            agent: identity.agent,
            session_id: identity.session_id,
            transcript_key: key,
            state: state_snapshot,
        })
    }

    pub(crate) fn start_bound(
        &self,
        binding_token: &str,
        cache_blob: Option<Vec<u8>>,
    ) -> Result<AgentChatStartResult, AgentSessionError> {
        let (key, state_snapshot, should_start, kind) = {
            let mut state = self.inner.state.lock();
            if state.closed {
                return Err(AgentSessionError::SessionClosed(
                    "host runtime is closed".to_owned(),
                ));
            }
            let Some(binding) = state
                .terminal_bindings
                .values()
                .find(|binding| binding.token == binding_token)
                .cloned()
            else {
                return Ok(AgentChatStartResult::StaleBinding);
            };
            let key = binding.key;
            let connected = state.connected;
            let foreground = state.foreground;
            let Some(session) = state.sessions.get_mut(&key) else {
                return Ok(AgentChatStartResult::StaleBinding);
            };
            if !session.started {
                if let Some(blob) = cache_blob.as_deref() {
                    let _ = session.core.restore_cache(blob);
                }
                session.started = true;
            }
            let state_snapshot = session.core.state();
            let should_start = session.explicit_restart_pending
                || should_restart_on_start(
                    connected,
                    session.operation_epoch,
                    state_snapshot.status,
                );
            session.explicit_restart_pending = should_start && !foreground;
            let result = (key, state_snapshot, should_start, session.core.kind());
            drop(state);
            result
        };
        if should_start {
            let label = match kind {
                AgentTranscriptKind::Codex => "Opening Codex transcript",
                AgentTranscriptKind::OpenCode => "Opening OpenCode transcript",
            };
            self.restart(key, label.to_owned());
        }
        Ok(AgentChatStartResult::Started {
            state: state_snapshot,
        })
    }

    pub(crate) fn state(&self, key: &str) -> Option<AgentTranscriptState> {
        self.inner
            .state
            .lock()
            .sessions
            .get(key)
            .map(|session| session.core.state())
    }

    pub(crate) fn has_terminal_binding(&self, terminal_id: &str) -> bool {
        self.inner
            .state
            .lock()
            .terminal_bindings
            .contains_key(terminal_id)
    }

    pub(crate) fn terminal_binding(&self, terminal_id: &str) -> Option<AgentChatBinding> {
        let state = self.inner.state.lock();
        let binding = state.terminal_bindings.get(terminal_id)?.clone();
        let transcript_state = state.sessions.get(&binding.key)?.core.state();
        drop(state);
        Some(AgentChatBinding {
            runtime_incarnation: self.inner.runtime_incarnation,
            binding_token: binding.token.clone(),
            binding_generation: binding.generation,
            terminal_id: terminal_id.to_owned(),
            pane_id: binding.pane_id.clone(),
            agent: binding.agent,
            session_id: binding.session_id.clone(),
            transcript_key: binding.key,
            state: transcript_state,
        })
    }

    pub(crate) fn close_terminal(&self, terminal_id: &str) -> Option<String> {
        let close = {
            let mut state = self.inner.state.lock();
            let binding = state.terminal_bindings.remove(terminal_id)?;
            let key = binding.key;
            let session = state.sessions.get_mut(&key)?;
            session.terminals.remove(terminal_id);
            let close = session.terminals.is_empty().then_some(key);
            drop(state);
            close
        };
        if let Some(key) = close {
            self.release_session(&key);
            return Some(key);
        }
        None
    }

    fn release_session(&self, key: &str) {
        let mut state = self.inner.state.lock();
        let Some(session) = state.sessions.get_mut(key) else {
            return;
        };
        if !session.terminals.is_empty() {
            return;
        }
        cancel_session_work(session);
        session.pending_cache_offset = None;
        session.closed = true;
        session.explicit_restart_pending = false;
        let _ = session.core.close_update();
        state
            .checkpoints
            .retain(|_, value| value.session_key != key);
    }

    pub(crate) fn reconcile_authoritative_bindings(
        &self,
        identities: &HashMap<String, AuthoritativeAgentChatIdentity>,
    ) {
        let changes = {
            let state = self.inner.state.lock();
            state
                .terminal_bindings
                .iter()
                .filter_map(|(terminal_id, binding)| {
                    let current = identities.get(terminal_id);
                    let retained = current.is_some_and(|identity| {
                        binding.pane_id == identity.pane_id
                            && binding.agent == identity.agent
                            && binding.session_id == identity.session_id
                    });
                    if retained {
                        None
                    } else {
                        Some((terminal_id.clone(), current.cloned()))
                    }
                })
                .collect::<Vec<_>>()
        };
        for (terminal_id, identity) in changes {
            if let Some(identity) = identity {
                // `bind_authoritative` replaces the terminal mapping under one
                // manager lock, then releases an orphaned old transcript.
                if self.bind_authoritative(identity).is_err() {
                    self.close_terminal(&terminal_id);
                }
            } else {
                self.close_terminal(&terminal_id);
            }
        }
    }

    pub(crate) fn confirm_cache(&self, token: &str) -> bool {
        let mut state = self.inner.state.lock();
        let Some(checkpoint) = state.checkpoints.remove(token) else {
            return false;
        };
        let Some(session) = state.sessions.get_mut(&checkpoint.session_key) else {
            return false;
        };
        let confirmed = session
            .core
            .confirm_cache(checkpoint.source_generation, checkpoint.offset);
        if confirmed
            && session
                .pending_cache_offset
                .is_some_and(|offset| offset <= checkpoint.offset)
        {
            session.pending_cache_offset = None;
        }
        drop(state);
        confirmed
    }

    fn restart(&self, key: String, reason: String) {
        let operation = {
            let mut state = self.inner.state.lock();
            if !state.connected || !state.foreground {
                return;
            }
            let Some(session) = state.sessions.get_mut(&key) else {
                return;
            };
            if !session.started || session.closed || session.terminals.is_empty() {
                return;
            }
            cancel_session_work(session);
            session.explicit_restart_pending = false;
            session.pending_cache_offset = None;
            let kind = session.core.kind();
            if let AgentSessionCore::OpenCode(core) = &mut session.core {
                core.begin_sync_generation();
            }
            let update = session.core.mark_restarting_update(reason);
            let operation = (
                session.operation_epoch,
                session.session_id.clone(),
                update,
                kind,
            );
            drop(state);
            operation
        };
        emit(&self.inner, key.clone(), operation.2, None);
        let manager = self.clone();
        self.spawn_worker(&key.clone(), operation.0, async move {
            match operation.3 {
                AgentTranscriptKind::Codex => {
                    manager
                        .resolve_and_open(key, operation.0, operation.1)
                        .await;
                }
                AgentTranscriptKind::OpenCode => {
                    manager.sync_opencode(key, operation.0, operation.1).await;
                }
            }
        });
    }

    fn spawn_worker(
        &self,
        key: &str,
        epoch: u64,
        work: impl std::future::Future<Output = ()> + Send + 'static,
    ) {
        let mut state = self.inner.state.lock();
        let Some(session) = current_session_mut(&mut state, key, epoch) else {
            return;
        };
        if let Ok(runtime) = crate::runtime() {
            // Hold the state lock until the handle is installed. A completion
            // cannot schedule its successor before we register this worker.
            session.worker = Some(runtime.spawn(work).abort_handle());
        }
    }

    async fn resolve_and_open(&self, key: String, operation_epoch: u64, session_id: String) {
        let connection = self.inner.connection.clone();
        let result = async {
            let output = execute(&connection, codex_rollout_find_command(&session_id))
                .await
                .map_err(|error| {
                    AgentSessionError::ReadFailed(format!(
                        "Codex rollout discovery failed: {error}"
                    ))
                })?;
            let path = resolve_rollout_path(&output, &session_id)?;
            let Some(path) = path else {
                return Err(AgentSessionError::SourceUnavailable(
                    "Codex has not created this rollout yet.".to_owned(),
                ));
            };
            let metadata = execute(
                &connection,
                format!(
                    "stat -c '%d:%i %s' {} 2>/dev/null || stat -f '%d:%i %z' {}",
                    shell_quote(&path),
                    shell_quote(&path)
                ),
            )
            .await
            .map_err(|error| {
                AgentSessionError::ReadFailed(format!(
                    "Codex rollout metadata lookup failed: {error}"
                ))
            })?;
            let (file_id, size) = parse_metadata(&metadata)?;
            Ok::<_, AgentSessionError>((path, file_id, size))
        }
        .await;
        let (path, file_id, size) = match result {
            Ok(result) => result,
            Err(error) => {
                let kind = if matches!(error, AgentSessionError::SourceUnavailable(_)) {
                    SessionFailureKind::SourceUnavailable
                } else {
                    SessionFailureKind::Transient
                };
                self.fail_session(key, operation_epoch, error.to_string(), kind);
                return;
            }
        };
        let opened = {
            let mut state = self.inner.state.lock();
            if !state.connected || !state.foreground {
                return;
            }
            let Some(session) = state.sessions.get_mut(&key) else {
                return;
            };
            if session.operation_epoch != operation_epoch || session.closed {
                return;
            }
            session.pending_cache_offset = None;
            let AgentSessionCore::Codex(core) = &mut session.core else {
                return;
            };
            let binding = core.bind_source(path.clone(), file_id.clone(), size);
            let reset = binding
                .rebuilt
                .then(|| AgentTranscriptUpdate::reset(core.state()));
            let context = NEXT_STREAM_CONTEXT.fetch_add(1, Ordering::Relaxed);
            streams().write().insert(
                context,
                StreamContext {
                    manager: Arc::downgrade(&self.inner),
                    session_key: key.clone(),
                    source_generation: binding.source_generation,
                    operation_epoch,
                },
            );
            session.stream_context = Some(context);
            let opened = (context, binding.start_offset, reset);
            drop(state);
            opened
        };
        if let Some(update) = opened.2 {
            emit(&self.inner, key.clone(), update, None);
        }
        let command = codex_stream_command(&path, opened.1);
        let context = opened.0;
        let data = Arc::new(move |bytes| stream_data(context, bytes));
        let closed = Arc::new(move |reason| stream_failed(context, reason));
        let stream_requested = match connection
            .open_exec_stream("agent-transcript", &command, data, closed)
            .await
        {
            Err(error) => {
                streams().write().remove(&opened.0);
                self.fail_session(
                    key.clone(),
                    operation_epoch,
                    format!("Codex rollout stream open failed: {error}"),
                    SessionFailureKind::Transient,
                );
                false
            }
            Ok(stream) => {
                let accepted = stream.is_current() && {
                    let mut state = self.inner.state.lock();
                    current_session_mut(&mut state, &key, operation_epoch)
                        .map(|session| session.stream = Some(stream.clone()))
                        .is_some()
                };
                if !accepted {
                    streams().write().remove(&opened.0);
                    let _ = stream.close();
                }
                accepted
            }
        };
        if stream_requested && size == opened.1 {
            let emission = {
                let mut state = self.inner.state.lock();
                current_session_mut(&mut state, &key, operation_epoch).and_then(|session| {
                    match &mut session.core {
                        AgentSessionCore::Codex(core) => core.mark_live_update(),
                        AgentSessionCore::OpenCode(_) => None,
                    }
                })
            };
            if let Some(update) = emission {
                emit(&self.inner, key, update, None);
            }
        }
    }

    async fn sync_opencode(&self, key: String, operation_epoch: u64, session_id: String) {
        let connection = self.inner.connection.clone();
        let cursor_output = match execute(
            &connection,
            opencode_login_command(&opencode_cursor_command(&session_id)),
        )
        .await
        {
            Ok(output) => output,
            Err(error) => {
                self.fail_session(
                    key,
                    operation_epoch,
                    error.to_string(),
                    SessionFailureKind::Transient,
                );
                return;
            }
        };
        let remote_cursor = match parse_open_code_cursor(&cursor_output) {
            Ok(cursor) => cursor,
            Err(error) => {
                self.fail_session(
                    key,
                    operation_epoch,
                    error.to_string(),
                    SessionFailureKind::Transient,
                );
                return;
            }
        };
        let local_cursor = {
            let mut state = self.inner.state.lock();
            let Some(session) = current_session_mut(&mut state, &key, operation_epoch) else {
                return;
            };
            let AgentSessionCore::OpenCode(core) = &mut session.core else {
                return;
            };
            core.cursor()
        };

        if local_cursor == Some(remote_cursor) {
            let update = {
                let mut state = self.inner.state.lock();
                current_session_mut(&mut state, &key, operation_epoch).and_then(|session| {
                    match &mut session.core {
                        AgentSessionCore::OpenCode(core) => Some(core.mark_live_update()),
                        AgentSessionCore::Codex(_) => None,
                    }
                })
            };
            if let Some(update) = update {
                if let Some(update) = update {
                    emit(&self.inner, key.clone(), update, None);
                }
                self.schedule_opencode_poll(key, operation_epoch, session_id);
            }
            return;
        }

        let needs_full = local_cursor.is_none_or(|cursor| remote_cursor < cursor);
        let command = if needs_full {
            opencode_export_command(&session_id)
        } else {
            opencode_events_command(&session_id, local_cursor.unwrap_or_default())
        };
        let payload = match execute(&connection, opencode_login_command(&command)).await {
            Ok(output) => output,
            Err(error) => {
                self.fail_session(
                    key,
                    operation_epoch,
                    error.to_string(),
                    SessionFailureKind::Transient,
                );
                return;
            }
        };
        let applied =
            self.finish_opencode_sync(&key, operation_epoch, remote_cursor, &payload, needs_full);
        if let Err(error) = applied {
            if needs_full {
                self.fail_session(key, operation_epoch, error, SessionFailureKind::Transient);
                return;
            }
            let export = execute(
                &connection,
                opencode_login_command(&opencode_export_command(&session_id)),
            )
            .await;
            match export {
                Ok(export) => {
                    if let Err(export_error) = self.finish_opencode_sync(
                        &key,
                        operation_epoch,
                        remote_cursor,
                        &export,
                        true,
                    ) {
                        self.fail_session(
                            key,
                            operation_epoch,
                            export_error,
                            SessionFailureKind::Transient,
                        );
                        return;
                    }
                }
                Err(export_error) => {
                    self.fail_session(
                        key,
                        operation_epoch,
                        format!("{error}; fallback export failed: {export_error}"),
                        SessionFailureKind::Transient,
                    );
                    return;
                }
            }
        }
        self.schedule_opencode_poll(key, operation_epoch, session_id);
    }

    fn finish_opencode_sync(
        &self,
        key: &str,
        operation_epoch: u64,
        remote_cursor: u64,
        payload: &str,
        full: bool,
    ) -> Result<(), String> {
        let emission = {
            let mut state = self.inner.state.lock();
            let (update, cache_candidate) = {
                let session = current_session_mut(&mut state, key, operation_epoch)
                    .ok_or_else(|| "OpenCode transcript operation became stale".to_owned())?;
                let AgentSessionCore::OpenCode(core) = &mut session.core else {
                    return Err("OpenCode transcript was rebound to another agent".to_owned());
                };
                let transcript_update = if full {
                    core.bootstrap(remote_cursor, payload).map(|changed| {
                        changed.then(|| AgentTranscriptUpdate {
                            revision: core.revision(),
                            deltas: Vec::new(),
                        })
                    })
                } else {
                    core.apply_events_incremental(remote_cursor, payload)
                }
                .map_err(|error| error.to_string())?;
                let mut update = core.finish_live_update(transcript_update);
                if full && let Some(update) = &mut update {
                    update.deltas = vec![AgentTranscriptDelta::Reset {
                        state: core.state(),
                    }];
                }
                let cursor = core.cursor().unwrap_or(remote_cursor);
                let checkpoint_base = session.pending_cache_offset.or(core.committed_cursor());
                let checkpoint_due = full
                    || update.as_ref().is_some_and(completes_turn)
                    || checkpoint_base.is_none_or(|base| {
                        cursor.saturating_sub(base) >= OPENCODE_CHECKPOINT_EVENTS
                    });
                let new_checkpoint =
                    checkpoint_due && (full || checkpoint_base.is_none_or(|base| cursor > base));
                let cache = new_checkpoint
                    .then(|| core.cache_blob().ok())
                    .flatten()
                    .map(|blob| {
                        session.pending_cache_offset = Some(cursor);
                        (blob, core.source_generation(), cursor)
                    });
                let update = update.or_else(|| {
                    cache.is_some().then(|| AgentTranscriptUpdate {
                        revision: core.revision(),
                        deltas: Vec::new(),
                    })
                });
                (update, cache)
            };
            let cache = cache_candidate.map(|(blob, source_generation, cursor)| {
                let checkpoint = state.next_checkpoint;
                state.next_checkpoint = state.next_checkpoint.saturating_add(1);
                let token = format!("checkpoint-{checkpoint}");
                state.checkpoints.insert(
                    token.clone(),
                    PendingCheckpoint {
                        session_key: key.to_owned(),
                        source_generation,
                        offset: cursor,
                    },
                );
                AgentTranscriptCacheWrite {
                    namespace: self.inner.runtime_id.clone(),
                    key: key.to_owned(),
                    blob,
                    confirmation_token: token,
                }
            });
            let emission = update.map(|update| (update, cache));
            drop(state);
            emission
        };
        if let Some((update, cache)) = emission {
            emit(&self.inner, key.to_owned(), update, cache);
        }
        Ok(())
    }

    fn schedule_opencode_poll(&self, key: String, operation_epoch: u64, session_id: String) {
        let scheduled = {
            let mut state = self.inner.state.lock();
            let Some(session) = current_session_mut(&mut state, &key, operation_epoch) else {
                return;
            };
            if session.retry_running || session.terminals.is_empty() {
                false
            } else {
                session.retry_running = true;
                true
            }
        };
        if !scheduled {
            return;
        }
        let manager = self.clone();
        self.spawn_worker(&key.clone(), operation_epoch, async move {
            tokio::time::sleep(OPENCODE_POLL_DELAY).await;
            let should_poll = {
                let mut state = manager.inner.state.lock();
                let Some(session) = current_session_mut(&mut state, &key, operation_epoch) else {
                    return;
                };
                session.retry_running = false;
                !session.terminals.is_empty() && !session.closed
            };
            if should_poll {
                manager
                    .sync_opencode(key, operation_epoch, session_id)
                    .await;
            }
        });
    }

    fn fail_session(
        &self,
        key: String,
        operation_epoch: u64,
        reason: String,
        kind: SessionFailureKind,
    ) {
        let emission = {
            let mut state = self.inner.state.lock();
            let session = current_session_mut(&mut state, &key, operation_epoch);
            let Some(session) = session else {
                return;
            };
            if session.retry_running || session.terminals.is_empty() {
                return;
            }
            let emission = match kind {
                SessionFailureKind::SourceUnavailable => {
                    session.core.mark_unavailable_update(reason)
                }
                SessionFailureKind::Transient => {
                    session.retry_running = true;
                    session.core.mark_stale_update(reason)
                }
            };
            drop(state);
            emission
        };
        emit(&self.inner, key.clone(), emission, None);
        if kind == SessionFailureKind::SourceUnavailable {
            // Codex deliberately defers creating a new rollout until the first
            // prompt is persisted. Missing history for an untouched TUI is a
            // stable result, not a transport failure. A later explicit Chat
            // open retries through `should_restart_on_start`.
            return;
        }
        let manager = self.clone();
        self.spawn_worker(&key.clone(), operation_epoch, async move {
            tokio::time::sleep(RETRY_DELAY).await;
            let should_retry = {
                let mut state = manager.inner.state.lock();
                let Some(session) = current_session_mut(&mut state, &key, operation_epoch) else {
                    return;
                };
                session.retry_running = false;
                // restart cancels old work; do not abort the currently
                // executing retry before it has installed its successor.
                session.worker = None;
                !session.terminals.is_empty() && !session.closed
            };
            if should_retry {
                manager.restart(key, "Rebinding remote transcript".to_owned());
            }
        });
    }
}

fn cancel_session_work(session: &mut SessionRuntime) {
    session.operation_epoch = session.operation_epoch.saturating_add(1);
    session.retry_running = false;
    if let Some(worker) = session.worker.take() {
        worker.abort();
    }
    if let Some(context) = session.stream_context.take() {
        streams().write().remove(&context);
    }
    if let Some(stream) = session.stream.take() {
        let _ = stream.close();
    }
}

fn should_restart_on_start(
    connected: bool,
    operation_epoch: u64,
    status: AgentTranscriptStatus,
) -> bool {
    connected
        && (operation_epoch == 0
            || matches!(
                status,
                AgentTranscriptStatus::Unavailable | AgentTranscriptStatus::Error
            ))
}

fn current_session_mut<'a>(
    state: &'a mut ManagerState,
    key: &str,
    operation_epoch: u64,
) -> Option<&'a mut SessionRuntime> {
    if !state.connected || !state.foreground {
        return None;
    }
    state
        .sessions
        .get_mut(key)
        .filter(|session| session.operation_epoch == operation_epoch && !session.closed)
}

fn merge_updates(
    first: Option<AgentTranscriptUpdate>,
    second: Option<AgentTranscriptUpdate>,
) -> Option<AgentTranscriptUpdate> {
    match (first, second) {
        (Some(mut first), Some(second)) => {
            first.revision = second.revision;
            first.deltas.extend(second.deltas);
            Some(first)
        }
        (Some(first), None) => Some(first),
        (None, Some(second)) => Some(second),
        (None, None) => None,
    }
}

fn completes_turn(update: &AgentTranscriptUpdate) -> bool {
    update.deltas.iter().any(|delta| {
        matches!(
            delta,
            AgentTranscriptDelta::TurnUpserted { turn, .. }
                if turn.completed_at_ms.is_some()
                    && matches!(turn.status, AgentTurnStatus::Idle | AgentTurnStatus::Error | AgentTurnStatus::Interrupted)
        )
    })
}

fn emit(
    manager: &Arc<AgentSessionManagerInner>,
    key: String,
    update: AgentTranscriptUpdate,
    cache_write: Option<AgentTranscriptCacheWrite>,
) {
    let sink = event_sink().read().clone();
    if let Some(sink) = sink {
        sink.event(AgentTranscriptEvent {
            runtime_id: manager.runtime_id.clone(),
            runtime_incarnation: manager.runtime_incarnation,
            key,
            update,
            cache_write,
        });
    }
}

fn stream_data(context: u64, bytes: Vec<u8>) {
    let Some(context_value) = streams().read().get(&context).cloned() else {
        return;
    };
    let Some(manager) = context_value.manager.upgrade() else {
        streams().write().remove(&context);
        return;
    };
    let emission = {
        let mut state = manager.state.lock();
        let (update, cache_candidate) = {
            let Some(session) = current_session_mut(
                &mut state,
                &context_value.session_key,
                context_value.operation_epoch,
            ) else {
                return;
            };
            let AgentSessionCore::Codex(core) = &mut session.core else {
                return;
            };
            match core.ingest(context_value.source_generation, &bytes) {
                Ok(result) => {
                    let current_generation = result.source_generation == core.source_generation();
                    let update = merge_updates(
                        result.update,
                        current_generation
                            .then(|| core.mark_live_update())
                            .flatten(),
                    );
                    let checkpoint_base = session
                        .pending_cache_offset
                        .unwrap_or_else(|| core.committed_offset());
                    let checkpoint_due = update.as_ref().is_some_and(completes_turn)
                        || result.committable_offset.saturating_sub(checkpoint_base)
                            >= CODEX_CHECKPOINT_BYTES;
                    let new_checkpoint =
                        checkpoint_due && result.committable_offset > checkpoint_base;
                    let cache = new_checkpoint
                        .then(|| core.cache_blob().ok())
                        .flatten()
                        .map(|blob| {
                            session.pending_cache_offset = Some(result.committable_offset);
                            (blob, result.committable_offset)
                        });
                    let update = update.or_else(|| {
                        cache.is_some().then(|| AgentTranscriptUpdate {
                            revision: core.revision(),
                            deltas: Vec::new(),
                        })
                    });
                    (update, cache)
                }
                Err(error) => (
                    Some(session.core.mark_stale_update(error.to_string())),
                    None,
                ),
            }
        };
        let cache = cache_candidate.map(|(blob, offset)| {
            let checkpoint = state.next_checkpoint;
            state.next_checkpoint = state.next_checkpoint.saturating_add(1);
            let token = format!("checkpoint-{checkpoint}");
            state.checkpoints.insert(
                token.clone(),
                PendingCheckpoint {
                    session_key: context_value.session_key.clone(),
                    source_generation: context_value.source_generation,
                    offset,
                },
            );
            AgentTranscriptCacheWrite {
                namespace: manager.runtime_id.clone(),
                key: context_value.session_key.clone(),
                blob,
                confirmation_token: token,
            }
        });
        update.map(|update| (update, cache))
    };
    if let Some((update, cache)) = emission {
        emit(&manager, context_value.session_key, update, cache);
    }
}

fn stream_failed(context: u64, reason: String) {
    let Some(context_value) = streams().write().remove(&context) else {
        return;
    };
    let Some(manager) = context_value.manager.upgrade() else {
        return;
    };
    AgentSessionManager { inner: manager }.fail_session(
        context_value.session_key,
        context_value.operation_epoch,
        reason,
        SessionFailureKind::Transient,
    );
}

async fn execute(
    connection: &HerdrConnection,
    command: String,
) -> Result<String, AgentSessionError> {
    let output = connection
        .execute(&command)
        .await
        .map_err(|error| AgentSessionError::ReadFailed(error.to_string()))?;
    if output.exit_status.is_some_and(|status| status != 0) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        return Err(AgentSessionError::ReadFailed(if stderr.is_empty() {
            "remote transcript command failed".to_owned()
        } else {
            stderr.to_owned()
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn validate_codex_session_id(value: &str) -> Result<(), AgentSessionError> {
    let valid = value.len() == 36
        && value
            .chars()
            .enumerate()
            .all(|(index, character)| match index {
                8 | 13 | 18 | 23 => character == '-',
                _ => character.is_ascii_hexdigit(),
            });
    if valid {
        Ok(())
    } else {
        Err(AgentSessionError::InvalidSession(
            "Codex session ID must be a UUID".to_owned(),
        ))
    }
}

fn validate_opencode_session_id(value: &str) -> Result<(), AgentSessionError> {
    let valid = value.strip_prefix("ses_").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_alphanumeric())
    });
    if valid {
        Ok(())
    } else {
        Err(AgentSessionError::InvalidSession(
            "OpenCode session ID must match ses_[A-Za-z0-9]+".to_owned(),
        ))
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn opencode_login_command(command: &str) -> String {
    // SSH hands this string to the user's login shell first. Keep that outer
    // layer valid in Bash and Fish, then let POSIX sh select the configured
    // login shell so its PATH setup remains available to OpenCode.
    let login_dispatch = r#"exec "${SHELL:-/bin/sh}" -lc "$1""#;
    format!(
        "exec /bin/sh -c {} whip-opencode {}",
        shell_quote(login_dispatch),
        shell_quote(command)
    )
}

fn opencode_export_command(session_id: &str) -> String {
    format!("opencode export {}", shell_quote(session_id))
}

fn sqlite_text_literal(value: &str) -> String {
    let mut literal = String::from("char(");
    for (index, byte) in value.bytes().enumerate() {
        if index != 0 {
            literal.push(',');
        }
        literal.push_str(&byte.to_string());
    }
    literal.push(')');
    literal
}

fn opencode_cursor_command(session_id: &str) -> String {
    let session_id = sqlite_text_literal(session_id);
    let query =
        format!("SELECT COALESCE(MAX(seq), 0) AS seq FROM event WHERE aggregate_id = {session_id}");
    format!("opencode db {} --format json", shell_quote(&query))
}

fn opencode_events_command(session_id: &str, after_sequence: u64) -> String {
    let session_id = sqlite_text_literal(session_id);
    let query = format!(
        "SELECT seq, type, data FROM event WHERE aggregate_id = {session_id} AND seq > {after_sequence} ORDER BY seq"
    );
    format!("opencode db {} --format json", shell_quote(&query))
}

fn codex_rollout_find_command(session_id: &str) -> String {
    let ordinary = shell_quote(&format!("rollout-*-{session_id}.jsonl"));
    let reverted = shell_quote(&format!("rollout-*-{session_id}_*.jsonl"));
    format!(
        "find \"$HOME/.codex/sessions\" -type f \\( -name {ordinary} -o -name {reverted} \\) -print"
    )
}

/// Stream raw rollout bytes immediately after the committed byte cursor.
///
/// Keep this as one direct exec rather than a remote shell supervisor. Besides
/// avoiding login-shell differences, this is the exact transport shape used
/// by the previous working TypeScript implementation. `-F` also survives a
/// same-path replacement; a new reverted-rollout filename is selected by the
/// Rust resolver whenever the stream is opened or rebound.
fn codex_stream_command(path: &str, offset: u64) -> String {
    let start = shell_quote(&format!("+{}", offset.saturating_add(1)));
    format!("exec tail -c {start} -F {}", shell_quote(path))
}

fn resolve_rollout_path(
    output: &str,
    session_id: &str,
) -> Result<Option<String>, AgentSessionError> {
    let paths = output
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return Ok(None);
    }

    // Codex keeps the thread ID stable across thread/revert, but writes the
    // replacement as `<thread-id>_<rollout-id>`. Mirror Codex's filesystem
    // fallback: select the newest filename timestamp and use the rollout UUID
    // as a deterministic tie-breaker for files created in the same second.
    let expected_thread = parse_uuid_bytes(session_id).ok_or_else(|| {
        AgentSessionError::InvalidSession("Codex session ID must be a UUID".to_owned())
    })?;
    let mut newest: Option<(NaiveDateTime, [u8; 16], &str)> = None;
    for path in paths {
        let Some((timestamp, thread_id, rollout_id)) = parse_rollout_filename(path) else {
            continue;
        };
        if thread_id != expected_thread {
            continue;
        }
        let replace = newest
            .as_ref()
            .is_none_or(|(current_timestamp, current_rollout, _)| {
                timestamp > *current_timestamp
                    || (timestamp == *current_timestamp && rollout_id > *current_rollout)
            });
        if replace {
            newest = Some((timestamp, rollout_id, path));
        }
    }

    newest
        .map(|(_, _, path)| Some(path.to_owned()))
        .ok_or_else(|| {
            AgentSessionError::SourceUnavailable(
                "Codex returned no valid rollout path for the session ID".to_owned(),
            )
        })
}

fn parse_rollout_filename(path: &str) -> Option<(NaiveDateTime, [u8; 16], [u8; 16])> {
    let name = path.rsplit('/').next()?;
    let core = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let timestamp = core.get(..19)?;
    if core.get(19..20)? != "-" {
        return None;
    }
    let timestamp = NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%dT%H-%M-%S").ok()?;
    let ids = core.get(20..)?;
    let (thread_id, rollout_id) = ids.split_once('_').unwrap_or((ids, ids));
    Some((
        timestamp,
        parse_uuid_bytes(thread_id)?,
        parse_uuid_bytes(rollout_id)?,
    ))
}

fn parse_uuid_bytes(value: &str) -> Option<[u8; 16]> {
    if value.len() != 36 {
        return None;
    }
    let mut bytes = [0_u8; 16];
    let mut nibble_index = 0_usize;
    for (index, character) in value.bytes().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if character != b'-' {
                return None;
            }
            continue;
        }
        let nibble = match character {
            b'0'..=b'9' => character - b'0',
            b'a'..=b'f' => character - b'a' + 10,
            b'A'..=b'F' => character - b'A' + 10,
            _ => return None,
        };
        let byte = bytes.get_mut(nibble_index / 2)?;
        if nibble_index.is_multiple_of(2) {
            *byte = nibble << 4;
        } else {
            *byte |= nibble;
        }
        nibble_index += 1;
    }
    (nibble_index == 32).then_some(bytes)
}

fn parse_metadata(output: &str) -> Result<(String, u64), AgentSessionError> {
    let mut fields = output.split_whitespace();
    let file_id = fields.next().unwrap_or_default();
    let size = fields.next().and_then(|value| value.parse::<u64>().ok());
    let file_id_valid = file_id.split_once(':').is_some_and(|(device, inode)| {
        !device.is_empty()
            && !inode.is_empty()
            && device.chars().all(|value| value.is_ascii_digit())
            && inode.chars().all(|value| value.is_ascii_digit())
    });
    if !file_id_valid || fields.next().is_some() {
        return Err(AgentSessionError::SourceUnavailable(
            "Codex returned invalid rollout metadata".to_owned(),
        ));
    }
    let size = size.ok_or_else(|| {
        AgentSessionError::SourceUnavailable("Codex returned invalid rollout metadata".to_owned())
    })?;
    Ok((file_id.to_owned(), size))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "11111111-1111-4111-8111-111111111111";

    fn test_manager(runtime_id: &str) -> AgentSessionManager {
        let manager = AgentSessionManager::new(
            runtime_id.to_owned(),
            1,
            HerdrConnection::new(runtime_id.to_owned(), String::new(), None, None),
        );
        manager.set_foreground(true);
        manager
    }

    #[test]
    fn validates_session_ids_before_building_remote_commands() {
        assert!(validate_codex_session_id(SESSION).is_ok());
        assert!(validate_codex_session_id(&format!("{SESSION}; uname -a")).is_err());
        assert!(validate_opencode_session_id("ses_abc123").is_ok());
        assert!(validate_opencode_session_id("ses_x'; DROP TABLE event;--").is_err());
    }

    #[test]
    fn background_cancels_inflight_work_and_rejects_late_results_without_losing_binding() {
        crate::runtime().unwrap().block_on(async {
            let manager = test_manager("pause-inflight");
            manager.connected();
            let binding = manager
                .bind_codex("terminal".into(), SESSION.into())
                .unwrap();
            let epoch = {
                let mut state = manager.inner.state.lock();
                let session = state.sessions.get_mut(&binding.transcript_key).unwrap();
                session.started = true;
                let epoch = session.operation_epoch;
                drop(state);
                epoch
            };
            let (alive, cancelled) = tokio::sync::oneshot::channel::<()>();
            manager.spawn_worker(&binding.transcript_key, epoch, async move {
                let _alive = alive;
                std::future::pending::<()>().await;
            });
            manager.set_foreground(false);
            assert!(
                tokio::time::timeout(Duration::from_secs(1), cancelled)
                    .await
                    .unwrap()
                    .is_err()
            );
            let paused = manager.state(&binding.transcript_key).unwrap();
            manager.fail_session(
                binding.transcript_key.clone(),
                epoch,
                "late failure".into(),
                SessionFailureKind::Transient,
            );
            manager.schedule_opencode_poll(binding.transcript_key.clone(), epoch, SESSION.into());
            assert_eq!(manager.state(&binding.transcript_key).unwrap(), paused);
            assert!(manager.has_terminal_binding("terminal"));
            let state = manager.inner.state.lock();
            let session = &state.sessions[&binding.transcript_key];
            assert!(session.worker.is_none());
            assert!(!session.retry_running);
            drop(state);
        });
    }

    #[test]
    fn background_start_waits_and_repeated_foreground_signal_does_not_duplicate_worker() {
        let manager = test_manager("pause-before-start");
        manager.connected();
        manager.set_foreground(false);
        let binding = manager
            .bind_opencode("terminal".into(), "ses_abc123".into())
            .unwrap();
        manager.start_bound(&binding.binding_token, None).unwrap();
        {
            let state = manager.inner.state.lock();
            let session = &state.sessions[&binding.transcript_key];
            assert!(session.started);
            assert!(session.worker.is_none());
            drop(state);
        }
        manager.set_foreground(true);
        let epoch = manager.inner.state.lock().sessions[&binding.transcript_key].operation_epoch;
        manager.set_foreground(true);
        assert_eq!(
            manager.inner.state.lock().sessions[&binding.transcript_key].operation_epoch,
            epoch
        );
        manager.set_foreground(false);
        assert!(
            manager.inner.state.lock().sessions[&binding.transcript_key]
                .worker
                .is_none()
        );
        manager.disconnected(true, "test cleanup");
    }

    #[test]
    fn background_pause_preserves_codex_cursor_and_partial_line() {
        let manager = test_manager("pause-cursor");
        let binding = manager
            .bind_codex("terminal".into(), SESSION.into())
            .unwrap();
        let (generation, offset) = {
            let mut state = manager.inner.state.lock();
            let session = state.sessions.get_mut(&binding.transcript_key).unwrap();
            session.started = true;
            let AgentSessionCore::Codex(core) = &mut session.core else {
                panic!("Codex core")
            };
            let source = core.bind_source("/tmp/rollout.jsonl".into(), "1:2".into(), 200);
            core.ingest(
                source.source_generation,
                b"{\"type\":\"unknown\"}\n{\"type\":",
            )
            .unwrap();
            let cursor = (core.source_generation(), core.committed_offset());
            drop(state);
            cursor
        };
        manager.set_foreground(false);
        // Resume without an installed transport must retain the in-memory reducer.
        manager.set_foreground(true);
        let mut state = manager.inner.state.lock();
        let session = state.sessions.get_mut(&binding.transcript_key).unwrap();
        let AgentSessionCore::Codex(core) = &mut session.core else {
            panic!("Codex core")
        };
        assert_eq!(core.source_generation(), generation);
        assert_eq!(core.committed_offset(), offset);
        assert!(core.ingest(generation, b"\"unknown\"}\n").is_ok());
        drop(state);
    }

    #[test]
    fn unavailable_sources_do_not_restart_on_background_foreground_toggle() {
        let manager = test_manager("pause-unavailable");
        manager.connected();
        let binding = manager
            .bind_codex("terminal".into(), SESSION.into())
            .unwrap();
        let epoch = manager.inner.state.lock().sessions[&binding.transcript_key].operation_epoch;
        manager.fail_session(
            binding.transcript_key.clone(),
            epoch,
            "missing source".into(),
            SessionFailureKind::SourceUnavailable,
        );
        let before = manager.state(&binding.transcript_key).unwrap();
        manager.set_foreground(false);
        manager.set_foreground(true);
        assert_eq!(manager.state(&binding.transcript_key).unwrap(), before);
        assert!(
            manager.inner.state.lock().sessions[&binding.transcript_key]
                .worker
                .is_none()
        );
    }

    #[test]
    fn opencode_commands_use_the_official_read_only_db_interface() {
        assert_eq!(
            opencode_export_command("ses_abc123"),
            "opencode export 'ses_abc123'"
        );
        let session_literal = "char(115,101,115,95,97,98,99,49,50,51)";
        assert!(opencode_cursor_command("ses_abc123").contains(&format!(
            "MAX(seq), 0) AS seq FROM event WHERE aggregate_id = {session_literal}"
        )));
        assert!(
            opencode_events_command("ses_abc123", 42)
                .contains(&format!("aggregate_id = {session_literal} AND seq > 42"))
        );
        assert_eq!(
            opencode_login_command("opencode export 'ses_abc123'"),
            concat!(
                "exec /bin/sh -c 'exec \"${SHELL:-/bin/sh}\" -lc \"$1\"' ",
                "whip-opencode 'opencode export '\\''ses_abc123'\\'''"
            )
        );
    }

    #[test]
    fn rollout_resolution_accepts_an_ordinary_rollout() {
        let path = format!(
            "/home/me/.codex/sessions/2026/08/26/rollout-2026-08-26T10-20-30-{SESSION}.jsonl"
        );
        assert_eq!(
            resolve_rollout_path(&format!("{path}\n"), SESSION).unwrap(),
            Some(path)
        );
        assert!(resolve_rollout_path("/wrong.jsonl\n", SESSION).is_err());
        assert!(resolve_rollout_path("", SESSION).unwrap().is_none());
    }

    #[test]
    fn rollout_resolution_follows_the_newest_reverted_rollout() {
        let older = format!(
            "/home/me/.codex/sessions/2026/08/26/rollout-2026-08-26T10-20-30-{SESSION}.jsonl"
        );
        let rollout = "0198e6cc-9d62-7000-8000-000000000001";
        let newer = format!(
            "/home/me/.codex/sessions/2026/08/26/rollout-2026-08-26T10-21-30-{SESSION}_{rollout}.jsonl"
        );
        assert_eq!(
            resolve_rollout_path(&format!("{older}\n{newer}\n"), SESSION).unwrap(),
            Some(newer)
        );
    }

    #[test]
    fn rollout_resolution_uses_rollout_uuid_to_break_timestamp_ties() {
        let first_rollout = "0198e6cc-9d62-7000-8000-000000000001";
        let second_rollout = "0198e6cc-9d62-7000-8000-000000000002";
        let first =
            format!("/sessions/rollout-2026-08-26T10-20-30-{SESSION}_{first_rollout}.jsonl");
        let second =
            format!("/sessions/rollout-2026-08-26T10-20-30-{SESSION}_{second_rollout}.jsonl");
        assert_eq!(
            resolve_rollout_path(&format!("{second}\n{first}\n"), SESSION).unwrap(),
            Some(second)
        );
    }

    #[test]
    fn rollout_resolution_rejects_invalid_revert_suffixes_and_other_threads() {
        let other_thread = "22222222-2222-4222-8222-222222222222";
        let invalid = format!("/sessions/rollout-2026-08-26T10-20-30-{SESSION}_not-a-uuid.jsonl");
        let other = format!("/sessions/rollout-2026-08-26T10-20-30-{other_thread}.jsonl");
        assert!(resolve_rollout_path(&format!("{invalid}\n{other}\n"), SESSION).is_err());
    }

    #[test]
    fn rollout_discovery_searches_ordinary_and_reverted_names() {
        let command = codex_rollout_find_command(SESSION);
        assert!(command.contains(&format!("'rollout-*-{SESSION}.jsonl'")));
        assert!(command.contains(&format!("'rollout-*-{SESSION}_*.jsonl'")));
    }

    #[test]
    fn metadata_validation_preserves_file_identity_and_size() {
        assert_eq!(
            parse_metadata("12:34 456\n").unwrap(),
            ("12:34".to_owned(), 456)
        );
        assert!(parse_metadata("bad 456").is_err());
        assert!(matches!(
            parse_metadata("12:34 nope"),
            Err(AgentSessionError::SourceUnavailable(message))
                if message == "Codex returned invalid rollout metadata"
        ));
    }

    #[test]
    fn stream_command_matches_the_pre_migration_binary_path() {
        assert_eq!(
            codex_stream_command("/tmp/rollout's file.jsonl", 123),
            "exec tail -c '+124' -F '/tmp/rollout'\\''s file.jsonl'"
        );
    }

    #[test]
    fn two_sessions_and_terminal_bindings_are_independent() {
        let manager = test_manager("host");
        let second = "22222222-2222-4222-8222-222222222222";
        let first = manager
            .bind_codex("terminal-1".into(), SESSION.into())
            .unwrap();
        let second = manager
            .bind_codex("terminal-2".into(), second.into())
            .unwrap();
        assert_ne!(first.transcript_key, second.transcript_key);
        manager.close_terminal("terminal-1");
        assert_eq!(
            manager.state(&first.transcript_key).unwrap().status,
            AgentTranscriptStatus::Closed
        );
        assert!(manager.state(&second.transcript_key).is_some());
    }

    #[test]
    fn cache_identity_is_host_qualified_agent_qualified_and_reconnect_stable() {
        let first_host = test_manager("host-a");
        let second_host = test_manager("host-b");
        first_host.connected();
        second_host.connected();

        let codex = first_host
            .bind_codex("terminal-codex".into(), SESSION.into())
            .unwrap();
        let opencode = first_host
            .bind_opencode("terminal-opencode".into(), "ses_abc123".into())
            .unwrap();
        let other_host = second_host
            .bind_codex("terminal-codex".into(), SESSION.into())
            .unwrap();

        assert_eq!(codex.transcript_key, format!("host-a\ncodex\n{SESSION}"));
        assert_eq!(opencode.transcript_key, "host-a\nopencode\nses_abc123");
        assert_ne!(codex.transcript_key, opencode.transcript_key);
        assert_ne!(codex.transcript_key, other_host.transcript_key);

        first_host.disconnected(false, "network changed");
        first_host.connected();
        let rebound = first_host
            .bind_codex("terminal-rebound".into(), SESSION.into())
            .unwrap();
        assert_eq!(rebound.transcript_key, codex.transcript_key);
    }

    #[test]
    fn shared_session_lives_until_its_last_terminal_detaches() {
        let manager = test_manager("host");
        let first = manager
            .bind_codex("terminal-1".into(), SESSION.into())
            .unwrap();
        let second = manager
            .bind_codex("terminal-2".into(), SESSION.into())
            .unwrap();
        assert_eq!(second.transcript_key, first.transcript_key);
        manager.start_bound(&first.binding_token, None).unwrap();

        assert_eq!(manager.close_terminal("terminal-1"), None);
        assert!(manager.state(&first.transcript_key).is_some());
        assert_eq!(
            manager.close_terminal("terminal-2"),
            Some(first.transcript_key.clone())
        );
        assert_eq!(
            manager.state(&first.transcript_key).unwrap().status,
            AgentTranscriptStatus::Closed
        );
    }

    #[test]
    fn late_cache_start_cannot_restore_a_rebound_terminal() {
        let manager = test_manager("host");
        let old = manager
            .bind_codex("terminal".into(), SESSION.into())
            .unwrap();
        let replacement = "22222222-2222-4222-8222-222222222222";
        let new = manager
            .bind_codex("terminal".into(), replacement.into())
            .unwrap();

        assert!(matches!(
            manager.start_bound(&old.binding_token, None),
            Ok(AgentChatStartResult::StaleBinding)
        ));
        assert_eq!(
            manager.state(&old.transcript_key).unwrap().status,
            AgentTranscriptStatus::Closed
        );
        assert!(matches!(
            manager.start_bound(&new.binding_token, None),
            Ok(AgentChatStartResult::Started { .. })
        ));
    }

    #[test]
    fn released_session_only_restarts_after_an_explicit_reopen() {
        let manager = test_manager("host");
        let first = manager
            .bind_codex("terminal".into(), SESSION.into())
            .unwrap();
        manager.start_bound(&first.binding_token, None).unwrap();
        {
            let mut state = manager.inner.state.lock();
            let session = state.sessions.get_mut(&first.transcript_key).unwrap();
            let AgentSessionCore::Codex(core) = &mut session.core else {
                panic!("expected Codex core");
            };
            let _ = core.mark_live_update();
            drop(state);
        }
        manager.close_terminal("terminal");

        assert_eq!(
            manager.state(&first.transcript_key).unwrap().status,
            AgentTranscriptStatus::Closed
        );
        let reopened = manager
            .bind_codex("terminal".into(), SESSION.into())
            .unwrap();
        assert_eq!(reopened.state.status, AgentTranscriptStatus::Loading);
        assert_ne!(reopened.binding_token, first.binding_token);
        assert!(matches!(
            manager.start_bound(&reopened.binding_token, None),
            Ok(AgentChatStartResult::Started { .. })
        ));
        {
            let mut state = manager.inner.state.lock();
            let session = state.sessions.get_mut(&reopened.transcript_key).unwrap();
            let AgentSessionCore::Codex(core) = &mut session.core else {
                panic!("expected Codex core");
            };
            let _ = core.mark_live_update();
            drop(state);
        }
        assert_eq!(
            manager.state(&reopened.transcript_key).unwrap().status,
            AgentTranscriptStatus::Live
        );
    }

    #[test]
    fn callbacks_from_rebound_session_epoch_cannot_mutate_replacement() {
        let manager = test_manager("host");
        manager.connected();
        let old = manager
            .bind_codex("terminal".into(), SESSION.into())
            .unwrap();
        let old_epoch = manager
            .inner
            .state
            .lock()
            .sessions
            .get(&old.transcript_key)
            .unwrap()
            .operation_epoch;
        let replacement = manager
            .bind_codex(
                "terminal".into(),
                "22222222-2222-4222-8222-222222222222".into(),
            )
            .unwrap();
        let before = manager.state(&replacement.transcript_key).unwrap();

        manager.fail_session(
            old.transcript_key,
            old_epoch,
            "late callback".to_owned(),
            SessionFailureKind::Transient,
        );

        assert_eq!(manager.state(&replacement.transcript_key).unwrap(), before);
    }

    #[test]
    fn missing_codex_rollout_stays_unavailable_until_explicit_reopen() {
        let manager = test_manager("host");
        manager.connected();
        let binding = manager
            .bind_codex("terminal".into(), SESSION.into())
            .unwrap();
        let operation_epoch = manager
            .inner
            .state
            .lock()
            .sessions
            .get(&binding.transcript_key)
            .unwrap()
            .operation_epoch;

        manager.fail_session(
            binding.transcript_key.clone(),
            operation_epoch,
            "Codex has not created this rollout yet.".to_owned(),
            SessionFailureKind::SourceUnavailable,
        );

        let state = manager.inner.state.lock();
        let session = state.sessions.get(&binding.transcript_key).unwrap();
        assert_eq!(
            session.core.state().status,
            AgentTranscriptStatus::Unavailable
        );
        assert_eq!(
            session.core.state().error.as_deref(),
            Some("Codex has not created this rollout yet.")
        );
        assert!(!session.retry_running);
        assert_eq!(session.operation_epoch, operation_epoch);
        drop(state);

        assert!(should_restart_on_start(
            true,
            operation_epoch,
            AgentTranscriptStatus::Unavailable
        ));
    }

    #[test]
    fn binding_tokens_are_scoped_to_runtime_incarnation() {
        let old = AgentSessionManager::new(
            "host".to_owned(),
            1,
            HerdrConnection::new("host-old".to_owned(), String::new(), None, None),
        );
        let replacement = AgentSessionManager::new(
            "host".to_owned(),
            2,
            HerdrConnection::new("host-new".to_owned(), String::new(), None, None),
        );
        let old_binding = old.bind_codex("terminal".into(), SESSION.into()).unwrap();
        let replacement_binding = replacement
            .bind_codex("terminal".into(), SESSION.into())
            .unwrap();

        assert_ne!(old_binding.binding_token, replacement_binding.binding_token);
        assert!(matches!(
            replacement.start_bound(&old_binding.binding_token, None),
            Ok(AgentChatStartResult::StaleBinding)
        ));
    }

    #[test]
    fn explicit_start_retries_failed_sessions() {
        assert!(should_restart_on_start(
            true,
            2,
            AgentTranscriptStatus::Unavailable
        ));
        assert!(should_restart_on_start(
            true,
            2,
            AgentTranscriptStatus::Error
        ));
        assert!(!should_restart_on_start(
            true,
            2,
            AgentTranscriptStatus::Loading
        ));
        assert!(!should_restart_on_start(
            true,
            2,
            AgentTranscriptStatus::Live
        ));
        assert!(!should_restart_on_start(
            true,
            2,
            AgentTranscriptStatus::Stale
        ));
        assert!(!should_restart_on_start(
            true,
            2,
            AgentTranscriptStatus::Closed
        ));
        assert!(!should_restart_on_start(
            false,
            2,
            AgentTranscriptStatus::Unavailable
        ));
        assert!(should_restart_on_start(
            true,
            0,
            AgentTranscriptStatus::Loading
        ));
    }
}
