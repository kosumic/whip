//! Scheduling and SSH effects for the reusable core protocol state machines.
use crate::{
    herdr_api::{HerdrControlError, HerdrControlRequest, HerdrControlResult},
    herdr_connection::{ConnectionExecStream, HerdrConnection, HerdrConnectionError, HerdrStream},
};
use herdr_protocol::hc::{
    self,
    client::{CallError, Transport},
    generated::{Request, Response},
    projection::View,
    session::{Action, Session, StreamItem},
    wire::Kind,
};
use parking_lot::Mutex;
use std::{
    collections::BTreeMap,
    sync::{Arc, OnceLock, Weak},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, Notify, oneshot};

type Failure = CallError<HerdrControlError>;
type Reply = oneshot::Sender<Result<Response, Failure>>;
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
enum ByteStream {
    Socket(Arc<HerdrStream>),
    Exec(Arc<ConnectionExecStream>),
}
impl ByteStream {
    fn write(&self, bytes: Vec<u8>) -> Result<(), HerdrConnectionError> {
        match self {
            Self::Socket(s) => s.write(bytes),
            Self::Exec(s) => s.write(bytes),
        }
    }
    fn close(&self) {
        let _ = match self {
            Self::Socket(s) => s.close(),
            Self::Exec(s) => s.close(),
        };
    }
    async fn wait_current<T, F: std::future::Future<Output = T>>(
        &self,
        future: F,
    ) -> Result<T, HerdrConnectionError> {
        match self {
            Self::Socket(s) => s.wait_current(future).await,
            Self::Exec(s) => s.wait_current(future).await,
        }
    }
}
struct Routing {
    wire: Session,
    pending: BTreeMap<u64, Reply>,
    channels: BTreeMap<u32, Arc<Notify>>,
    failure: Option<HerdrControlError>,
}
pub(crate) struct Core {
    connection: Weak<HerdrConnection>,
    revision: u64,
    stream: Mutex<Option<ByteStream>>,
    socket_path: Mutex<Option<String>>,
    routing: Mutex<Routing>,
    ready: Notify,
    model: OnceLock<hc::client::Client>,
    view: AsyncMutex<View>,
}

fn disconnected(error: impl std::fmt::Display) -> HerdrControlError {
    HerdrControlError::TransportDisconnected(error.to_string())
}
pub(crate) fn control_error(error: Failure) -> HerdrControlError {
    match error {
        CallError::Transport(e) => e,
        CallError::Protocol(hc::Error::Rpc(e)) => HerdrControlError::ProtocolError(
            e.data
                .as_ref()
                .map_or_else(|| e.code.to_string(), |d| d.kind.clone()),
            e.message,
        ),
        CallError::Protocol(
            e @ (hc::Error::UnsupportedGeneration(_)
            | hc::Error::MissingMethod(_)
            | hc::Error::Unsupported(_)),
        ) => HerdrControlError::UnsupportedResponse(e.to_string()),
        CallError::Protocol(e) => HerdrControlError::MalformedResponse(e.to_string()),
        e @ CallError::Partial { .. } => {
            HerdrControlError::ProtocolError("partial_completion".into(), e.to_string())
        }
    }
}

