use futures::future::BoxFuture;
use rtc::{
    media::Sample,
    rtp_transceiver::rtp_sender::{
        RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
        RtpCodecKind,
    },
};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use webrtc::peer_connection::{PeerConnectionEventHandler, RTCIceGatheringState};
use webrtc::{
    media_stream::{MediaStreamTrack, track_local::static_sample::TrackLocalStaticSample},
    peer_connection::MediaEngine,
};
pub type TestResult = Result<(), Box<dyn std::error::Error>>;
pub async fn send_silence(audio: &TrackLocalStaticSample) -> TestResult {
    audio
        .write_sample(
            1234,
            111,
            &Sample {
                data: vec![0xf8, 0xff, 0xfe].into(),
                duration: Duration::from_millis(20),
                ..Sample::new(std::time::Instant::now())
            },
            &[],
        )
        .await?;
    Ok(())
}
pub struct Gathered(pub Arc<Notify>);
impl PeerConnectionEventHandler for Gathered {
    fn on_ice_gathering_state_change<'a, 'async_trait>(
        &'a self,
        state: RTCIceGatheringState,
    ) -> BoxFuture<'async_trait, ()>
    where
        'a: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            if state == RTCIceGatheringState::Complete {
                self.0.notify_one();
            }
        })
    }
}
pub fn audio() -> Result<(MediaEngine, Arc<TrackLocalStaticSample>), Box<dyn std::error::Error>> {
    let codec = RTCRtpCodec {
        mime_type: "audio/opus".into(),
        clock_rate: 48_000,
        channels: 2,
        sdp_fmtp_line: "minptime=10;useinbandfec=1".into(),
        rtcp_feedback: vec![],
    };
    let mut media = MediaEngine::default();
    media.register_codec(
        RTCRtpCodecParameters {
            rtp_codec: codec.clone(),
            payload_type: 111,
        },
        RtpCodecKind::Audio,
    )?;
    let track = TrackLocalStaticSample::new(
        std::time::Instant::now(),
        MediaStreamTrack::new(
            "fixture".into(),
            "audio".into(),
            "microphone".into(),
            RtpCodecKind::Audio,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(1234),
                    ..Default::default()
                },
                codec,
                active: true,
                ..Default::default()
            }],
        ),
    )?;
    Ok((media, Arc::new(track)))
}
