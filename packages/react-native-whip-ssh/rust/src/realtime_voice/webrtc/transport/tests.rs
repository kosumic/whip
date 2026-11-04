// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
// Adapted from Codex voice-host transport_tests.rs at 021fccb046508938c4754982efccfb51d6e8356e.
use super::super::{audio_track::AudioTrack, identity::Identity};
use super::*;
use futures::StreamExt;
use tokio::sync::mpsc;
type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;
struct RemoteEvents(mpsc::Sender<Arc<dyn DataChannel>>, Arc<Notify>);
impl PeerConnectionEventHandler for RemoteEvents {
    fn on_data_channel<'a, 'async_trait>(
        &'a self,
        channel: Arc<dyn DataChannel>,
    ) -> BoxFuture<'async_trait, ()>
    where
        'a: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            let _ = self.0.try_send(channel);
        })
    }
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
                self.1.notify_one();
            }
        })
    }
}
#[tokio::test]
async fn real_udp_and_tcp_peers_exchange_events_and_opus_without_an_api_call() -> TestResult {
    for tcp in [false, true] {
        timeout(Duration::from_secs(30), async {
            let (sender, mut channels) = mpsc::channel(1);
            let gathered = Arc::new(Notify::new());
            let settings =
                rtc::peer_connection::configuration::setting_engine::SettingEngineBuilder::new()
                    .with_lite(true)
                    .build();
            let (media, mut remote_audio) = AudioTrack::new()?;
            let builder = PeerConnectionBuilder::new()
                .with_media_engine(media)
                .with_setting_engine(settings)
                .with_handler(Arc::new(RemoteEvents(sender, gathered.clone())));
            let builder = if tcp {
                builder.with_tcp_addrs(vec!["0.0.0.0:0"])
            } else {
                builder.with_udp_addrs(vec!["0.0.0.0:0"])
            };
            let remote = Box::pin(builder.build()).await?;
            remote.add_track(remote_audio.track.clone()).await?;
            let (mut socket, _commands, events) = crate::realtime_voice::socket::Socket::relay();
            let mut local = Transport::new(
                events,
                Arc::new(parking_lot::Mutex::new(Identity::default())),
            )
            .await?;
            remote
                .set_remote_description(RTCSessionDescription::offer(local.offer().await?)?)
                .await?;
            let answer = remote.create_answer(None).await?;
            remote.set_local_description(answer).await?;
            gathered.notified().await;
            let answer = remote
                .local_description()
                .await
                .ok_or("missing answer")?
                .sdp;
            assert_eq!(local.apply_answer(answer).await?, AnswerOutcome::Ready);
            let channel = channels.recv().await.ok_or("missing event channel")?;
            assert_eq!(channel.label().await?, "oai-events");
            assert!(channel.ordered().await?);
            let event = r#"{"type":"rate_limits.updated","event_id":"test","rate_limits":[]}"#;
            channel.send_text(event).await?;
            let message = socket.next().await.ok_or("missing wire event")??;
            assert_eq!(message.into_text()?.as_str(), event);
            local.incoming.set_suppressed(false)?;
            remote_audio
                .send(super::super::audio_track::EncodedAudio {
                    data: vec![0xf8, 0xff, 0xfe],
                    at: std::time::Instant::now(),
                })
                .await?;
            let received = loop {
                if let Some(packet) = local.incoming.take()? {
                    break packet;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            };
            let packet =
                super::super::packet::parse(received.as_ref()).ok_or("invalid received RTP")?;
            drop(received);
            assert_eq!(packet.payload, [0xf8, 0xff, 0xfe]);
            let mut decoder = opus::Decoder::new(24_000, opus::Channels::Mono)?;
            let mut pcm = vec![0; 2880];
            assert!(decoder.decode(&packet.payload, &mut pcm, false)? > 0);
            local.close().await?;
            drop(local);
            remote.close().await?;
            Ok::<_, Box<dyn std::error::Error>>(())
        })
        .await??;
    }
    Ok(())
}
#[tokio::test]
async fn malformed_answer_is_redacted_and_peer_remains_closable() -> TestResult {
    let (_socket, _commands, events) = crate::realtime_voice::socket::Socket::relay();
    let mut peer = Transport::new(
        events,
        Arc::new(parking_lot::Mutex::new(Identity::default())),
    )
    .await?;
    peer.offer().await?;
    assert_eq!(
        peer.apply_answer("synthetic-private-invalid-sdp".into())
            .await,
        Err("invalid voice answer")
    );
    assert!(peer.connection.remote_description().await.is_none());
    peer.close().await?;
    drop(peer);
    Ok(())
}
