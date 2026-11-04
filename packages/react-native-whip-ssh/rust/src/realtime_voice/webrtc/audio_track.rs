// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
// Adapted from Codex at 021fccb046508938c4754982efccfb51d6e8356e.
//! A single Opus RTP track. Muted capture sends generated silence to keep the peer alive;
//! elapsed time advances in whole packets so capture jitter and mute transitions preserve
//! the receiver's 20 ms source grid without inventing packet loss.

use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use rtc::media::Sample;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodec;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodecParameters;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodingParameters;
use rtc::rtp_transceiver::rtp_sender::RTCRtpEncodingParameters;
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use webrtc::media_stream::MediaStreamTrack;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::peer_connection::MediaEngine;

pub(crate) const OPUS_PAYLOAD_TYPE: u8 = 111;
pub(crate) const SEND_TIMEOUT: Duration = Duration::from_millis(/*millis*/ 100);

pub(crate) struct EncodedAudio {
    pub(crate) data: Vec<u8>,
    pub(crate) at: Instant,
}

pub(crate) struct AudioTrack {
    pub(crate) track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
    end: Option<Instant>,
    silence: Option<Vec<u8>>,
}

impl AudioTrack {
    pub(crate) fn new() -> Result<(MediaEngine, Self), &'static str> {
        let id = uuid::Uuid::new_v4();
        let bytes = id.as_bytes();
        let ssrc = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        let codec = RTCRtpCodec {
            mime_type: "audio/opus".into(),
            clock_rate: 48_000,
            channels: 2,
            sdp_fmtp_line: "minptime=10;useinbandfec=1".into(),
            rtcp_feedback: vec![],
        };
        let mut media = MediaEngine::default();
        media
            .register_codec(
                RTCRtpCodecParameters {
                    rtp_codec: codec.clone(),
                    payload_type: OPUS_PAYLOAD_TYPE,
                },
                RtpCodecKind::Audio,
            )
            .map_err(|_| "failed to register voice codec")?;
        let track = TrackLocalStaticSample::new(
            Instant::now(),
            MediaStreamTrack::new(
                "realtime".into(),
                format!("audio-{ssrc}"),
                "microphone".into(),
                RtpCodecKind::Audio,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters {
                        ssrc: Some(ssrc),
                        ..Default::default()
                    },
                    codec,
                    active: true,
                    ..Default::default()
                }],
            ),
        )
        .map_err(|_| "failed to create voice track")?;
        Ok((
            media,
            Self {
                track: Arc::new(track),
                ssrc,
                end: None,
                silence: None,
            },
        ))
    }

    /// Send only synthetic silence while muted, never a device or processing buffer.
    /// Reuse the encoded packet and pace it by the same RTP clock as live capture.
    pub(crate) async fn send_muted_silence(&mut self, at: Instant) -> Result<(), &'static str> {
        if self.end.is_some_and(|end| at < end) {
            return Ok(());
        }
        if self.silence.is_none() {
            let mut encoder = opus::Encoder::new(
                /*sample_rate*/ 24_000,
                opus::Channels::Mono,
                opus::Application::Voip,
            )
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
        tokio::time::timeout(SEND_TIMEOUT, async {
            let duration = Duration::from_millis(/*millis*/ 20);
            let elapsed = self
                .end
                .map(|end| frame.at.saturating_duration_since(end))
                .unwrap_or_default();
            // RTP counts audio samples, not callback wall-clock jitter. Skipping
            // fractional packets changes the source grid and causes receivers
            // that assemble fixed-duration frames to reject subsequent audio.
            let skipped = Duration::from_millis(
                u64::try_from(elapsed.as_millis() / duration.as_millis() * duration.as_millis())
                    .map_err(|_| "voice clock overflow")?,
            );
            let mut gap = skipped;
            while !gap.is_zero() {
                let duration = gap.min(Duration::from_secs(/*secs*/ 3600));
                self.track
                    .write_sample(
                        self.ssrc,
                        /*payload_type*/ OPUS_PAYLOAD_TYPE,
                        &Sample {
                            // write_sample truncates floating-point seconds to RTP ticks.
                            // Bias empty gaps by 1 ns to keep whole packets exact.
                            duration: duration + Duration::from_nanos(/*nanos*/ 1),
                            ..Sample::new(frame.at)
                        },
                        &[],
                    )
                    .await
                    .map_err(|_| "failed to advance voice clock")?;
                gap -= duration;
            }
            self.track
                .write_sample(
                    self.ssrc,
                    /*payload_type*/ OPUS_PAYLOAD_TYPE,
                    &Sample {
                        data: frame.data.into(),
                        duration,
                        ..Sample::new(frame.at)
                    },
                    &[],
                )
                .await
                .map_err(|_| "failed to send voice audio")?;
            self.end = Some(self.end.unwrap_or(frame.at) + skipped + duration);
            Ok(())
        })
        .await
        .map_err(|_| "voice audio sender stalled")?
    }
}
