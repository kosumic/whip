//! Exercise accelerated clients against an independent, DTLS 1.2 stock peer.
use super::*;
#[path = "../../tests/support/mod.rs"]
mod support;
use rtc::peer_connection::configuration::setting_engine::SettingEngineBuilder;
use std::sync::Arc;
use std::time::Instant;
use support::{Gathered, TestResult, audio, send_silence};
use tokio::sync::Notify;
use webrtc::{
    data_channel::DataChannelEvent,
    peer_connection::{PeerConnection, PeerConnectionBuilder, RTCSessionDescription},
};
#[tokio::test]
async fn udp_and_tcp_media_preserve_rtp_bursts_amid_mirrored_data_channel_events() -> TestResult {
    let _guard = crate::prepared::TEST_LOCK.lock().await;
    transport_bursts(false).await
}

#[tokio::test]
async fn prepared_crypto_creates_fresh_udp_and_tcp_connections() -> TestResult {
    let _guard = crate::prepared::TEST_LOCK.lock().await;
    super::super::prepared::configure(true);
    let result = transport_bursts(true).await;
    super::super::prepared::configure(false);
    result
}

async fn transport_bursts(prepared: bool) -> TestResult {
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
            if prepared {
                super::super::prepared::ready().await?;
            }
            let mut local = Transport::with_protocol(Some(protocol)).await?;
            if prepared {
                assert!(local.prepared_client);
            }
            remote
                .set_remote_description(RTCSessionDescription::offer(local.offer())?)
                .await?;
            let channel = remote
                .create_data_channel(
                    "events",
                    Some(webrtc::data_channel::RTCDataChannelInit {
                        negotiated: Some(crate::TransportConfig::default().channel_id),
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
            let started = r#"{"type":"session.started","event_id":"primary-start","session":{"id":"live_fixture"}}"#;
            channel.send_text(started).await?;
            tokio::time::timeout(Duration::from_secs(5), local.primary_started.wait_for(Option::is_some)).await??;
            assert_eq!(local.primary_started.borrow().as_deref(), Some(started));
            // A burst of mirrored messages cannot terminate media, even when
            // the application is busy and not polling its sideband receiver.
            for _ in 0..256 {
                channel.send_text(event).await?;
            }
            local.incoming.set_suppressed(false)?;
            send_silence(&audio).await?;
            let received = loop {
                if let Some(packet) = local.incoming.take()? {
                    break packet;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            };
            let packet = super::super::packet::parse(received.as_ref()).ok_or("Invalid RTP")?;
            assert_eq!(received.reliable, protocol == str0m::net::Protocol::Tcp);
            drop(received);
            assert_eq!(packet.payload, [0xf8, 0xff, 0xfe]);
            assert_eq!(local.primary_started.borrow().as_deref(), Some(started));
            let mut decoder = opus::Decoder::new(24_000, opus::Channels::Mono)?;
            assert!(decoder.decode(&packet.payload, &mut [0; 2880], false)? > 0);
            drop(packet);
            admitted_burst(&audio, &mut local.incoming).await?;
            channel.close().await?;
            tokio::time::timeout(
                Duration::from_secs(5),
                local.ready.wait_for(|ready| !*ready),
            )
            .await??;
            // A closed control channel reports readiness loss, but only the
            // owner may retire the peer after collecting final session events.
            send_silence(&audio).await?;
            loop {
                if local.incoming.take()?.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
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

// Adapted from Codex PR #46880: all admitted packets must reach the real Opus
// decoder even when one network batch spans more than the reorder window.
async fn admitted_burst(
    audio: &webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample,
    incoming: &mut crate::incoming::Incoming,
) -> TestResult {
    use crate::jitter::{Frame, Jitter, MAX_FRAME_SAMPLES};

    const BURST_PACKETS: usize = 12;
    for _ in 0..BURST_PACKETS {
        send_silence(audio).await?;
    }
    let mut jitter = Jitter::default();
    let mut expected = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), async {
        while expected.len() < BURST_PACKETS {
            if let Some(received) = incoming.take()? {
                let packet = crate::packet::parse(received.as_ref()).ok_or("Invalid burst RTP")?;
                expected.push((packet.sequence, packet.timestamp, packet.payload.clone()));
                let at = received.at;
                jitter.push(packet.retaining(received), at);
            } else {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
        Ok::<_, &'static str>(())
    })
    .await??;

    let mut decoder = opus::Decoder::new(crate::RATE as u32, opus::Channels::Mono)?;
    let mut pcm = vec![0; MAX_FRAME_SAMPLES];
    let mut actual = Vec::new();
    let mut samples = 0;
    // Advance the test's playout clock without wall-clock sleeps. The entire
    // burst is due, and no empty-queue concealment is needed between packets.
    let due = Instant::now() + Duration::from_secs(1);
    for _ in 0..BURST_PACKETS {
        let Some(Frame::Packet(packet)) = jitter.pop(due) else {
            return Err("Admitted burst speech disappeared before decoding".into());
        };
        let count = decoder.decode(&packet.payload, &mut pcm, false)?;
        samples += count;
        jitter.advance(count);
        actual.push((packet.sequence, packet.timestamp, packet.payload));
    }
    assert_eq!(actual, expected);
    assert_eq!(samples, BURST_PACKETS * crate::FRAME);
    assert!(jitter.is_empty());
    assert!(jitter.take_statistics() == crate::jitter::Statistics::default());
    Ok(())
}
#[tokio::test]
async fn malformed_answer_is_redacted_and_peer_remains_closable() -> TestResult {
    let _guard = crate::prepared::TEST_LOCK.lock().await;
    let mut peer = Transport::new().await?;
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
    let _guard = crate::prepared::TEST_LOCK.lock().await;
    let mut peer = Transport::new().await?;
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
    let _guard = crate::prepared::TEST_LOCK.lock().await;
    let mut peer = Transport::new().await?;
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
