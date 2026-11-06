//! Typed GPT-Live commands on the same bounded socket used by Realtime.
use futures::SinkExt;
use oai_rt_rs::live::{self as api, ClientEvent, Command, Field};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio_tungstenite::tungstenite::Message;
pub const CONTEXT_BYTES: usize = 480;
static SEQUENCE: AtomicU64 = AtomicU64::new(1);
pub fn codec() -> api::Codec {
    api::Codec {
        max_event_bytes: crate::MAX_WIRE,
    }
}
pub fn chunks(mut text: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    while !text.is_empty() {
        let mut end = text.len().min(CONTEXT_BYTES);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&text[..end]);
        text = &text[end..];
    }
    chunks
}

pub async fn send_with_prefix(
    socket: &mut crate::RealtimeSocket,
    command: Command,
    prefix: &str,
) -> Result<String, &'static str> {
    let id = format!("{prefix}:{}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let event = ClientEvent {
        event_id: Field::Value(id.clone()),
        command,
    };
    let text = codec()
        .encode(&event)
        .map_err(|_| "GPT-Live command is invalid.")?;
    tokio::time::timeout(
        voice_call_media::capture_worker::SEND_TIMEOUT,
        socket.send(Message::Text(text.into())),
    )
    .await
    .map_err(|_| "GPT-Live upload timed out.")?
    .map_err(|_| "GPT-Live connection ended.")?;
    Ok(id)
}

pub async fn send(
    socket: &mut crate::RealtimeSocket,
    command: Command,
) -> Result<String, &'static str> {
    send_with_prefix(socket, command, "voice-live").await
}
