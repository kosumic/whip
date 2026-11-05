//! Native 24kHz PCM/Opus bridge. Device callbacks and audio never cross JavaScript.
use super::super::{RATE, RealtimeVoiceAdapter, capture_worker};
use super::{
    audio_track::EncodedAudio,
    identity::Identity,
    jitter::{Frame as JitterFrame, Jitter, MAX_FRAME_SAMPLES, MAX_PACKETS, Statistics},
    packet,
    transport::Transport,
};
use parking_lot::Mutex;
use std::{
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio::sync::watch;

const FRAME_DURATION: Duration = capture_worker::PACKET_DURATION;

#[expect(
    clippy::significant_drop_tightening,
    reason = "The jitter buffer owns ingress permits across media ticks until the loop exits"
)]
pub(super) async fn run(
    owner: &RealtimeVoiceAdapter,
    peer: &mut Transport,
    identity: Arc<Mutex<Identity>>,
    mut stop: watch::Receiver<bool>,
    attempt: &super::super::recovery::Attempt,
) -> Result<(), &'static str> {
    let rate = u32::try_from(RATE).map_err(|_| "Invalid voice sample rate.")?;
    let mut encoder = opus::Encoder::new(rate, opus::Channels::Mono, opus::Application::Voip)
        .map_err(|_| "Voice encoder could not start.")?;
    let mut decoder = opus::Decoder::new(rate, opus::Channels::Mono)
        .map_err(|_| "Voice decoder could not start.")?;
    let mut decoded = vec![0_i16; MAX_FRAME_SAMPLES];
    let mut jitter = Jitter::default();
    let mut epoch = 0;
    let mut frame = ::audio_ingress::Packet::new(owner.input.packet_samples);
    let mut pending = capture_worker::Pending::new(owner);
    let mut encoded = vec![0; 1275];
    let mut last_silence = None::<Instant>;
    let mut tick = tokio::time::interval(Duration::from_millis(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if !attempt.current() {
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
                let (next_epoch, enabled, tag, finishing, failed) = { let state = identity.lock(); (state.epoch, state.enabled, state.current.clone(), state.finish_at, state.failed) };
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
                                let mut view = owner.view.lock();
                                view.media.rtp_packets += 1;
                                view.media.reliable_rtp_packets += u64::from(received.reliable);
                                view.media.rtp_samples += u64::try_from(opus::packet::get_nb_samples(&packet.payload, rate).unwrap_or(0)).unwrap_or(u64::MAX);
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
                        let mut view = owner.view.lock();
                        view.media.decoded_packets += 1;
                        view.media.decoded_samples += u64::try_from(count).unwrap_or(u64::MAX);
                        view.media.decoded_peak = view.media.decoded_peak.max(peak);
                    } else {
                        owner.view.lock().media.concealed_samples += u64::try_from(count).unwrap_or(u64::MAX);
                    }
                    jitter.advance(count);
                    // Preserve the continuous media clock, including quiet
                    // phonemes and pauses, as in Codex's native sink. Speaking
                    // state is derived separately from audible device samples.
                    if let Some(tag) = &tag {
                        if identity.lock().epoch != epoch { break; }
                        let bytes = decoded[..count].iter().flat_map(|sample| sample.to_le_bytes()).collect();
                        owner.output.lock().append(tag.item.clone(), tag.index, bytes)?;
                        owner.view.lock().media.queued_samples += u64::try_from(count).unwrap_or(u64::MAX);
                    }
                }
                let statistics = jitter.take_statistics();
                if statistics != Statistics::default() {
                    let mut view = owner.view.lock();
                    view.media.late_packets += statistics.late_packets;
                    view.media.clock_resyncs += statistics.resyncs;
                    view.media.packet_overflows += statistics.overflows;
                }
                let finished = { identity.lock().finish(epoch, Instant::now()) };
                if finished {
                    peer.incoming.set_suppressed(true)?;
                    jitter.stop();
                    if let Some(tag) = &tag { owner.output.lock().transcript.finish_audio(&tag.item, tag.index); }
                }
                if last_silence.is_none_or(|last| last.elapsed() >= FRAME_DURATION) && (!owner.ready.load(Ordering::Acquire) || owner.view.lock().muted || !owner.allow_input) {
                    tokio::select! {
                        biased;
                        _ = stop.changed() => return Ok(()),
                        result = peer.audio.send_muted_silence(Instant::now()) => result?,
                    }
                    last_silence = Some(Instant::now());
                }
                if owner.closed.load(Ordering::Acquire) { return Ok(()); }
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
                owner.view.lock().uploaded_packets += 1;
                super::input_started(owner);
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
