//! Codex's WebRTC call startup: initial configuration in POST, sideband in parallel.
mod api;
mod audio_track;
mod driver;
mod identity;
mod incoming;
mod jitter;
mod media;
mod network;
mod packet;
mod transport;

use super::{ClientEvent, RealtimeSocket, RealtimeVoiceAdapter, recovery, socket, startup};
use futures::{SinkExt, StreamExt, channel::mpsc as wire};
use parking_lot::Mutex;
use std::{
    sync::{Arc, atomic::Ordering},
    time::Instant,
};
use tokio::{sync::watch, task::JoinHandle};
use tokio_tungstenite::tungstenite::Message;

pub(super) struct Handle {
    identity: Arc<Mutex<identity::Identity>>,
    stop: watch::Sender<bool>,
    workers: Vec<JoinHandle<Result<(), &'static str>>>,
}
impl Handle {
    pub fn cancel_audio(&self, response: Option<&str>) {
        self.identity.lock().cancel_response(response);
    }
    pub fn drained(&self) -> bool {
        self.identity.lock().ended
    }
    pub async fn close(self) -> Result<(), &'static str> {
        self.stop.send_replace(true);
        let mut clean = true;
        for mut task in self.workers {
            match tokio::time::timeout(recovery::WORKER_DRAIN_TIMEOUT, &mut task).await {
                Ok(Ok(Ok(()))) => {}
                Ok(_) => clean = false,
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    clean = false;
                }
            }
        }
        if clean {
            Ok(())
        } else {
            Err(recovery::CLEANUP_FAILED)
        }
    }
}

async fn retire(
    owner: &RealtimeVoiceAdapter,
    stop: &watch::Sender<bool>,
    mut sideband: JoinHandle<Result<(), &'static str>>,
    peer: &mut transport::Transport,
    call: &api::Call,
    message: &'static str,
    retryable: bool,
) -> recovery::Failure {
    owner.view.lock().recovery = recovery::State::Retiring;
    stop.send_replace(true);
    // A normal sideband read failure is why we may be retiring. A panicked or
    // timed-out worker cannot establish that retirement finished.
    let worker_clean =
        match tokio::time::timeout(std::time::Duration::from_secs(3), &mut sideband).await {
            Ok(Ok(Err(recovery::CLEANUP_FAILED))) => false,
            Ok(result) => result.is_ok(),
            Err(_) => {
                sideband.abort();
                let _ = sideband.await;
                false
            }
        };
    // Ask the server to retire the call while its media transport still exists.
    let call_clean = call.hangup().await.is_ok();
    let peer_clean = peer.close().await.is_ok();
    if worker_clean && peer_clean && call_clean {
        recovery::Failure { message, retryable }
    } else {
        recovery::CLEANUP_FAILED.into()
    }
}

