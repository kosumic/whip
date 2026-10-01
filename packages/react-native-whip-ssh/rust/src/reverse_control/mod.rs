//! Host-owned HTTP MCP listener and launch-scoped reverse-control authorization.
mod browser;
mod device;
mod download;
mod http;
mod recovery;
mod tools;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use hmac::digest::CtOutput;
use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, oneshot};

use crate::herdr_api::{HerdrAgentKind, HerdrPaneInfo, HerdrTabLaunch};
use crate::ssh::{RemoteForward, SshSession};

const MAX_RESPONSE: usize = browser::model::MAX_IMAGE_RESULT;
const ACTION_TIMEOUT: Duration = Duration::from_secs(20);
const MCP_TOOL_TIMEOUT: Duration = Duration::from_secs(125);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const MCP_SERVER_NAME: &str = "whip";
const OPENCODE_STANDALONE_ARG: &str = "--standalone";
const FORWARD_TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECTING_MESSAGE: &str = "SSH connection is reconnecting; retry when it is restored";
const STATE_CHANGED_EVENT: &str = "state-changed";
static SINK: OnceLock<RwLock<Option<Arc<dyn ReverseControlEventSink>>>> = OnceLock::new();

#[derive(Clone, Debug, uniffi::Record)]
pub struct ReverseControlSession {
    pub runtime_id: String,
    pub session_id: String,
    pub pane_id: String,
    pub terminal_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum ReverseControlState {
    Off,
    RestartRequired,
    Recovering,
    Connected,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct ReverseControlEvent {
    pub session: ReverseControlSession,
    pub kind: String,
    pub request_id: String,
    pub action: String,
    pub arguments_json: String,
}

#[uniffi::export(with_foreign)]
pub trait ReverseControlEventSink: Send + Sync {
    fn event(&self, event: ReverseControlEvent);
}

#[uniffi::export]
pub fn set_reverse_control_event_sink(sink: Arc<dyn ReverseControlEventSink>) {
    *SINK.get_or_init(|| RwLock::new(None)).write() = Some(sink);
}

pub(crate) fn detach_ui() {
    if let Some(sink) = SINK.get() {
        *sink.write() = None;
    }
}

fn emit(session: &ReverseControlSession, kind: &str, request: &str, action: &str, args: Value) {
    let sink = SINK.get().and_then(|sink| sink.read().clone());
    if let Some(sink) = sink {
        sink.event(ReverseControlEvent {
            session: session.clone(),
            kind: kind.to_owned(),
            request_id: request.to_owned(),
            action: action.to_owned(),
            arguments_json: args.to_string(),
        });
    }
}

struct Session {
    info: ReverseControlSession,
    agent: HerdrAgentKind,
    token_hash: CtOutput<Sha256>,
    started: Instant,
    observed_agent: bool,
    conversation: Option<String>,
    protocol: Option<String>,
}

struct AuthenticatedSession {
    protocol: Option<String>,
}

struct Bridge {
    transport: Option<BridgeTransport>,
    local_port: u16,
    remote_port: u16,
    transport_epoch: u64,
    server: http::Server,
    epoch: u64,
}

struct BridgeTransport {
    ssh: Arc<SshSession>,
    forward: RemoteForward,
}

impl Bridge {
    fn connected(&self) -> bool {
        self.server.is_alive()
            && self
                .transport
                .as_ref()
                .is_some_and(|transport| transport.ssh.is_alive())
    }
}

fn retire_bridge(bridge: Option<Bridge>) {
    if let Some(Bridge {
        server, transport, ..
    }) = bridge
    {
        // Stop accepting HTTP requests but flush the final DELETE/error response
        // before tearing down its SSH channel. Forward draining is bounded.
        drop(server);
        if let Some(BridgeTransport { forward, .. }) = transport
            && let Ok(runtime) = crate::runtime()
        {
            runtime.spawn(async move { forward.close_gracefully().await });
        }
    }
}

struct Pending {
    session: String,
    rpc_id: Value,
    response: oneshot::Sender<Value>,
}

enum ToolAction {
    Browser(Box<browser::model::BrowserAction>),
    Device(device::DeviceAction),
}

#[derive(serde::Deserialize)]
struct NativeReply {
    ok: bool,
    #[serde(default, deserialize_with = "present_value")]
    value: Option<Value>,
    error: Option<browser::model::BrowserError>,
}
fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    <Value as serde::Deserialize>::deserialize(deserializer).map(Some)
}

struct NativeStepPending {
    session: String,
    parent: String,
    response: oneshot::Sender<Result<Value, browser::model::BrowserError>>,
}
struct NativeStep {
    owner: std::sync::Weak<ReverseControl>,
    request: String,
    receiver: Option<oneshot::Receiver<Result<Value, browser::model::BrowserError>>>,
}
impl NativeStep {
    async fn receive(mut self) -> Result<Value, browser::model::BrowserError> {
        let receiver = self.receiver.take().ok_or_else(|| {
            browser::model::BrowserError::new(
                browser::model::ErrorCode::InvalidResult,
                "Missing bridge response",
            )
        })?;
        receiver.await.map_err(|_| {
            browser::model::BrowserError::new(
                browser::model::ErrorCode::SessionClosed,
                "Browser bridge closed",
            )
        })?
    }
}
impl Drop for NativeStep {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            let step = owner.steps.lock().remove(&self.request);
            if let Some(step) = step {
                let info = owner
                    .sessions
                    .lock()
                    .get(&step.session)
                    .map(|session| session.info.clone());
                if let Some(info) = info {
                    emit(&info, "cancel", &self.request, "", Value::Null);
                }
            }
        }
    }
}
struct NativeBridge {
    owner: std::sync::Weak<ReverseControl>,
    session: String,
    parent: String,
}
impl browser::engine::Bridge for NativeBridge {
    fn call(
        &self,
        operation: browser::engine::Primitive,
    ) -> futures::future::BoxFuture<'_, Result<Value, browser::model::BrowserError>> {
        Box::pin(async move {
            let owner = self.owner.upgrade().ok_or_else(|| {
                browser::model::BrowserError::new(
                    browser::model::ErrorCode::SessionClosed,
                    "Browser session closed",
                )
            })?;
            let download = if let browser::engine::Primitive::Download {
                destination_path,
                max_bytes,
                ..
            } = &operation
            {
                let ssh = owner
                    .bridge
                    .lock()
                    .as_ref()
                    .and_then(|bridge| bridge.transport.as_ref())
                    .map(|transport| transport.ssh.clone())
                    .filter(|ssh| ssh.is_alive())
                    .ok_or_else(|| {
                        browser::model::BrowserError::new(
                            browser::model::ErrorCode::DownloadFailed,
                            "Download requires a connected SSH host",
                        )
                    })?;
                Some((ssh, destination_path.clone(), *max_bytes))
            } else {
                None
            };
            let value = owner
                .begin_step(&self.session, &self.parent, operation)?
                .receive()
                .await?;
            if let Some((ssh, destination, max_bytes)) = download {
                download::transfer(ssh, value, &destination, max_bytes).await
            } else {
                Ok(value)
            }
        })
    }
}