impl Core {
    pub(crate) fn is_alive(&self) -> bool {
        self.routing.lock().failure.is_none()
            && self
                .connection
                .upgrade()
                .is_some_and(|c| c.revision() == self.revision)
    }
    pub(crate) async fn open(
        connection: Arc<HerdrConnection>,
        command: &str,
        session: &str,
        explicit: Option<&str>,
    ) -> Result<Arc<Self>, HerdrControlError> {
        let core = Arc::new(Self {
            connection: Arc::downgrade(&connection),
            revision: connection.revision(),
            stream: Mutex::new(None),
            socket_path: Mutex::new(None),
            routing: Mutex::new(Routing {
                wire: Session::default(),
                pending: BTreeMap::new(),
                channels: BTreeMap::new(),
                failure: None,
            }),
            ready: Notify::new(),
            model: OnceLock::new(),
            view: AsyncMutex::new(View::default()),
        });
        let discovery = hc::endpoint::discover_command(command, session, explicit)
            .map_err(|e| control_error(e.into()))?;
        let output = connection.execute(&discovery).await.map_err(disconnected)?;
        let endpoint =
            hc::endpoint::parse_discovery(&output.stdout).map_err(|e| control_error(e.into()))?;
        let data = {
            let weak = Arc::downgrade(&core);
            Arc::new(move |bytes| {
                if let Some(core) = weak.upgrade() {
                    core.receive(bytes);
                }
            })
        };
        let closed = {
            let weak = Arc::downgrade(&core);
            Arc::new(move |reason| {
                if let Some(core) = weak.upgrade() {
                    core.fail(disconnected(reason));
                }
            })
        };
        let mut opened = None;
        let mut actual_session = session.trim().to_owned();
        let mut actual_command = command.to_owned();
        if let Some(mut endpoint) = endpoint {
            *core.socket_path.lock() = Some(endpoint.socket.clone());
            actual_session = endpoint.session.clone();
            actual_command = endpoint.command.clone();
            match connection
                .open_raw_socket(&endpoint.socket, data.clone(), closed.clone())
                .await
            {
                Ok(stream) => opened = Some(ByteStream::Socket(stream)),
                Err(_) if endpoint.installed => {
                    let start =
                        hc::endpoint::start_command(&actual_command, &endpoint.session, explicit)
                            .map_err(|e| control_error(e.into()))?;
                    let output = connection.execute(&start).await.map_err(disconnected)?;
                    if output.exit_status.is_some_and(|status| status != 0) {
                        return Err(HerdrControlError::ProtocolError(
                            "core_start_failed".into(),
                            String::from_utf8_lossy(&output.stderr).trim().into(),
                        ));
                    }
                    let output = connection.execute(&discovery).await.map_err(disconnected)?;
                    endpoint = hc::endpoint::parse_discovery(&output.stdout)
                        .map_err(|e| control_error(e.into()))?
                        .ok_or_else(|| disconnected("core socket discovery changed shell"))?;
                    *core.socket_path.lock() = Some(endpoint.socket.clone());
                    if let Ok(stream) = connection
                        .open_raw_socket(&endpoint.socket, data.clone(), closed.clone())
                        .await
                    {
                        opened = Some(ByteStream::Socket(stream));
                    }
                }
                Err(error) => return Err(disconnected(error)),
            }
        }
        let stream = match opened {
            Some(stream) => stream,
            None => {
                if actual_session.is_empty() {
                    actual_session = "default".into();
                }
                let posix = hc::endpoint::parse_discovery(&output.stdout)
                    .map_err(|e| control_error(e.into()))?
                    .is_some();
                let mut connect =
                    hc::endpoint::connect_command(&actual_command, &actual_session, posix)
                        .map_err(|e| control_error(e.into()))?;
                if let Some(path) = explicit {
                    if !posix {
                        return Err(HerdrControlError::InvalidField(
                            "explicit Unix socket requires a POSIX SSH shell".into(),
                        ));
                    }
                    connect = format!("HC_SOCKET={} {connect}", hc::endpoint::shell_quote(path));
                }
                ByteStream::Exec(
                    connection
                        .open_exec_stream("core", &connect, data, closed)
                        .await
                        .map_err(disconnected)?,
                )
            }
        };
        *core.stream.lock() = Some(stream.clone());
        let mut guard = Opening(Some(core.clone()));
        core.write(Session::hello_request())
            .map_err(control_error)?;
        let wait = async {
            loop {
                let notified = core.ready.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                {
                    let routing = core.routing.lock();
                    if let Some(error) = &routing.failure {
                        return Err(error.clone());
                    }
                    if routing.wire.hello().is_some() {
                        return Ok(());
                    }
                }
                notified.await;
            }
        };
        stream
            .wait_current(tokio::time::timeout(TIMEOUT, wait))
            .await
            .map_err(disconnected)?
            .map_err(|_| HerdrControlError::RequestTimeout("core hello timed out".into()))??;
        let Response::EventsSubscribe(subscription) = core
            .rpc(Request::events_subscribe(
                hc::generated::EventsSubscribeParams::default(),
            ))
            .await
            .map_err(control_error)?
        else {
            return Err(HerdrControlError::MalformedResponse(
                "expected events.subscribe".into(),
            ));
        };
        let channel = subscription.channel.ok_or_else(|| {
            HerdrControlError::MalformedResponse("core subscription returned no channel".into())
        })?;
        let hello = core
            .routing
            .lock()
            .wire
            .hello()
            .cloned()
            .ok_or_else(|| disconnected("core hello lost"))?;
        core.model
            .set(
                hc::client::Client::new(hello, *subscription)
                    .map_err(|e| control_error(e.into()))?,
            )
            .map_err(|_| disconnected("core client initialized twice"))?;
        core.start_events(channel);
        let weak = Arc::downgrade(&core);
        tokio::spawn(async move {
            let result = stream.wait_current(std::future::pending::<()>()).await;
            if let Some(core) = weak.upgrade() {
                core.fail(disconnected(
                    result
                        .err()
                        .map_or_else(|| "core transport ended".into(), |e| e.to_string()),
                ));
            }
        });
        guard.0.take();
        Ok(core)
    }
    fn model(&self) -> Result<&hc::client::Client, Failure> {
        self.model.get().ok_or_else(|| hc::Error::Closed.into())
    }
    pub(crate) fn socket_path(&self) -> Option<String> {
        self.socket_path.lock().clone()
    }
    pub(crate) async fn control(
        &self,
        request: HerdrControlRequest,
        nonce: &str,
    ) -> Result<HerdrControlResult, HerdrControlError> {
        // Shared desktop IDs must remain unique across different Whip clients.
        let operation_id = format!("{nonce}-{}", uuid::Uuid::new_v4().simple());
        let mut view = self.view.lock().await;
        self.model()
            .map_err(control_error)?
            .control(self, request, &mut view, &operation_id)
            .await
            .map_err(control_error)
    }
    pub(crate) async fn request_json(
        &self,
        method: &str,
        params: serde_json::Value,
        nonce: &str,
    ) -> Result<serde_json::Value, HerdrControlError> {
        let operation_id = format!("{nonce}-{}", uuid::Uuid::new_v4().simple());
        let mut view = self.view.lock().await;
        self.model()
            .map_err(control_error)?
            .request_json(self, method, params, &mut view, &operation_id)
            .await
            .map_err(control_error)
    }
    fn write(&self, bytes: Vec<u8>) -> Result<(), Failure> {
        let result = self
            .stream
            .lock()
            .as_ref()
            .ok_or_else(|| CallError::Transport(disconnected("core byte stream unavailable")))?
            .write(bytes);
        if let Err(error) = result {
            let error = disconnected(error);
            self.fail(error.clone());
            return Err(CallError::Transport(error));
        }
        Ok(())
    }
    fn receive(&self, bytes: Vec<u8>) {
        let actions = {
            let mut r = self.routing.lock();
            if r.failure.is_some() {
                return;
            }
            r.wire.receive(&bytes)
        };
        match actions {
            Err(error) => self.fail(control_error(error.into())),
            Ok(actions) => {
                for action in actions {
                    match action {
                        Action::Ready(_) => self.ready.notify_waiters(),
                        Action::Reply { id, result } => {
                            let sender = self.routing.lock().pending.remove(&id);
                            if sender.is_none_or(|sender| {
                                sender.send(result.map_err(Into::into)).is_err()
                            }) {
                                self.cancel(id);
                            }
                        }
                        Action::Channel(channel) => {
                            if let Some(notify) = self.routing.lock().channels.get(&channel) {
                                notify.notify_one();
                            }
                        }
                        Action::Send(bytes) => {
                            let _ = self.write(bytes);
                        }
                    }
                }
            }
        }
    }
    fn cancel(&self, id: u64) {
        let bytes = {
            let mut r = self.routing.lock();
            r.pending.remove(&id);
            r.wire.cancel(id)
        };
        if let Ok(bytes) = bytes {
            for bytes in bytes {
                let _ = self.write(bytes);
            }
        }
    }
    pub(crate) fn fail(&self, error: HerdrControlError) {
        let (pending, notifies) = {
            let mut r = self.routing.lock();
            if r.failure.is_some() {
                return;
            }
            r.failure = Some(error.clone());
            let _ = r.wire.end();
            (
                std::mem::take(&mut r.pending),
                std::mem::take(&mut r.channels),
            )
        };
        if let Some(stream) = self.stream.lock().take() {
            stream.close();
        }
        self.ready.notify_waiters();
        for (_, notify) in notifies {
            notify.notify_waiters();
        }
        for (_, reply) in pending {
            let _ = reply.send(Err(CallError::Transport(error.clone())));
        }
        if let Some(connection) = self.connection.upgrade()
            && connection.revision() == self.revision
        {
            crate::host_runtime::event_subscription_closed(
                connection.client_key(),
                error.to_string(),
            );
        }
    }
    pub(crate) async fn read_channel(
        &self,
        channel: u32,
    ) -> Result<Vec<StreamItem>, HerdrControlError> {
        let notify = {
            let mut r = self.routing.lock();
            if let Some(error) = &r.failure {
                return Err(error.clone());
            }
            if r.channels.len() >= hc::session::MAX_CHANNELS && !r.channels.contains_key(&channel) {
                return Err(control_error(hc::Error::Limit("channel consumers").into()));
            }
            r.channels.entry(channel).or_default().clone()
        };
        loop {
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let items = {
                let mut r = self.routing.lock();
                if let Some(error) = &r.failure {
                    return Err(error.clone());
                }
                r.wire
                    .take_channel(channel)
                    .map_err(|e| control_error(e.into()))?
            };
            if !items.is_empty() {
                return Ok(items);
            }
            notified.await;
        }
    }
    pub(crate) fn consumed(&self, channel: u32, bytes: usize) -> Result<(), HerdrControlError> {
        let frame = self
            .routing
            .lock()
            .wire
            .consumed(channel, bytes)
            .map_err(|e| control_error(e.into()))?;
        if let Some(frame) = frame {
            self.write(frame).map_err(control_error)?;
        }
        Ok(())
    }
    fn consume_events(
        &self,
        channel: u32,
        decoder: &mut hc::events::Decoder,
        items: Vec<StreamItem>,
    ) -> Result<(), HerdrControlError> {
        for item in items {
            match item {
                StreamItem::Data(bytes) => {
                    let notifications =
                        decoder.push(&bytes).map_err(|e| control_error(e.into()))?;
                    let changes = self
                        .model()
                        .map_err(control_error)?
                        .apply_notifications(notifications)
                        .map_err(|e| control_error(e.into()))?;
                    self.consumed(channel, bytes.len())?;
                    if (changes.terminals
                        || changes.machines
                        || changes.refetch_documents
                        || !changes.documents.is_empty())
                        && let Some(connection) = self.connection.upgrade()
                    {
                        crate::host_runtime::core_state_changed(
                            connection.client_key(),
                            self.revision,
                        );
                    }
                }
                StreamItem::Closed(reason) => {
                    return Err(disconnected(format!(
                        "core event stream closed: {reason:?}"
                    )));
                }
            }
        }
        Ok(())
    }
    fn start_events(self: &Arc<Self>, channel: u32) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut decoder = hc::events::Decoder::default();
            loop {
                let Some(core) = weak.upgrade() else {
                    return;
                };
                let result = core
                    .read_channel(channel)
                    .await
                    .and_then(|items| core.consume_events(channel, &mut decoder, items));
                if let Err(error) = result {
                    core.fail(error);
                    return;
                }
            }
        });
    }
}
impl Transport for Core {
    type Failure = HerdrControlError;
    async fn rpc(&self, request: Request) -> Result<Response, Failure> {
        let (sender, receiver) = oneshot::channel();
        let (id, bytes) = {
            let mut r = self.routing.lock();
            if let Some(error) = &r.failure {
                return Err(CallError::Transport(error.clone()));
            }
            let (id, bytes) = r.wire.request(request)?;
            r.pending.insert(id, sender);
            drop(r);
            (id, bytes)
        };
        let mut guard = Pending {
            core: self,
            id,
            armed: true,
        };
        self.write(bytes)?;
        let stream = self
            .stream
            .lock()
            .clone()
            .ok_or_else(|| CallError::Transport(disconnected("core stream closed")))?;
        let response = stream
            .wait_current(tokio::time::timeout(TIMEOUT, receiver))
            .await
            .map_err(|e| CallError::Transport(disconnected(e)))?
            .map_err(|_| {
                CallError::Transport(HerdrControlError::RequestTimeout(
                    "core RPC timed out; its outcome may be unknown".into(),
                ))
            })?
            .map_err(|_| CallError::Transport(disconnected("core RPC cancelled")))??;
        if let Some(channel) = response.stream_channel() {
            self.routing.lock().wire.claim_channel(channel)?;
        }
        guard.armed = false;
        Ok(response)
    }
    fn stream_send(&self, channel: u32, kind: Kind, payload: Vec<u8>) -> Result<(), Failure> {
        let frame = self
            .routing
            .lock()
            .wire
            .channel_frame(channel, kind, payload)?;
        self.write(frame)
    }
    fn stream_close(&self, channel: u32) -> Result<(), Failure> {
        let frame = {
            let mut r = self.routing.lock();
            if let Some(notify) = r.channels.remove(&channel) {
                notify.notify_waiters();
            }
            r.wire.close_channel(channel)?
        };
        if let Some(frame) = frame {
            self.write(frame)?;
        }
        Ok(())
    }
}
struct Pending<'a> {
    core: &'a Core,
    id: u64,
    armed: bool,
}
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.core.cancel(self.id);
        }
    }
}
struct Opening(Option<Arc<Core>>);
impl Drop for Opening {
    fn drop(&mut self) {
        if let Some(core) = self.0.take() {
            core.fail(disconnected("core connection setup was cancelled"));
        }
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        if let Some(stream) = self.stream.get_mut().take() {
            stream.close();
        }
    }
}

#[cfg(all(test, unix))]
mod tests;
