// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
// Adapted from Codex's bounded RTP ingress; crypto and depacketization are owned by str0m.
//! Nonblocking admission with shared packet/byte/audio leases through decode.
use parking_lot::Mutex;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

// The three independent limits cover tiny frames, large payloads, and playable
// backlog. These are retention limits across ingress AND jitter, not per queue.
pub(super) const PACKETS: usize = 1024;
const BYTES: usize = 2 * 1024 * 1024;
const PACKET_BYTES: usize = 64 * 1024;
const AUDIO_SAMPLES: usize = crate::RATE * 8;
const UDP_MAX_AGE: Duration = Duration::from_secs(1);
const OVERLOAD: &str = "Reliable incoming audio exceeded its bounded backlog.";

/// Admission diagnostics, separate from jitter loss and intentional retirement.
/// Counts are deltas when returned by `Incoming::take_statistics`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Statistics {
    pub accepted_packets: u64,
    pub packet_limit_drops: u64,
    pub byte_limit_drops: u64,
    pub audio_limit_drops: u64,
    pub stale_packets: u64,
    pub suppressed_packets: u64,
    pub retired_packets: u64,
    pub invalid_packets: u64,
    pub closed_packets: u64,
    pub reliable_failures: u64,
    pub failed_packets: u64,
}
impl std::ops::AddAssign for Statistics {
    fn add_assign(&mut self, delta: Self) {
        self.accepted_packets += delta.accepted_packets;
        self.packet_limit_drops += delta.packet_limit_drops;
        self.byte_limit_drops += delta.byte_limit_drops;
        self.audio_limit_drops += delta.audio_limit_drops;
        self.stale_packets += delta.stale_packets;
        self.suppressed_packets += delta.suppressed_packets;
        self.retired_packets += delta.retired_packets;
        self.invalid_packets += delta.invalid_packets;
        self.closed_packets += delta.closed_packets;
        self.reliable_failures += delta.reliable_failures;
        self.failed_packets += delta.failed_packets;
    }
}
struct Admission {
    epoch: u64,
    failure: Option<&'static str>,
    statistics: Statistics,
}
struct State {
    // Seal and enqueue are synchronous under this lock. No await or pressure
    // wait may hold it, or run on the shared RTC driver.
    admission: Mutex<Admission>,
    packets: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
    audio: Arc<Semaphore>,
}
pub struct ReceivedRtp {
    data: Vec<u8>,
    pub at: Instant,
    pub reliable: bool,
    epoch: u64,
    _packet: OwnedSemaphorePermit,
    _bytes: OwnedSemaphorePermit,
    _audio: OwnedSemaphorePermit,
}
impl AsRef<[u8]> for ReceivedRtp {
    fn as_ref(&self) -> &[u8] {
        &self.data
    }
}
pub struct Incoming {
    state: Arc<State>,
    receiver: mpsc::Receiver<ReceivedRtp>,
}
pub(super) struct Ingress {
    state: Arc<State>,
    sender: mpsc::Sender<ReceivedRtp>,
    stream: Option<str0m::rtp::Ssrc>,
}
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Outcome {
    Accepted,
    Suppressed,
    Dropped,
    Failed,
}
impl Incoming {
    pub(super) fn new() -> (Self, Ingress) {
        let state = Arc::new(State {
            admission: Mutex::new(Admission {
                epoch: 1,
                failure: None,
                statistics: Statistics::default(),
            }),
            packets: Arc::new(Semaphore::new(PACKETS)),
            bytes: Arc::new(Semaphore::new(BYTES)),
            audio: Arc::new(Semaphore::new(AUDIO_SAMPLES)),
        });
        let (sender, receiver) = mpsc::channel(PACKETS);
        (
            Self {
                state: state.clone(),
                receiver,
            },
            Ingress {
                state,
                sender,
                stream: None,
            },
        )
    }
    pub fn set_suppressed(&self, suppressed: bool) -> Result<(), &'static str> {
        self.suppress(suppressed).map(|_| ())
    }
    fn suppress(&self, suppressed: bool) -> Result<u64, &'static str> {
        let mut admission = self.state.admission.lock();
        let previous = admission.epoch;
        if (previous % 2 == 1) != suppressed {
            admission.epoch = previous.checked_add(1).ok_or("audio epoch exhausted")?;
        }
        Ok(previous)
    }
    pub fn take_statistics(&self) -> Statistics {
        std::mem::take(&mut self.state.admission.lock().statistics)
    }
    pub fn take(&mut self) -> Result<Option<ReceivedRtp>, &'static str> {
        let epoch = self.state.admission.lock().epoch;
        self.take_epoch(epoch)
    }
    /// Seal admission without invalidating accepted audio. Only normal tail
    /// drain consumes this token; cancellation invalidates the epoch instead.
    pub(super) fn seal(&self) -> Result<u64, &'static str> {
        self.suppress(true)
    }
    pub(super) fn take_sealed(&mut self, epoch: u64) -> Result<Option<ReceivedRtp>, &'static str> {
        self.take_epoch(epoch)
    }
    /// Only used after synchronized sealing: no accepted producer can enqueue
    /// after an empty observation. Work limits can leave raw packets queued.
    pub(super) fn is_empty(&self) -> bool {
        self.receiver.is_empty()
    }
    /// Called after cancellation has suppressed admission and stopped jitter.
    /// Free raw leases immediately, including when playback stays disabled.
    pub(super) fn discard(&mut self, retained: usize) {
        let mut retired = retained as u64;
        while self.receiver.try_recv().is_ok() {
            retired += 1;
        }
        self.state.admission.lock().statistics.retired_packets += retired;
    }
    fn take_epoch(&mut self, epoch: u64) -> Result<Option<ReceivedRtp>, &'static str> {
        if let Some(reason) = self.state.admission.lock().failure {
            return Err(reason);
        }
        for _ in 0..PACKETS {
            let Ok(packet) = self.receiver.try_recv() else {
                return Ok(None);
            };
            // Accepted media never expires by wall clock. Its leases bound
            // playable duration and memory even through a slow/paused consumer.
            if epoch.is_multiple_of(2) && packet.epoch == epoch {
                return Ok(Some(packet));
            }
            self.state.admission.lock().statistics.retired_packets += 1;
        }
        Ok(None)
    }
}
impl Ingress {
    // str0m has already authenticated RTP and removed SRTP/header extensions.
    // Taking its parts also lets fixtures exercise this exact admission path.
    pub(super) fn receive(
        &mut self,
        header: &str0m::rtp::RtpHeader,
        payload: &[u8],
        at: Instant,
        reliable: bool,
    ) -> Outcome {
        let mut admission = self.state.admission.lock();
        if admission.epoch % 2 == 1 {
            admission.statistics.suppressed_packets += 1;
            return Outcome::Suppressed;
        }
        if admission.failure.is_some() {
            admission.statistics.failed_packets += 1;
            return Outcome::Failed;
        }
        let size = 12 + payload.len();
        let samples = opus::packet::get_nb_samples(payload, crate::RATE as u32).ok();
        if size > PACKET_BYTES
            || header.payload_type != super::audio_track::OPUS_PAYLOAD_TYPE.into()
            || self.stream.is_some_and(|ssrc| ssrc != header.ssrc)
            || samples
                .is_none_or(|samples| samples == 0 || samples > super::jitter::MAX_FRAME_SAMPLES)
        {
            admission.statistics.invalid_packets += 1;
            admission.failure = Some("Invalid incoming audio packet.");
            return Outcome::Failed;
        }
        self.stream = Some(header.ssrc);
        // UDP may already be obsolete before admission. Reliable transport
        // delay is not evidence of lost speech. Neither expires after acceptance.
        if !reliable && at.elapsed() > UDP_MAX_AGE {
            admission.statistics.stale_packets += 1;
            return Outcome::Dropped;
        }
        let Ok(packet_permit) = self.state.packets.clone().try_acquire_owned() else {
            admission.statistics.packet_limit_drops += 1;
            return exhausted(&mut admission, reliable);
        };
        // packet::parse retains a payload copy alongside the raw RTP token.
        // Charge BOTH allocations until the decoder releases that token.
        let Ok(byte_permit) = self
            .state
            .bytes
            .clone()
            .try_acquire_many_owned((size * 2) as u32)
        else {
            admission.statistics.byte_limit_drops += 1;
            return exhausted(&mut admission, reliable);
        };
        let Ok(audio_permit) = self
            .state
            .audio
            .clone()
            .try_acquire_many_owned(samples.unwrap() as u32)
        else {
            admission.statistics.audio_limit_drops += 1;
            return exhausted(&mut admission, reliable);
        };
        let mut data = Vec::with_capacity(size);
        data.extend_from_slice(&[0x80, super::audio_track::OPUS_PAYLOAD_TYPE]);
        data.extend_from_slice(&header.sequence_number.to_be_bytes());
        data.extend_from_slice(&header.timestamp.to_be_bytes());
        data.extend_from_slice(&header.ssrc.to_be_bytes());
        data.extend_from_slice(payload);
        match self.sender.try_send(ReceivedRtp {
            data,
            at,
            reliable,
            epoch: admission.epoch,
            _packet: packet_permit,
            _bytes: byte_permit,
            _audio: audio_permit,
        }) {
            Ok(()) => {
                admission.statistics.accepted_packets += 1;
                Outcome::Accepted
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                admission.statistics.packet_limit_drops += 1;
                exhausted(&mut admission, reliable)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                admission.statistics.closed_packets += 1;
                admission.failure = Some("Incoming audio consumer closed.");
                Outcome::Failed
            }
        }
    }
}
fn exhausted(admission: &mut Admission, reliable: bool) -> Outcome {
    if reliable {
        // Fail the media consumer explicitly; never block RTC/control/ICE/DTLS
        // or pretend the surviving fragments are a complete reliable stream.
        admission.statistics.reliable_failures += 1;
        admission.failure = Some(OVERLOAD);
        Outcome::Failed
    } else {
        Outcome::Dropped
    }
}

#[cfg(test)]
#[path = "playout/tests.rs"]
mod playout_tests;
