#![allow(
    clippy::assert_is_empty,
    reason = "An explicit emptiness assertion communicates the queue contract"
)]
#![allow(
    clippy::unwrap_used,
    reason = "Tests fail immediately on unexpected admission errors"
)]
use audio_ingress::{Error, Format, Ingress, InputGate, Limits, Packet};
use std::time::{Duration, Instant};

const FORMAT: Format = Format {
    sample_rate: 16_000,
    channels: 1,
};
fn queue(packets: usize, samples: usize) -> Ingress {
    Ingress::new(
        FORMAT,
        Limits {
            packets,
            samples_per_packet: samples,
            max_age: Duration::from_secs(1),
        },
    )
    .unwrap()
}

#[test]
fn borrowed_little_endian_pcm_is_copied_and_ordered_across_ring_wrap() {
    let queue = queue(2, 4);
    let ticket = queue.ticket();
    let mut source = vec![0, 128, 255, 127, 255, 255, 0, 0];
    queue
        .push_le(ticket, FORMAT, 0, Instant::now(), &source)
        .unwrap();
    source.fill(0);
    queue
        .push(ticket, FORMAT, 1, Instant::now(), &[12])
        .unwrap();
    let mut out = Packet::new(4);
    assert!(queue.pop_into(&mut out).unwrap());
    assert_eq!(out.samples, [i16::MIN, i16::MAX, -1, 0]);
    assert_eq!(out.ticket, ticket);
    assert_eq!(out.sequence, 0);
    queue
        .push(ticket, FORMAT, 2, Instant::now(), &[23, 24])
        .unwrap();
    for (sequence, expected) in [(1, vec![12]), (2, vec![23, 24])] {
        assert!(queue.pop_into(&mut out).unwrap());
        assert_eq!(out.sequence, sequence);
        assert_eq!(out.samples, expected);
    }
    assert!(!queue.pop_into(&mut out).unwrap());
    assert!(out.samples.is_empty());
}

#[test]
fn overflow_preserves_previously_accepted_audio_without_overwriting() {
    let queue = queue(1, 2);
    let ticket = queue.ticket();
    queue
        .push(ticket, FORMAT, 0, Instant::now(), &[1, 2])
        .unwrap();
    assert_eq!(
        queue.push(ticket, FORMAT, 1, Instant::now(), &[3]),
        Err(Error::Overflow)
    );
    let mut out = Packet::new(2);
    assert!(queue.pop_into(&mut out).unwrap());
    assert_eq!(out.samples, [1, 2]);
    queue.push(ticket, FORMAT, 1, Instant::now(), &[3]).unwrap();
    assert!(queue.pop_into(&mut out).unwrap());
    assert_eq!(out.samples, [3]);
}

#[test]
fn simultaneous_capture_and_dequeue_do_not_report_contention_or_lose_samples() {
    let queue = queue(4, 8192);
    let (sent, received) = std::sync::mpsc::sync_channel(1);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let samples = [1234; 8192];
            for sequence in 0..10_000 {
                queue
                    .push(queue.ticket(), FORMAT, sequence, Instant::now(), &samples)
                    .unwrap();
                sent.send(sequence).unwrap();
            }
        });
        let mut packet = Packet::new(8192);
        for _ in 0..10_000 {
            let sequence = received.recv().unwrap();
            assert!(queue.pop_into(&mut packet).unwrap());
            assert_eq!(packet.sequence, sequence);
            assert_eq!(packet.samples, [1234; 8192]);
        }
    });
}

#[test]
fn discarding_backlog_releases_capacity_for_fresh_ordered_capture() {
    let queue = queue(2, 4);
    for sequence in 0..2 {
        queue
            .push(queue.ticket(), FORMAT, sequence, Instant::now(), &[1])
            .unwrap();
    }
    queue.discard();
    queue
        .push(queue.ticket(), FORMAT, 3, Instant::now(), &[9])
        .unwrap();
    let mut packet = Packet::new(4);
    assert!(queue.pop_into(&mut packet).unwrap());
    assert_eq!(packet.samples, [9]);
    assert!(!queue.pop_into(&mut packet).unwrap());
}

