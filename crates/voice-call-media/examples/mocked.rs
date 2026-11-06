//! In-process signaling peer and a bounded PCM host. No credentials or devices.
use audio_ingress::{Format, Ingress, Limits, Packet, Ticket};
#[path = "../tests/support/mod.rs"]
mod support;
use rtc::peer_connection::configuration::setting_engine::SettingEngineBuilder;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use support::{Gathered, TestResult, audio, send_silence};
use tokio::sync::{Notify, watch};
use voice_call_media::{
    AnswerOutcome, Capture, FRAME, Host, Playback, RATE, Statistics, Tag, Transport,
};
use webrtc::peer_connection::{PeerConnection, PeerConnectionBuilder, RTCSessionDescription};

struct Pcm {
    input: Ingress,
    wake: Notify,
    uploaded: AtomicU64,
    rendered: AtomicU64,
}
impl Capture for Pcm {
    fn packet_samples(&self) -> usize {
        FRAME
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
        self.accepts(self.generation())
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
                .map_err(|_| "mock ingress ended")?
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
impl Host for Pcm {
    fn current(&self) -> bool {
        true
    }
    fn playback(&self) -> Playback {
        Playback {
            epoch: 1,
            enabled: true,
            tag: Some(Tag {
                response: "mock".into(),
                item: "audio".into(),
                index: 0,
            }),
            ..Default::default()
        }
    }
    fn render(&self, _: u64, _: &Tag, pcm: &[i16]) -> Result<bool, &'static str> {
        self.rendered.fetch_add(pcm.len() as u64, Ordering::Relaxed);
        Ok(true)
    }
    fn finish(&self, _: u64, _: Instant) -> bool {
        false
    }
    fn statistics(&self, _: Statistics) {}
    fn uploaded(&self) {
        self.uploaded.fetch_add(1, Ordering::Relaxed);
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> TestResult {
    let format = Format {
        sample_rate: RATE as u32,
        channels: 1,
    };
    let host = Pcm {
        input: Ingress::new(
            format,
            Limits {
                packets: 4,
                samples_per_packet: FRAME,
                max_age: Duration::from_millis(500),
            },
        )
        .map_err(|_| "invalid ingress")?,
        wake: Notify::new(),
        uploaded: AtomicU64::new(0),
        rendered: AtomicU64::new(0),
    };
    let gathered = Arc::new(Notify::new());
    let (engine, audio) = audio()?;
    let remote = Box::pin(
        PeerConnectionBuilder::new()
            .with_media_engine(engine)
            .with_setting_engine(SettingEngineBuilder::new().with_lite(true).build())
            .with_udp_addrs(vec!["0.0.0.0:0"])
            .with_handler(Arc::new(Gathered(gathered.clone())))
            .build(),
    )
    .await?;
    remote.add_track(audio.clone()).await?;
    let mut local = Transport::new().await?;
    // Mock signaling exchanges SDP locally; a real host sends the offer to its provider.
    remote
        .set_remote_description(RTCSessionDescription::offer(local.offer())?)
        .await?;
    remote
        .create_data_channel(
            "events",
            Some(webrtc::data_channel::RTCDataChannelInit {
                negotiated: Some(4),
                ..Default::default()
            }),
        )
        .await?;
    let answer = remote.create_answer(None).await?;
    remote.set_local_description(answer).await?;
    gathered.notified().await;
    assert_eq!(
        local
            .apply_answer(
                remote
                    .local_description()
                    .await
                    .ok_or("missing answer")?
                    .sdp
            )
            .await?,
        AnswerOutcome::Ready
    );
    let (stop, stopped) = watch::channel(false);
    let media = voice_call_media::run(&host, &mut local, stopped);
    let simulate = async {
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            for sequence in 0..100 {
                let at = Instant::now();
                host.input
                    .push(host.input.ticket(), format, sequence, at, &[100; FRAME])
                    .map_err(|_| "mock capture rejected")?;
                host.wake.notify_one();
                send_silence(&audio).await.map_err(|_| "mock peer ended")?;
                tokio::time::sleep(Duration::from_millis(20)).await;
                if host.uploaded.load(Ordering::Relaxed) > 0
                    && host.rendered.load(Ordering::Relaxed) > 0
                {
                    return Ok::<_, &'static str>(());
                }
            }
            Err("PCM did not flow in both directions")
        })
        .await;
        stop.send_replace(true);
        result
    };
    let (media_result, simulation) = tokio::join!(media, simulate);
    host.input.close();
    let closed = local.close().await;
    remote.close().await?;
    media_result?;
    simulation??;
    closed?;
    println!("Native PCM uploaded and rendered; capture and peer stopped explicitly.");
    Ok(())
}