#[expect(
    clippy::significant_drop_tightening,
    reason = "The live peer is transferred to the media worker and must remain open through confirmation."
)]
pub(super) async fn start(
    owner: Arc<RealtimeVoiceAdapter>,
    key: &native_credentials::NativeCredential,
    update: ClientEvent,
    config: &super::Config,
    attempt: Arc<recovery::Attempt>,
) -> Result<RealtimeSocket, recovery::Failure> {
    let (socket, commands, events) = socket::Socket::relay();
    let identity = Arc::new(Mutex::new(identity::Identity::default()));
    let offer_started = Instant::now();
    let mut peer = transport::Transport::new(events.clone(), identity.clone()).await?;
    if !attempt.current() {
        let _ = peer.close().await;
        return Err(recovery::CANCELLED.into());
    }
    let offer = peer.offer();
    owner.view.lock().startup.offer = Some(startup::elapsed(offer_started));
    let session = initial_session(update, config.model()?)?;
    let confirmation = confirmation(&session)?;
    let call_started = Instant::now();
    // Do not race/drop this future on cancellation: the response may carry the
    // only identity with which an already-created server call can be retired.
    let call = match api::Call::create(key, offer, session).await {
        Ok(call) => call,
        Err(error) => {
            let _ = peer.close().await;
            return Err(error.into());
        }
    };
    if !attempt.current() {
        let _ = call.hangup().await;
        let _ = peer.close().await;
        return Err(recovery::CANCELLED.into());
    }
    owner.view.lock().startup.configuration = Some(startup::elapsed(call_started));
    let (stop, stopped) = watch::channel(false);
    let request = super::authorized_request(
        key,
        &format!("wss://api.openai.com/v1/realtime?call_id={}", call.id),
    )?;
    let sideband = spawn_sideband(
        request,
        commands,
        events,
        stopped.clone(),
        confirmation,
        identity.clone(),
        attempt.clone(),
    );
    let negotiated = Instant::now();
    let answer = peer.apply_answer(call.answer.clone()).await;
    if !matches!(answer, Ok(transport::AnswerOutcome::Ready)) || !attempt.current() {
        let retryable = matches!(answer, Ok(transport::AnswerOutcome::TimedOut))
            && attempt.current()
            && attempt.errors.borrow().is_none_or(|error| error.retryable);
        return Err(retire(
            &owner,
            &stop,
            sideband,
            &mut peer,
            &call,
            "Realtime WebRTC negotiation failed. Check your network.",
            retryable,
        )
        .await);
    }
    owner.view.lock().startup.negotiation = Some(startup::elapsed(negotiated));
    // The call POST already accepted the complete session configuration.
    // Match Codex: start media after negotiation while the sideband connects
    // independently. Its effective settings are still validated by run().
    if let Err(error) = attempt.activate() {
        return Err(retire(
            &owner,
            &stop,
            sideband,
            &mut peer,
            &call,
            error.message,
            false,
        )
        .await);
    }
    let media_owner = owner.clone();
    let media_identity = identity.clone();
    let media = tokio::spawn(async move {
        let result = media::run(&media_owner, &mut peer, media_identity, stopped, &attempt).await;
        if let Err(error) = result {
            attempt.fail(error.into());
        }
        let call_clean = call.hangup().await.is_ok();
        let peer_clean = peer.close().await.is_ok();
        drop(peer);
        if peer_clean && call_clean {
            Ok(())
        } else {
            Err(recovery::CLEANUP_FAILED)
        }
    });
    *owner.media.lock() = Some(Handle {
        identity,
        stop,
        workers: vec![sideband, media],
    });
    {
        let mut view = owner.view.lock();
        if !owner.closed.load(Ordering::Acquire) {
            view.media_ready = true;
        }
    }
    if owner.devices_ready.load(Ordering::Acquire) {
        devices_started(&owner);
    }
    Ok(socket)
}

fn confirmation(session: &serde_json::Value) -> Result<ClientEvent, &'static str> {
    // Initial instructions/context/tools already went with the SDP request.
    // Reconfirm audio without reprocessing that context on the critical path.
    super::typed(serde_json::json!({"type":"session.update","session":{
        "type":"realtime", "audio":session["audio"].clone()
    }}))
}

// Models are immutable after creation. Only the call POST includes this field;
// WebSocket sessions select it in the connection URL, never in session.update.
fn initial_session(
    update: ClientEvent,
    model: &super::models::Model,
) -> Result<serde_json::Value, &'static str> {
    let mut session =
        serde_json::to_value(update).map_err(|_| "Invalid voice session.")?["session"].take();
    session["model"] = serde_json::Value::String(model.id.clone());
    Ok(session)
}