#[derive(Default)]
pub(crate) struct ReverseControl {
    recovery: Mutex<recovery::Recovery>,
    bridge: Mutex<Option<Bridge>>,
    startup: AsyncMutex<()>,
    epoch: AtomicU64,
    sequence: AtomicU64,
    sessions: Mutex<HashMap<String, Session>>,
    pending: Mutex<HashMap<String, Pending>>,
    steps: Mutex<HashMap<String, NativeStepPending>>,
    tasks: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    browser_sessions: Mutex<HashMap<String, Arc<browser::engine::BrowserSession>>>,
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    russh::keys::ssh_key::getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(crate::lower_hex(&bytes))
}

fn token_hash(token: &str) -> CtOutput<Sha256> {
    CtOutput::new(Sha256::digest(token.as_bytes()))
}

pub(crate) struct AgentLaunch {
    kind: HerdrAgentKind,
    args: Vec<String>,
}

impl AgentLaunch {
    pub(crate) async fn for_host(mut self, ssh: &SshSession) -> Result<Self, String> {
        if self.kind == HerdrAgentKind::OpenCode {
            let command = crate::agent_sessions::opencode_login_command("opencode --version");
            let output = tokio::time::timeout(Duration::from_secs(10), ssh.execute(&command))
                .await
                .map_err(|_| "OpenCode version detection timed out".to_owned())?
                .map_err(|error| error.to_string())?;
            if output.exit_status != Some(0) {
                return Err("Could not detect OpenCode version on the host".to_owned());
            }
            self.set_opencode_version(&String::from_utf8_lossy(&output.stdout))?;
        }
        Ok(self)
    }

    fn set_opencode_version(&mut self, version: &str) -> Result<(), String> {
        let protocol = crate::agent_sessions::parse_opencode_protocol(version)
            .map_err(|error| error.to_string())?;
        if protocol == crate::agent_transcript::OpenCodeProtocol::V2 {
            // V2 otherwise reuses a shared background service which may ignore
            // this process's config, or expose its credential to other sessions.
            if self.args.iter().any(|arg| arg.starts_with("--standalone=")) {
                return Err("Reverse Control requires OpenCode v2 standalone mode".to_owned());
            }
            if !self.args.iter().any(|arg| arg == OPENCODE_STANDALONE_ARG) {
                self.args.insert(0, OPENCODE_STANDALONE_ARG.to_owned());
            }
        }
        Ok(())
    }
}

