//! Native 24kHz PCM/Opus bridge. Device callbacks and audio never cross JavaScript.
use super::{
    audio_track::EncodedAudio,
    jitter::{Frame as JitterFrame, Jitter, MAX_FRAME_SAMPLES, MAX_PACKETS, Statistics},
    packet,
    transport::Transport,
};
use crate::{Host, RATE, Statistics as MediaStatistics, capture_worker};
use std::time::{Duration, Instant};
use tokio::sync::watch;

const FRAME_DURATION: Duration = capture_worker::PACKET_DURATION;

#[expect(
    clippy::significant_drop_tightening,
    reason = "The jitter buffer owns ingress permits across media ticks until the loop exits"
)]
pub async fn run(
    owner: &impl Host,
    peer: &mut Transport,
    mut stop: watch::Receiver<bool>,
) -> Result<(), &'static str> {
    let rate = u32::try_from(RATE).map_err(|_| "Invalid voice sample rate.")?;
    let mut encoder = opus::Encoder::new(rate, opus::Channels::Mono, opus::Application::Voip)
        .map_err(|_| "Voice encoder could not start.")?;
    let mut decoder = opus::Decoder::new(rate, opus::Channels::Mono)
        .map_err(|_| "Voice decoder could not start.")?;
    let mut decoded = vec![0_i16; MAX_FRAME_SAMPLES];
    let mut jitter = Jitter::default();
    let mut epoch = 0;
    let mut frame = ::audio_ingress::Packet::new(owner.packet_samples());
    let mut pending = capture_worker::Pending::new(owner);
    let mut encoded = vec![0; 1275];
    let mut last_silence = None::<Instant>;
    let mut tick = tokio::time::interval(Duration::from_millis(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if *stop.borrow() || !owner.current() {
            return Ok(());
        }
        if pending.refresh(owner)? {
            encoder
                .reset_state()
                .map_err(|_| "Voice encoder reset failed.")?;
        }
        tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            _ = tick.tick() => {
                let state = owner.playback();
                let (next_epoch, enabled, tag, finishing, failed) = (state.epoch, state.enabled, state.tag, state.finish_at, state.failed);
                if failed { return Err("Invalid voice media control event."); }
                if !*peer.ready.borrow() { return Err(peer.failure.borrow().unwrap_or("Realtime media connection ended.")); }
                if epoch != next_epoch {
                    peer.incoming.set_suppressed(true)?;
                    jitter = Jitter::default();
                    decoder.reset_state().map_err(|_| "Voice decoder reset failed.")?;
                    epoch = next_epoch;
                }
                peer.incoming.set_suppressed(!enabled)?;
                for _ in 0..super::incoming::PACKETS {
                    let Some(received) = peer.incoming.take()? else { break; };
                    let arrival = received.at;
                    // Keep packets received within the response's tail grace.
                    // Later RTP can continue after stopped and prevent draining.
                    if finishing.is_none_or(|deadline| arrival <= deadline)
                        && let Some(packet) = packet::parse(received.as_ref()) {
                            {
                                owner.statistics(MediaStatistics { rtp_packets: 1, reliable_rtp_packets: u64::from(received.reliable), rtp_samples: u64::try_from(opus::packet::get_nb_samples(&packet.payload, rate).unwrap_or(0)).unwrap_or(u64::MAX), ..Default::default() });
                            }
                            // Keep packet/byte permits through decoding, as in
                            // Codex, rather than releasing them into a second queue.
                            jitter.push(packet.retaining(received), arrival);
                        }
                }
                let playout_at = Instant::now();
                for _ in 0..MAX_PACKETS {
                    if !enabled { break; }
                    let Some(packet) = jitter.pop(playout_at) else { break; };
                    let (payload, capacity) = match &packet {
                        JitterFrame::Packet(packet) => (packet.payload.as_slice(), decoded.len()),
                        JitterFrame::Missing(samples) => (&[][..], *samples),
                    };
                    let count = decoder.decode(payload, &mut decoded[..capacity], false).map_err(|_| "Realtime audio decoding failed.")?;
                    if matches!(packet, JitterFrame::Packet(_)) {
                        let peak = decoded[..count].iter().map(|sample| sample.unsigned_abs()).max().unwrap_or(0);
                        owner.statistics(MediaStatistics { decoded_packets: 1, decoded_samples: u64::try_from(count).unwrap_or(u64::MAX), decoded_peak: peak, ..Default::default() });
                    } else {
                        owner.statistics(MediaStatistics { concealed_samples: u64::try_from(count).unwrap_or(u64::MAX), ..Default::default() });
                    }
                    jitter.advance(count);
                    // Preserve the continuous media clock, including quiet
                    // phonemes and pauses, as in Codex's native sink. Speaking
                    // state is derived separately from audible device samples.
                    if let Some(tag) = &tag {
                        if !owner.render(epoch, tag, &decoded[..count])? { break; }
                        owner.statistics(MediaStatistics { queued_samples: u64::try_from(count).unwrap_or(u64::MAX), ..Default::default() });
                    }
                }
                let statistics = jitter.take_statistics();
                if statistics != Statistics::default() {
                    owner.statistics(MediaStatistics { late_packets: statistics.late_packets, clock_resyncs: statistics.resyncs, packet_overflows: statistics.overflows, ..Default::default() });
                }
                let finished = owner.finish(epoch, Instant::now());
                if finished {
                    peer.incoming.set_suppressed(true)?;
                    jitter.stop();
                }
                if last_silence.is_none_or(|last| last.elapsed() >= FRAME_DURATION) && !owner.capture_enabled() {
                    tokio::select! {
                        biased;
                        _ = stop.changed() => return Ok(()),
                        result = peer.audio.send_muted_silence(Instant::now()) => result?,
                    }
                    last_silence = Some(Instant::now());
                }
                if !owner.current() { return Ok(()); }
            }
            _ = tokio::task::yield_now(), if pending.ready() => {
                if pending.refresh(owner)? { encoder.reset_state().map_err(|_| "Voice encoder reset failed.")?; }
                let Some(captured) = pending.take() else { continue; };
                if !captured.current(owner) { pending.reset(owner)?; encoder.reset_state().map_err(|_| "Voice encoder reset failed.")?; continue; }
                let count = encoder.encode(&captured.samples, &mut encoded).map_err(|_| "Voice encoding failed.")?;
                // A control may arrive while encoding. Never commit a second
                // old-generation packet after an in-flight send completes.
                if !captured.current(owner) { pending.reset(owner)?; encoder.reset_state().map_err(|_| "Voice encoder reset failed.")?; continue; }
                tokio::select! {
                    biased;
                    _ = stop.changed() => return Ok(()),
                    result = peer.audio.send(EncodedAudio { data: encoded[..count].to_vec(), at: captured.at }) => result?,
                }
                owner.uploaded();
                last_silence = Some(Instant::now());
            }
            captured = owner.next_capture(&mut frame), if !pending.ready() => {
                if captured? { pending.reset(owner)?; encoder.reset_state().map_err(|_| "Voice encoder reset failed.")?; }
                if pending.refresh(owner)? { encoder.reset_state().map_err(|_| "Voice encoder reset failed.")?; }
                owner.process_capture(&mut frame)?;
                pending.push(&frame)?;
            }
        }
    }
}
