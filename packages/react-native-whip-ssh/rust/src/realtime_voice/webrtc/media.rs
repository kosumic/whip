//! Native 24kHz PCM/Opus bridge. Device callbacks and audio never cross JavaScript.
use super::super::{FRAME, RATE, RealtimeVoiceAdapter, capture_worker};
use super::{
    audio_track::EncodedAudio,
    identity::Identity,
    jitter::{Frame as JitterFrame, Jitter, MAX_PACKETS},
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
    let mut decoded = vec![0_i16; RATE * 120 / 1000];
    let mut jitter = Jitter::default();
    let mut epoch = 0;
    let mut frame = ::audio_ingress::Packet::new(owner.input.packet_samples);
    let mut pending = capture_worker::Pending::new(owner);
    let mut encoded = vec![0; 1275];
    let mut last_silence = None::<Instant>;
    let mut last_live_sound = None::<Instant>;
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
                let (next_epoch, enabled, tag, finishing, failed, live) = { let state = identity.lock(); (state.epoch, state.enabled, state.current.clone(), state.finish_at, state.failed, state.live) };
                if failed || !*peer.ready.borrow() { return Err("Realtime media connection ended."); }
                if epoch != next_epoch {
                    peer.incoming.set_suppressed(true)?;
                    jitter = Jitter::default();
                    decoder.reset_state().map_err(|_| "Voice decoder reset failed.")?;
                    last_live_sound = None;
                    epoch = next_epoch;
                }
                peer.incoming.set_suppressed(!enabled)?;
                for _ in 0..super::incoming::PACKETS {
                    let Some(packet) = peer.incoming.take()? else { break; };
                    let arrival = packet.at;
                    // Keep packets received within the response's tail grace.
                    // Later RTP can continue after stopped and prevent draining.
                    if finishing.is_none_or(|deadline| arrival <= deadline)
                        && let Some(packet) = packet::parse(packet.as_ref()) { jitter.push(packet, arrival); }
                }
                let playout_at = Instant::now();
                for _ in 0..MAX_PACKETS {
                    if !enabled { break; }
                    let Some(packet) = jitter.pop(playout_at) else { break; };
                    let payload = if let JitterFrame::Packet(packet) = &packet {
                        packet.payload.as_slice()
                    } else { &[] };
                    let count = decoder.decode(payload, if payload.is_empty() { &mut decoded[..FRAME] } else { &mut decoded }, false).map_err(|_| "Realtime audio decoding failed.")?;
                    jitter.advance(count);
                    // Live is one continuous track, including silence. Retain
                    // short pauses, then let the native playback queue drain.
                    if live {
                        if decoded[..count].iter().any(|sample| sample.unsigned_abs() >= 64) {
                            last_live_sound = Some(playout_at);
                        }
                        if last_live_sound.is_none_or(|last| playout_at.duration_since(last) > Duration::from_millis(250)) { continue; }
                    }
                    if let Some(tag) = &tag {
                        if identity.lock().epoch != epoch { break; }
                        let bytes = decoded[..count].iter().flat_map(|sample| sample.to_le_bytes()).collect();
                        owner.output.lock().append(tag.item.clone(), tag.index, bytes)?;
                    }
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