pub(crate) fn agent_launch(launch: HerdrTabLaunch) -> Result<AgentLaunch, String> {
    match launch {
        HerdrTabLaunch::Agent {
            kind: kind @ (HerdrAgentKind::Codex | HerdrAgentKind::OpenCode),
            args,
        } if !args.iter().any(|arg| arg.chars().any(char::is_control)) => {
            if kind == HerdrAgentKind::OpenCode
                && (args.first().is_some_and(|arg| arg == "attach")
                    || args.iter().any(|arg| {
                        matches!(arg.as_str(), "--server" | "--attach" | "--no-standalone")
                            || arg.starts_with("--server=")
                            || arg.starts_with("--attach=")
                    }))
            {
                return Err(
                    "Reverse Control requires a local OpenCode process, not an attached server"
                        .to_owned(),
                );
            }
            Ok(AgentLaunch { kind, args })
        }
        _ => Err(
            "Reverse Control requires an explicit Codex or OpenCode launch with valid arguments"
                .to_owned(),
        ),
    }
}

fn configured_launch(
    launch: AgentLaunch,
    session: &str,
    port: u16,
    token: &str,
) -> Result<HerdrTabLaunch, String> {
    let AgentLaunch { kind, args } = launch;
    let url = format!("http://127.0.0.1:{port}/mcp/{session}");
    if kind == HerdrAgentKind::OpenCode {
        // Both v1 and v2 load this runtime override. V2 normalizes the legacy
        // MCP shape into mcp.servers. Keep global/project config and hooks intact.
        let config = json!({"mcp": {(MCP_SERVER_NAME): {
            "type": "remote",
            "url": url,
            "enabled": true,
            "headers": {"Authorization": format!("Bearer {token}")},
            "oauth": false,
            "timeout": MCP_TOOL_TIMEOUT.as_millis(),
        }}});
        // agent.start currently accepts only argv, not environment overrides.
        // `env` scopes the credential to this process, on POSIX and fish shells.
        let mut argv = vec![
            "env".to_owned(),
            format!("OPENCODE_CONFIG_CONTENT={config}"),
            kind.as_str().to_owned(),
        ];
        argv.extend(args);
        let command =
            shlex::try_join(argv.iter().map(String::as_str)).map_err(|error| error.to_string())?;
        return Ok(HerdrTabLaunch::Command { command });
    }
    let mut args = args;
    let authorization = serde_json::to_string(&format!("Bearer {token}")).unwrap_or_default();
    args.splice(
        0..0,
        [
            "-c".to_owned(),
            format!("mcp_servers.{MCP_SERVER_NAME}.url=\"{url}\""),
            "-c".to_owned(),
            format!("mcp_servers.{MCP_SERVER_NAME}.http_headers={{Authorization={authorization}}}"),
            "-c".to_owned(),
            format!("mcp_servers.{MCP_SERVER_NAME}.required=true"),
            "-c".to_owned(),
            format!(
                "mcp_servers.{MCP_SERVER_NAME}.tool_timeout_sec={}",
                MCP_TOOL_TIMEOUT.as_secs()
            ),
        ],
    );
    Ok(HerdrTabLaunch::Agent { kind, args })
}

