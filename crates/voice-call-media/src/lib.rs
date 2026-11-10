//! Native media on the caller's Tokio runtime. Signaling, credentials and device
//! ownership belong to the host. Capture generations invalidate pending PCM;
//! playback epochs invalidate retained RTP without opening another recorder.
pub mod activity;
pub mod audio_track;
pub mod capture_worker;
mod driver;
pub mod echo;
pub mod health;
pub mod incoming;
mod jitter;
mod media;
mod network;
mod packet;
mod playout;
pub mod prepared;
pub mod processing;
pub mod transport;

pub use media::run;
use std::{future::Future, time::Instant};
pub use transport::{AnswerOutcome, Transport};

pub const RATE: usize = 24_000;
pub const FRAME: usize = RATE / 50;
pub const MAX_SDP_BYTES: usize = 512 * 1024;

/// The host chooses the data channel and optional first control event to retain.
/// Remaining mirrored messages are discarded so they cannot backpressure RTP.
#[derive(Clone)]
pub struct TransportConfig {
    pub channel_label: String,
    pub channel_id: u16,
    pub first_event_kind: Option<String>,
}
impl Default for TransportConfig {
    fn default() -> Self {
        Self {
            channel_label: "events".into(),
            channel_id: 4,
            first_event_kind: None,
        }
    }
}
fn event_is(text: &str, expected: &str) -> bool {
    #[derive(serde::Deserialize)]
    struct Kind<'a> {
        #[serde(borrow, rename = "type")]
        kind: &'a str,
    }
    serde_json::from_str::<Kind<'_>>(text).is_ok_and(|event| event.kind == expected)
}

/// Device/ingress adapter. `next_capture` must be cancellation safe. Recover,
/// generation and accepts must refer to the same bounded audio-ingress queue.
/// Implementations must not hold a lock across an await or call through JS.
pub trait Capture: Sync {
    fn packet_samples(&self) -> usize;
    fn generation(&self) -> u64;
    fn accepts(&self, generation: u64) -> bool;
    fn capture_enabled(&self) -> bool;
    fn recover(&self) -> bool;
    fn reset_capture(&self) -> Result<(), &'static str>;
    fn next_capture(
        &self,
        packet: &mut audio_ingress::Packet,
    ) -> impl Future<Output = Result<bool, &'static str>> + Send;
    fn process_capture(&self, packet: &mut audio_ingress::Packet) -> Result<(), &'static str>;
}

/// Opaque host identifiers attached to continuous playout, not wire events.
#[derive(Clone, PartialEq)]
pub struct Tag {
    pub response: String,
    pub item: String,
    pub index: u32,
}
#[derive(Clone, Default)]
pub struct Playback {
    pub epoch: u64,
    pub enabled: bool,
    pub tag: Option<Tag>,
    /// A normal server stop requests bounded tail admission followed by drain.
    /// It is not a deadline for discarding accepted audio.
    pub stopped_at: Option<Instant>,
    pub failed: bool,
}
#[derive(Default)]
pub struct Statistics {
    pub network: Option<health::Statistics>,
    pub ingress: incoming::Statistics,
    pub rtp_packets: u64,
    pub reliable_rtp_packets: u64,
    pub rtp_samples: u64,
    pub decoded_packets: u64,
    pub decoded_samples: u64,
    pub decoded_peak: u16,
    pub queued_samples: u64,
    pub concealed_samples: u64,
    pub late_packets: u64,
    pub clock_resyncs: u64,
    pub packet_overflows: u64,
}
/// Provider/host policy stays outside the media loop. All callbacks are bounded
/// synchronous work except receiving native capture. `render` rechecks epoch
/// under the same control lock used for cancellation before committing samples.
pub trait Host: Capture {
    fn current(&self) -> bool;
    fn playback(&self) -> Playback;
    fn render(&self, epoch: u64, tag: &Tag, pcm: &[i16]) -> Result<bool, &'static str>;
    /// Source-clock position of decoded RTP, independent of queued PCM length.
    /// Concealment continues the preceding clock without a packet timestamp.
    fn render_timed(
        &self,
        epoch: u64,
        tag: &Tag,
        pcm: &[i16],
        _rtp_timestamp: Option<u32>,
    ) -> Result<bool, &'static str> {
        self.render(epoch, tag, pcm)
    }
    /// Commit a drained snapshot only if its epoch, tag and stop still match.
    fn finish(&self, playback: &Playback) -> bool;
    fn statistics(&self, delta: Statistics);
    fn uploaded(&self);
}

impl<C: Capture + Send> Capture for std::sync::Arc<C> {
    fn packet_samples(&self) -> usize {
        (**self).packet_samples()
    }
    fn generation(&self) -> u64 {
        (**self).generation()
    }
    fn accepts(&self, generation: u64) -> bool {
        (**self).accepts(generation)
    }
    fn capture_enabled(&self) -> bool {
        (**self).capture_enabled()
    }
    fn recover(&self) -> bool {
        (**self).recover()
    }
    fn reset_capture(&self) -> Result<(), &'static str> {
        (**self).reset_capture()
    }
    async fn next_capture(&self, packet: &mut audio_ingress::Packet) -> Result<bool, &'static str> {
        (**self).next_capture(packet).await
    }
    fn process_capture(&self, packet: &mut audio_ingress::Packet) -> Result<(), &'static str> {
        (**self).process_capture(packet)
    }
}
