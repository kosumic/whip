use super::super::{RealtimeVoiceAdapter, recovery};
use std::sync::Arc;
pub(in crate::realtime_voice) async fn start(
    owner: Arc<RealtimeVoiceAdapter>,
    key: &native_credentials::NativeCredential,
    session: serde_json::Value,
) -> Result<(super::super::RealtimeSocket, String), &'static str> {
    let attempt = recovery::Attempt::new(owner.clone());
    let host = Arc::new(super::host::AppHost {
        owner: owner.clone(),
        attempt,
    });
    let (socket, handle, id) = voice_openai::connect_live(host, key, session).await?;
    *owner.media.lock() = Some(handle);
    Ok((socket, id))
}
#[cfg(test)]
use super::{
    api,
    identity::Identity,
    media,
    transport::{AnswerOutcome, Transport},
};
#[cfg(test)]
use crate::realtime_voice::{self as voice, socket, startup};
#[cfg(test)]
use futures::{SinkExt, StreamExt};
#[cfg(test)]
use native_credentials::NativeCredential;
#[cfg(test)]
use parking_lot::Mutex;
#[cfg(test)]
use serde_json::{Value, json};
#[cfg(test)]
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
#[cfg(test)]
use tokio::sync::watch;
#[cfg(test)]
use tokio_tungstenite::tungstenite::Message;
#[cfg(test)]
use voice_openai::LiveCall as Call;
#[cfg(test)]
mod tests;
