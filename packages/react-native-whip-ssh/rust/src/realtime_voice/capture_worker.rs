//! Bounded capture work, following Codex's capture_worker.rs at 9ff072db8ae43d413c8d205ebf22b54b83c72cef.
//! Retain one processed batch plus a partial packet; return between sends so
//! controls and receive/playback work run before another packet is committed.
use super::{FRAME, RealtimeVoiceAdapter, processing};
use std::{
    collections::VecDeque,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

pub(super) const PACKET_DURATION: Duration = Duration::from_millis(20);
pub(super) const SEND_TIMEOUT: Duration = Duration::from_millis(100);

pub(super) struct Frame {
    pub samples: [i16; FRAME],
    pub generation: u64,
    pub at: Instant,
}
impl Frame {
    pub fn current(&self, owner: &RealtimeVoiceAdapter) -> bool {
        owner.input.accepts(self.generation)
            && owner.ready.load(Ordering::Acquire)
            && !owner.closed.load(Ordering::Acquire)
            && !owner.view.lock().muted
            && self.at.elapsed() <= processing::MAX_DELAY
    }
}

pub(super) struct Pending {
    samples: VecDeque<i16>,
    generation: u64,
    at: Option<Instant>,
    limit: usize,
}
impl Pending {
    pub fn new(owner: &RealtimeVoiceAdapter) -> Self {
        let limit = owner.input.packet_samples + FRAME;
        Self {
            samples: VecDeque::with_capacity(limit),
            generation: owner.input.generation(),
            at: None,
            limit,
        }
    }

    pub fn ready(&self) -> bool {
        self.samples.len() >= FRAME
    }

    pub fn reset(&mut self, owner: &RealtimeVoiceAdapter) -> Result<(), &'static str> {
        self.samples.clear();
        self.at = None;
        self.generation = owner.input.generation();
        if let Some(echo) = owner.echo.lock().as_mut() {
            echo.reset_capture()?;
        }
        Ok(())
    }

    /// Check even while a processed batch is pending: an overloaded native
    /// queue or a rapid mute/unmute transition invalidates that batch too.
    pub fn refresh(&mut self, owner: &RealtimeVoiceAdapter) -> Result<bool, &'static str> {
        let discontinuity = owner.input.recover();
        let changed = self.generation != owner.input.generation();
        let stale = self
            .at
            .is_some_and(|at| at.elapsed() > processing::MAX_DELAY);
        let disabled = !self.samples.is_empty()
            && (!owner.input.accepts(self.generation)
                || !owner.ready.load(Ordering::Acquire)
                || owner.view.lock().muted);
        if discontinuity || changed || stale || disabled {
            self.reset(owner)?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn push(&mut self, packet: &::audio_ingress::Packet) -> Result<(), &'static str> {
        if packet.samples.is_empty() || packet.ticket.generation != self.generation {
            return Ok(());
        }
        if self.ready() || packet.samples.len() > self.limit - self.samples.len() {
            return Err("Realtime pending capture exceeded its bounded batch.");
        }
        if self.samples.is_empty() {
            self.at = Some(packet.at);
        }
        self.samples.extend(&packet.samples);
        Ok(())
    }

    pub fn take(&mut self) -> Option<Frame> {
        if !self.ready() {
            return None;
        }
        let at = self.at?;
        let mut samples = [0; FRAME];
        for (sample, captured) in samples.iter_mut().zip(self.samples.drain(..FRAME)) {
            *sample = captured;
        }
        self.at = (!self.samples.is_empty()).then_some(at + PACKET_DURATION);
        Some(Frame {
            samples,
            generation: self.generation,
            at,
        })
    }
}