#[test]
fn format_packet_order_and_timestamp_errors_do_not_consume_capacity() {
    let queue = queue(2, 4);
    let ticket = queue.ticket();
    let at = Instant::now();
    for format in [
        Format {
            sample_rate: 24_000,
            channels: 1,
        },
        Format {
            channels: 2,
            ..FORMAT
        },
    ] {
        assert_eq!(
            queue.push(ticket, format, 0, at, &[1]),
            Err(Error::InvalidFormat)
        );
    }
    for samples in [&[][..], &[0; 5][..]] {
        assert_eq!(
            queue.push(ticket, FORMAT, 0, at, samples),
            Err(Error::InvalidPacket)
        );
    }
    assert_eq!(
        queue.push_le(ticket, FORMAT, 0, at, &[0]),
        Err(Error::InvalidPacket)
    );
    assert_eq!(
        queue.push(ticket, FORMAT, 0, at + Duration::from_secs(1), &[0]),
        Err(Error::InvalidPacket)
    );
    assert_eq!(
        queue.push(
            ticket,
            FORMAT,
            0,
            at.checked_sub(Duration::from_secs(2)).unwrap(),
            &[0]
        ),
        Err(Error::Expired)
    );
    queue.push(ticket, FORMAT, 1, at, &[1]).unwrap();
    assert_eq!(
        queue.push(ticket, FORMAT, 1, at, &[1]),
        Err(Error::OutOfOrder)
    );
    assert_eq!(
        queue.push(
            ticket,
            FORMAT,
            2,
            at.checked_sub(Duration::from_millis(1)).unwrap(),
            &[1]
        ),
        Err(Error::OutOfOrder)
    );
    queue.push(ticket, FORMAT, 2, Instant::now(), &[2]).unwrap();
}

#[test]
fn mute_unmute_cancels_queued_and_already_dequeued_tickets() {
    let queue = queue(1, 4);
    let old = queue.ticket();
    queue.push(old, FORMAT, 0, Instant::now(), &[11]).unwrap();
    let mut out = Packet::new(4);
    assert!(queue.pop_into(&mut out).unwrap());
    queue.push(old, FORMAT, 1, Instant::now(), &[12]).unwrap();
    assert!(queue.set_muted(true));
    assert!(!queue.set_muted(true));
    assert!(!queue.accepts(out.ticket));
    assert!(queue.set_muted(false));
    assert!(!queue.set_muted(false));
    assert_eq!(
        queue.push(old, FORMAT, 2, Instant::now(), &[13]),
        Err(Error::Stale)
    );
    let fresh = queue.ticket();
    queue.push(fresh, FORMAT, 0, Instant::now(), &[21]).unwrap();
    assert!(queue.pop_into(&mut out).unwrap());
    assert_eq!(out.samples, [21]);
}

#[test]
fn teardown_and_replacement_never_admit_another_sessions_ticket() {
    let old = queue(1, 4);
    let old_ticket = old.ticket();
    old.push(old_ticket, FORMAT, 0, Instant::now(), &[1])
        .unwrap();
    old.close();
    assert!(!old.accepts(old_ticket));
    assert_eq!(old.pop_into(&mut Packet::new(4)), Err(Error::Closed));
    assert!(
        old.push(old_ticket, FORMAT, 1, Instant::now(), &[1])
            .is_err()
    );
    let next = queue(1, 4);
    assert_ne!(old_ticket.session, next.ticket().session);
    assert_eq!(
        next.push(old_ticket, FORMAT, 0, Instant::now(), &[1]),
        Err(Error::Stale)
    );
}

#[test]
fn configuration_and_consumer_storage_are_bounded() {
    for (packets, samples) in [(0, 1), (1, 0), (usize::MAX, 2), (1024, 2048)] {
        assert!(
            Ingress::new(
                FORMAT,
                Limits {
                    packets,
                    samples_per_packet: samples,
                    max_age: Duration::from_secs(1)
                }
            )
            .is_err()
        );
    }
    let queue = queue(1, 4);
    assert_eq!(
        queue.pop_into(&mut Packet::new(2)),
        Err(Error::InvalidPacket)
    );
}

#[test]
fn realtime_gate_fences_rapid_toggles_without_changing_repeated_controls() {
    let gate = InputGate::new(false);
    let before = gate.generation();
    assert!(!gate.set_muted(false));
    assert!(gate.accepts(before));
    assert!(gate.set_muted(true));
    assert!(!gate.accepts(before));
    assert!(gate.set_muted(false));
    assert!(!gate.accepts(before));
    assert!(gate.accepts(gate.generation()));
}
