//! Host-owned HTTP MCP listener and launch-scoped browser authorization.
mod browser;
mod http;
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
static SINK: OnceLock<RwLock<Option<Arc<dyn ReverseControlEventSink>>>> = OnceLock::new();

#[derive(Clone, Debug, uniffi::Record)]
pub struct ReverseControlSession {
    pub runtime_id: String,
    pub session_id: String,
    pub pane_id: String,
    pub terminal_id: String,
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
    token_hash: CtOutput<Sha256>,
    started: Instant,
    observed_agent: bool,
    protocol: Option<String>,
}

struct AuthenticatedSession {
    protocol: Option<String>,
}

struct Bridge {
    ssh: Arc<SshSession>,
    forward: RemoteForward,
    server: http::Server,
    epoch: u64,
}

fn retire_bridge(bridge: Option<Bridge>) {
    if let Some(Bridge {
        server, forward, ..
    }) = bridge
    {
        // Stop accepting HTTP requests but flush the final DELETE/error response
        // before tearing down its SSH channel. Forward draining is bounded.
        drop(server);
        if let Ok(runtime) = crate::runtime() {
            runtime.spawn(async move { forward.close_gracefully().await });
        }
    }
}

struct Pending {
    session: String,
    rpc_id: Value,
    response: oneshot::Sender<Value>,
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
            owner
                .begin_step(&self.session, &self.parent, operation)?
                .receive()
                .await
        })
    }
}