fn spawn_sideband(
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    commands: wire::Receiver<Message>,
    events: socket::Events,
    mut stop: watch::Receiver<bool>,
    update: ClientEvent,
    identity: Arc<Mutex<identity::Identity>>,
    attempt: Arc<recovery::Attempt>,
) -> JoinHandle<Result<(), &'static str>> {
    tokio::spawn(async move {
        let started = Instant::now();
        let result = tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            result = super::connect_request(request) => result,
        };
        let result = match result {
            Ok(mut socket) => {
                let result = if attempt.current() {
                    attempt.owner.view.lock().startup.websocket = Some(startup::elapsed(started));
                    match super::send(&mut socket, update).await {
                        Ok(()) => {
                            relay_sideband(&mut socket, commands, events, &mut stop, identity).await
                        }
                        Err(message) => Err(recovery::Failure {
                            message,
                            retryable: true,
                        }),
                    }
                } else {
                    Ok(())
                };
                let closed =
                    tokio::time::timeout(std::time::Duration::from_secs(2), socket.close(None))
                        .await;
                if !matches!(
                    closed,
                    Ok(Ok(())
                        | Err(tokio_tungstenite::tungstenite::Error::ConnectionClosed
                            | tokio_tungstenite::tungstenite::Error::AlreadyClosed))
                ) {
                    attempt.fail(recovery::CLEANUP_FAILED.into());
                    return Err(recovery::CLEANUP_FAILED);
                }
                result
            }
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            attempt.fail(error);
        }
        result.map_err(|error| error.message)
    })
}

async fn relay_sideband(
    socket: &mut socket::RawSocket,
    mut commands: wire::Receiver<Message>,
    mut events: socket::Events,
    stop: &mut watch::Receiver<bool>,
    identity: Arc<Mutex<identity::Identity>>,
) -> Result<(), recovery::Failure> {
    loop {
        tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            command = commands.next() => {
                let Some(command) = command else { return Ok(()); };
                tokio::time::timeout(super::IO_TIMEOUT, socket.send(command)).await
                    .map_err(|_| recovery::Failure { message: "Realtime sideband write timed out.", retryable: true })?
                    .map_err(|_| recovery::Failure { message: "Realtime sideband disconnected.", retryable: true })?;
            }
            event = socket.next() => {
                let Some(event) = event else { return Err(recovery::Failure { message: "Realtime sideband ended.", retryable: true }); };
                if let Ok(Message::Text(text)) = &event {
                    let value = serde_json::from_str(text).map_err(|_| "Invalid Realtime event.")?;
                    identity.lock().observe(&value);
                }
                events.send(event).await.map_err(|_| "Realtime event consumer ended.")?;
            }
        }
    }
}

pub(super) fn devices_started(owner: &RealtimeVoiceAdapter) {
    owner.devices_ready.store(true, Ordering::Release);
    let mut view = owner.view.lock();
    if !owner.webrtc || !view.media_ready || owner.closed.load(Ordering::Acquire) {
        return;
    }
    owner.ready.store(true, Ordering::Release);
    view.recovery = recovery::State::Active;
    if owner.allow_input && !view.muted && view.startup.first_input.is_none() {
        // Accept capture now; advertise listening after its first encoded
        // packet has reached the media sender, rather than at device open.
        view.phase = "starting";
        return;
    }
    view.phase = if view.muted { "muted" } else { "listening" };
    view.startup.listening.get_or_insert_with(|| {
        owner
            .client_elapsed_ms
            .saturating_add(startup::elapsed(owner.started_at))
    });
}

pub(super) fn input_started(owner: &RealtimeVoiceAdapter) {
    let elapsed = owner
        .client_elapsed_ms
        .saturating_add(startup::elapsed(owner.started_at));
    let mut view = owner.view.lock();
    view.startup.first_input.get_or_insert(elapsed);
    view.startup.listening.get_or_insert(elapsed);
}

#[cfg(test)]
mod tests {
    use super::confirmation;
    use serde_json::json;

    #[test]
    fn audio_confirmation_preserves_settings_without_resending_prompt_or_tools()
    -> Result<(), Box<dyn std::error::Error>> {
        let session = json!({"type":"realtime","instructions":"already supplied context","tools":[{"type":"function","name":"bound_agent"}],
            "audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"transcription":{"model":"gpt-4o-mini-transcribe"}},"output":{"format":{"type":"audio/pcm","rate":24000},"voice":"cedar"}}});
        let event = serde_json::to_value(confirmation(&session)?)?;
        assert_eq!(event["type"], "session.update");
        assert_eq!(event["session"]["audio"], session["audio"]);
        let settings = event["session"].as_object().ok_or("missing session")?;
        assert!(!settings.contains_key("instructions"));
        assert!(!settings.contains_key("tools"));
        Ok(())
    }
}
