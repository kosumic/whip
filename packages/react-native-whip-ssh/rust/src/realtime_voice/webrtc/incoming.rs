// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
// Adapted from Codex's bounded RTP ingress; crypto and depacketization are owned by str0m.
//! Packet/byte permits follow retained RTP; response epochs discard stale audio.
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

pub(super) const PACKETS: usize = 64;
const BYTES: usize = 2 * 1024 * 1024;
const PACKET_BYTES: usize = 64 * 1024;
struct State {
    epoch: AtomicU64,
    failed: AtomicBool,
    packets: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
}
pub(crate) struct ReceivedRtp {
    data: Vec<u8>,
    pub(crate) at: Instant,
    pub(crate) reliable: bool,
    epoch: u64,
    _packet: OwnedSemaphorePermit,
    _bytes: OwnedSemaphorePermit,
}
impl AsRef<[u8]> for ReceivedRtp {
    fn as_ref(&self) -> &[u8] {
        &self.data
    }
}
pub(crate) struct Incoming {
    state: Arc<State>,
    receiver: mpsc::Receiver<ReceivedRtp>,
}
pub(super) struct Ingress {
    state: Arc<State>,
    sender: mpsc::Sender<ReceivedRtp>,
    stream: Option<str0m::rtp::Ssrc>,
}
impl Incoming {
    pub(super) fn new() -> (Self, Ingress) {
        let state = Arc::new(State {
            epoch: AtomicU64::new(1),
            failed: AtomicBool::new(false),
            packets: Arc::new(Semaphore::new(PACKETS)),
            bytes: Arc::new(Semaphore::new(BYTES)),
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
    pub(crate) fn set_suppressed(&self, suppressed: bool) -> Result<(), &'static str> {
        let epoch = self.state.epoch.load(Ordering::Acquire);
        if (epoch % 2 == 1) != suppressed {
            self.state.epoch.store(
                epoch.checked_add(1).ok_or("audio epoch exhausted")?,
                Ordering::Release,
            );
        }
        Ok(())
    }
    pub(crate) fn take(&mut self) -> Result<Option<ReceivedRtp>, &'static str> {
        if self.state.failed.load(Ordering::Acquire) {
            return Err("incoming audio failed");
        }
        let epoch = self.state.epoch.load(Ordering::Acquire);
        for _ in 0..PACKETS {
            let Ok(packet) = self.receiver.try_recv() else {
                return Ok(None);
            };
            if epoch.is_multiple_of(2)
                && packet.epoch == epoch
                && packet.at.elapsed() <= Duration::from_secs(1)
            {
                return Ok(Some(packet));
            }
        }
        Ok(None)
    }
}
impl Ingress {
    pub(super) fn receive(&mut self, packet: str0m::rtp::RtpPacket, reliable: bool) {
        let epoch = self.state.epoch.load(Ordering::Acquire);
        if epoch % 2 == 1 || self.state.failed.load(Ordering::Acquire) {
            return;
        }
        let size = 12 + packet.payload.len();
        if size > PACKET_BYTES
            || packet.header.payload_type != super::audio_track::OPUS_PAYLOAD_TYPE.into()
            || self.stream.is_some_and(|ssrc| ssrc != packet.header.ssrc)
        {
            self.state.failed.store(true, Ordering::Release);
            return;
        }
        self.stream = Some(packet.header.ssrc);
        if packet.timestamp.elapsed() > Duration::from_secs(1) {
            return;
        }
        let Ok(packet_permit) = self.state.packets.clone().try_acquire_owned() else {
            return;
        };
        let Ok(byte_permit) = self
            .state
            .bytes
            .clone()
            .try_acquire_many_owned(u32::try_from(size).unwrap_or(u32::MAX))
        else {
            return;
        };
        // The consumer needs only Opus, sequence, and source-clock timestamp.
        // str0m has already authenticated and removed SRTP/header extensions.
        let mut data = Vec::with_capacity(size);
        data.extend_from_slice(&[0x80, super::audio_track::OPUS_PAYLOAD_TYPE]);
        data.extend_from_slice(&packet.header.sequence_number.to_be_bytes());
        data.extend_from_slice(&packet.header.timestamp.to_be_bytes());
        data.extend_from_slice(&packet.header.ssrc.to_be_bytes());
        data.extend_from_slice(&packet.payload);
        let _ = self.sender.try_send(ReceivedRtp {
            data,
            at: packet.timestamp,
            reliable,
            epoch,
            _packet: packet_permit,
            _bytes: byte_permit,
        });
    }
}
