//! Provider audio identity over the provider-neutral native media engine.
use super::identity::Identity;
use crate::Host;
use parking_lot::Mutex;
use std::sync::Arc;
use tokio::sync::watch;
use voice_call_media::Transport;
use voice_call_media::{Capture, Playback, Statistics, Tag};

pub fn transport_config() -> voice_call_media::TransportConfig {
    voice_call_media::TransportConfig {
        channel_label: "oai-events".into(),
        channel_id: crate::DATA_CHANNEL_ID,
        first_event_kind: Some("session.started".into()),
    }
}
struct MediaHost<'a, H> {
    owner: &'a H,
    identity: Arc<Mutex<Identity>>,
}
impl<H: Host> Capture for MediaHost<'_, H> {
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
impl<H: Host> voice_call_media::Host for MediaHost<'_, H> {
    fn current(&self) -> bool {
        self.owner.current()
    }
    fn playback(&self) -> Playback {
        let state = self.identity.lock();
        Playback {
            epoch: state.epoch,
            enabled: state.enabled,
            tag: state.current.clone(),
            stopped_at: state.stopped_at,
            failed: state.failed,
        }
    }
    fn render(&self, epoch: u64, tag: &Tag, pcm: &[i16]) -> Result<bool, &'static str> {
        let identity = self.identity.lock();
        if !self.owner.current() || identity.epoch != epoch || !identity.enabled {
            return Ok(false);
        }
        self.owner.render(tag, pcm)?;
        drop(identity);
        Ok(true)
    }
    fn finish(&self, playback: &Playback) -> bool {
        let mut identity = self.identity.lock();
        if !self.owner.current() || !identity.finish(playback) {
            return false;
        }
        if let Some(tag) = &identity.current {
            self.owner.finish_audio(tag);
        }
        true
    }
    fn statistics(&self, delta: Statistics) {
        self.owner.statistics(delta);
    }
    fn uploaded(&self) {
        self.owner.uploaded();
    }
}
pub async fn run(
    owner: &impl Host,
    peer: &mut Transport,
    identity: Arc<Mutex<Identity>>,
    stop: watch::Receiver<bool>,
) -> Result<(), &'static str> {
    voice_call_media::run(&MediaHost { owner, identity }, peer, stop).await
}
