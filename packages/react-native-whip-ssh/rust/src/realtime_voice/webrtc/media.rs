//! Whip adapters for the provider-neutral native media engine.
use super::super::{RealtimeVoiceAdapter, recovery};
use super::{identity::Identity, transport::Transport};
use parking_lot::Mutex;
use std::{
    sync::{Arc, atomic::Ordering},
    time::Instant,
};
use tokio::sync::watch;
use voice_call_media::{Capture, Host, Playback, Statistics, Tag};

pub(super) fn transport_config() -> voice_call_media::TransportConfig {
    voice_call_media::TransportConfig {
        channel_label: "oai-events".into(),
        channel_id: 4,
        first_event_kind: Some("session.started".into()),
    }
}
impl Capture for RealtimeVoiceAdapter {
    fn packet_samples(&self) -> usize {
        self.input.packet_samples
    }
    fn generation(&self) -> u64 {
        self.input.generation()
    }
    fn accepts(&self, generation: u64) -> bool {
        self.input.accepts(generation)
    }
    fn capture_enabled(&self) -> bool {
        self.allow_input
            && self.ready.load(Ordering::Acquire)
            && !self.closed.load(Ordering::Acquire)
            && !self.view.lock().muted
    }
    fn recover(&self) -> bool {
        self.input.recover()
    }
    fn reset_capture(&self) -> Result<(), &'static str> {
        if let Some(echo) = self.echo.lock().as_mut() {
            echo.reset_capture()?;
        }
        Ok(())
    }
    async fn next_capture(&self, packet: &mut audio_ingress::Packet) -> Result<bool, &'static str> {
        self.next_capture(packet).await
    }
    fn process_capture(&self, packet: &mut audio_ingress::Packet) -> Result<(), &'static str> {
        self.process_capture(packet)
    }
}
struct MediaHost<'a> {
    owner: &'a RealtimeVoiceAdapter,
    identity: Arc<Mutex<Identity>>,
    attempt: &'a recovery::Attempt,
}
impl Capture for MediaHost<'_> {
    fn packet_samples(&self) -> usize {
        self.owner.packet_samples()
    }
    fn generation(&self) -> u64 {
        self.owner.generation()
    }
    fn accepts(&self, generation: u64) -> bool {
        self.owner.accepts(generation)
    }
    fn capture_enabled(&self) -> bool {
        self.owner.capture_enabled()
    }
    fn recover(&self) -> bool {
        self.owner.recover()
    }
    fn reset_capture(&self) -> Result<(), &'static str> {
        self.owner.reset_capture()
    }
    async fn next_capture(&self, packet: &mut audio_ingress::Packet) -> Result<bool, &'static str> {
        self.owner.next_capture(packet).await
    }
    fn process_capture(&self, packet: &mut audio_ingress::Packet) -> Result<(), &'static str> {
        self.owner.process_capture(packet)
    }
}
impl Host for MediaHost<'_> {
    fn current(&self) -> bool {
        self.attempt.current()
    }
    fn playback(&self) -> Playback {
        let state = self.identity.lock();
        Playback {
            epoch: state.epoch,
            enabled: state.enabled,
            tag: state.current.clone(),
            finish_at: state.finish_at,
            failed: state.failed,
        }
    }
    fn render(&self, epoch: u64, tag: &Tag, pcm: &[i16]) -> Result<bool, &'static str> {
        let identity = self.identity.lock();
        if identity.epoch != epoch || !identity.enabled {
            return Ok(false);
        }
        let bytes = pcm.iter().flat_map(|sample| sample.to_le_bytes()).collect();
        self.owner
            .output
            .lock()
            .append(tag.item.clone(), tag.index, bytes)?;
        drop(identity);
        Ok(true)
    }
    fn finish(&self, epoch: u64, now: Instant) -> bool {
        let mut identity = self.identity.lock();
        if !identity.finish(epoch, now) {
            return false;
        }
        if let Some(tag) = &identity.current {
            self.owner
                .output
                .lock()
                .transcript
                .finish_audio(&tag.item, tag.index);
        }
        drop(identity);
        true
    }
    fn statistics(&self, delta: Statistics) {
        let mut view = self.owner.view.lock();
        let media = &mut view.media;
        media.rtp_packets += delta.rtp_packets;
        media.reliable_rtp_packets += delta.reliable_rtp_packets;
        media.rtp_samples += delta.rtp_samples;
        media.decoded_packets += delta.decoded_packets;
        media.decoded_samples += delta.decoded_samples;
        media.decoded_peak = media.decoded_peak.max(delta.decoded_peak);
        media.queued_samples += delta.queued_samples;
        media.concealed_samples += delta.concealed_samples;
        media.late_packets += delta.late_packets;
        media.clock_resyncs += delta.clock_resyncs;
        media.packet_overflows += delta.packet_overflows;
        drop(view);
    }
    fn uploaded(&self) {
        self.owner.view.lock().uploaded_packets += 1;
        super::input_started(self.owner);
    }
}
pub(super) async fn run(
    owner: &RealtimeVoiceAdapter,
    peer: &mut Transport,
    identity: Arc<Mutex<Identity>>,
    stop: watch::Receiver<bool>,
    attempt: &recovery::Attempt,
) -> Result<(), &'static str> {
    voice_call_media::run(
        &MediaHost {
            owner,
            identity,
            attempt,
        },
        peer,
        stop,
    )
    .await
}
