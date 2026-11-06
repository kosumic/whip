//! Codex startup ownership, using the public Live signaling and attach protocol.
//! The POST starts the session; native media and the control sideband then run
//! in parallel. Neither connection sends session.start or replays commands.
use super::{
    Handle, api,
    identity::Identity,
    media,
    transport::{AnswerOutcome, Transport},
};
use crate::realtime_voice::{self as voice, RealtimeVoiceAdapter, recovery, socket, startup};
use futures::{SinkExt, StreamExt};
use native_credentials::NativeCredential;
use parking_lot::Mutex;
use reqwest::header::{AUTHORIZATION, HeaderValue};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use tokio::{sync::watch, task::JoinHandle};
use tokio_tungstenite::tungstenite::Message;

const SESSIONS: &str = "https://api.openai.com/v1/live/sessions";
const ATTACH: &str = "wss://api.openai.com/v1/live/sessions";
const CREATION_UNKNOWN: &str = "GPT-Live creation outcome is unknown. Start a new call manually.";

struct Call {
    id: String,
    answer: String,
    attach: tokio_tungstenite::tungstenite::http::Request<()>,
    closed: Arc<AtomicBool>,
}

impl Call {
    async fn create(
        key: &NativeCredential,
        offer: String,
        session: Value,
    ) -> Result<Self, &'static str> {
        let mut authorization = HeaderValue::from_bytes(&key.authorization())
            .map_err(|_| "Invalid voice credential.")?;
        authorization.set_sensitive(true);
        let mut response = api::client()?.post(SESSIONS).header(AUTHORIZATION, authorization)
            .json(&json!({"session":session,"transport":{"type":"webrtc","sdp":offer,"dcid":super::driver::DATA_CHANNEL_ID}}))
            .send().await.map_err(|_| CREATION_UNKNOWN)?;
        if response.status().as_u16() != 201 {
            let status = response.status().as_u16();
            if let Ok(value) = read_json(&mut response).await
                && let Ok(error) =
                    serde_json::from_value::<oai_rt_rs::live::ProviderError>(value["error"].clone())
            {
                voice::live::errors::rejected(&error, false);
            }
            return Err(match status {
                401 | 403 | 404 => {
                    "GPT-Live access was denied. Check the saved key and project model access."
                }
                429 => "GPT-Live quota or rate limit reached.",
                400..=499 => "OpenAI rejected the GPT-Live WebRTC configuration.",
                _ => CREATION_UNKNOWN,
            });
        }
        let value = read_json(&mut response).await?;
        let id = value["session"]["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or(CREATION_UNKNOWN)?;
        let attach = voice::authorized_request(key, &format!("{ATTACH}/{id}/attach"))?;
        let mut call = Self {
            id: id.into(),
            answer: String::new(),
            attach,
            closed: Arc::new(AtomicBool::new(false)),
        };
        call.answer = value["transport"]["sdp"]
            .as_str()
            .filter(|sdp| sdp.starts_with("v=0"))
            .ok_or("GPT-Live returned an invalid SDP answer.")?
            .into();
        Ok(call)
    }
    async fn retire(&self) -> Result<(), &'static str> {
        retire(self.attach.clone(), self.closed.clone()).await
    }
}

async fn read_json(response: &mut reqwest::Response) -> Result<Value, &'static str> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| CREATION_UNKNOWN)? {
        if bytes.len() + chunk.len() > voice::MAX_WIRE {
            return Err(CREATION_UNKNOWN);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| CREATION_UNKNOWN)
}
impl Drop for Call {
    fn drop(&mut self) {
        if !self.closed.load(Ordering::Acquire)
            && let Ok(runtime) = crate::runtime()
        {
            let request = self.attach.clone();
            let closed = self.closed.clone();
            runtime.spawn(async move {
                let _ = retire(request, closed).await;
            });
        }
    }
}

fn valid_id(id: &str) -> bool {
    id.strip_prefix("live_").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.len() <= 128
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
}

async fn retire(
    mut request: tokio_tungstenite::tungstenite::http::Request<()>,
    closed: Arc<AtomicBool>,
) -> Result<(), &'static str> {
    if closed.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    // This is a new connection, not a retry of the original handshake nonce.
    let nonce = tokio_tungstenite::tungstenite::handshake::client::generate_key();
    request.headers_mut().insert(
        tokio_tungstenite::tungstenite::http::header::SEC_WEBSOCKET_KEY,
        HeaderValue::from_str(&nonce).map_err(|_| recovery::CLEANUP_FAILED)?,
    );
    // There is no public Live hangup REST endpoint. If ordinary finalization
    // failed, attach to this known session and close it without replaying work.
    tokio::time::timeout(recovery::HANGUP_TIMEOUT, async {
        let mut socket = voice::connect_request(request)
            .await
            .map_err(|_| recovery::CLEANUP_FAILED)?;
        socket
            .send(Message::Text(
                json!({"type":"session.close"}).to_string().into(),
            ))
            .await
            .map_err(|_| recovery::CLEANUP_FAILED)?;
        while let Some(frame) = socket.next().await {
            let Message::Text(text) = frame.map_err(|_| recovery::CLEANUP_FAILED)? else {
                continue;
            };
            let value: Value = serde_json::from_str(&text).map_err(|_| recovery::CLEANUP_FAILED)?;
            if value["type"] == "session.closed" {
                let _ = socket.close(None).await;
                return Ok(());
            }
        }
        Err(recovery::CLEANUP_FAILED)
    })
    .await
    .map_err(|_| recovery::CLEANUP_FAILED)?
}

