//! Whip call ownership and native device readiness over voice-call-openai.
use super::startup;
#[cfg(test)]
mod api;
mod host;
#[cfg(test)]
mod identity;
pub(super) mod live;
#[cfg(test)]
mod media;
pub(in crate::realtime_voice) mod prepared;
#[cfg(test)]
mod transport;
use super::{ClientEvent, RealtimeSocket, RealtimeVoiceAdapter, recovery};
use std::sync::{Arc, atomic::Ordering};
pub(super) use voice_call_openai::Handle;

pub(super) async fn start(
    owner: Arc<RealtimeVoiceAdapter>,
    key: &native_credentials::NativeCredential,
    update: ClientEvent,
    config: &super::Config,
    attempt: Arc<recovery::Attempt>,
) -> Result<RealtimeSocket, recovery::Failure> {
    let host = Arc::new(host::AppHost {
        owner: owner.clone(),
        attempt,
    });
    let (socket, handle) =
        voice_call_openai::connect_realtime(host, key, update, &config.model()?.id).await?;
    *owner.media.lock() = Some(handle);
    media_connected(&owner);
    Ok(socket)
}
pub(super) use live::start as start_live;
#[cfg(test)]
fn initial_session(
    update: ClientEvent,
    model: &super::models::Model,
) -> Result<serde_json::Value, &'static str> {
    voice_call_openai::initial_session(update, &model.id)
}
/// Devices and negotiation finish independently. Either completion order must
/// activate input, without retaining microphone audio from session startup.
pub(super) fn media_connected(owner: &RealtimeVoiceAdapter) {
    {
        let mut view = owner.view.lock();
        if owner.closed.load(Ordering::Acquire) {
            return;
        }
        view.media_ready = true;
    }
    if owner.devices_ready.load(Ordering::Acquire) {
        devices_started(owner);
    }
}

pub(super) fn devices_started(owner: &RealtimeVoiceAdapter) {
    owner.devices_ready.store(true, Ordering::Release);
    let mut view = owner.view.lock();
    if !owner.webrtc
        || !view.media_ready
        || owner.closed.load(Ordering::Acquire)
        || owner.live && view.startup.settings_confirmed.is_none()
    {
        return;
    }
    owner.ready.store(true, Ordering::Release);
    view.recovery = recovery::State::Active;
    if owner.allow_input && !view.muted && view.startup.first_input.is_none() {
        // Accept capture now; advertise listening after its first encoded
        // packet has reached the media sender, rather than at device open.
        if view.phase != "reconnecting" {
            view.phase = "starting";
        }
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
    if matches!(view.phase, "starting" | "reconnecting")
        && view.media_ready
        && !view.muted
        && (!owner.live || view.startup.settings_confirmed.is_some())
    {
        view.phase = "listening";
    }
}
