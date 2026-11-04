//! Native 24kHz PCM/Opus bridge. Device callbacks and audio never cross JavaScript.
use super::super::{FRAME, RATE, RealtimeVoiceAdapter, startup};
use super::{
    audio_track::EncodedAudio,
    identity::Identity,
    packet::{self, Packet},
    transport::Transport,
};
use parking_lot::Mutex;
use std::{
    collections::VecDeque,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio::sync::watch;

const REORDER: Duration = Duration::from_millis(60);
const FRAME_DURATION: Duration = Duration::from_millis(20);
const MAX_PACKETS: usize = 64;

enum JitterFrame {
    Packet(Packet),
    Missing,
}

#[derive(Default)]
struct Jitter {
    packets: VecDeque<Packet>,
    sequence: Option<u16>,
    deadline: Option<Instant>,
}
impl Jitter {
    fn push(&mut self, packet: Packet, now: Instant) {
        if self.sequence.is_none() {
            self.sequence = Some(packet.sequence);
            self.deadline = Some(now + REORDER);
        }
        let distance = packet::distance(packet.sequence, self.sequence.unwrap_or(packet.sequence));
        if distance < 0
            || self
                .packets
                .iter()
                .any(|old| old.sequence == packet.sequence)
        {
            return;
        }
        if self.packets.len() == MAX_PACKETS
            || distance >= i16::try_from(MAX_PACKETS).unwrap_or(i16::MAX)
        {
            // Resume from fresh media after a long loss rather than retaining stale speech.
            self.packets.clear();
            self.sequence = Some(packet.sequence);
            self.deadline = Some(now + REORDER);
        }
        self.packets.push_back(packet);
    }
    fn pop(&mut self, now: Instant) -> Option<JitterFrame> {
        if self.packets.is_empty() || self.deadline.is_none_or(|deadline| deadline > now) {
            return None;
        }
        let expected = self.sequence?;
        let packet = self
            .packets
            .iter()
            .position(|packet| packet.sequence == expected)
            .and_then(|index| self.packets.remove(index));
        self.sequence = Some(expected.wrapping_add(1));
        Some(packet.map_or(JitterFrame::Missing, JitterFrame::Packet))
    }
    fn advance(&mut self, samples: usize) {
        self.deadline = self.deadline.map(|deadline| {
            deadline
                + Duration::from_micros(u64::try_from(samples * 1_000_000 / RATE).unwrap_or(20_000))
        });
    }
}

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
    let mut last_timestamp = None;
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
                    owner.view.lock().startup.first_input.get_or_insert_with(|| owner.client_elapsed_ms.saturating_add(startup::elapsed(owner.started_at)));
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
                    last_timestamp = None;
                }
                peer.incoming.set_suppressed(!enabled)?;
                while let Some(packet) = peer.incoming.take()? {
                    let arrival = packet.at;
                    if let Some(packet) = packet::parse(packet.as_ref()) { jitter.push(packet, arrival); }
                }
                while let Some(packet) = jitter.pop(Instant::now()) {
                    let payload = if let JitterFrame::Packet(packet) = &packet {
                        if last_timestamp.is_some_and(|last: u32| packet.timestamp.wrapping_sub(last) > u32::MAX / 2) { jitter.advance(FRAME); continue; }
                        last_timestamp = Some(packet.timestamp);
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
                if finishing.is_some_and(|deadline| Instant::now() >= deadline) && jitter.packets.is_empty() {
                    if let Some(tag) = &tag { owner.output.lock().transcript.finish_audio(&tag.item, tag.index); }
                    let mut state = identity.lock();
                    if state.epoch == epoch { state.enabled = false; state.ended = true; state.finish_at = None; }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jitter_reorders_wrapped_sequences_and_advances_only_by_decoded_audio()
    -> Result<(), &'static str> {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        for sequence in [u16::MAX, 1, 0, 0] {
            jitter.push(
                Packet {
                    sequence,
                    timestamp: 0,
                    payload: vec![1],
                },
                now,
            );
        }
        assert!(jitter.pop(now).is_none());
        for (index, expected) in [u16::MAX, 0, 1].into_iter().enumerate() {
            let at = now
                + REORDER
                + Duration::from_millis(u64::try_from(index * 20).map_err(|_| "index")?);
            let Some(JitterFrame::Packet(packet)) = jitter.pop(at) else {
                return Err("missing frame or unexpected loss");
            };
            assert_eq!(packet.sequence, expected);
            jitter.advance(FRAME);
        }
        assert!(jitter.packets.is_empty());
        Ok(())
    }

    #[test]
    fn jitter_distinguishes_pending_audio_from_missing_packets() {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        assert!(jitter.pop(now).is_none());
        for sequence in [0, 2] {
            jitter.push(
                Packet {
                    sequence,
                    timestamp: 0,
                    payload: vec![1],
                },
                now,
            );
        }
        assert!(jitter.pop(now).is_none());
        let first = now + REORDER;
        assert!(matches!(
            jitter.pop(first),
            Some(JitterFrame::Packet(Packet { sequence: 0, .. }))
        ));
        jitter.advance(FRAME);
        assert!(jitter.pop(first).is_none());
        let missing = first + FRAME_DURATION;
        assert!(matches!(jitter.pop(missing), Some(JitterFrame::Missing)));
        jitter.advance(FRAME);
        assert!(jitter.pop(missing).is_none());
        let next = missing + FRAME_DURATION;
        assert!(matches!(
            jitter.pop(next),
            Some(JitterFrame::Packet(Packet { sequence: 2, .. }))
        ));
        jitter.advance(FRAME);
        assert!(jitter.pop(next + FRAME_DURATION).is_none());
    }
}