#[derive(Default)]
pub(crate) struct ReverseControl {
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

pub(crate) fn codex_args(launch: HerdrTabLaunch) -> Result<Vec<String>, String> {
    match launch {
        HerdrTabLaunch::Agent {
            kind: HerdrAgentKind::Codex,
            args,
        } => Ok(args),
        _ => Err("Reverse Control is available only for an explicit Codex launch".to_owned()),
    }
}

fn launch_args(mut args: Vec<String>, session: &str, port: u16, token: &str) -> Vec<String> {
    let url = format!("http://127.0.0.1:{port}/mcp/{session}");
    let authorization = serde_json::to_string(&format!("Bearer {token}")).unwrap_or_default();
    args.splice(
        0..0,
        [
            "-c".to_owned(),
            format!("mcp_servers.whip_browser.url=\"{url}\""),
            "-c".to_owned(),
            format!("mcp_servers.whip_browser.http_headers={{Authorization={authorization}}}"),
            "-c".to_owned(),
            "mcp_servers.whip_browser.required=true".to_owned(),
            "-c".to_owned(),
            "mcp_servers.whip_browser.tool_timeout_sec=25".to_owned(),
        ],
    );
    args
}

impl ReverseControl {
    pub(crate) async fn prepare(
        self: &Arc<Self>,
        ssh: Arc<SshSession>,
        info: ReverseControlSession,
        args: Vec<String>,
    ) -> Result<Vec<String>, String> {
        let _startup = self.startup.lock().await;
        let token = random_token()?;
        self.ensure_bridge(ssh).await?;
        // Registration and bridge removal share this lock order. Last-session
        // cleanup cannot race with a new registration and retire its forward.
        let port = {
            let bridge = self.bridge.lock();
            let current = bridge.as_ref().ok_or("SSH browser bridge closed")?;
            if !current.ssh.is_alive() || !current.server.is_alive() {
                return Err("SSH browser bridge disconnected".to_owned());
            }
            let port = current.forward.port;
            self.sessions.lock().insert(
                info.session_id.clone(),
                Session {
                    info: info.clone(),
                    token_hash: token_hash(&token),
                    started: Instant::now(),
                    observed_agent: false,
                    protocol: None,
                },
            );
            drop(bridge);
            port
        };
        emit(&info, "opened", "", "", Value::Null);
        let args = launch_args(args, &info.session_id, port, &token);
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
        Ok(args)
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
        let forward =
            tokio::time::timeout(Duration::from_secs(10), ssh.open_remote_forward(local_port))
                .await
                .map_err(|_| "SSH browser reverse forwarding timed out".to_owned())?
                .map_err(|_| {
                    "SSH server refused browser reverse forwarding; enable AllowTcpForwarding"
                        .to_owned()
                })?;
        let authority = format!("127.0.0.1:{}", forward.port);
        let server = http::serve(listener, Arc::downgrade(self), authority, epoch)?;
        let mut stopped = server.stopped();
        let observed_ssh = ssh.clone();
        let mut bridge = self.bridge.lock();
        if self.epoch.load(Ordering::Acquire) != epoch || !ssh.is_alive() || !server.is_alive() {
            return Err("SSH changed during browser bridge startup".to_owned());
        }
        *bridge = Some(Bridge {
            ssh,
            forward,
            server,
            epoch,
        });
        drop(bridge);
        let weak = Arc::downgrade(self);
        crate::runtime()?.spawn(async move {
            if *stopped.borrow() {
                return;
            }
            tokio::select! {
                _ = observed_ssh.disconnected() => {
                    if let Some(owner) = weak.upgrade() {
                        owner.shutdown_bridge(epoch);
                    }
                },
                _ = stopped.changed() => {},
            }
        });
        Ok(())
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
                drop(sessions);
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
        let action = BrowserAction::parse(
            name.strip_prefix("browser.").unwrap_or_default(),
            &message["params"]["arguments"],
        )
        .map_err(|error| error.mcp())?;
        let session_id = SessionId(session.to_owned());
        session_id.validate().map_err(|error| error.mcp())?;
        if let Some(tab) = action.tab_id() {
            engine::authorize_tab(&session_id, tab).map_err(|error| error.mcp())?;
        }
        let runtime = crate::runtime().map_err(|_| {
            BrowserError::new(ErrorCode::BrowserUnavailable, "Browser runtime unavailable").mcp()
        })?;
        let (response, receiver) = oneshot::channel();
        let request = self.sequence.fetch_add(1, Ordering::Relaxed).to_string();
        {
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
        }
        // Resolve the selected tab at arrival, before the per-session queue. UI
        // selection changes never redirect an action already waiting its turn.
        let context = match self.begin_step(
            session,
            &request,
            engine::Primitive::ResolveTab {
                tab_id: action.tab_id().cloned(),
            },
        ) {
            Ok(context) => context,
            Err(error) => {
                self.finish_action(&request, error.mcp());
                return Ok(receiver);
            }
        };
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
        let owner = Arc::downgrade(self);
        let task_request = request.clone();
        let (begin, begun) = oneshot::channel();
        let task = runtime.spawn(async move {
            let _ = begun.await;
            let work = async {
                let context = engine::decode(context.receive().await?)?;
                let _serial = queue.gate.lock().await;
                engine::run(bridge, &session_id, &task_request, action, context).await
            };
            let result = match engine::deadline(ACTION_TIMEOUT, work).await {
                Ok(result) => result.mcp().unwrap_or_else(|error| error.mcp()),
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
        use browser::model::{BrowserError, ErrorCode};
        let (action, mut args) = operation.wire()?;
        args["lease_id"] = json!(parent);
        let (response, receiver) = oneshot::channel();
        let request = format!(
            "{parent}:step:{}",
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let info = {
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
            info
        };
        emit(&info, "action", &request, &action, args);
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
    }

    pub(crate) fn close_terminal(&self, terminal: &str) {
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
    }

    pub(crate) fn reconcile(&self, panes: &[HerdrPaneInfo]) {
        let ids: Vec<_> = {
            let mut sessions = self.sessions.lock();
            sessions
                .iter_mut()
                .filter_map(|(id, session)| {
                    let pane = panes.iter().find(|pane| {
                        pane.pane_id == session.info.pane_id
                            && pane.terminal_id == session.info.terminal_id
                    });
                    let codex = pane.is_some_and(|pane| pane.agent.as_deref() == Some("codex"));
                    if codex {
                        session.observed_agent = true;
                    }
                    (pane.is_none()
                        || (!codex
                            && (session.observed_agent
                                || session.started.elapsed() > Duration::from_secs(15))))
                    .then(|| id.clone())
                })
                .collect()
        };
        for id in ids {
            self.close_session(&id);
        }
    }

    pub(crate) fn shutdown(&self) {
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
