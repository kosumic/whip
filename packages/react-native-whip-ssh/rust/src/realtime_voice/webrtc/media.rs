//! Native 24kHz PCM/Opus bridge. Device callbacks and audio never cross JavaScript.
use super::super::{FRAME, RATE, RealtimeVoiceAdapter};
use super::{
    audio_track::EncodedAudio,
    identity::Identity,
    jitter::{Frame as JitterFrame, Jitter, MAX_PACKETS},
    packet,
    transport::Transport,
};
use parking_lot::Mutex;
use std::{
    collections::VecDeque,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio::sync::watch;

const FRAME_DURATION: Duration = Duration::from_millis(20);

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
    let mut input_generation = owner.input.generation();
    let mut input = VecDeque::new();
    let mut input_at = Instant::now();
    let mut encoded = vec![0; 1275];
    let mut last_silence = None::<Instant>;
    let mut tick = tokio::time::interval(Duration::from_millis(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if !attempt.current() {
            return Ok(());
        }
        tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            captured = owner.next_capture(&mut frame) => {
                if captured? {
                    input.clear();
                    encoder.reset_state().map_err(|_| "Voice encoder reset failed.")?;
                }
                if frame.samples.is_empty() { continue; }
                if input_generation != frame.ticket.generation { input.clear(); encoder.reset_state().map_err(|_| "Voice encoder reset failed.")?; input_generation = frame.ticket.generation; }
                if input.is_empty() { input_at = frame.at; }
                input.extend(&frame.samples);
                while input.len() >= FRAME {
                    let pcm: Vec<i16> = input.drain(..FRAME).collect();
                    let count = encoder.encode(&pcm, &mut encoded).map_err(|_| "Voice encoding failed.")?;
                    peer.audio.send(EncodedAudio { data: encoded[..count].to_vec(), at: input_at }).await?;
                    owner.view.lock().uploaded_packets += 1;
                    super::input_started(owner);
                    input_at += FRAME_DURATION;
                    last_silence = Some(Instant::now());
                }
            }
            _ = tick.tick() => {
                let (next_epoch, enabled, tag, finishing, failed) = { let state = identity.lock(); (state.epoch, state.enabled, state.current.clone(), state.finish_at, state.failed) };
                if failed || !*peer.ready.borrow() { return Err("Realtime media connection ended."); }
                if epoch != next_epoch {
                    peer.incoming.set_suppressed(true)?;
                    jitter = Jitter::default();
                    decoder.reset_state().map_err(|_| "Voice decoder reset failed.")?;
                    epoch = next_epoch;
                }
                peer.incoming.set_suppressed(!enabled)?;
                while let Some(packet) = peer.incoming.take()? {
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
                    input.clear();
                    peer.audio.send_muted_silence(Instant::now()).await?;
                    last_silence = Some(Instant::now());
                }
                if owner.closed.load(Ordering::Acquire) { return Ok(()); }
            }
        }
    }
}