impl ReverseControl {
    pub(crate) async fn prepare(
        self: &Arc<Self>,
        ssh: Arc<SshSession>,
        info: ReverseControlSession,
        launch: AgentLaunch,
    ) -> Result<HerdrTabLaunch, String> {
        let _startup = self.startup.lock().await;
        // A new launch can race the first snapshot after restart. Reserve the
        // saved port without granting any saved agent access until validation.
        self.recovery
            .lock()
            .load()
            .map_err(|_| "Could not load Reverse Control recovery records".to_owned())?;
        let token = random_token()?;
        let kind = launch.kind;
        self.ensure_bridge(ssh).await?;
        // Registration and bridge removal share this lock order. Last-session
        // cleanup cannot race with a new registration and retire its forward.
        let port = {
            let bridge = self.bridge.lock();
            let current = bridge.as_ref().ok_or("SSH browser bridge closed")?;
            if !current.connected() {
                return Err("SSH browser bridge disconnected".to_owned());
            }
            let port = current.remote_port;
            self.sessions.lock().insert(
                info.session_id.clone(),
                Session {
                    info: info.clone(),
                    agent: kind,
                    token_hash: token_hash(&token),
                    started: Instant::now(),
                    observed_agent: false,
                    conversation: None,
                    protocol: None,
                },
            );
            drop(bridge);
            port
        };
        emit(&info, "opened", "", "", Value::Null);
        let launch = configured_launch(launch, &info.session_id, port, &token)?;
        let weak = Arc::downgrade(self);
        let id = info.session_id;
        crate::runtime()?.spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if let Some(owner) = weak.upgrade() {
                let initialized = owner
                    .sessions
                    .lock()
                    .get(&id)
                    .is_none_or(|session| session.protocol.is_some());
                if !initialized {
                    owner.close_session(&id);
                }
            }
        });
        Ok(launch)
    }

    async fn ensure_bridge(self: &Arc<Self>, ssh: Arc<SshSession>) -> Result<(), String> {
        if self.bridge.lock().is_some() {
            return Ok(());
        }
        let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| "Could not bind browser MCP loopback listener".to_owned())?;
        let local_port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let saved_port = self.recovery.lock().port;
        let forwarding = async {
            match saved_port {
                Some(port) => ssh.open_remote_forward_at(local_port, port).await,
                None => ssh.open_remote_forward(local_port).await,
            }
        };
        let forward = tokio::time::timeout(FORWARD_TIMEOUT, forwarding)
            .await
            .map_err(|_| "SSH browser reverse forwarding timed out".to_owned())?
            .map_err(|_| {
                "SSH server refused browser reverse forwarding; enable AllowTcpForwarding"
                    .to_owned()
            })?;
        let remote_port = forward.port;
        let authority = format!("127.0.0.1:{remote_port}");
        let server = http::serve(listener, Arc::downgrade(self), authority, epoch)?;
        let stopped = server.stopped();
        let mut bridge = self.bridge.lock();
        if self.epoch.load(Ordering::Acquire) != epoch || !ssh.is_alive() || !server.is_alive() {
            return Err("SSH changed during browser bridge startup".to_owned());
        }
        *bridge = Some(Bridge {
            transport: Some(BridgeTransport {
                ssh: ssh.clone(),
                forward,
            }),
            local_port,
            remote_port,
            transport_epoch: 0,
            server,
            epoch,
        });
        drop(bridge);
        self.observe_transport(ssh, stopped, epoch, 0);
        Ok(())
    }

    fn observe_transport(
        self: &Arc<Self>,
        ssh: Arc<SshSession>,
        mut stopped: tokio::sync::watch::Receiver<bool>,
        epoch: u64,
        transport_epoch: u64,
    ) {
        let weak = Arc::downgrade(self);
        let Ok(runtime) = crate::runtime() else {
            return;
        };
        runtime.spawn(async move {
            if *stopped.borrow() {
                return;
            }
            tokio::select! {
                _ = ssh.disconnected() => {
                    if let Some(owner) = weak.upgrade() {
                        owner.suspend_bridge(Some((epoch, transport_epoch)));
                    }
                },
                _ = stopped.changed() => {},
            }
        });
    }

    /// Network loss suspends execution, not launch authorization. Outstanding
    /// commands are cancelled once and are never replayed on the new transport.
    pub(crate) fn suspend(&self) {
        self.suspend_bridge(None);
    }

    fn suspend_bridge(&self, expected: Option<(u64, u64)>) {
        let (transport, requests) = {
            let mut current = self.bridge.lock();
            let Some(bridge) = current.as_mut() else {
                return;
            };
            if expected.is_some_and(|expected| expected != (bridge.epoch, bridge.transport_epoch)) {
                return;
            }
            bridge.transport_epoch = bridge.transport_epoch.wrapping_add(1);
            let transport = bridge.transport.take();
            let requests = self.pending.lock().keys().cloned().collect::<Vec<_>>();
            drop(current);
            (transport, requests)
        };
        drop(transport);
        for request in requests {
            if let Some(task) = self.tasks.lock().remove(&request) {
                task.abort();
            }
            self.finish_action(&request, browser::model::BrowserError::new(
                browser::model::ErrorCode::DeviceUnavailable,
                "SSH connection interrupted; command outcome may be unknown. Reconnect before issuing another call",
            ).mcp());
        }
        self.emit_state_changed();
    }

    pub(crate) fn needs_resume(&self) -> bool {
        let recovery = self.recovery.lock();
        let bridge = self.bridge.lock();
        bridge.as_ref().map_or_else(
            || recovery.port.is_some() && !self.sessions.lock().is_empty(),
            |bridge| bridge.transport.is_none(),
        )
    }

    /// Called only after a fresh host snapshot reconciles surviving launches.
    pub(crate) async fn resume(self: &Arc<Self>, ssh: Arc<SshSession>) -> Result<(), String> {
        let _startup = self.startup.lock().await;
        if self.bridge.lock().is_none() {
            if self.sessions.lock().is_empty() {
                return Ok(());
            }
            self.ensure_bridge(ssh).await?;
            for info in self.list() {
                emit(&info, "opened", "", "", Value::Null);
            }
            return Ok(());
        }
        let (epoch, transport_epoch, local_port, remote_port) = {
            let current = self.bridge.lock();
            let Some(bridge) = current.as_ref().filter(|bridge| bridge.transport.is_none()) else {
                return Ok(());
            };
            let identity = (
                bridge.epoch,
                bridge.transport_epoch,
                bridge.local_port,
                bridge.remote_port,
            );
            drop(current);
            identity
        };
        let forward = tokio::time::timeout(
            FORWARD_TIMEOUT,
            ssh.open_remote_forward_at(local_port, remote_port),
        )
        .await
        .map_err(|_| "MCP reverse-forward restoration timed out".to_owned())?
        .map_err(|_| "Could not restore the original MCP reverse-forward port".to_owned())?;
        let stopped = {
            let mut current = self.bridge.lock();
            let Some(bridge) = current.as_mut().filter(|bridge| {
                bridge.epoch == epoch
                    && bridge.transport_epoch == transport_epoch
                    && bridge.transport.is_none()
            }) else {
                return Err("MCP restoration was superseded".to_owned());
            };
            if !ssh.is_alive() || !bridge.server.is_alive() {
                return Err("MCP transport disconnected during restoration".to_owned());
            }
            bridge.transport = Some(BridgeTransport {
                ssh: ssh.clone(),
                forward,
            });
            let stopped = bridge.server.stopped();
            drop(current);
            stopped
        };
        self.observe_transport(ssh, stopped, epoch, transport_epoch);
        self.emit_state_changed();
        Ok(())
    }

    fn emit_state_changed(&self) {
        for info in self.list() {
            emit(&info, STATE_CHANGED_EVENT, "", "", Value::Null);
        }
    }

    fn shutdown_bridge(&self, epoch: u64) {
        let (bridge, sessions) = {
            let mut current = self.bridge.lock();
            if current.as_ref().is_none_or(|bridge| bridge.epoch != epoch) {
                return;
            }
            self.epoch.fetch_add(1, Ordering::AcqRel);
            let ids = self.sessions.lock().keys().cloned().collect::<Vec<_>>();
            (current.take(), ids)
        };
        for session in sessions {
            self.close_session(&session);
        }
        retire_bridge(bridge);
    }

    /// Hash comparison uses CtOutput's constant-time equality.
    fn authenticate(&self, id: &str, token: &str) -> Option<AuthenticatedSession> {
        if token.len() != 64 {
            return None;
        }
        let received = token_hash(token);
        self.sessions.lock().get(id).and_then(|session| {
            (received == session.token_hash).then(|| AuthenticatedSession {
                protocol: session.protocol.clone(),
            })
        })
    }

    async fn request(self: &Arc<Self>, session: &str, message: &Value) -> Option<Value> {
        let id = message["id"].clone();
        if id.is_null() {
            if message["method"] == "notifications/cancelled" {
                let target = &message["params"]["requestId"];
                let requests: Vec<_> = self
                    .pending
                    .lock()
                    .iter()
                    .filter(|(_, call)| call.session == session && &call.rpc_id == target)
                    .map(|(key, _)| key.clone())
                    .collect();
                for request in requests {
                    self.cancel_request(&request, "Browser action cancelled");
                }
            }
            return None;
        }
        let result = match message["method"].as_str() {
            Some("initialize") => {
                let requested = message["params"]["protocolVersion"]
                    .as_str()
                    .unwrap_or_default();
                let protocol = if http::PROTOCOLS.contains(&requested) {
                    requested
                } else {
                    http::LATEST_PROTOCOL
                };
                let mut sessions = self.sessions.lock();
                let Some(owned) = sessions.get_mut(session) else {
                    return Some(rpc_error(id, -32000, "Browser session closed"));
                };
                owned.protocol = Some(protocol.to_owned());
                let info = owned.info.clone();
                drop(sessions);
                self.save_recovery();
                emit(&info, STATE_CHANGED_EVENT, "", "", Value::Null);
                tools::initialize(protocol)
            }
            Some("ping") => json!({}),
            Some("tools/list") => json!({"tools":tools::tools()}),
            Some("tools/call") => match self.start_action(session, id.clone(), message) {
                Ok(receiver) => receiver.await.unwrap_or_else(|_| {
                    browser::model::BrowserError::new(
                        browser::model::ErrorCode::SessionClosed,
                        "Browser session closed",
                    )
                    .mcp()
                }),
                Err(result) => result,
            },
            _ => return Some(rpc_error(id, -32601, "Method not found")),
        };
        Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }

    fn start_action(
        self: &Arc<Self>,
        session: &str,
        rpc_id: Value,
        message: &Value,
    ) -> Result<oneshot::Receiver<Value>, Value> {
        use browser::{
            engine,
            model::{BrowserAction, BrowserError, ErrorCode, SessionId},
        };
        let name = message["params"]["name"].as_str().unwrap_or_default();
        let action = if name.starts_with("device.") {
            ToolAction::Device(
                device::DeviceAction::parse(name, &message["params"]["arguments"])
                    .map_err(|error| error.mcp())?,
            )
        } else {
            ToolAction::Browser(Box::new(
                BrowserAction::parse(
                    name.strip_prefix("browser.").unwrap_or_default(),
                    &message["params"]["arguments"],
                )
                .map_err(|error| error.mcp())?,
            ))
        };
        let session_id = SessionId(session.to_owned());
        session_id.validate().map_err(|error| error.mcp())?;
        if let ToolAction::Browser(action) = &action
            && let Some(tab) = action.tab_id()
        {
            engine::authorize_tab(&session_id, tab).map_err(|error| error.mcp())?;
        }
        let (native_action, args) = match &action {
            ToolAction::Device(action) => {
                let (name, args) = action.wire();
                (name.to_owned(), args)
            }
            ToolAction::Browser(action) => engine::Primitive::ResolveTab {
                tab_id: action.tab_id().cloned(),
            }
            .wire()
            .map_err(|error| error.mcp())?,
        };
        let runtime = crate::runtime().map_err(|_| {
            BrowserError::new(ErrorCode::BrowserUnavailable, "Browser runtime unavailable").mcp()
        })?;
        let (response, receiver) = oneshot::channel();
        let request = self.sequence.fetch_add(1, Ordering::Relaxed).to_string();
        {
            let bridge = self.bridge.lock();
            if bridge.as_ref().is_some_and(|bridge| !bridge.connected()) {
                return Err(
                    BrowserError::new(ErrorCode::DeviceUnavailable, RECONNECTING_MESSAGE).mcp(),
                );
            }
            let sessions = self.sessions.lock();
            if !sessions.contains_key(session) {
                return Err(
                    BrowserError::new(ErrorCode::SessionClosed, "Browser session closed").mcp(),
                );
            }
            let mut pending = self.pending.lock();
            if pending
                .values()
                .filter(|call| call.session == session)
                .count()
                >= 8
            {
                return Err(BrowserError::new(
                    ErrorCode::BrowserUnavailable,
                    "Browser busy; retry after the current call",
                )
                .mcp());
            }
            pending.insert(
                request.clone(),
                Pending {
                    session: session.to_owned(),
                    rpc_id,
                    response,
                },
            );
            drop(pending);
            drop(sessions);
            // Suspension must see every request accepted on this transport.
            drop(bridge);
        }
        // Resolve the selected browser tab at arrival. Device calls need no tab.
        let step = match self.begin_wire_step(session, &request, &native_action, args) {
            Ok(step) => step,
            Err(error) => {
                self.finish_action(&request, error.mcp());
                return Ok(receiver);
            }
        };
        let timeout = if matches!(&action, ToolAction::Browser(action) if matches!(action.as_ref(), BrowserAction::Download(_)))
        {
            DOWNLOAD_TIMEOUT
        } else {
            ACTION_TIMEOUT
        };
        let work: futures::future::BoxFuture<'static, Result<Value, BrowserError>> = match action {
            ToolAction::Device(action) => {
                Box::pin(async move { action.result(step.receive().await?) })
            }
            ToolAction::Browser(action) => {
                let queue = self
                    .browser_sessions
                    .lock()
                    .entry(session.to_owned())
                    .or_default()
                    .clone();
                let bridge: Arc<dyn engine::Bridge> = Arc::new(NativeBridge {
                    owner: Arc::downgrade(self),
                    session: session.to_owned(),
                    parent: request.clone(),
                });
                let browser_request = request.clone();
                Box::pin(async move {
                    let context = engine::decode(step.receive().await?)?;
                    let _serial = queue.gate.lock().await;
                    engine::run(bridge, &session_id, &browser_request, *action, context)
                        .await?
                        .mcp()
                })
            }
        };
        let owner = Arc::downgrade(self);
        let task_request = request.clone();
        let (begin, begun) = oneshot::channel();
        let task = runtime.spawn(async move {
            let _ = begun.await;
            let result = match engine::deadline(timeout, work).await {
                Ok(result) => result,
                Err(error) => error.mcp(),
            };
            if let Some(owner) = owner.upgrade() {
                owner.finish_action(&task_request, result);
            }
        });
        self.tasks.lock().insert(request, task.abort_handle());
        let _ = begin.send(());
        Ok(receiver)
    }

    fn begin_step(
        self: &Arc<Self>,
        session: &str,
        parent: &str,
        operation: browser::engine::Primitive,
    ) -> Result<NativeStep, browser::model::BrowserError> {
        let (action, args) = operation.wire()?;
        self.begin_wire_step(session, parent, &action, args)
    }

    fn begin_wire_step(
        self: &Arc<Self>,
        session: &str,
        parent: &str,
        action: &str,
        mut args: Value,
    ) -> Result<NativeStep, browser::model::BrowserError> {
        use browser::model::{BrowserError, ErrorCode};
        args["lease_id"] = json!(parent);
        let (response, receiver) = oneshot::channel();
        let request = format!(
            "{parent}:step:{}",
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let info = {
            let bridge = self.bridge.lock();
            if bridge.as_ref().is_some_and(|bridge| !bridge.connected()) {
                return Err(BrowserError::new(
                    ErrorCode::DeviceUnavailable,
                    RECONNECTING_MESSAGE,
                ));
            }
            let sessions = self.sessions.lock();
            let owned = sessions.get(session).ok_or_else(|| {
                BrowserError::new(ErrorCode::SessionClosed, "Browser session closed")
            })?;
            if self
                .pending
                .lock()
                .get(parent)
                .is_none_or(|call| call.session != session)
            {
                return Err(BrowserError::new(
                    ErrorCode::Cancelled,
                    "Browser action cancelled",
                ));
            }
            self.steps.lock().insert(
                request.clone(),
                NativeStepPending {
                    session: session.to_owned(),
                    parent: parent.to_owned(),
                    response,
                },
            );
            let info = owned.info.clone();
            drop(sessions);
            drop(bridge);
            info
        };
        emit(&info, "action", &request, action, args);
        Ok(NativeStep {
            owner: Arc::downgrade(self),
            request,
            receiver: Some(receiver),
        })
    }

    fn finish_action(&self, request: &str, result: Value) {
        self.tasks.lock().remove(request);
        let pending = self.pending.lock().remove(request);
        if let Some(pending) = pending {
            let info = self
                .sessions
                .lock()
                .get(&pending.session)
                .map(|session| session.info.clone());
            let _ = pending.response.send(result);
            if let Some(info) = info {
                emit(&info, "release", request, "", Value::Null);
            }
        }
        self.cancel_steps(request);
    }
    fn cancel_steps(&self, parent: &str) {
        let steps: Vec<_> = self
            .steps
            .lock()
            .extract_if(|_, step| step.parent == parent)
            .map(|(id, step)| (id, step.session))
            .collect();
        for (request, session) in steps {
            if let Some(info) = self
                .sessions
                .lock()
                .get(&session)
                .map(|session| session.info.clone())
            {
                emit(&info, "cancel", &request, "", Value::Null);
            }
        }
    }
    fn cancel_request(&self, request: &str, message: &str) {
        if let Some(task) = self.tasks.lock().remove(request) {
            task.abort();
        }
        let code = if message.contains("timed out") {
            browser::model::ErrorCode::Timeout
        } else {
            browser::model::ErrorCode::Cancelled
        };
        self.finish_action(
            request,
            browser::model::BrowserError::new(code, message).mcp(),
        );
    }

    pub(crate) fn reply(&self, session: &str, request: &str, result: &str) {
        use browser::model::{BrowserError, ErrorCode};
        let pending = {
            let mut steps = self.steps.lock();
            if steps
                .get(request)
                .is_none_or(|step| step.session != session)
            {
                return;
            }
            steps.remove(request)
        };
        let Some(pending) = pending else { return };
        let result = if result.len() > MAX_RESPONSE {
            Err(BrowserError::new(
                ErrorCode::ResultTooLarge,
                "Browser response too large",
            ))
        } else {
            serde_json::from_str::<NativeReply>(result)
                .map_err(|_| {
                    BrowserError::new(ErrorCode::InvalidResult, "Invalid native browser reply")
                })
                .and_then(|reply| match reply {
                    NativeReply {
                        ok: true,
                        value: Some(value),
                        error: None,
                    } => Ok(value),
                    NativeReply {
                        ok: false,
                        error: Some(error),
                        ..
                    } => Err(error),
                    _ => Err(BrowserError::new(
                        ErrorCode::InvalidResult,
                        "Invalid native browser reply",
                    )),
                })
        };
        let _ = pending.response.send(result);
    }

    pub(crate) fn connected_terminal(&self, terminal_id: &str) -> bool {
        let bridge = self.bridge.lock();
        bridge.as_ref().is_some_and(Bridge::connected)
            && self.sessions.lock().values().any(|session| {
                session.info.terminal_id == terminal_id && session.protocol.is_some()
            })
    }

    pub(crate) fn recovering_terminal(&self, terminal_id: &str) -> bool {
        let recovery = self.recovery.lock();
        recovery.waiting_for(terminal_id)
            || self
                .sessions
                .lock()
                .values()
                .any(|session| session.info.terminal_id == terminal_id)
    }

    pub(crate) fn terminal_state(&self, terminal_id: &str, enabled: bool) -> ReverseControlState {
        if self.connected_terminal(terminal_id) {
            ReverseControlState::Connected
        } else if self.recovering_terminal(terminal_id) {
            ReverseControlState::Recovering
        } else if enabled {
            ReverseControlState::RestartRequired
        } else {
            ReverseControlState::Off
        }
    }

    pub(crate) fn list(&self) -> Vec<ReverseControlSession> {
        self.sessions
            .lock()
            .values()
            .map(|session| session.info.clone())
            .collect()
    }

    pub(crate) fn close_session(&self, id: &str) {
        let (session, bridge) = {
            let mut bridge = self.bridge.lock();
            let mut sessions = self.sessions.lock();
            let Some(session) = sessions.remove(id) else {
                return;
            };
            let retired = if sessions.is_empty() {
                self.epoch.fetch_add(1, Ordering::AcqRel);
                bridge.take()
            } else {
                None
            };
            drop(sessions);
            drop(bridge);
            (session, retired)
        };
        let requests: Vec<_> = self
            .pending
            .lock()
            .extract_if(|_, call| call.session == id)
            .map(|(request, call)| (request, call.response))
            .collect();
        for (request, response) in requests {
            if let Some(task) = self.tasks.lock().remove(&request) {
                task.abort();
            }
            self.cancel_steps(&request);
            let _ = response.send(
                browser::model::BrowserError::new(
                    browser::model::ErrorCode::SessionClosed,
                    "Browser session closed",
                )
                .mcp(),
            );
        }
        let roots: Vec<_> = self
            .steps
            .lock()
            .values()
            .filter(|step| step.session == id)
            .map(|step| step.parent.clone())
            .collect();
        for root in roots {
            if let Some(task) = self.tasks.lock().remove(&root) {
                task.abort();
            }
            self.cancel_steps(&root);
        }
        self.browser_sessions.lock().remove(id);
        emit(&session.info, "closed", "", "", Value::Null);
        retire_bridge(bridge);
        self.save_recovery();
    }

    pub(crate) fn close_terminal(&self, terminal: &str) {
        self.recovery.lock().forget_terminal(terminal);
        let ids: Vec<_> = self
            .sessions
            .lock()
            .iter()
            .filter(|(_, session)| session.info.terminal_id == terminal)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.close_session(&id);
        }
        self.save_recovery();
    }

    pub(crate) fn reconcile(&self, panes: &[HerdrPaneInfo]) {
        self.recover_saved(panes);
        let ids: Vec<_> = {
            let mut sessions = self.sessions.lock();
            sessions
                .iter_mut()
                .filter_map(|(id, session)| {
                    let pane = panes.iter().find(|pane| {
                        pane.pane_id == session.info.pane_id
                            && pane.terminal_id == session.info.terminal_id
                    });
                    let agent = pane
                        .is_some_and(|pane| pane.agent.as_deref() == Some(session.agent.as_str()));
                    let conversation = pane.and_then(recovery::conversation);
                    let replaced = session
                        .conversation
                        .as_deref()
                        .zip(conversation)
                        .is_some_and(|(original, current)| original != current);
                    if agent {
                        session.observed_agent = true;
                        if session.conversation.is_none() {
                            session.conversation = conversation.map(str::to_owned);
                        }
                    }
                    (replaced
                        || pane.is_none()
                        || (!agent
                            && (session.observed_agent
                                || session.started.elapsed() > Duration::from_secs(15))))
                    .then(|| id.clone())
                })
                .collect()
        };
        for id in ids {
            self.close_session(&id);
        }
        self.save_recovery();
    }

    pub(crate) fn shutdown(&self) {
        self.recovery.lock().clear();
        let (bridge, sessions) = {
            let mut bridge = self.bridge.lock();
            self.epoch.fetch_add(1, Ordering::AcqRel);
            let ids = self.sessions.lock().keys().cloned().collect::<Vec<_>>();
            (bridge.take(), ids)
        };
        for session in sessions {
            self.close_session(&session);
        }
        retire_bridge(bridge);
        self.save_recovery();
    }
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

pub(crate) fn new_session(
    runtime_id: &str,
    pane: &HerdrPaneInfo,
) -> Result<ReverseControlSession, String> {
    Ok(ReverseControlSession {
        runtime_id: runtime_id.to_owned(),
        session_id: random_token()?,
        pane_id: pane.pane_id.clone(),
        terminal_id: pane.terminal_id.clone(),
    })
}

#[cfg(test)]
mod tests;
