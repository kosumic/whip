//! Generation-aware transport boundary for logical Herdr streams.

use std::future::Future;
use std::sync::{
    Arc, Weak,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use parking_lot::RwLock;
use tokio::sync::{Mutex, watch};

use crate::herdr_api::HerdrControlError;
use crate::host_profiles::HostHerdrBackend;
use crate::ssh::{CommandOutput, SshErrorCode, SshFailure, SshSession};

const REMOTE_HOME_COMMAND: &str = r#"printf %s "$HOME""#;
pub(crate) const HERDR_DISABLED_MESSAGE: &str = "Herdr is disabled for this host";
static NEXT_STREAM_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HerdrStreamKind {
    Events,
    Terminal,
    AgentView,
}

impl HerdrStreamKind {
    fn channel_label(self) -> &'static str {
        match self {
            Self::Events => "events",
            Self::Terminal => "terminal",
            Self::AgentView => "agent-view",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HerdrStreamFraming {
    Raw,
    LengthPrefixed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HerdrRequestReplay {
    Never,
    AfterSocketRediscovery,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum HerdrConnectionError {
    #[error("{HERDR_DISABLED_MESSAGE}")]
    Disabled,
    #[error("Herdr connection is disconnected")]
    Disconnected,
    #[error("Herdr connection was replaced while the operation was active")]
    Stale,
    #[error("SSH transport returned an invalid remote home directory")]
    InvalidRemoteHome,
    #[error(transparent)]
    Transport(#[from] SshFailure),
}

impl HerdrConnectionError {
    pub(crate) fn is_timeout(&self) -> bool {
        matches!(
            self,
            Self::Transport(SshFailure::Transport {
                code: SshErrorCode::ConnectionTimeout,
                ..
            })
        )
    }
}

struct ConnectionState {
    revision: u64,
    generation: u64,
    ssh: Option<Arc<SshSession>>,
    socket_path: Option<String>,
    socket_from_cache: bool,
    backend: Option<HostHerdrBackend>,
}

#[derive(Clone)]
struct ConnectionSnapshot {
    revision: u64,
    generation: u64,
    ssh: Arc<SshSession>,
}

#[derive(Clone)]
struct ResolvedSocket {
    path: String,
    from_cache: bool,
}

pub(crate) enum SubmissionRequestFailure {
    Unsent,
    Ambiguous,
}

/// The stable connection object used by every Herdr protocol consumer.
///
/// HostRuntime replaces the SSH session inside this object. Callers retain the
/// same `Arc<HerdrConnection>` and ask it for logical streams; they never need
/// to coordinate SSH generations, stream-local paths, or stale callbacks.
pub(crate) struct HerdrConnection {
    client_key: String,
    enabled: bool,
    session_name: String,
    state: RwLock<ConnectionState>,
    lifecycle: watch::Sender<u64>,
    socket_discovery: Mutex<()>,
    backend_config: RwLock<(HostHerdrBackend, String)>,
    explicit_socket: Option<String>,
    core: RwLock<Option<Arc<crate::hc_transport::Core>>>,
    core_start: Mutex<()>,
}

impl HerdrConnection {
    pub(crate) fn new(
        client_key: String,
        session_name: String,
        socket_path: Option<String>,
        cached_socket_path: Option<String>,
        enabled: bool,
    ) -> Arc<Self> {
        let cached_socket_path =
            cached_socket_path.filter(|path| path.ends_with(&session_socket_suffix(&session_name)));
        let socket_from_cache = socket_path.is_none() && cached_socket_path.is_some();
        let resolved_socket = socket_path.clone().or(cached_socket_path);
        let (lifecycle, _) = watch::channel(0);
        Arc::new(Self {
            client_key,
            enabled,
            session_name,
            state: RwLock::new(ConnectionState {
                revision: 0,
                generation: 0,
                ssh: None,
                socket_path: resolved_socket,
                socket_from_cache,
                backend: None,
            }),
            lifecycle,
            socket_discovery: Mutex::new(()),
            backend_config: RwLock::new((HostHerdrBackend::Legacy, "herdr".into())),
            explicit_socket: socket_path,
            core: RwLock::new(None),
            core_start: Mutex::new(()),
        })
    }

    pub(crate) fn registered(
        client_key: String,
        socket_path: String,
    ) -> Result<Arc<Self>, HerdrConnectionError> {
        let ssh = SshSession::registered(&client_key)?;
        let connection = Self::new(client_key, String::new(), Some(socket_path), None, true);
        let _ = connection.install(1, ssh);
        Ok(connection)
    }

    pub(crate) fn client_key(&self) -> &str {
        &self.client_key
    }

    pub(crate) fn configure_backend(&self, backend: HostHerdrBackend, command: String) {
        *self.backend_config.write() = (backend, command);
    }
    pub(crate) fn core_command(&self) -> String {
        let config = self.backend_config.read();
        if config.1.trim().is_empty() || config.1 == "herdr" {
            "hc".into()
        } else {
            config.1.clone()
        }
    }
    pub(crate) fn configured_backend(&self) -> HostHerdrBackend {
        self.backend_config.read().0
    }
    pub(crate) async fn backend(&self) -> Result<HostHerdrBackend, HerdrControlError> {
        if !self.enabled {
            return Err(HerdrControlError::InvalidField(
                HERDR_DISABLED_MESSAGE.into(),
            ));
        }
        let configured = self.configured_backend();
        if configured != HostHerdrBackend::Auto {
            return Ok(configured);
        }
        if let Some(backend) = self.state.read().backend {
            return Ok(backend);
        }
        let revision = self.revision();
        let command = self.core_command();
        let probe = herdr_protocol::hc::endpoint::discover_command(
            &command,
            &self.session_name,
            self.explicit_socket.as_deref(),
        )
        .map_err(|e| HerdrControlError::InvalidField(e.to_string()))?;
        let output = self
            .execute(&probe)
            .await
            .map_err(|e| HerdrControlError::TransportDisconnected(e.to_string()))?;
        let installed = match herdr_protocol::hc::endpoint::parse_discovery(&output.stdout)
            .map_err(|e| HerdrControlError::MalformedResponse(e.to_string()))?
        {
            Some(endpoint) => endpoint.installed,
            None => {
                let command = herdr_protocol::hc::endpoint::version_command(&command, false)
                    .map_err(|e| HerdrControlError::InvalidField(e.to_string()))?;
                self.execute(&command)
                    .await
                    .map_err(|e| HerdrControlError::TransportDisconnected(e.to_string()))?
                    .exit_status
                    == Some(0)
            }
        };
        let backend = if installed {
            HostHerdrBackend::Core
        } else {
            let output = self
                .execute(&herdr_protocol::hc::endpoint::legacy_version_command())
                .await
                .map_err(|e| HerdrControlError::TransportDisconnected(e.to_string()))?;
            if output.exit_status == Some(0) {
                HostHerdrBackend::Legacy
            } else {
                HostHerdrBackend::Core
            }
        };
        let mut state = self.state.write();
        if state.revision != revision {
            return Err(HerdrControlError::TransportDisconnected(
                "SSH changed during backend detection".into(),
            ));
        }
        state.backend = Some(backend);
        drop(state);
        Ok(backend)
    }
    pub(crate) fn is_core(&self) -> bool {
        self.configured_backend() == HostHerdrBackend::Core
            || self.state.read().backend == Some(HostHerdrBackend::Core)
    }
    pub(crate) fn local_terminal_scrollback(&self) -> bool {
        self.is_core()
    }
    pub(crate) async fn core(
        self: &Arc<Self>,
    ) -> Result<Arc<crate::hc_transport::Core>, HerdrControlError> {
        let _start = self.core_start.lock().await;
        if let Some(core) = self.core.read().as_ref().filter(|core| core.is_alive()) {
            return Ok(core.clone());
        }
        let core = crate::hc_transport::Core::open(
            self.clone(),
            &self.core_command(),
            &self.session_name,
            self.explicit_socket.as_deref(),
        )
        .await?;
        if !core.is_alive() {
            return Err(HerdrControlError::TransportDisconnected(
                "core changed while connecting".into(),
            ));
        }
        *self.core.write() = Some(core.clone());
        Ok(core)
    }

    pub(crate) fn install(&self, generation: u64, ssh: Arc<SshSession>) -> Option<Arc<SshSession>> {
        let (revision, previous) = {
            let mut state = self.state.write();
            state.revision = state.revision.wrapping_add(1);
            state.generation = generation;
            state.backend = None;
            let previous = state.ssh.replace(ssh);
            (state.revision, previous)
        };
        self.lifecycle.send_replace(revision);
        let old_core = self.core.write().take();
        if let Some(core) = old_core {
            core.fail(HerdrControlError::TransportDisconnected(
                "SSH session replaced".into(),
            ));
        }
        previous
    }

    pub(crate) fn clear(&self, generation: u64) -> Option<Arc<SshSession>> {
        let (revision, previous) = {
            let mut state = self.state.write();
            if state.generation != generation || state.ssh.is_none() {
                return None;
            }
            state.revision = state.revision.wrapping_add(1);
            let previous = state.ssh.take();
            (state.revision, previous)
        };
        self.lifecycle.send_replace(revision);
        let old_core = self.core.write().take();
        if let Some(core) = old_core {
            core.fail(HerdrControlError::TransportDisconnected(
                "SSH session disconnected".into(),
            ));
        }
        previous
    }

    pub(crate) fn current_ssh(&self) -> Result<Arc<SshSession>, HerdrConnectionError> {
        Ok(self.snapshot()?.ssh)
    }

    pub(crate) fn resolved_socket_path(&self) -> Option<String> {
        if !self.enabled {
            return None;
        }
        if self.is_core() {
            return self
                .core
                .read()
                .as_ref()
                .and_then(|core| core.socket_path());
        }
        self.state.read().socket_path.clone()
    }

    pub(crate) async fn resolve_control_socket(&self) -> Result<String, HerdrConnectionError> {
        let snapshot = self.snapshot()?;
        Ok(self.resolve_socket(&snapshot).await?.path)
    }

    pub(crate) async fn execute(
        &self,
        command: &str,
    ) -> Result<CommandOutput, HerdrConnectionError> {
        let snapshot = self.snapshot()?;
        self.wait_current(&snapshot, snapshot.ssh.execute(command))
            .await?
            .map_err(Into::into)
    }

    pub(crate) async fn execute_with_timeout(
        &self,
        command: &str,
        timeout: std::time::Duration,
    ) -> Result<CommandOutput, HerdrConnectionError> {
        let snapshot = self.snapshot()?;
        self.wait_current(
            &snapshot,
            snapshot.ssh.execute_with_timeout(command, timeout),
        )
        .await?
        .map_err(Into::into)
    }

    fn snapshot(&self) -> Result<ConnectionSnapshot, HerdrConnectionError> {
        let state = self.state.read();
        let ssh = state
            .ssh
            .clone()
            .filter(|ssh| ssh.is_alive())
            .ok_or(HerdrConnectionError::Disconnected)?;
        Ok(ConnectionSnapshot {
            revision: state.revision,
            generation: state.generation,
            ssh,
        })
    }

    fn snapshot_is_current(&self, snapshot: &ConnectionSnapshot) -> bool {
        let state = self.state.read();
        state.revision == snapshot.revision
            && state.generation == snapshot.generation
            && state
                .ssh
                .as_ref()
                .is_some_and(|ssh| Arc::ptr_eq(ssh, &snapshot.ssh) && ssh.is_alive())
    }

    async fn wait_current<T, F>(
        &self,
        snapshot: &ConnectionSnapshot,
        future: F,
    ) -> Result<T, HerdrConnectionError>
    where
        F: Future<Output = T>,
    {
        let mut lifecycle = self.lifecycle.subscribe();
        if *lifecycle.borrow_and_update() != snapshot.revision
            || !self.snapshot_is_current(snapshot)
        {
            return Err(HerdrConnectionError::Stale);
        }
        tokio::select! {
            result = future => {
                if self.snapshot_is_current(snapshot) {
                    Ok(result)
                } else {
                    Err(HerdrConnectionError::Stale)
                }
            }
            changed = lifecycle.changed() => {
                let _ = changed;
                Err(HerdrConnectionError::Stale)
            }
        }
    }

    async fn resolve_socket(
        &self,
        snapshot: &ConnectionSnapshot,
    ) -> Result<ResolvedSocket, HerdrConnectionError> {
        if !self.enabled {
            return Err(HerdrConnectionError::Disabled);
        }
        {
            let state = self.state.read();
            if state.revision != snapshot.revision {
                return Err(HerdrConnectionError::Stale);
            }
            if let Some(path) = &state.socket_path {
                return Ok(ResolvedSocket {
                    path: path.clone(),
                    from_cache: state.socket_from_cache,
                });
            }
        }

        let _discovery = self.socket_discovery.lock().await;
        {
            let state = self.state.read();
            if state.revision != snapshot.revision {
                return Err(HerdrConnectionError::Stale);
            }
            if let Some(path) = &state.socket_path {
                return Ok(ResolvedSocket {
                    path: path.clone(),
                    from_cache: state.socket_from_cache,
                });
            }
        }

        let output = self
            .wait_current(snapshot, snapshot.ssh.execute(REMOTE_HOME_COMMAND))
            .await??;
        let home = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if home.is_empty() {
            return Err(HerdrConnectionError::InvalidRemoteHome);
        }
        let socket = format!("{home}{}", session_socket_suffix(&self.session_name));
        let mut state = self.state.write();
        if state.revision != snapshot.revision {
            return Err(HerdrConnectionError::Stale);
        }
        state.socket_path = Some(socket.clone());
        state.socket_from_cache = false;
        drop(state);
        Ok(ResolvedSocket {
            path: socket,
            from_cache: false,
        })
    }

    fn invalidate_cached_socket(
        &self,
        snapshot: &ConnectionSnapshot,
        socket: &ResolvedSocket,
    ) -> bool {
        if !socket.from_cache {
            return false;
        }
        let mut state = self.state.write();
        if state.revision != snapshot.revision
            || !state.socket_from_cache
            || state.socket_path.as_deref() != Some(&socket.path)
        {
            return false;
        }
        state.socket_path = None;
        state.socket_from_cache = false;
        true
    }

    fn confirm_socket(&self, snapshot: &ConnectionSnapshot, socket: &ResolvedSocket) {
        let mut state = self.state.write();
        if state.revision == snapshot.revision && state.socket_path.as_deref() == Some(&socket.path)
        {
            state.socket_from_cache = false;
        }
    }

    /// Non-replayable composer RPC pinned to the admitted SSH generation.
    pub(crate) async fn submission_request(
        &self,
        generation: u64,
        request: &[u8],
        active: &(dyn Fn() -> bool + Sync),
    ) -> Result<Vec<u8>, SubmissionRequestFailure> {
        let snapshot = self
            .snapshot()
            .map_err(|_| SubmissionRequestFailure::Unsent)?;
        if snapshot.generation != generation {
            return Err(SubmissionRequestFailure::Unsent);
        }
        let socket = self
            .resolve_socket(&snapshot)
            .await
            .map_err(|_| SubmissionRequestFailure::Unsent)?;
        if !active() {
            return Err(SubmissionRequestFailure::Unsent);
        }
        self.wait_current(
            &snapshot,
            snapshot.ssh.request_unix_socket(
                &socket.path,
                request,
                b'\n',
                crate::herdr_api::CONTROL_TIMEOUT_MS,
                crate::herdr_api::MAX_CONTROL_RESPONSE_BYTES,
            ),
        )
        .await
        .map_err(|_| SubmissionRequestFailure::Ambiguous)?
        .map_err(|_| SubmissionRequestFailure::Ambiguous)
    }

    pub(crate) async fn request(
        &self,
        request: &[u8],
        response_terminator: u8,
        timeout_ms: u64,
        max_response_bytes: usize,
        replay: HerdrRequestReplay,
    ) -> Result<Vec<u8>, HerdrConnectionError> {
        let mut may_rediscover = replay == HerdrRequestReplay::AfterSocketRediscovery;
        loop {
            let snapshot = self.snapshot()?;
            let socket = self.resolve_socket(&snapshot).await?;
            let response = self
                .wait_current(
                    &snapshot,
                    snapshot.ssh.request_unix_socket(
                        &socket.path,
                        request,
                        response_terminator,
                        timeout_ms,
                        max_response_bytes,
                    ),
                )
                .await?;
            match response {
                Ok(response) => {
                    self.confirm_socket(&snapshot, &socket);
                    return Ok(response);
                }
                Err(error)
                    if may_rediscover && self.invalidate_cached_socket(&snapshot, &socket) =>
                {
                    may_rediscover = false;
                    let _ = error;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    pub(crate) async fn open_stream(
        self: &Arc<Self>,
        kind: HerdrStreamKind,
        framing: HerdrStreamFraming,
        max_frame_bytes: usize,
        frame: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        closed: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Arc<HerdrStream>, HerdrConnectionError> {
        let mut may_rediscover = true;
        loop {
            let snapshot = self.snapshot()?;
            let socket = self.resolve_socket(&snapshot).await?;
            let socket_path = match kind {
                HerdrStreamKind::Events => socket.path.clone(),
                HerdrStreamKind::Terminal | HerdrStreamKind::AgentView => {
                    client_socket_path(&socket.path)
                }
            };
            let stream_id = NEXT_STREAM_ID.fetch_add(1, Ordering::Relaxed);
            let channel_id = format!("whip-herdr-{}-{stream_id}", kind.channel_label());
            let weak_connection = Arc::downgrade(self);
            let callback_revision = snapshot.revision;
            let guarded_frame = frame.clone();
            let guarded_frame = Arc::new(move |bytes| {
                if connection_revision_is_current(&weak_connection, callback_revision) {
                    guarded_frame(bytes);
                }
            });
            let weak_connection = Arc::downgrade(self);
            let guarded_closed = closed.clone();
            let guarded_closed = Arc::new(move |reason| {
                if connection_revision_is_current(&weak_connection, callback_revision) {
                    guarded_closed(reason);
                }
            });
            let opened = match framing {
                HerdrStreamFraming::Raw => {
                    self.wait_current(
                        &snapshot,
                        snapshot.ssh.open_unix_socket(
                            &channel_id,
                            &socket_path,
                            max_frame_bytes,
                            guarded_frame,
                            guarded_closed,
                        ),
                    )
                    .await?
                }
                HerdrStreamFraming::LengthPrefixed => {
                    self.wait_current(
                        &snapshot,
                        snapshot.ssh.open_length_prefixed_unix_socket(
                            &channel_id,
                            &socket_path,
                            max_frame_bytes,
                            guarded_frame,
                            guarded_closed,
                        ),
                    )
                    .await?
                }
            };
            match opened {
                Ok(()) => {
                    self.confirm_socket(&snapshot, &socket);
                    return Ok(Arc::new(HerdrStream {
                        connection: self.clone(),
                        snapshot,
                        channel_id,
                        framing,
                        closed: AtomicBool::new(false),
                    }));
                }
                Err(error)
                    if may_rediscover && self.invalidate_cached_socket(&snapshot, &socket) =>
                {
                    may_rediscover = false;
                    let _ = error;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    pub(crate) async fn open_exec_stream(
        self: &Arc<Self>,
        label: &str,
        command: &str,
        data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        closed: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Arc<ConnectionExecStream>, HerdrConnectionError> {
        let snapshot = self.snapshot()?;
        let stream_id = NEXT_STREAM_ID.fetch_add(1, Ordering::Relaxed);
        let channel_id = format!("whip-{}-{stream_id}", channel_label(label));
        let weak_connection = Arc::downgrade(self);
        let callback_revision = snapshot.revision;
        let guarded_data = Arc::new(move |bytes| {
            if connection_revision_is_current(&weak_connection, callback_revision) {
                data(bytes);
            }
        });
        let weak_connection = Arc::downgrade(self);
        let guarded_closed = Arc::new(move |reason| {
            if connection_revision_is_current(&weak_connection, callback_revision) {
                closed(reason);
            }
        });
        let opened = self
            .wait_current(
                &snapshot,
                snapshot
                    .ssh
                    .open_exec(&channel_id, command, guarded_data, guarded_closed),
            )
            .await;
        match opened {
            Ok(Ok(())) => Ok(Arc::new(ConnectionExecStream {
                connection: self.clone(),
                snapshot,
                channel_id,
                closed: AtomicBool::new(false),
            })),
            Ok(Err(error)) => Err(error.into()),
            Err(error) => {
                let _ = snapshot.ssh.close_exec(&channel_id);
                Err(error)
            }
        }
    }

    /// Open an already discovered endpoint without applying legacy path rules.
    pub(crate) async fn open_raw_socket(
        self: &Arc<Self>,
        path: &str,
        data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        closed: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Arc<HerdrStream>, HerdrConnectionError> {
        let snapshot = self.snapshot()?;
        let channel_id = format!(
            "whip-core-{}",
            NEXT_STREAM_ID.fetch_add(1, Ordering::Relaxed)
        );
        let weak = Arc::downgrade(self);
        let revision = snapshot.revision;
        let data = Arc::new(move |bytes| {
            if connection_revision_is_current(&weak, revision) {
                data(bytes);
            }
        });
        let weak = Arc::downgrade(self);
        let closed = Arc::new(move |reason| {
            if connection_revision_is_current(&weak, revision) {
                closed(reason);
            }
        });
        let opened = self
            .wait_current(
                &snapshot,
                snapshot
                    .ssh
                    .open_unix_socket(&channel_id, path, 32 * 1024, data, closed),
            )
            .await;
        match opened {
            Ok(Ok(())) => Ok(Arc::new(HerdrStream {
                connection: self.clone(),
                snapshot,
                channel_id,
                framing: HerdrStreamFraming::Raw,
                closed: AtomicBool::new(false),
            })),
            Ok(Err(error)) => Err(error.into()),
            Err(error) => {
                let _ = snapshot.ssh.close_unix_socket(&channel_id);
                Err(error)
            }
        }
    }

    pub(crate) fn revision(&self) -> u64 {
        self.state.read().revision
    }
}

fn connection_revision_is_current(connection: &Weak<HerdrConnection>, revision: u64) -> bool {
    connection
        .upgrade()
        .is_some_and(|connection| connection.state.read().revision == revision)
}

fn session_socket_suffix(session_name: &str) -> String {
    let session_name = session_name.trim();
    if session_name.is_empty() {
        "/.config/herdr/herdr.sock".to_owned()
    } else {
        format!("/.config/herdr/sessions/{session_name}/herdr.sock")
    }
}

fn client_socket_path(api_socket: &str) -> String {
    api_socket
        .strip_suffix(".sock")
        .map(|prefix| format!("{prefix}-client.sock"))
        .unwrap_or_else(|| format!("{api_socket}-client"))
}

fn channel_label(label: &str) -> String {
    let label = label
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    if label.is_empty() {
        "stream".to_owned()
    } else {
        label
    }
}

pub(crate) struct HerdrStream {
    connection: Arc<HerdrConnection>,
    snapshot: ConnectionSnapshot,
    channel_id: String,
    framing: HerdrStreamFraming,
    closed: AtomicBool,
}

impl HerdrStream {
    pub(crate) fn write(&self, bytes: Vec<u8>) -> Result<(), HerdrConnectionError> {
        if !self.connection.snapshot_is_current(&self.snapshot) {
            return Err(HerdrConnectionError::Stale);
        }
        self.snapshot
            .ssh
            .write_unix_socket(
                &self.channel_id,
                bytes,
                self.framing == HerdrStreamFraming::LengthPrefixed,
            )
            .map_err(Into::into)
    }

    pub(crate) async fn wait_current<T, F>(&self, future: F) -> Result<T, HerdrConnectionError>
    where
        F: Future<Output = T>,
    {
        self.connection.wait_current(&self.snapshot, future).await
    }

    pub(crate) fn close(&self) -> Result<(), HerdrConnectionError> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.snapshot
            .ssh
            .close_unix_socket(&self.channel_id)
            .map_err(Into::into)
    }
}

impl Drop for HerdrStream {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

pub(crate) struct ConnectionExecStream {
    connection: Arc<HerdrConnection>,
    snapshot: ConnectionSnapshot,
    channel_id: String,
    closed: AtomicBool,
}

impl std::fmt::Debug for ConnectionExecStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConnectionExecStream")
            .field("channel_id", &self.channel_id)
            .field("current", &self.is_current())
            .finish_non_exhaustive()
    }
}

impl ConnectionExecStream {
    pub(crate) fn write(&self, bytes: Vec<u8>) -> Result<(), HerdrConnectionError> {
        if !self.is_current() {
            return Err(HerdrConnectionError::Stale);
        }
        self.snapshot
            .ssh
            .write_exec(&self.channel_id, bytes)
            .map_err(Into::into)
    }
    pub(crate) async fn wait_current<T, F: Future<Output = T>>(
        &self,
        future: F,
    ) -> Result<T, HerdrConnectionError> {
        self.connection.wait_current(&self.snapshot, future).await
    }
    pub(crate) fn close(&self) -> Result<(), HerdrConnectionError> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.snapshot
            .ssh
            .close_exec(&self.channel_id)
            .map_err(Into::into)
    }

    pub(crate) fn is_current(&self) -> bool {
        self.connection.snapshot_is_current(&self.snapshot)
    }
}

impl Drop for ConnectionExecStream {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_socket_derivation_matches_existing_protocol_paths() {
        assert_eq!(
            client_socket_path("/tmp/herdr.sock"),
            "/tmp/herdr-client.sock"
        );
        assert_eq!(client_socket_path("/tmp/control"), "/tmp/control-client");
    }

    #[test]
    fn configured_and_cached_socket_origins_are_distinct() {
        let explicit = HerdrConnection::new(
            "explicit".to_owned(),
            String::new(),
            Some("/run/herdr.sock".to_owned()),
            Some("/old.sock".to_owned()),
            true,
        );
        assert_eq!(
            explicit.resolved_socket_path().as_deref(),
            Some("/run/herdr.sock")
        );
        assert!(!explicit.state.read().socket_from_cache);

        let cached = HerdrConnection::new(
            "cached".to_owned(),
            String::new(),
            None,
            Some("/home/u/.config/herdr/herdr.sock".to_owned()),
            true,
        );
        assert!(cached.state.read().socket_from_cache);
    }

    #[test]
    fn cached_socket_from_another_session_is_ignored() {
        let named = |session: &str, cached: &str| {
            HerdrConnection::new(
                "cached".to_owned(),
                session.to_owned(),
                None,
                Some(cached.to_owned()),
                true,
            )
        };

        let switched = named("b", "/home/u/.config/herdr/sessions/a/herdr.sock");
        assert_eq!(switched.resolved_socket_path(), None);
        assert!(!switched.state.read().socket_from_cache);

        let to_default = named("", "/home/u/.config/herdr/sessions/a/herdr.sock");
        assert_eq!(to_default.resolved_socket_path(), None);
        let to_named = named("a", "/home/u/.config/herdr/herdr.sock");
        assert_eq!(to_named.resolved_socket_path(), None);

        let unchanged = named("a", "/home/u/.config/herdr/sessions/a/herdr.sock");
        assert_eq!(
            unchanged.resolved_socket_path().as_deref(),
            Some("/home/u/.config/herdr/sessions/a/herdr.sock")
        );
        assert!(unchanged.state.read().socket_from_cache);

        let explicit = HerdrConnection::new(
            "explicit".to_owned(),
            "b".to_owned(),
            Some("/run/herdr.sock".to_owned()),
            Some("/home/u/.config/herdr/sessions/a/herdr.sock".to_owned()),
            true,
        );
        assert_eq!(
            explicit.resolved_socket_path().as_deref(),
            Some("/run/herdr.sock")
        );
    }

    #[test]
    fn callback_revision_guard_rejects_replaced_connections() {
        let connection = HerdrConnection::new("test".to_owned(), String::new(), None, None, true);
        let revision = connection.state.read().revision;
        assert!(connection_revision_is_current(
            &Arc::downgrade(&connection),
            revision
        ));
        connection.state.write().revision = revision.wrapping_add(1);
        assert!(!connection_revision_is_current(
            &Arc::downgrade(&connection),
            revision
        ));
    }

    #[test]
    fn channel_labels_cannot_escape_the_connection_namespace() {
        assert_eq!(
            channel_label("agent transcript/rollout"),
            "agent-transcript-rollout"
        );
        assert_eq!(channel_label(""), "stream");
    }

    #[test]
    fn timeout_classification_uses_the_typed_ssh_code() {
        let timeout = HerdrConnectionError::Transport(SshFailure::Transport {
            code: SshErrorCode::ConnectionTimeout,
            message: "localized timeout diagnostic".to_owned(),
        });
        let other = HerdrConnectionError::Transport(SshFailure::Transport {
            code: SshErrorCode::SessionClosed,
            message: "timed out text in a non-timeout error".to_owned(),
        });
        assert!(timeout.is_timeout());
        assert!(!other.is_timeout());
    }
}
