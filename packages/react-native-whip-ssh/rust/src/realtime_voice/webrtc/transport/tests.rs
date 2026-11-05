//! Exercise accelerated clients against an independent, DTLS 1.2 stock peer.
use super::*;
use futures::{StreamExt, future::BoxFuture};
use rtc::{
    media::Sample,
    peer_connection::configuration::setting_engine::SettingEngineBuilder,
    rtp_transceiver::rtp_sender::{
        RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
        RtpCodecKind,
    },
};
use std::sync::Arc;
use tokio::sync::Notify;
use webrtc::{
    data_channel::DataChannelEvent,
    peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceGatheringState,
        RTCSessionDescription,
    },
};
use webrtc::{
    media_stream::{MediaStreamTrack, track_local::static_sample::TrackLocalStaticSample},
    peer_connection::MediaEngine,
};
type TestResult = Result<(), Box<dyn std::error::Error>>;
struct Gathered(Arc<Notify>);
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
fn audio() -> Result<(MediaEngine, Arc<TrackLocalStaticSample>), Box<dyn std::error::Error>> {
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
#[tokio::test]
async fn udp_and_tcp_interoperate_with_stock_dtls12_and_exchange_events_and_opus() -> TestResult {
    for protocol in [str0m::net::Protocol::Udp, str0m::net::Protocol::Tcp] {
        tokio::time::timeout(Duration::from_secs(30), async {
            let gathered = Arc::new(Notify::new());
            let (media, audio) = audio()?;
            let builder = PeerConnectionBuilder::new()
                .with_media_engine(media)
                .with_setting_engine(SettingEngineBuilder::new().with_lite(true).build())
                .with_handler(Arc::new(Gathered(gathered.clone())));
            let builder = if protocol == str0m::net::Protocol::Tcp {
                builder.with_tcp_addrs(vec!["0.0.0.0:0"])
            } else {
                builder.with_udp_addrs(vec!["0.0.0.0:0"])
            };
            let remote = Box::pin(builder.build()).await?;
            remote.add_track(audio.clone()).await?;
            let (mut socket, _commands, events) = crate::realtime_voice::socket::Socket::relay();
            let mut local = Transport::with_protocol(
                events,
                Arc::new(Mutex::new(Identity::default())),
                Some(protocol),
            )
            .await?;
            remote
                .set_remote_description(RTCSessionDescription::offer(local.offer())?)
                .await?;
            let channel = remote
                .create_data_channel(
                    "oai-events",
                    Some(webrtc::data_channel::RTCDataChannelInit {
                        negotiated: Some(super::super::driver::DATA_CHANNEL_ID),
                        ..Default::default()
                    }),
                )
                .await?;
            let answer = remote.create_answer(None).await?;
            remote.set_local_description(answer).await?;
            gathered.notified().await;
            let answer = remote
                .local_description()
                .await
                .ok_or("Missing answer")?
                .sdp;
            assert_eq!(local.apply_answer(answer).await?, AnswerOutcome::Ready);
            loop {
                match channel.poll().await.ok_or("Event channel ended")? {
                    DataChannelEvent::OnOpen => break,
                    DataChannelEvent::OnClose | DataChannelEvent::OnError => {
                        return Err("Event channel failed".into());
                    }
                    _ => {}
                }
            }
            let event = r#"{"type":"rate_limits.updated","event_id":"test","rate_limits":[]}"#;
            channel.send_text(event).await?;
            assert_eq!(
                socket
                    .next()
                    .await
                    .ok_or("No wire event")??
                    .into_text()?
                    .as_str(),
                event
            );
            local.incoming.set_suppressed(false)?;
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
            let received = loop {
                if let Some(packet) = local.incoming.take()? {
                    break packet;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            };
            let packet = super::super::packet::parse(received.as_ref()).ok_or("Invalid RTP")?;
            drop(received);
            assert_eq!(packet.payload, [0xf8, 0xff, 0xfe]);
            let mut decoder = opus::Decoder::new(24_000, opus::Channels::Mono)?;
            assert!(decoder.decode(&packet.payload, &mut [0; 2880], false)? > 0);
            remote.close().await?;
            tokio::time::timeout(
                Duration::from_secs(5),
                local.ready.wait_for(|ready| !*ready),
            )
            .await??;
            local.close().await?;
            drop(local);
            Ok::<(), Box<dyn std::error::Error>>(())
        })
        .await??;
    }
    Ok(())
}
#[tokio::test]
async fn malformed_answer_is_redacted_and_peer_remains_closable() -> TestResult {
    let (_socket, _commands, events) = crate::realtime_voice::socket::Socket::relay();
    let mut peer = Transport::new(events, Arc::new(Mutex::new(Identity::default()))).await?;
    assert_eq!(
        peer.apply_answer("synthetic-private-invalid-sdp".into())
            .await,
        Err("Invalid voice answer.")
    );
    peer.close().await?;
    drop(peer);
    Ok(())
}

#[tokio::test]
async fn untrusted_answer_candidate_count_is_bounded_before_negotiation() -> TestResult {
    let (_socket, _commands, events) = crate::realtime_voice::socket::Socket::relay();
    let mut peer = Transport::new(events, Arc::new(Mutex::new(Identity::default()))).await?;
    let answer = "a=candidate:1 1 udp 1 127.0.0.1 5000 typ host\r\n".repeat(33);
    assert_eq!(
        peer.apply_answer(answer).await,
        Err("Too many voice candidates.")
    );
    peer.close().await?;
    drop(peer);
    Ok(())
}

#[tokio::test]
async fn closing_before_negotiation_releases_udp_and_tcp_listeners() -> TestResult {
    let (_socket, _commands, events) = crate::realtime_voice::socket::Socket::relay();
    let mut peer = Transport::new(events, Arc::new(Mutex::new(Identity::default()))).await?;
    let mut udp = None;
    let mut tcp = None;
    for line in peer
        .offer()
        .lines()
        .filter(|line| line.starts_with("a=candidate:"))
    {
        let fields: Vec<_> = line.split_whitespace().collect();
        let address: std::net::IpAddr = fields[4].parse()?;
        if !address.is_ipv4() {
            continue;
        }
        let port: u16 = fields[5].parse()?;
        if fields[2] == "udp" {
            udp = Some(port);
        }
        if fields[2] == "tcp" && line.contains("tcptype passive") {
            tcp = Some(port);
        }
    }
    peer.close().await?;
    drop(peer);
    let _udp = tokio::net::UdpSocket::bind((
        std::net::Ipv4Addr::UNSPECIFIED,
        udp.ok_or("No UDP candidate")?,
    ))
    .await?;
    let _tcp = tokio::net::TcpListener::bind((
        std::net::Ipv4Addr::UNSPECIFIED,
        tcp.ok_or("No TCP candidate")?,
    ))
    .await?;
    Ok(())
}
