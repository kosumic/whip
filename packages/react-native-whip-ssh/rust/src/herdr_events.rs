//! Whip's event transport, subscriptions, and native callbacks.
use crate::herdr_api::{
    HerdrAgentStatus, HerdrPaneInfo, HerdrPaneLayoutSnapshot, HerdrPaneScrollInfo, HerdrTabInfo,
    HerdrWorkspaceInfo, HerdrWorktreeInfo,
};
use crate::herdr_connection::{HerdrConnection, HerdrStream, HerdrStreamFraming, HerdrStreamKind};
pub use herdr_protocol::events::HerdrEvent;
use herdr_protocol::events::{JsonlEventParser, StreamItem};
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use tokio::sync::oneshot;

macro_rules! native_type {
    ($kind:ident, $item:item) => {
        #[uniffi::remote($kind)]
        $item
    };
}
herdr_protocol::herdr_event_type_schema!(native_type);

const EVENT_READ_CHUNK_BYTES: usize = 32 * 1024;
const SUBSCRIPTION_ACK_TIMEOUT: Duration = Duration::from_secs(15);

#[uniffi::export(with_foreign)]
pub trait HerdrEventSink: Send + Sync {
    fn event(&self, client_key: String, event: HerdrEvent);
    fn closed(&self, client_key: String, reason: String);
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum HerdrEventError {
    #[error("{0}")]
    UnsupportedProtocol(String),
    #[error("{0}")]
    TransportDisconnected(String),
    #[error("{0}")]
    SubscriptionUnavailable(String),
}

impl From<herdr_protocol::events::EventProtocolError> for HerdrEventError {
    fn from(error: herdr_protocol::events::EventProtocolError) -> Self {
        use herdr_protocol::events::EventProtocolError;
        match error {
            EventProtocolError::UnsupportedProtocol(message) => Self::UnsupportedProtocol(message),
            EventProtocolError::InvalidRequest(message) => Self::SubscriptionUnavailable(message),
        }
    }
}

fn subscription_request(protocol: u32, pane_ids: &[String]) -> Result<Vec<u8>, HerdrEventError> {
    herdr_protocol::events::subscription_request(protocol, pane_ids).map_err(Into::into)
}

struct EventSubscription {
    id: u64,
    client_key: String,
    stream: Mutex<Option<Arc<HerdrStream>>>,
    parser: Mutex<JsonlEventParser>,
    acknowledgement: Mutex<Option<oneshot::Sender<Result<(), HerdrEventError>>>>,
}

impl EventSubscription {
    fn finish_acknowledgement(&self, result: Result<(), HerdrEventError>) {
        if let Some(sender) = self.acknowledgement.lock().take() {
            let _ = sender.send(result);
        }
    }

    fn close_stream(&self) {
        if let Some(stream) = self.stream.lock().take() {
            let _ = stream.close();
        }
    }
}

#[derive(Default)]
struct Registry {
    by_id: HashMap<u64, Arc<EventSubscription>>,
    by_client: HashMap<String, u64>,
}

static NEXT_SUBSCRIPTION_ID: AtomicU64 = AtomicU64::new(1);
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
static EVENT_SINK: OnceLock<RwLock<Option<Arc<dyn HerdrEventSink>>>> = OnceLock::new();

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}
fn event_sink() -> &'static RwLock<Option<Arc<dyn HerdrEventSink>>> {
    EVENT_SINK.get_or_init(|| RwLock::new(None))
}
fn subscription(id: u64) -> Option<Arc<EventSubscription>> {
    registry().lock().by_id.get(&id).cloned()
}

fn remove_subscription(id: u64) {
    let mut registry = registry().lock();
    registry.by_client.retain(|_, current| *current != id);
    registry.by_id.remove(&id);
}

fn transport_frame(id: u64, bytes: Vec<u8>) {
    let Some(subscription) = subscription(id) else {
        return;
    };
    let items = subscription.parser.lock().push(&bytes);
    let mut events = Vec::new();
    for item in items {
        match item {
            StreamItem::Acknowledged => subscription.finish_acknowledgement(Ok(())),
            StreamItem::Event(event) => events.push(*event),
            StreamItem::ServerError(reason) => {
                forward_events(&subscription.client_key, std::mem::take(&mut events));
                fail_subscription(&subscription, reason);
                break;
            }
        }
    }
    forward_events(&subscription.client_key, events);
}

fn forward_events(client_key: &str, events: Vec<HerdrEvent>) {
    let Some(events) = crate::host_runtime::deliver_herdr_events(client_key, events) else {
        return;
    };
    if let Some(sink) = event_sink().read().clone() {
        for event in events {
            sink.event(client_key.to_owned(), event);
        }
    }
}

fn transport_closed(id: u64, reason: String) {
    let Some(subscription) = subscription(id) else {
        return;
    };
    subscription.parser.lock().end();
    subscription.finish_acknowledgement(Err(HerdrEventError::TransportDisconnected(format!(
        "Herdr event subscription closed before acknowledgement: {reason}"
    ))));
    if !crate::host_runtime::event_subscription_closed(&subscription.client_key, reason.clone())
        && let Some(sink) = event_sink().read().clone()
    {
        sink.closed(subscription.client_key.clone(), reason);
    }
    remove_subscription(id);
}

