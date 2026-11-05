// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
// Adapted from Codex at 021fccb046508938c4754982efccfb51d6e8356e.
//! A bounded Opus sender with a continuous 48kHz RTP clock across mute and callback jitter.
use super::driver::Command;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch};
pub(crate) const OPUS_PAYLOAD_TYPE: u8 = 111;
pub(crate) const SEND_TIMEOUT: Duration = super::super::capture_worker::SEND_TIMEOUT;
const PACKET: Duration = Duration::from_millis(20);
const RTP_SAMPLES: u32 = 960;
pub(crate) struct EncodedAudio {
    pub(crate) data: Vec<u8>,
    pub(crate) at: Instant,
}

#[cfg(test)]
mod tests;
pub(crate) struct AudioTrack {
    sender: mpsc::Sender<Command>,
    failure: watch::Receiver<Option<&'static str>>,
    end: Option<Instant>,
    timestamp: u32,
    silence: Option<Vec<u8>>,
}
impl AudioTrack {
    pub(super) fn new(
        sender: mpsc::Sender<Command>,
        failure: watch::Receiver<Option<&'static str>>,
    ) -> Self {
        Self {
            sender,
            failure,
            end: None,
            timestamp: 0,
            silence: None,
        }
    }
    pub(crate) async fn send_muted_silence(&mut self, at: Instant) -> Result<(), &'static str> {
        if self.end.is_some_and(|end| at < end) {
            return Ok(());
        }
        if self.silence.is_none() {
            let mut encoder =
                opus::Encoder::new(24_000, opus::Channels::Mono, opus::Application::Voip)
                    .map_err(|_| "failed to create voice silence encoder")?;
            let mut data = vec![0; 1275];
            let len = encoder
                .encode_float(&[0.0; 480], &mut data)
                .map_err(|_| "failed to encode voice silence")?;
            data.truncate(len);
            self.silence = Some(data);
        }
        self.send(EncodedAudio {
            data: self
                .silence
                .as_ref()
                .ok_or("voice silence unavailable")?
                .clone(),
            at,
        })
        .await
    }
    pub(crate) async fn send(&mut self, frame: EncodedAudio) -> Result<(), &'static str> {
        let skipped = self
            .end
            .map(|end| frame.at.saturating_duration_since(end).as_millis() / PACKET.as_millis())
            .unwrap_or(0);
        let ticks =
            u32::try_from(skipped * u128::from(RTP_SAMPLES)).map_err(|_| "voice clock overflow")?;
        let timestamp = self.timestamp.wrapping_add(ticks);
        let (complete, result) = oneshot::channel();
        tokio::time::timeout(SEND_TIMEOUT, async {
            if self
                .sender
                .send(Command::Audio {
                    data: frame.data,
                    timestamp,
                    at: frame.at,
                    complete,
                })
                .await
                .is_err()
            {
                return Err(self.failure_reason().await);
            }
            match result.await {
                Ok(result) => result,
                Err(_) => Err(self.failure_reason().await),
            }
        })
        .await
        .map_err(|_| "voice audio sender stalled")??;
        self.timestamp = timestamp.wrapping_add(RTP_SAMPLES);
        let skipped = Duration::from_millis(
            u64::try_from(skipped * PACKET.as_millis()).map_err(|_| "voice clock overflow")?,
        );
        self.end = Some(self.end.unwrap_or(frame.at) + skipped + PACKET);
        Ok(())
    }

    async fn failure_reason(&mut self) -> &'static str {
        // The in-flight acknowledgement may drop just before the driver's
        // terminal cause is published. Retain that cause within SEND_TIMEOUT.
        if self.failure.borrow().is_none() {
            let _ = self.failure.changed().await;
        }
        self.failure.borrow().unwrap_or("voice media sender ended")
    }
}
