//! Host-owned HTTP MCP listener and launch-scoped browser authorization.
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

const MAX_RESPONSE: usize = 8 * 1024 * 1024;
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

#[derive(Default)]
pub(crate) struct ReverseControl {
    bridge: Mutex<Option<Bridge>>,
    startup: AsyncMutex<()>,
    epoch: AtomicU64,
    sequence: AtomicU64,
    sessions: Mutex<HashMap<String, Session>>,
    pending: Mutex<HashMap<String, Pending>>,
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
                Ok(receiver) => receiver
                    .await
                    .unwrap_or_else(|_| tool_error("Browser session closed")),
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
        let name = message["params"]["name"].as_str().unwrap_or_default();
        let action = name.strip_prefix("browser.").unwrap_or_default();
        if !tools::ACTIONS.contains(&action) {
            return Err(tool_error("Unknown browser tool"));
        }
        let args = message["params"]["arguments"]
            .as_object()
            .map_or_else(|| json!({}), |args| Value::Object(args.clone()));
        let (response, receiver) = oneshot::channel();
        let request = self.sequence.fetch_add(1, Ordering::Relaxed).to_string();
        let info = {
            let sessions = self.sessions.lock();
            let Some(owned) = sessions.get(session) else {
                return Err(tool_error("Browser session closed"));
            };
            let mut pending = self.pending.lock();
            if pending
                .values()
                .filter(|call| call.session == session)
                .count()
                >= 8
            {
                return Err(tool_error("Browser busy; retry after the current call"));
            }
            pending.insert(
                request.clone(),
                Pending {
                    session: session.to_owned(),
                    rpc_id,
                    response,
                },
            );
            let info = owned.info.clone();
            drop(pending);
            drop(sessions);
            info
        };
        emit(&info, "action", &request, action, args);
        // HTTP disconnect is not MCP cancellation. This watchdog is independent
        // of the HTTP response future, so abandoned calls still settle and clean up.
        let weak = Arc::downgrade(self);
        crate::runtime()
            .map_err(|_| tool_error("Browser runtime unavailable"))?
            .spawn(async move {
                tokio::time::sleep(ACTION_TIMEOUT).await;
                if let Some(owner) = weak.upgrade() {
                    owner.cancel_request(&request, "Browser action timed out");
                }
            });
        Ok(receiver)
    }

    fn cancel_request(&self, request: &str, message: &str) {
        let pending = self.pending.lock().remove(request);
        if let Some(pending) = pending {
            let info = self
                .sessions
                .lock()
                .get(&pending.session)
                .map(|session| session.info.clone());
            let _ = pending.response.send(tool_error(message));
            if let Some(info) = info {
                emit(&info, "cancel", request, "", Value::Null);
            }
        }
    }

    pub(crate) fn reply(&self, session: &str, request: &str, result: &str) {
        let pending = {
            let mut calls = self.pending.lock();
            if calls
                .get(request)
                .is_none_or(|call| call.session != session)
            {
                return;
            }
            calls.remove(request)
        };
        let Some(pending) = pending else { return };
        let result = if result.len() > MAX_RESPONSE {
            tool_error("Browser response too large")
        } else {
            serde_json::from_str::<Value>(result)
                .unwrap_or_else(|_| tool_error("Invalid browser response"))
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
            .map(|(_, call)| call.response)
            .collect();
        for response in requests {
            let _ = response.send(tool_error("Browser session closed"));
        }
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

fn tool_error(message: &str) -> Value {
    json!({"isError":true,"content":[{"type":"text","text":message}]})
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
