//! Bounded RTP playout follows source timestamps and adapts to arrival-clock shifts.
//! As in Codex's clock-slaved playout, valid queued speech survives network bursts.
use super::packet::{self, Packet};
use crate::realtime_voice::{FRAME, RATE};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

const REORDER: Duration = Duration::from_millis(60);
pub(super) const MAX_PACKETS: usize = 64;
const RTP_RATE: usize = 48_000;
const MIN_FRAME_SAMPLES: usize = RATE / 400;
pub(super) const MAX_FRAME_SAMPLES: usize = RATE * 120 / 1000;

pub(super) enum Frame {
    Packet(Packet),
    Missing(usize),
}

#[derive(Default, PartialEq, Eq)]
pub(super) struct Statistics {
    pub late_packets: u64,
    pub resyncs: u64,
    pub overflows: u64,
}

#[derive(Default)]
pub(super) struct Jitter {
    packets: VecDeque<Packet>,
    sequence: Option<u16>,
    timestamp: Option<u32>,
    deadline: Option<Instant>,
    frame_samples: Option<usize>,
    statistics: Statistics,
    reliable: bool,
}

fn distance(timestamp: u32, expected: u32) -> i32 {
    i32::from_ne_bytes(timestamp.wrapping_sub(expected).to_ne_bytes())
}

impl Jitter {
    pub fn push(&mut self, packet: Packet, now: Instant) {
        let sequence = packet::distance(packet.sequence, self.sequence.unwrap_or(packet.sequence));
        if sequence < 0
            || self
                .packets
                .iter()
                .any(|old| old.sequence == packet.sequence)
        {
            return;
        }
        let clock_jump = self.timestamp.is_some_and(|timestamp| {
            usize::try_from(distance(packet.timestamp, timestamp))
                .is_ok_and(|gap| gap > MAX_PACKETS * FRAME * RTP_RATE / RATE)
        });
        if self.sequence.is_none()
            || self.packets.is_empty()
                && (sequence >= i16::try_from(MAX_PACKETS).unwrap_or(i16::MAX) || clock_jump)
        {
            self.packets.clear();
            self.sequence = Some(packet.sequence);
            self.timestamp = Some(packet.timestamp);
            self.deadline = Some(now + REORDER);
        }
        if self.packets.len() == MAX_PACKETS {
            // Never replace queued words just to admit a newer burst.
            self.statistics.overflows += 1;
            return;
        }
        self.reliable = packet.reliable;
        self.packets.push_back(packet);
    }

    pub fn pop(&mut self, now: Instant) -> Option<Frame> {
        if self.deadline.is_none_or(|deadline| deadline > now) {
            return None;
        }
        let timestamp = self.timestamp?;
        // TCP already orders and retransmits the stream. An empty queue means
        // wait for its next frame, not invent elapsed source samples which make
        // that frame late when it arrives. Retain its original speech.
        if self.reliable && self.packets.is_empty() {
            return None;
        }
        if !self.packets.is_empty()
            && self
                .packets
                .iter()
                .all(|packet| distance(packet.timestamp, timestamp) < 0)
        {
            // The entire arrival timeline shifted. Rebuffer unheard sequences
            // instead of dropping every subsequent word against the old clock.
            // push() already rejects sequences which have actually been decoded.
            let next = self.sequence?;
            let packet = self
                .packets
                .iter()
                .min_by_key(|packet| packet::distance(packet.sequence, next))?;
            self.timestamp = Some(packet.timestamp);
            self.deadline = Some(now + REORDER);
            self.statistics.resyncs += 1;
            return None;
        }
        // Late audio has already been concealed. Never replay it and build
        // an ever-growing delay behind the speaker's actual source clock.
        let before = self.packets.len();
        self.packets
            .retain(|packet| distance(packet.timestamp, timestamp) >= 0);
        self.statistics.late_packets +=
            u64::try_from(before - self.packets.len()).unwrap_or(u64::MAX);
        let packet = self
            .packets
            .iter()
            .position(|packet| packet.timestamp == timestamp)
            .and_then(|index| self.packets.remove(index));
        if let Some(packet) = packet {
            self.sequence = Some(packet.sequence.wrapping_add(1));
            Some(Frame::Packet(packet))
        } else {
            // A sparse Opus stream can keep consecutive sequence numbers
            // while skipping timestamps. Only actual packets advance sequence.
            // Opus packet durations vary. A fixed 20ms concealment step can
            // skip a valid 10ms packet immediately following a loss.
            let samples = self
                .packets
                .iter()
                .filter_map(|packet| usize::try_from(distance(packet.timestamp, timestamp)).ok())
                .map(|ticks| ticks * RATE / RTP_RATE)
                .min()
                .unwrap_or(usize::MAX)
                .min(self.frame_samples.unwrap_or(FRAME))
                .clamp(MIN_FRAME_SAMPLES, MAX_FRAME_SAMPLES);
            Some(Frame::Missing(samples))
        }
    }

