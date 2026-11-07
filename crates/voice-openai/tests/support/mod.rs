//! A second app's mock native-audio and credential adapters.
#![allow(
    dead_code,
    reason = "Shared fixtures support independent test binaries and examples."
)]
use audio_ingress::{Format, Ingress, Limits, Packet, Ticket};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::Notify;
use voice_call_media::{Capture, FRAME, RATE, Statistics, Tag};
use voice_openai::{
    Credential, Host, Timing,
    recovery::{CANCELLED, Failure},
};

#[derive(Default)]
pub struct MockCredential(pub AtomicU64);
impl Credential for MockCredential {
    fn authorization(&self) -> zeroize::Zeroizing<Vec<u8>> {
        self.0.fetch_add(1, Ordering::Relaxed);
        zeroize::Zeroizing::new(b"Bearer mock-credential".to_vec())
    }
}
pub struct App {
    pub current: AtomicBool,
    pub input: Ingress,
    wake: Notify,
    active: AtomicBool,
    failure: Mutex<Option<Failure>>,
    rendered: Mutex<Vec<i16>>,
}
impl App {
    pub fn rendered(&self) -> Vec<i16> {
        self.rendered.lock().clone()
    }
    pub fn feed(&self, sequence: u64, samples: &[i16]) -> Result<(), &'static str> {
        self.input
            .push(
                self.input.ticket(),
                Format {
                    sample_rate: RATE as u32,
                    channels: 1,
                },
                sequence,
                std::time::Instant::now(),
                samples,
            )
            .map_err(|_| "Mock capture rejected")?;
        self.wake.notify_one();
        Ok(())
    }
    pub fn new(current: bool) -> Result<Self, &'static str> {
        Ok(Self {
            current: AtomicBool::new(current),
            input: Ingress::new(
                Format {
                    sample_rate: RATE as u32,
                    channels: 1,
                },
                Limits {
                    packets: 4,
                    samples_per_packet: FRAME * 4,
                    max_age: Duration::from_millis(500),
                },
            )
            .map_err(|_| "Invalid mock PCM")?,
            wake: Notify::new(),
            active: AtomicBool::new(false),
            failure: Mutex::new(None),
            rendered: Mutex::new(Vec::new()),
        })
    }
}
impl voice_openai::session::Audio for App {
    fn is_muted(&self) -> bool {
        !self.input.accepts(self.input.ticket())
    }
    fn current(&self) -> bool {
        self.current.load(Ordering::Acquire)
    }
    fn set_muted(&self, muted: bool) -> Result<(), &'static str> {
        self.input.set_muted(muted);
        Ok(())
    }
    fn interrupt(&self) -> Option<voice_openai::ClientEvent> {
        None
    }
    fn render_pcm(&self, _: String, _: u32, pcm: Vec<u8>) -> Result<(), &'static str> {
        if !pcm.len().is_multiple_of(2) {
            return Err("Invalid mock PCM");
        }
        let samples: Vec<_> = pcm
            .as_chunks::<2>()
            .0
            .iter()
            .map(|bytes| i16::from_le_bytes(*bytes))
            .collect();
        voice_openai::Host::render(
            self,
            &Tag {
                response: String::new(),
                item: String::new(),
                index: 0,
            },
            &samples,
        )
    }
    fn cancel_audio(&self, _: Option<&str>) {}
    fn resume_live_audio(&self) {}
    fn confirm_live_closed(&self) {}
    fn uploaded(&self) {}
}
impl Capture for App {
    fn packet_samples(&self) -> usize {
        FRAME * 4
    }
    fn generation(&self) -> u64 {
        self.input.ticket().generation
    }
    fn accepts(&self, generation: u64) -> bool {
        self.input.accepts(Ticket {
            generation,
            ..self.input.ticket()
        })
    }
    fn capture_enabled(&self) -> bool {
        self.current.load(Ordering::Acquire) && self.accepts(self.generation())
    }
    fn recover(&self) -> bool {
        false
    }
    fn reset_capture(&self) -> Result<(), &'static str> {
        Ok(())
    }
    async fn next_capture(&self, packet: &mut Packet) -> Result<bool, &'static str> {
        loop {
            let wake = self.wake.notified();
            if self
                .input
                .pop_into(packet)
                .map_err(|_| "Mock microphone closed")?
            {
                return Ok(false);
            }
            wake.await;
        }
    }
    fn process_capture(&self, _: &mut Packet) -> Result<(), &'static str> {
        Ok(())
    }
}
impl Host for App {
    fn current(&self) -> bool {
        self.current.load(Ordering::Acquire)
    }
    fn collecting_usage(&self) -> bool {
        self.active.load(Ordering::Acquire) && !Host::current(self)
    }
    fn activate(&self) -> Result<(), Failure> {
        if !Host::current(self) {
            return Err(CANCELLED.into());
        }
        self.active.store(true, Ordering::Release);
        Ok(())
    }
    fn failure(&self) -> Option<Failure> {
        *self.failure.lock()
    }
    fn fail(&self, failure: Failure) {
        *self.failure.lock() = Some(failure);
    }
    fn retiring(&self) {
        self.active.store(false, Ordering::Release);
    }
    fn timing(&self, _: Timing) {}
    fn render(&self, _: &Tag, pcm: &[i16]) -> Result<(), &'static str> {
        let mut rendered = self.rendered.lock();
        if rendered.len() + pcm.len() > RATE / 2 {
            return Err("Mock playback backpressure");
        }
        rendered.extend_from_slice(pcm);
        Ok(())
    }
    fn finish_audio(&self, _: &Tag) {}
    fn statistics(&self, _: Statistics) {}
    fn uploaded(&self) {}
}
