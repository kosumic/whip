//! Normal stops close tail admission, then drain accepted media. Cancellation
//! instead invalidates the epoch immediately, including retained RTP permits.
use crate::{
    Host, RATE, Statistics, Tag,
    incoming::Incoming,
    jitter::{Frame, Jitter, MAX_FRAME_SAMPLES},
    packet,
};
use std::time::{Duration, Instant};

const TAIL_QUIET: Duration = Duration::from_millis(160);
// Control and RTP have independent delivery clocks. Allow late tail arrivals,
// but never let continuous silence/keepalive RTP hold completion open forever.
// At this cap, seal admission and play every accepted packet. The packet bound
// and pop_tail's bounded gaps bound the remaining drain by media duration;
// neither this cap nor the quiet grace is a deadline for dropping queued words.
const TAIL_WAIT: Duration = Duration::from_secs(1);
// Bound synchronous work per tick independently of retained backlog capacity.
const MAX_WORK: usize = 64;

struct Tail {
    tag: Option<Tag>,
    stopped_at: Instant,
    progress_at: Instant,
    sealed_epoch: Option<u64>,
}

pub(super) struct Playout {
    decoder: opus::Decoder,
    decoded: Vec<i16>,
    jitter: Jitter,
    epoch: u64,
    tail: Option<Tail>,
}
impl Playout {
    pub fn new() -> Result<Self, &'static str> {
        Ok(Self {
            decoder: opus::Decoder::new(RATE as u32, opus::Channels::Mono)
                .map_err(|_| "Voice decoder could not start.")?,
            decoded: vec![0; MAX_FRAME_SAMPLES],
            jitter: Jitter::default(),
            epoch: 0,
            tail: None,
        })
    }

    pub fn tick(
        &mut self,
        owner: &impl Host,
        incoming: &mut Incoming,
        now: Instant,
    ) -> Result<(), &'static str> {
        if !owner.current() {
            return Ok(());
        }
        let state = owner.playback();
        if state.failed {
            return Err("Invalid voice media control event.");
        }
        if self.epoch != state.epoch {
            incoming.set_suppressed(true)?;
            incoming.discard(self.jitter.stop());
            self.decoder
                .reset_state()
                .map_err(|_| "Voice decoder reset failed.")?;
            self.epoch = state.epoch;
            self.tail = None;
        }
        if self.tail.as_ref().map(|tail| tail.stopped_at) != state.stopped_at
            || self.tail.as_ref().is_some_and(|tail| tail.tag != state.tag)
        {
            self.tail = state.stopped_at.map(|stopped_at| Tail {
                tag: state.tag.clone(),
                stopped_at,
                progress_at: stopped_at,
                sealed_epoch: None,
            });
        }
        incoming.set_suppressed(
            !state.enabled
                || self
                    .tail
                    .as_ref()
                    .is_some_and(|tail| tail.sealed_epoch.is_some()),
        )?;
        if !state.enabled {
            incoming.discard(self.jitter.stop());
            owner.statistics(Statistics {
                ingress: incoming.take_statistics(),
                ..Default::default()
            });
            return Ok(());
        }
        if let Some(tail) = &mut self.tail
            && tail.sealed_epoch.is_none()
            && now >= tail.stopped_at + TAIL_WAIT
        {
            tail.sealed_epoch = Some(incoming.seal()?);
        }
        self.receive(owner, incoming)?;
        for _ in 0..MAX_WORK {
            if !owner.current() {
                return Ok(());
            }
            let frame = if self.tail.is_some() {
                self.jitter.pop_tail(now)
            } else {
                self.jitter.pop(now)
            };
            let Some(frame) = frame else {
                break;
            };
            let (payload, capacity) = match &frame {
                Frame::Packet(packet) => (packet.payload.as_slice(), self.decoded.len()),
                Frame::Missing(samples) => (&[][..], *samples),
            };
            let count = self
                .decoder
                .decode(payload, &mut self.decoded[..capacity], false)
                .map_err(|_| "Realtime audio decoding failed.")?;
            if matches!(frame, Frame::Packet(_)) {
                let peak = self.decoded[..count]
                    .iter()
                    .map(|sample| sample.unsigned_abs())
                    .max()
                    .unwrap_or(0);
                owner.statistics(Statistics {
                    decoded_packets: 1,
                    decoded_samples: count as u64,
                    decoded_peak: peak,
                    ..Default::default()
                });
                if let Some(tail) = &mut self.tail {
                    tail.progress_at = tail.progress_at.max(now);
                }
            } else {
                owner.statistics(Statistics {
                    concealed_samples: count as u64,
                    ..Default::default()
                });
            }
            self.jitter.advance(count);
            // Keep quiet phonemes, caption samples and the continuous Opus
            // clock. The host rechecks cancellation under its control lock.
            if let Some(tag) = &state.tag {
                if !owner.render(self.epoch, tag, &self.decoded[..count])? {
                    break;
                }
                owner.statistics(Statistics {
                    queued_samples: count as u64,
                    ..Default::default()
                });
            }
        }
        let statistics = self.jitter.take_statistics();
        if statistics != Default::default() {
            owner.statistics(Statistics {
                late_packets: statistics.late_packets,
                clock_resyncs: statistics.resyncs,
                packet_overflows: statistics.overflows,
                ..Default::default()
            });
        }
        // Only actual accepted packets/decodes extend the quiet period. PLC
        // and duplicates cannot postpone completion. Seal before the final
        // receive so concurrent, already accepted ingress is drained too.
        if self.jitter.is_empty()
            && let Some(tail) = &mut self.tail
            && (tail.sealed_epoch.is_some() || now >= tail.progress_at + TAIL_QUIET)
        {
            if tail.sealed_epoch.is_none() {
                tail.sealed_epoch = Some(incoming.seal()?);
                self.receive(owner, incoming)?;
            }
            if self.jitter.is_empty() && incoming.is_empty() && owner.finish(&state) {
                self.jitter.stop();
            }
        }
        Ok(())
    }

    fn receive(&mut self, owner: &impl Host, incoming: &mut Incoming) -> Result<(), &'static str> {
        let result = self.receive_packets(owner, incoming);
        // Report overload even when the receive fails, including the final
        // receive racing a synchronized tail seal.
        owner.statistics(Statistics {
            ingress: incoming.take_statistics(),
            ..Default::default()
        });
        result
    }

    fn receive_packets(
        &mut self,
        owner: &impl Host,
        incoming: &mut Incoming,
    ) -> Result<(), &'static str> {
        for _ in 0..MAX_WORK {
            let received = match self.tail.as_ref().and_then(|tail| tail.sealed_epoch) {
                Some(epoch) => incoming.take_sealed(epoch)?,
                None => incoming.take()?,
            };
            let Some(received) = received else {
                break;
            };
            let arrival = received.at;
            if let Some(packet) = packet::parse(received.as_ref()) {
                owner.statistics(Statistics {
                    rtp_packets: 1,
                    reliable_rtp_packets: u64::from(received.reliable),
                    rtp_samples: opus::packet::get_nb_samples(&packet.payload, RATE as u32)
                        .unwrap_or(0) as u64,
                    ..Default::default()
                });
                if self.jitter.push(packet.retaining(received), arrival)
                    && let Some(tail) = &mut self.tail
                {
                    tail.progress_at = tail.progress_at.max(arrival);
                }
            }
        }
        Ok(())
    }
}