    pub fn advance(&mut self, samples: usize) {
        self.frame_samples = Some(samples);
        let ticks = u32::try_from(samples.saturating_mul(RTP_RATE) / RATE).unwrap_or(u32::MAX);
        self.timestamp = self
            .timestamp
            .map(|timestamp| timestamp.wrapping_add(ticks));
        self.deadline = self.deadline.map(|deadline| {
            deadline
                + Duration::from_micros(
                    u64::try_from(samples.saturating_mul(1_000_000) / RATE).unwrap_or(20_000),
                )
        });
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.packets.is_empty()
    }

    pub fn stop(&mut self) {
        *self = Self::default();
    }
    pub fn take_statistics(&mut self) -> Statistics {
        std::mem::take(&mut self.statistics)
    }
}

#[cfg(test)]
#[allow(
    clippy::significant_drop_tightening,
    reason = "Packet fixtures retain no network permits and buffers remain available across assertions"
)]
mod tests {
    use super::*;
    type TestResult = Result<(), &'static str>;
    const TICKS: u32 = 960;

    fn packet(sequence: u16, timestamp: u32) -> Packet {
        Packet {
            sequence,
            timestamp,
            payload: vec![0xf8, 0xff, 0xfe],
            reliable: false,
            _lease: None,
        }
    }

    #[test]
    fn wrapped_out_of_order_packets_follow_the_rtp_clock() -> TestResult {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        for (sequence, timestamp) in [(u16::MAX, 0u32.wrapping_sub(TICKS)), (1, TICKS), (0, 0)] {
            jitter.push(packet(sequence, timestamp), now);
        }
        assert!(jitter.pop(now).is_none());
        for (index, expected) in [u16::MAX, 0, 1].into_iter().enumerate() {
            let at = now
                + REORDER
                + Duration::from_millis(u64::try_from(index).map_err(|_| "index")? * 20);
            let Some(Frame::Packet(packet)) = jitter.pop(at) else {
                return Err("missing packet");
            };
            assert_eq!(packet.sequence, expected);
            jitter.advance(FRAME);
        }
        assert!(jitter.is_empty());
        Ok(())
    }

    #[test]
    fn empty_queue_advances_silence_without_skipping_the_next_sequence() {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        assert!(jitter.pop(now).is_none());
        jitter.push(packet(10, 0), now);
        assert!(matches!(jitter.pop(now + REORDER), Some(Frame::Packet(_))));
        jitter.advance(FRAME);
        assert!(matches!(
            jitter.pop(now + REORDER + Duration::from_millis(20)),
            Some(Frame::Missing(_))
        ));
        jitter.advance(FRAME);
        // DTX resumes with the next sequence, two source frames later.
        jitter.push(packet(11, TICKS * 2), now + Duration::from_millis(40));
        assert!(matches!(
            jitter.pop(now + REORDER + Duration::from_millis(40)),
            Some(Frame::Packet(Packet { sequence: 11, .. }))
        ));
    }

    #[test]
    fn loss_is_concealed_once_and_late_packets_cannot_replay_old_speech() {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        jitter.push(packet(0, 0), now);
        assert!(matches!(jitter.pop(now + REORDER), Some(Frame::Packet(_))));
        jitter.advance(FRAME);
        assert!(matches!(
            jitter.pop(now + REORDER + Duration::from_millis(20)),
            Some(Frame::Missing(_))
        ));
        jitter.advance(FRAME);
        jitter.push(packet(1, TICKS), now + Duration::from_millis(40));
        jitter.push(packet(2, TICKS * 2), now + Duration::from_millis(40));
        assert!(matches!(
            jitter.pop(now + REORDER + Duration::from_millis(40)),
            Some(Frame::Packet(Packet { sequence: 2, .. }))
        ));
        jitter.advance(FRAME);
        assert!(jitter.is_empty());
    }

    #[test]
    fn sparse_twenty_second_reply_keeps_its_full_playback_duration() {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        let mut sequence = 0;
        let mut samples = 0;
        for frame in 0..1000u32 {
            let at = now + Duration::from_millis(u64::from(frame) * 20);
            if frame.is_multiple_of(5) {
                jitter.push(packet(sequence, frame * TICKS), at);
                sequence += 1;
            }
            assert!(jitter.pop(at + REORDER).is_some());
            jitter.advance(FRAME);
            samples += FRAME;
        }
        assert_eq!(samples, RATE * 20);
    }

    #[test]
    fn finished_or_cancelled_playout_never_generates_more_audio() {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        jitter.push(packet(0, 0), now);
        assert!(jitter.pop(now + REORDER).is_some());
        jitter.advance(FRAME);
        jitter.stop();
        assert!(jitter.pop(now + Duration::from_secs(10)).is_none());
        jitter.push(packet(1, TICKS), now + Duration::from_secs(11));
        assert!(jitter.pop(now + Duration::from_secs(11)).is_none());
        assert!(matches!(
            jitter.pop(now + Duration::from_secs(11) + REORDER),
            Some(Frame::Packet(_))
        ));
    }