fn fail_subscription(subscription: &EventSubscription, reason: String) {
    subscription.finish_acknowledgement(Err(HerdrEventError::SubscriptionUnavailable(
        reason.clone(),
    )));
    if !crate::host_runtime::event_subscription_closed(&subscription.client_key, reason.clone())
        && let Some(sink) = event_sink().read().clone()
    {
        sink.closed(subscription.client_key.clone(), reason);
    }
    subscription.close_stream();
    remove_subscription(subscription.id);
}

pub(crate) async fn start_on_runtime(
    connection: Arc<HerdrConnection>,
    protocol: u32,
    pane_ids: Vec<String>,
) -> Result<(), HerdrEventError> {
    let client_key = connection.client_key().to_owned();
    if registry().lock().by_client.contains_key(&client_key) {
        return Ok(());
    }
    let request = subscription_request(protocol, &pane_ids)?;
    let id = NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed);
    let (acknowledgement_sender, acknowledgement_receiver) = oneshot::channel();
    let subscription = Arc::new(EventSubscription {
        id,
        client_key: client_key.clone(),
        stream: Mutex::new(None),
        parser: Mutex::new(JsonlEventParser::default()),
        acknowledgement: Mutex::new(Some(acknowledgement_sender)),
    });
    {
        let mut registry = registry().lock();
        registry.by_id.insert(id, subscription.clone());
        registry.by_client.insert(client_key.clone(), id);
    }
    let frame = Arc::new(move |bytes| transport_frame(id, bytes));
    let closed = Arc::new(move |reason| transport_closed(id, reason));
    let stream = match connection
        .open_stream(
            HerdrStreamKind::Events,
            HerdrStreamFraming::Raw,
            EVENT_READ_CHUNK_BYTES,
            frame,
            closed,
        )
        .await
    {
        Ok(stream) => stream,
        Err(error) => {
            remove_subscription(id);
            return Err(HerdrEventError::TransportDisconnected(error.to_string()));
        }
    };
    *subscription.stream.lock() = Some(stream.clone());
    if let Err(error) = stream.write(request) {
        subscription.close_stream();
        remove_subscription(id);
        return Err(HerdrEventError::TransportDisconnected(error.to_string()));
    }
    match stream
        .wait_current(tokio::time::timeout(
            SUBSCRIPTION_ACK_TIMEOUT,
            acknowledgement_receiver,
        ))
        .await
    {
        Ok(Ok(Ok(result))) => result,
        Ok(Ok(Err(_))) => Err(HerdrEventError::SubscriptionUnavailable(
            "Herdr event subscription acknowledgement was cancelled".to_owned(),
        )),
        Ok(Err(_)) => {
            remove_subscription(id);
            subscription.close_stream();
            Err(HerdrEventError::SubscriptionUnavailable(
                "timed out waiting for Herdr event subscription acknowledgement".to_owned(),
            ))
        }
        Err(error) => {
            remove_subscription(id);
            subscription.close_stream();
            Err(HerdrEventError::TransportDisconnected(error.to_string()))
        }
    }
}

#[uniffi::export]
pub fn set_herdr_event_sink(sink: Arc<dyn HerdrEventSink>) {
    *event_sink().write() = Some(sink);
}

#[uniffi::export]
pub fn clear_herdr_event_sink() {
    *event_sink().write() = None;
}

#[uniffi::export]
pub async fn start_herdr_event_subscription(
    client_key: String,
    socket_path: String,
    protocol: u32,
    pane_ids: Vec<String>,
) -> Result<(), HerdrEventError> {
    let runtime = crate::runtime().map_err(HerdrEventError::TransportDisconnected)?;
    let connection = HerdrConnection::registered(client_key, socket_path)
        .map_err(|error| HerdrEventError::TransportDisconnected(error.to_string()))?;
    runtime
        .spawn(start_on_runtime(connection, protocol, pane_ids))
        .await
        .map_err(|error| {
            HerdrEventError::SubscriptionUnavailable(format!(
                "Herdr event runtime task failed: {error}"
            ))
        })?
}

#[uniffi::export]
pub fn close_herdr_event_subscription(client_key: String) {
    let subscription = {
        let registry = registry().lock();
        registry
            .by_client
            .get(&client_key)
            .and_then(|id| registry.by_id.get(id))
            .cloned()
    };
    if let Some(subscription) = subscription {
        subscription.finish_acknowledgement(Err(HerdrEventError::SubscriptionUnavailable(
            "Herdr event subscription was closed before acknowledgement".to_owned(),
        )));
        remove_subscription(subscription.id);
        subscription.close_stream();
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    // An acknowledged subscription at the byte-parser boundary, without SSH.
    pub(crate) struct EventStreamFixture {
        id: u64,
    }

    impl EventStreamFixture {
        pub(crate) fn new(client_key: String) -> Self {
            let id = NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed);
            let subscription = Arc::new(EventSubscription {
                id,
                client_key: client_key.clone(),
                stream: Mutex::new(None),
                parser: Mutex::new(JsonlEventParser::default()),
                acknowledgement: Mutex::new(None),
            });
            let mut registry = registry().lock();
            assert!(!registry.by_client.contains_key(&client_key));
            registry.by_client.insert(client_key, id);
            registry.by_id.insert(id, subscription);
            drop(registry);
            Self { id }
        }

        pub(crate) fn is_active(&self) -> bool {
            subscription(self.id).is_some()
        }

        pub(crate) fn send(&self, bytes: Vec<u8>) {
            transport_frame(self.id, bytes);
        }
    }

    impl Drop for EventStreamFixture {
        fn drop(&mut self) {
            remove_subscription(self.id);
        }
    }
}