pub(in crate::realtime_voice) async fn start(
    owner: Arc<RealtimeVoiceAdapter>,
    key: &NativeCredential,
    session: Value,
) -> Result<(socket::Socket, String), &'static str> {
    let attempt = recovery::Attempt::new(owner.clone());
    let (socket, commands, events) = socket::Socket::relay();
    let identity = Arc::new(Mutex::new(Identity::live()));
    let offered = Instant::now();
    let mut peer = Transport::new().await?;
    owner.view.lock().startup.prepared_client = peer.prepared_client;
    owner.view.lock().startup.offer = Some(startup::elapsed(offered));
    let created = Instant::now();
    // Retain the POST through cancellation so a returned session can be retired.
    let call = Call::create(key, peer.offer(), session).await?;
    owner.view.lock().startup.configuration = Some(startup::elapsed(created));
    if owner.closed.load(Ordering::Acquire) {
        call.retire().await?;
        peer.close().await?;
        return Err(recovery::CANCELLED);
    }
    let (stop, stopped) = watch::channel(false);
    let sideband = spawn_sideband(
        call.attach.clone(),
        commands,
        events,
        stopped.clone(),
        attempt.clone(),
    );
    let negotiated = Instant::now();
    let connected = peer.apply_answer(call.answer.clone()).await;
    if !matches!(connected, Ok(AnswerOutcome::Ready)) || !attempt.current() {
        stop.send_replace(true);
        let _ = call.retire().await;
        let _ = peer.close().await;
        drop(peer);
        let _ = sideband.await;
        return Err("GPT-Live WebRTC negotiation failed.");
    }
    owner.view.lock().startup.negotiation = Some(startup::elapsed(negotiated));
    if let Err(error) = attempt.activate() {
        stop.send_replace(true);
        let _ = call.retire().await;
        let _ = peer.close().await;
        drop(peer);
        let _ = sideband.await;
        return Err(error.message);
    }
    let closed = call.closed.clone();
    let id = call.id.clone();
    let media_owner = owner.clone();
    let media_identity = identity.clone();
    let media = tokio::spawn(async move {
        let mut stopped = stopped;
        let result = media::run(
            &media_owner,
            &mut peer,
            media_identity,
            stopped.clone(),
            &attempt,
        )
        .await;
        if let Err(error) = result {
            attempt.fail(error.into());
        }
        if attempt.collecting_usage() {
            let _ = peer.incoming.set_suppressed(true);
            // Live finalization needs a running primary media clock, not just
            // an open DTLS connection. Hardware capture is already stopped;
            // send only silence until the sideband confirms session.closed.
            let _ = tokio::time::timeout(
                voice::live::CLOSE_TIMEOUT + Duration::from_millis(500),
                async {
                    let mut tick = tokio::time::interval(voice::capture_worker::PACKET_DURATION);
                    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    let mut sending = true;
                    loop {
                        tokio::select! {
                            biased;
                            _ = stopped.changed() => break,
                            _ = tick.tick(), if sending => {
                                sending = peer.audio.send_muted_silence(Instant::now()).await.is_ok();
                            }
                        }
                    }
                },
            )
            .await;
        }
        let retired = call.retire().await;
        let drained = peer.close().await;
        retired.and(drained)
    });
    *owner.media.lock() = Some(Handle {
        identity,
        stop,
        workers: vec![sideband, media],
        live_closed: Some(closed),
    });
    // The POST accepted the immutable Live configuration. Devices may already
    // be running; enable input now without waiting for the sideband snapshot.
    super::media_connected(&owner);
    Ok((socket, id))
}

fn spawn_sideband(
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    mut commands: futures::channel::mpsc::Receiver<Message>,
    mut events: socket::Events,
    mut stop: watch::Receiver<bool>,
    attempt: Arc<recovery::Attempt>,
) -> JoinHandle<Result<(), &'static str>> {
    tokio::spawn(async move {
        let started = Instant::now();
        let connected = tokio::select! { biased; _ = stop.changed() => return Ok(()), result = voice::connect_request(request) => result };
        let result = async {
            let mut socket = connected.map_err(|error| error.message)?;
            attempt.owner.view.lock().startup.websocket = Some(startup::elapsed(started));
            let result: Result<(), &'static str> = loop {
                tokio::select! {
                    biased;
                    _ = stop.changed() => break Ok(()),
                    command = commands.next() => {
                        let Some(command) = command else { break Ok(()); };
                        tokio::time::timeout(voice::IO_TIMEOUT, socket.send(command)).await
                            .map_err(|_| "GPT-Live control upload timed out.")?.map_err(|_| "GPT-Live control connection ended.")?;
                    }
                    event = socket::next_sideband_event(&mut socket) => {
                        let event = event?;
                        let closed = matches!(event, Message::Close(_));
                        tokio::select! {
                            biased;
                            _ = stop.changed() => break Ok(()),
                            result = events.send(Ok(event)) => result.map_err(|_| "GPT-Live control consumer ended.")?,
                        }
                        if closed { break Ok(()); }
                    }
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
            result
        }.await;
        if let Err(error) = result {
            attempt.fail(error.into());
        }
        result
    })
}

#[cfg(test)]
mod tests;