    #[test]
    fn discontinuous_timestamps_resume_fresh_instead_of_concealing_an_unbounded_gap() {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        jitter.push(packet(0, 0), now);
        assert!(jitter.pop(now + REORDER).is_some());
        jitter.advance(FRAME);
        let resumed = now + Duration::from_millis(100);
        jitter.push(packet(1, TICKS * 10_000), resumed);
        assert!(jitter.pop(resumed).is_none());
        assert!(matches!(
            jitter.pop(resumed + REORDER),
            Some(Frame::Packet(Packet { sequence: 1, .. }))
        ));
    }

    #[test]
    fn a_burst_cannot_replace_the_words_already_waiting_for_playback() -> TestResult {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        for sequence in 0..=u16::try_from(MAX_PACKETS).map_err(|_| "packet limit")? {
            jitter.push(packet(sequence, u32::from(sequence) * TICKS), now);
        }
        for sequence in 0..MAX_PACKETS {
            let at = now
                + REORDER
                + Duration::from_millis(u64::try_from(sequence).map_err(|_| "sequence")? * 20);
            let Some(Frame::Packet(packet)) = jitter.pop(at) else {
                return Err("Queued speech disappeared");
            };
            assert_eq!(usize::from(packet.sequence), sequence);
            jitter.advance(FRAME);
        }
        Ok(())
    }

    #[test]
    fn a_sustained_network_delay_recovers_unheard_speech_without_waiting_for_a_sequence_gap() {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        jitter.push(packet(0, 0), now);
        assert!(matches!(jitter.pop(now + REORDER), Some(Frame::Packet(_))));
        jitter.advance(FRAME);
        for frame in 1..=4 {
            assert!(
                jitter
                    .pop(now + REORDER + Duration::from_millis(frame * 20))
                    .is_some()
            );
            jitter.advance(FRAME);
        }
        let arrived = now + Duration::from_millis(160);
        jitter.push(packet(1, TICKS), arrived);
        jitter.push(packet(2, TICKS * 2), arrived);
        let _ = jitter.pop(arrived);
        assert!(matches!(
            jitter.pop(arrived + REORDER),
            Some(Frame::Packet(Packet { sequence: 1, .. }))
        ));
        jitter.advance(FRAME);
        assert!(matches!(
            jitter.pop(arrived + REORDER + Duration::from_millis(20)),
            Some(Frame::Packet(Packet { sequence: 2, .. }))
        ));
    }

    #[test]
    fn ten_ms_packet_loss_does_not_skip_the_following_received_packet() {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        jitter.push(packet(0, 0), now);
        assert!(matches!(jitter.pop(now + REORDER), Some(Frame::Packet(_))));
        jitter.advance(RATE / 100);
        jitter.push(packet(2, TICKS), now + Duration::from_millis(20));
        let Some(Frame::Missing(samples)) = jitter.pop(now + REORDER + Duration::from_millis(10))
        else {
            panic!("Missing ten-ms frame");
        };
        assert_eq!(samples, RATE / 100);
        jitter.advance(samples);
        assert!(matches!(
            jitter.pop(now + REORDER + Duration::from_millis(20)),
            Some(Frame::Packet(Packet { sequence: 2, .. }))
        ));
    }

    #[test]
    fn a_known_short_gap_uses_its_rtp_duration_when_packet_sizes_change() {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        jitter.push(packet(0, 0), now);
        assert!(matches!(jitter.pop(now + REORDER), Some(Frame::Packet(_))));
        jitter.advance(FRAME);
        jitter.push(
            packet(2, TICKS + TICKS / 2),
            now + Duration::from_millis(30),
        );
        let Some(Frame::Missing(samples)) = jitter.pop(now + REORDER + Duration::from_millis(20))
        else {
            panic!("Missing short frame");
        };
        assert_eq!(samples, RATE / 100);
        jitter.advance(samples);
        assert!(matches!(
            jitter.pop(now + REORDER + Duration::from_millis(30)),
            Some(Frame::Packet(Packet { sequence: 2, .. }))
        ));
    }

    #[test]
    fn reliable_media_waits_through_transport_stalls_without_deleting_words() {
        let now = Instant::now();
        let mut jitter = Jitter::default();
        let reliable = |sequence, timestamp| Packet {
            reliable: true,
            ..packet(sequence, timestamp)
        };
        jitter.push(reliable(0, 0), now);
        assert!(matches!(jitter.pop(now + REORDER), Some(Frame::Packet(_))));
        jitter.advance(FRAME);
        assert!(jitter.pop(now + Duration::from_millis(600)).is_none());
        for sequence in 1..=20 {
            jitter.push(
                reliable(sequence, u32::from(sequence) * TICKS),
                now + Duration::from_millis(600),
            );
        }
        for sequence in 1..=20 {
            assert!(
                matches!(jitter.pop(now + Duration::from_millis(600)), Some(Frame::Packet(Packet {sequence: received, ..})) if received == sequence)
            );
            jitter.advance(FRAME);
        }
        assert_eq!(jitter.take_statistics().late_packets, 0);
    }
}
