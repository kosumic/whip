//! Native devices, app state and call-attempt policy stay owned by Whip.
use super::super::{RealtimeVoiceAdapter, recovery};
use std::sync::{Arc, atomic::Ordering};
use voice_call_media::{Capture, Statistics, Tag};
use voice_call_openai::{Host, Timing};
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
            && !self
                .microphone
                .lock()
                .blocks_capture(std::time::Instant::now())
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

pub(super) struct AppHost {
    pub owner: Arc<RealtimeVoiceAdapter>,
    pub attempt: Arc<recovery::Attempt>,
}
impl Capture for AppHost {
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
        self.attempt.current() && self.owner.capture_enabled()
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
impl Host for AppHost {
    fn current(&self) -> bool {
        self.attempt.current()
    }
    fn collecting_usage(&self) -> bool {
        self.attempt.collecting_usage()
    }
    fn activate(&self) -> Result<(), recovery::Failure> {
        self.attempt.activate()
    }
    fn failure(&self) -> Option<recovery::Failure> {
        *self.attempt.errors.borrow()
    }
    fn fail(&self, error: recovery::Failure) {
        self.attempt.fail(error);
    }
    fn retiring(&self) {
        self.owner.view.lock().recovery = recovery::State::Retiring;
    }
    fn timing(&self, timing: Timing) {
        if !self.attempt.current() {
            return;
        }
        if matches!(timing, Timing::Accepted) {
            self.owner.continuity.lock().created(None);
            return;
        }
        let mut view = self.owner.view.lock();
        match timing {
            Timing::Accepted => {}
            Timing::Prepared(value) => view.startup.prepared_client = value,
            Timing::Offer(ms) => view.startup.offer = Some(ms),
            Timing::Configuration(ms) => view.startup.configuration = Some(ms),
            Timing::Negotiation(ms) => view.startup.negotiation = Some(ms),
            Timing::Sideband(ms) => view.startup.websocket = Some(ms),
        }
        drop(view);
    }
    fn render(&self, tag: &Tag, pcm: &[i16]) -> Result<(), &'static str> {
        let bytes = pcm.iter().flat_map(|sample| sample.to_le_bytes()).collect();
        let mut output = self.owner.output.lock();
        if !self.attempt.current() {
            return Ok(());
        }
        let result = output.append(tag.item.clone(), tag.index, bytes);
        drop(output);
        result
    }
    fn finish_audio(&self, tag: &Tag) {
        if !self.attempt.current() {
            return;
        }
        self.owner
            .output
            .lock()
            .transcript
            .finish_audio(&tag.item, tag.index);
    }
    fn statistics(&self, delta: Statistics) {
        if !self.attempt.current() {
            return;
        }
        let mut view = self.owner.view.lock();
        let media = &mut view.media;
        if let Some(network) = delta.network {
            media.network = network;
        }
        media.ingress += delta.ingress;
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
        if !self.attempt.current() {
            return;
        }
        self.owner.view.lock().uploaded_packets += 1;
        super::input_started(&self.owner);
    }
}
