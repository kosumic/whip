use crate::{ClientEvent, IO_TIMEOUT};
use futures::SinkExt;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio_tungstenite::tungstenite::Message;
static EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(1);
pub async fn send<S>(socket: &mut S, event: ClientEvent) -> Result<(), &'static str>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    send_with_prefix(socket, event, crate::EVENT_PREFIX).await
}

pub async fn send_value<S>(socket: &mut S, value: Value) -> Result<(), &'static str>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    send_value_with_prefix(socket, value, crate::EVENT_PREFIX).await
}

pub async fn send_value_with_prefix<S>(
    socket: &mut S,
    mut value: Value,
    prefix: &str,
) -> Result<(), &'static str>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let kind = value["type"]
        .as_str()
        .ok_or("Realtime event has no type.")?;
    let id = format!(
        "{prefix}:{kind}:{}",
        EVENT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    value["event_id"] = json!(id);
    let text = serde_json::to_string(&value).map_err(|_| "Realtime event could not be encoded.")?;
    tokio::time::timeout(IO_TIMEOUT, socket.send(Message::Text(text.into())))
        .await
        .map_err(|_| "Realtime upload timed out.")?
        .map_err(|_| "Realtime connection ended.")
}

pub async fn send_with_prefix<S>(
    socket: &mut S,
    event: ClientEvent,
    prefix: &str,
) -> Result<(), &'static str>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let value = serde_json::to_value(event).map_err(|_| "Realtime event could not be encoded.")?;
    send_value_with_prefix(socket, value, prefix).await
}
