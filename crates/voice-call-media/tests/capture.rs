use audio_ingress::{Format, Ingress, Limits, Packet, Ticket};
use std::time::{Duration, Instant};
use voice_call_media::{Capture, FRAME, RATE, capture_worker::Pending};

struct Microphone(Ingress);
impl Microphone {
    fn new() -> Result<Self, &'static str> {
        Ingress::new(
            Format {
                sample_rate: RATE as u32,
                channels: 1,
            },
            Limits {
                packets: 2,
                samples_per_packet: FRAME * 4,
                max_age: Duration::from_millis(500),
            },
        )
        .map(Self)
        .map_err(|_| "invalid mock microphone")
    }
    fn packet(&self, count: usize) -> Packet {
        let mut packet = Packet::new(count);
        packet.ticket = self.0.ticket();
        packet.at = Instant::now();
        packet.samples.resize(count, 1000);
        packet
    }
}
impl Capture for Microphone {
    fn packet_samples(&self) -> usize {
        FRAME * 4
    }
    fn generation(&self) -> u64 {
        self.0.ticket().generation
    }
    fn accepts(&self, generation: u64) -> bool {
        self.0.accepts(Ticket {
            generation,
            ..self.0.ticket()
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
    async fn next_capture(&self, _: &mut Packet) -> Result<bool, &'static str> {
        std::future::pending().await
    }
    fn process_capture(&self, _: &mut Packet) -> Result<(), &'static str> {
        Ok(())
    }
}

#[test]
fn rapid_mute_unmute_invalidates_already_processed_pcm_and_partial_packets()
-> Result<(), &'static str> {
    let microphone = Microphone::new()?;
    let mut pending = Pending::new(&microphone);
    pending.push(&microphone.packet(FRAME * 2 + FRAME / 2))?;
    let first = pending.take().ok_or("missing first frame")?;
    assert!(first.current(&microphone));
    microphone.0.set_muted(true);
    microphone.0.set_muted(false);
    assert!(!first.current(&microphone));
    assert!(pending.refresh(&microphone)?);
    assert!(pending.take().is_none());
    pending.push(&microphone.packet(FRAME))?;
    assert!(
        pending
            .take()
            .ok_or("missing resumed frame")?
            .current(&microphone)
    );
    microphone.0.close();
    assert!(!first.current(&microphone));
    Ok(())
}

#[test]
fn capture_backpressure_retains_only_one_batch_and_rejects_oversized_pcm()
-> Result<(), &'static str> {
    let microphone = Microphone::new()?;
    let mut pending = Pending::new(&microphone);
    pending.push(&microphone.packet(FRAME * 4))?;
    assert!(pending.push(&microphone.packet(FRAME)).is_err());
    for _ in 0..4 {
        assert!(pending.take().is_some());
    }
    assert!(pending.take().is_none());
    assert!(pending.push(&microphone.packet(FRAME * 6)).is_err());
    Ok(())
}
