//! Codex's WebRTC call startup: initial configuration in POST, sideband in parallel.
mod api;
mod audio_track;
mod identity;
mod incoming;
mod media;
mod packet;
mod transport;
mod transport_runtime;

use super::{CapturedAudio, ClientEvent, RealtimeSocket, RealtimeVoiceAdapter, socket, startup};
use futures::{SinkExt, StreamExt, channel::mpsc as wire};
use parking_lot::Mutex;
use std::{
    sync::{Arc, atomic::Ordering},
    time::Instant,
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
use tokio_tungstenite::tungstenite::Message;

pub(super) struct Handle {
    pub input: mpsc::Sender<CapturedAudio>,
    identity: Arc<Mutex<identity::Identity>>,
    stop: watch::Sender<bool>,
    workers: Vec<JoinHandle<()>>,
}
impl Handle {
    pub fn cancel_audio(&self, response: Option<&str>) {
        self.identity.lock().cancel_response(response);
    }
    pub fn drained(&self) -> bool {
        self.identity.lock().ended
    }
    pub async fn close(self) {
        self.stop.send_replace(true);
        for task in self.workers {
            let _ = task.await;
        }
    }
}

pub(super) async fn start(
    owner: Arc<RealtimeVoiceAdapter>,
    key: native_credentials::NativeCredential,
    update: ClientEvent,
) -> Result<RealtimeSocket, &'static str> {
    let (socket, commands, events) = socket::Socket::relay();
    let identity = Arc::new(Mutex::new(identity::Identity::default()));
    let offer_started = Instant::now();
    let mut peer = transport::Transport::new(events.clone(), identity.clone()).await?;
    let offer = match peer.offer().await {
        Ok(offer) => offer,
        Err(error) => {
            let _ = peer.close().await;
            return Err(error);
        }
    };
    owner.view.lock().startup.offer = Some(startup::elapsed(offer_started));
    let session =
        serde_json::to_value(update).map_err(|_| "Invalid voice session.")?["session"].take();
    let call_started = Instant::now();
    let call = match api::Call::create(&key, offer, session).await {
        Ok(call) => call,
        Err(error) => {
            let _ = peer.close().await;
            return Err(error);
        }
    };
    owner.view.lock().startup.configuration = Some(startup::elapsed(call_started));
    let (stop, stopped) = watch::channel(false);
    let sideband = spawn_sideband(
        owner.clone(),
        key,
        call.id.clone(),
        commands,
        events,
        stopped.clone(),
    );
    let negotiated = Instant::now();
    let answer = peer.apply_answer(call.answer.clone()).await;
    if !matches!(answer, Ok(transport::AnswerOutcome::Ready)) {
        stop.send_replace(true);
        let _ = sideband.await;
        let _ = peer.close().await;
        drop(peer);
        call.hangup().await;
        return Err("Realtime WebRTC negotiation failed. Check your network.");
    }
    owner.view.lock().startup.negotiation = Some(startup::elapsed(negotiated));
    let (input, capture) = mpsc::channel(32);
    let media_owner = owner.clone();
    let media_identity = identity.clone();
    let media = tokio::spawn(async move {
        let result = media::run(&media_owner, &mut peer, capture, media_identity, stopped).await;
        if let Err(error) = result {
            media_owner.fail(error);
        }
        let _ = peer.close().await;
        drop(peer);
        call.hangup().await;
    });
    *owner.media.lock() = Some(Handle {
        input,
        identity,
        stop,
        workers: vec![sideband, media],
    });
    owner.view.lock().media_ready = true;
    Ok(socket)
}

fn spawn_sideband(
    owner: Arc<RealtimeVoiceAdapter>,
    key: native_credentials::NativeCredential,
    id: String,
    commands: wire::Receiver<Message>,
    events: socket::Events,
    mut stop: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let started = Instant::now();
        let url = format!("wss://api.openai.com/v1/realtime?call_id={id}");
        let result = tokio::select! {
            biased;
            _ = stop.changed() => return,
            result = super::connect_raw(key, &url) => result,
        };
        let result = match result {
            Ok(mut socket) => {
                owner.view.lock().startup.websocket = Some(startup::elapsed(started));
                let result = relay_sideband(&mut socket, commands, events, &mut stop).await;
                let _ = socket.close(None).await;
                result
            }
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            owner.fail(error);
        }
    })
}

async fn relay_sideband(
    socket: &mut socket::RawSocket,
    mut commands: wire::Receiver<Message>,
    mut events: socket::Events,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), &'static str> {
    loop {
        tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            command = commands.next() => {
                let Some(command) = command else { return Ok(()); };
                tokio::time::timeout(super::IO_TIMEOUT, socket.send(command)).await.map_err(|_| "Realtime sideband write timed out.")?.map_err(|_| "Realtime sideband disconnected.")?;
            }
            event = socket.next() => {
                let Some(event) = event else { return Err("Realtime sideband ended."); };
                events.send(event).await.map_err(|_| "Realtime event consumer ended.")?;
            }
        }
    }
}

pub(super) fn devices_started(owner: &RealtimeVoiceAdapter) {
    if !owner.webrtc || !owner.view.lock().media_ready || owner.closed.load(Ordering::Acquire) {
        return;
    }
    owner.ready.store(true, Ordering::Release);
    let mut view = owner.view.lock();
    view.phase = "listening";
    view.startup.listening.get_or_insert_with(|| {
        owner
            .client_elapsed_ms
            .saturating_add(startup::elapsed(owner.started_at))
    });
}
