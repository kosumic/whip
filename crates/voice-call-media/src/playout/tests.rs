use super::*;
use crate::{Capture, FRAME, Host, Playback, RATE, Statistics, Tag, playout::Playout};
use std::sync::atomic::{AtomicBool, Ordering};

type TestResult = Result<(), Box<dyn std::error::Error>>;
const STEP: Duration = Duration::from_millis(5);
const RTP_TICKS: u32 = 960;

struct Sink {
    playback: Playback,
    samples: Vec<i16>,
    decoded: u64,
    concealed: u64,
    queued: u64,
    finished: Vec<String>,
    replace_on_finish: Option<Playback>,
    cancel_on_render: bool,
    ingress: super::Statistics,
}
struct App {
    sink: Mutex<Sink>,
    current: AtomicBool,
}
fn playback(response: &str, epoch: u64) -> Playback {
    Playback {
        epoch,
        enabled: true,
        tag: Some(Tag {
            response: response.into(),
            item: response.into(),
            index: 0,
        }),
        ..Default::default()
    }
}
impl App {
    fn new() -> Self {
        Self {
            sink: Mutex::new(Sink {
                playback: playback("reply", 1),
                samples: Vec::new(),
                decoded: 0,
                concealed: 0,
                queued: 0,
                finished: Vec::new(),
                replace_on_finish: None,
                cancel_on_render: false,
                ingress: super::Statistics::default(),
            }),
            current: AtomicBool::new(true),
        }
    }
    fn stop(&self, now: Instant) {
        self.sink.lock().playback.stopped_at = Some(now);
    }
    fn cancel(&self) {
        let mut sink = self.sink.lock();
        sink.playback.epoch += 1;
        sink.playback.enabled = false;
        sink.playback.stopped_at = None;
    }
}
impl Capture for App {
    fn packet_samples(&self) -> usize {
        FRAME
    }
    fn generation(&self) -> u64 {
        1
    }
    fn accepts(&self, _: u64) -> bool {
        true
    }
    fn capture_enabled(&self) -> bool {
        true
    }
    fn recover(&self) -> bool {
        false
    }
    fn reset_capture(&self) -> Result<(), &'static str> {
        Ok(())
    }
    async fn next_capture(&self, _: &mut audio_ingress::Packet) -> Result<bool, &'static str> {
        std::future::pending().await
    }
    fn process_capture(&self, _: &mut audio_ingress::Packet) -> Result<(), &'static str> {
        Ok(())
    }
}
impl Host for App {
    fn current(&self) -> bool {
        self.current.load(Ordering::Acquire)
    }
    fn playback(&self) -> Playback {
        self.sink.lock().playback.clone()
    }
    fn render(&self, epoch: u64, _: &Tag, pcm: &[i16]) -> Result<bool, &'static str> {
        let mut sink = self.sink.lock();
        if sink.cancel_on_render {
            sink.cancel_on_render = false;
            sink.playback.epoch += 1;
            sink.playback.enabled = false;
        }
        if !self.current() || epoch != sink.playback.epoch || !sink.playback.enabled {
            return Ok(false);
        }
        sink.samples.extend_from_slice(pcm);
        Ok(true)
    }
    fn finish(&self, snapshot: &Playback) -> bool {
        let mut sink = self.sink.lock();
        if let Some(next) = sink.replace_on_finish.take() {
            sink.playback = next;
        }
        if !self.current()
            || !sink.playback.enabled
            || sink.playback.epoch != snapshot.epoch
            || sink.playback.tag != snapshot.tag
            || snapshot.stopped_at.is_none()
            || sink.playback.stopped_at != snapshot.stopped_at
        {
            return false;
        }
        sink.playback.enabled = false;
        sink.playback.stopped_at = None;
        sink.finished
            .push(snapshot.tag.as_ref().unwrap().response.clone());
        true
    }
    fn statistics(&self, delta: Statistics) {
        let mut sink = self.sink.lock();
        sink.decoded += delta.decoded_packets;
        sink.concealed += delta.concealed_samples;
        sink.queued += delta.queued_samples;
        sink.ingress += delta.ingress;
    }
    fn uploaded(&self) {}
}

// Build a continuous, non-silent Opus stream and its expected PCM using an
// independent decoder. Exact PCM comparison detects decoder resets at stops.
fn speech(frames: usize) -> Result<(Vec<Vec<u8>>, Vec<i16>), opus::Error> {
    let mut encoder =
        opus::Encoder::new(RATE as u32, opus::Channels::Mono, opus::Application::Voip)?;
    let mut decoder = opus::Decoder::new(RATE as u32, opus::Channels::Mono)?;
    let mut packets = Vec::new();
    let mut expected = Vec::new();
    let mut encoded = [0; 1275];
    let mut decoded = [0; FRAME];
    for frame in 0..frames {
        let samples: Vec<_> = (0..FRAME)
            .map(|sample| {
                let phase =
                    (frame * FRAME + sample) as f32 * 440.0 * std::f32::consts::TAU / RATE as f32;
                (phase.sin() * 8000.0) as i16
            })
            .collect();
        let count = encoder.encode(&samples, &mut encoded)?;
        let packet = encoded[..count].to_vec();
        let count = decoder.decode(&packet, &mut decoded, false)?;
        expected.extend_from_slice(&decoded[..count]);
        packets.push(packet);
    }
    Ok((packets, expected))
}

#[test]
fn delayed_udp_speech_is_not_replaced_with_repeated_concealment() -> TestResult {
    let now = Instant::now();
    let app = App::new();
    let (mut incoming, mut ingress) = Incoming::new();
    let mut playout = Playout::new()?;
    playout.tick(&app, &mut incoming, now)?;
    let (packets, expected) = speech(40)?;
    for ms in (0..=2000).step_by(5) {
        let at = now + Duration::from_millis(ms);
        for (sequence, packet) in packets.iter().enumerate() {
            // A transport stall, then an ordered burst. No packet was lost.
            let arrival = if sequence < 10 {
                sequence * 20
            } else {
                (sequence * 20 + 100).max(380)
            };
            if ms as usize == arrival {
                assert!(enqueue(
                    &mut ingress,
                    sequence as u16,
                    sequence as u32 * RTP_TICKS,
                    packet,
                    at,
                    false,
                ));
            }
        }
        if ms == 900 {
            app.stop(at);
        }
        playout.tick(&app, &mut incoming, at)?;
    }
    let sink = app.sink.lock();
    assert_eq!(sink.decoded, packets.len() as u64);
    assert_eq!(sink.concealed, 0, "delay alone is not packet loss");
    assert_eq!(sink.samples, expected, "every syllable must play once");
    assert_eq!(sink.finished, ["reply"]);
    Ok(())
}

// Feed the exact admission method used for authenticated str0m RTP, including
// all limits, age policy, channel handling and seal synchronization.
fn enqueue(
    ingress: &mut Ingress,
    sequence: u16,
    timestamp: u32,
    payload: &[u8],
    at: Instant,
    reliable: bool,
) -> bool {
    ingress.receive(
        &str0m::rtp::RtpHeader {
            payload_type: crate::audio_track::OPUS_PAYLOAD_TYPE.into(),
            sequence_number: sequence,
            timestamp,
            ssrc: 1.into(),
            ..Default::default()
        },
        payload,
        at,
        reliable,
    ) == Outcome::Accepted
}
fn advance(
    playout: &mut Playout,
    app: &App,
    incoming: &mut Incoming,
    from: Instant,
    through: Instant,
) -> TestResult {
    let mut now = from;
    while now <= through {
        playout.tick(app, incoming, now)?;
        now += STEP;
    }
    Ok(())
}

#[test]
fn queued_speech_outlives_stop_grace_and_even_the_tail_admission_cap() -> TestResult {
    for reliable in [false, true] {
        for frames in [20, 64] {
            let now = Instant::now();
            let app = App::new();
            let (mut incoming, mut ingress) = Incoming::new();
            let mut playout = Playout::new()?;
            playout.tick(&app, &mut incoming, now)?;
            let (packets, expected) = speech(frames)?;
            for (sequence, packet) in packets.iter().enumerate() {
                assert!(enqueue(
                    &mut ingress,
                    sequence as u16,
                    sequence as u32 * RTP_TICKS,
                    packet,
                    now,
                    reliable
                ));
            }
            app.stop(now);
            advance(
                &mut playout,
                &app,
                &mut incoming,
                now,
                now + Duration::from_millis(200),
            )?;
            assert!(
                app.playback().enabled,
                "queued words must prevent completion"
            );
            advance(
                &mut playout,
                &app,
                &mut incoming,
                now + Duration::from_millis(205),
                now + Duration::from_secs(2),
            )?;
            let sink = app.sink.lock();
            assert_eq!(sink.samples, expected);
            assert_eq!(sink.decoded, frames as u64);
            assert_eq!(sink.concealed, 0);
            assert_eq!(sink.queued as usize, expected.len());
            assert_eq!(sink.finished, ["reply"]);
        }
    }
    Ok(())
}

#[test]
fn late_bursts_and_a_packet_after_the_backlog_drains_are_still_played() -> TestResult {
    for reliable in [false, true] {
        let now = Instant::now();
        let app = App::new();
        let (mut incoming, mut ingress) = Incoming::new();
        let mut playout = Playout::new()?;
        playout.tick(&app, &mut incoming, now)?;
        let (packets, expected) = speech(27)?;
        for ms in (0..=1100).step_by(5) {
            let at = now + Duration::from_millis(ms);
            let burst = match ms {
                0 => 0..20,
                300 => 20..26,
                650 => 26..27,
                _ => 0..0,
            };
            for sequence in burst {
                assert!(enqueue(
                    &mut ingress,
                    sequence as u16,
                    sequence as u32 * RTP_TICKS,
                    &packets[sequence],
                    at,
                    reliable
                ));
            }
            if ms == 650 {
                assert!(app.playback().enabled);
            }
            if ms == 0 {
                app.stop(at);
            }
            playout.tick(&app, &mut incoming, at)?;
        }
        let sink = app.sink.lock();
        assert_eq!(sink.samples, expected);
        assert_eq!(sink.finished, ["reply"]);
    }
    Ok(())
}

#[test]
fn idle_loss_and_large_timestamp_gaps_complete_within_a_bound() -> TestResult {
    for timestamps in [vec![], vec![0], vec![0, 1920], vec![0, 28_800_000]] {
        let now = Instant::now();
        let app = App::new();
        let (mut incoming, mut ingress) = Incoming::new();
        let mut playout = Playout::new()?;
        playout.tick(&app, &mut incoming, now)?;
        let (packets, _) = speech(timestamps.len())?;
        for (sequence, timestamp) in timestamps.iter().enumerate() {
            assert!(enqueue(
                &mut ingress,
                sequence as u16,
                *timestamp,
                &packets[sequence],
                now,
                false
            ));
        }
        app.stop(now);
        advance(
            &mut playout,
            &app,
            &mut incoming,
            now,
            now + Duration::from_millis(500),
        )?;
        let sink = app.sink.lock();
        assert_eq!(sink.finished, ["reply"]);
        assert_eq!(sink.decoded, timestamps.len() as u64);
        assert!(sink.concealed <= FRAME as u64);
    }
    Ok(())
}

#[test]
fn continuous_tail_rtp_cannot_hold_completion_open() -> TestResult {
    let now = Instant::now();
    let app = App::new();
    let (mut incoming, mut ingress) = Incoming::new();
    let mut playout = Playout::new()?;
    playout.tick(&app, &mut incoming, now)?;
    let (packets, _) = speech(75)?;
    app.stop(now);
    let mut accepted = 0;
    for ms in (0..=1500).step_by(5) {
        let at = now + Duration::from_millis(ms);
        if ms % 20 == 0 && ms < 1500 {
            let sequence = ms as usize / 20;
            accepted += usize::from(enqueue(
                &mut ingress,
                sequence as u16,
                sequence as u32 * RTP_TICKS,
                &packets[sequence],
                at,
                true,
            ));
        }
        playout.tick(&app, &mut incoming, at)?;
    }
    let sink = app.sink.lock();
    assert_eq!(sink.finished, ["reply"]);
    assert_eq!(sink.decoded as usize, accepted);
    assert!(accepted < packets.len());
    assert_eq!(sink.concealed, 0);
    Ok(())
}

#[test]
fn duplicate_tail_packets_cannot_extend_an_idle_response() -> TestResult {
    let now = Instant::now();
    let app = App::new();
    let (mut incoming, mut ingress) = Incoming::new();
    let mut playout = Playout::new()?;
    playout.tick(&app, &mut incoming, now)?;
    let (packets, expected) = speech(1)?;
    app.stop(now);
    for ms in (0..=300).step_by(5) {
        let at = now + Duration::from_millis(ms);
        enqueue(&mut ingress, 0, 0, &packets[0], at, false);
        playout.tick(&app, &mut incoming, at)?;
    }
    let sink = app.sink.lock();
    assert_eq!(sink.samples, expected);
    assert_eq!(sink.decoded, 1);
    assert_eq!(sink.finished, ["reply"]);
    Ok(())
}

#[test]
fn cancellation_epoch_change_and_teardown_discard_stale_tail_promptly() -> TestResult {
    for control in ["cancel", "epoch", "teardown", "cancel_during_render"] {
        let now = Instant::now();
        let app = App::new();
        let (mut incoming, mut ingress) = Incoming::new();
        let mut playout = Playout::new()?;
        playout.tick(&app, &mut incoming, now)?;
        let (packets, _) = speech(20)?;
        for (sequence, packet) in packets.iter().enumerate() {
            assert!(enqueue(
                &mut ingress,
                sequence as u16,
                sequence as u32 * RTP_TICKS,
                packet,
                now,
                true
            ));
        }
        app.stop(now);
        advance(
            &mut playout,
            &app,
            &mut incoming,
            now,
            now + Duration::from_millis(100),
        )?;
        let heard = app.sink.lock().samples.len();
        // Leave a packet in raw ingress too, to test invalidation at both queues.
        assert!(enqueue(
            &mut ingress,
            20,
            20 * RTP_TICKS,
            &packets[0],
            now + Duration::from_millis(101),
            true
        ));
        match control {
            "cancel" => app.cancel(),
            "epoch" => app.sink.lock().playback = playback("new", 2),
            "teardown" => app.current.store(false, Ordering::Release),
            _ => app.sink.lock().cancel_on_render = true,
        }
        advance(
            &mut playout,
            &app,
            &mut incoming,
            now + Duration::from_millis(105),
            now + Duration::from_secs(2),
        )?;
        let sink = app.sink.lock();
        assert_eq!(sink.samples.len(), heard, "{control} replayed old speech");
        assert!(
            sink.finished.is_empty(),
            "{control} committed an old finish"
        );
        if control == "epoch" {
            assert!(sink.playback.enabled);
        }
    }
    Ok(())
}

#[test]
fn normal_response_boundary_preserves_decoder_and_rejects_prior_completion() -> TestResult {
    let now = Instant::now();
    let app = App::new();
    let (mut incoming, mut ingress) = Incoming::new();
    let mut playout = Playout::new()?;
    playout.tick(&app, &mut incoming, now)?;
    let (packets, expected) = speech(22)?;
    for (sequence, packet) in packets[..20].iter().enumerate() {
        assert!(enqueue(
            &mut ingress,
            sequence as u16,
            sequence as u32 * RTP_TICKS,
            packet,
            now,
            true
        ));
    }
    app.stop(now);
    advance(
        &mut playout,
        &app,
        &mut incoming,
        now,
        now + Duration::from_millis(200),
    )?;
    app.sink.lock().playback = playback("next", 1);
    assert!(enqueue(
        &mut ingress,
        20,
        20 * RTP_TICKS,
        &packets[20],
        now + Duration::from_millis(205),
        true
    ));
    assert!(enqueue(
        &mut ingress,
        21,
        21 * RTP_TICKS,
        &packets[21],
        now + Duration::from_millis(205),
        true
    ));
    advance(
        &mut playout,
        &app,
        &mut incoming,
        now + Duration::from_millis(205),
        now + Duration::from_millis(700),
    )?;
    assert!(app.playback().enabled);
    assert!(app.sink.lock().finished.is_empty());
    // A start/stop can race the final completion callback without changing
    // the continuous Opus epoch. The old snapshot cannot finish that response.
    app.stop(now + Duration::from_millis(700));
    let mut newest = playback("newest", 1);
    newest.stopped_at = Some(now + Duration::from_millis(860));
    app.sink.lock().replace_on_finish = Some(newest);
    advance(
        &mut playout,
        &app,
        &mut incoming,
        now + Duration::from_millis(705),
        now + Duration::from_millis(860),
    )?;
    assert!(app.playback().enabled);
    assert!(app.sink.lock().finished.is_empty());
    advance(
        &mut playout,
        &app,
        &mut incoming,
        now + Duration::from_millis(865),
        now + Duration::from_millis(1050),
    )?;
    let sink = app.sink.lock();
    assert_eq!(sink.samples, expected);
    assert_eq!(sink.finished, ["newest"]);
    Ok(())
}

#[test]
fn reliable_paused_burst_and_slow_resume_preserve_exact_speech_through_seal() -> TestResult {
    const FRAMES: usize = 300;
    let now = Instant::now();
    let app = App::new();
    let (mut incoming, mut ingress) = Incoming::new();
    let mut playout = Playout::new()?;
    playout.tick(&app, &mut incoming, now)?;
    let (packets, expected) = speech(FRAMES)?;
    // Simulate an already delayed reliable burst, then a completely paused
    // consumer. Both old wall-clock age checks used to delete this speech.
    let arrived = now - Duration::from_secs(2);
    for (sequence, packet) in packets.iter().enumerate() {
        assert!(enqueue(
            &mut ingress,
            sequence as u16,
            sequence as u32 * RTP_TICKS,
            packet,
            arrived,
            true
        ));
    }
    app.stop(now);
    // The first consumer tick occurs beyond the one-second admission cap:
    // seal the real ingress first, then drain all 300 accepted packets slowly.
    for ms in (1100..=7500).step_by(100) {
        playout.tick(&app, &mut incoming, now + Duration::from_millis(ms))?;
    }
    let sink = app.sink.lock();
    assert_eq!(sink.samples, expected);
    assert_eq!(sink.decoded, FRAMES as u64);
    assert_eq!(sink.concealed, 0);
    assert_eq!(sink.finished, ["reply"]);
    assert_eq!(sink.ingress.accepted_packets, FRAMES as u64);
    assert_eq!(sink.ingress.reliable_failures, 0);
    drop(sink);
    assert!(!enqueue(
        &mut ingress,
        FRAMES as u16,
        FRAMES as u32 * RTP_TICKS,
        &packets[0],
        now,
        true
    ));
    assert_eq!(incoming.take_statistics().suppressed_packets, 1);
    assert_eq!(ingress.state.packets.available_permits(), PACKETS);
    assert_eq!(ingress.state.bytes.available_permits(), BYTES);
    assert_eq!(ingress.state.audio.available_permits(), AUDIO_SAMPLES);
    Ok(())
}

#[test]
fn decoded_leases_release_capacity_for_the_next_reliable_burst() -> TestResult {
    let now = Instant::now();
    let app = App::new();
    let (mut incoming, mut ingress) = Incoming::new();
    let mut playout = Playout::new()?;
    playout.tick(&app, &mut incoming, now)?;
    let (packets, expected) = speech(600)?;
    for (sequence, payload) in packets[..300].iter().enumerate() {
        assert!(enqueue(
            &mut ingress,
            sequence as u16,
            sequence as u32 * RTP_TICKS,
            payload,
            now,
            true
        ));
    }
    advance(
        &mut playout,
        &app,
        &mut incoming,
        now,
        now + Duration::from_secs(5),
    )?;
    // Decoding (not transfer to jitter) releases the shared duration budget.
    for (sequence, payload) in packets.iter().enumerate().skip(300) {
        assert!(enqueue(
            &mut ingress,
            sequence as u16,
            sequence as u32 * RTP_TICKS,
            payload,
            now + Duration::from_secs(5),
            true
        ));
    }
    app.stop(now + Duration::from_secs(5));
    advance(
        &mut playout,
        &app,
        &mut incoming,
        now + Duration::from_millis(5005),
        now + Duration::from_secs(13),
    )?;
    let sink = app.sink.lock();
    assert_eq!(sink.samples, expected);
    assert_eq!(sink.decoded, 600);
    assert_eq!(sink.finished, ["reply"]);
    Ok(())
}

#[test]
fn all_retention_limits_are_bounded_and_observable_for_each_transport() -> TestResult {
    let mut encoder = opus::Encoder::new(
        RATE as u32,
        opus::Channels::Mono,
        opus::Application::LowDelay,
    )?;
    let mut tiny = vec![0; 1275];
    let count = encoder.encode(&[0; RATE / 400], &mut tiny)?;
    tiny.truncate(count);
    assert_eq!(
        opus::packet::get_nb_samples(&tiny, RATE as u32)?,
        RATE / 400
    );
    let normal = vec![0xf8, 0xff, 0xfe];
    let mut large = normal.clone();
    large.resize(PACKET_BYTES - 12, 0);
    opus::packet::pad(&mut large, normal.len())?;
    for reliable in [false, true] {
        for (payload, limit, kind) in [
            (&tiny, PACKETS, "packet"),
            (&large, BYTES / (PACKET_BYTES * 2), "byte"),
            (&normal, AUDIO_SAMPLES / FRAME, "audio"),
        ] {
            let now = Instant::now();
            let (mut incoming, mut ingress) = Incoming::new();
            incoming.set_suppressed(false)?;
            for sequence in 0..limit {
                assert!(
                    enqueue(
                        &mut ingress,
                        sequence as u16,
                        sequence as u32 * RTP_TICKS,
                        payload,
                        now,
                        reliable
                    ),
                    "{kind} {sequence}"
                );
            }
            assert!(!enqueue(
                &mut ingress,
                limit as u16,
                limit as u32 * RTP_TICKS,
                payload,
                now,
                reliable
            ));
            let stats = incoming.take_statistics();
            assert_eq!(stats.accepted_packets, limit as u64);
            assert_eq!(stats.packet_limit_drops, u64::from(kind == "packet"));
            assert_eq!(stats.byte_limit_drops, u64::from(kind == "byte"));
            assert_eq!(stats.audio_limit_drops, u64::from(kind == "audio"));
            assert_eq!(stats.reliable_failures, u64::from(reliable));
            if reliable {
                assert!(matches!(incoming.take(), Err(OVERLOAD)));
                // A failed reliable stream never silently resumes fragments.
                assert!(!enqueue(&mut ingress, 0, 0, payload, now, true));
                assert_eq!(incoming.take_statistics().failed_packets, 1);
            } else {
                // UDP drops newest, preserving all accepted raw packets in order.
                for sequence in 0..limit {
                    let received = incoming.take()?.ok_or("missing accepted UDP")?;
                    let parsed = crate::packet::parse(received.as_ref()).ok_or("invalid UDP")?;
                    assert_eq!(parsed.sequence, sequence as u16);
                    assert_eq!(&parsed.payload, payload);
                }
                assert!(enqueue(
                    &mut ingress,
                    limit as u16 + 1,
                    0,
                    payload,
                    now,
                    false
                ));
            }
            // Cancellation remains immediate even after a sticky failure.
            incoming.set_suppressed(true)?;
            incoming.discard(0);
            assert_eq!(ingress.state.packets.available_permits(), PACKETS);
            assert_eq!(ingress.state.bytes.available_permits(), BYTES);
            assert_eq!(ingress.state.audio.available_permits(), AUDIO_SAMPLES);
        }
    }
    Ok(())
}

#[test]
fn limits_follow_packets_into_jitter_and_failure_reaches_host_diagnostics() -> TestResult {
    let now = Instant::now();
    let app = App::new();
    let (mut incoming, mut ingress) = Incoming::new();
    let mut playout = Playout::new()?;
    playout.tick(&app, &mut incoming, now)?;
    let payload = [0xf8, 0xff, 0xfe];
    for sequence in 0..AUDIO_SAMPLES / FRAME {
        assert!(enqueue(
            &mut ingress,
            sequence as u16,
            sequence as u32 * RTP_TICKS,
            &payload,
            now,
            true
        ));
    }
    // Pull packets into real jitter without decoding (reorder deadline isn't due).
    playout.tick(&app, &mut incoming, now)?;
    assert_eq!(ingress.state.audio.available_permits(), 0);
    assert!(!enqueue(
        &mut ingress,
        400,
        400 * RTP_TICKS,
        &payload,
        now,
        true
    ));
    assert_eq!(playout.tick(&app, &mut incoming, now), Err(OVERLOAD));
    assert_eq!(app.sink.lock().ingress.audio_limit_drops, 1);
    assert_eq!(app.sink.lock().ingress.reliable_failures, 1);
    app.cancel();
    playout.tick(&app, &mut incoming, now)?;
    assert_eq!(ingress.state.audio.available_permits(), AUDIO_SAMPLES);
    assert_eq!(
        app.sink.lock().ingress.retired_packets,
        (AUDIO_SAMPLES / FRAME) as u64
    );
    assert!(app.sink.lock().samples.is_empty());
    Ok(())
}

#[test]
fn stale_udp_suppression_and_epoch_retirement_have_separate_counters() -> TestResult {
    let now = Instant::now();
    let old = now - Duration::from_secs(2);
    let (mut incoming, mut ingress) = Incoming::new();
    let payload = [0xf8, 0xff, 0xfe];
    assert!(!enqueue(&mut ingress, 0, 0, &payload, now, true));
    incoming.set_suppressed(false)?;
    assert!(!enqueue(&mut ingress, 0, 0, &payload, old, false));
    assert!(enqueue(&mut ingress, 0, 0, &payload, old, true));
    incoming.set_suppressed(true)?;
    incoming.set_suppressed(false)?;
    assert!(incoming.take()?.is_none());
    assert!(enqueue(&mut ingress, 1, RTP_TICKS, &payload, now, true));
    assert!(incoming.take()?.is_some());
    assert_eq!(
        incoming.take_statistics(),
        super::Statistics {
            accepted_packets: 2,
            suppressed_packets: 1,
            stale_packets: 1,
            retired_packets: 1,
            ..Default::default()
        }
    );
    assert_eq!(incoming.take_statistics(), super::Statistics::default());
    Ok(())
}

#[test]
fn closed_consumer_and_invalid_media_are_explicit_and_release_all_leases() -> TestResult {
    let now = Instant::now();
    let (incoming, mut ingress) = Incoming::new();
    incoming.set_suppressed(false)?;
    drop(incoming);
    assert!(!enqueue(&mut ingress, 0, 0, &[0xf8, 0xff, 0xfe], now, true));
    assert_eq!(ingress.state.admission.lock().statistics.closed_packets, 1);
    assert_eq!(ingress.state.packets.available_permits(), PACKETS);
    assert_eq!(ingress.state.bytes.available_permits(), BYTES);
    assert_eq!(ingress.state.audio.available_permits(), AUDIO_SAMPLES);
    let (mut incoming, mut ingress) = Incoming::new();
    incoming.set_suppressed(false)?;
    assert!(!enqueue(&mut ingress, 0, 0, &[], now, true));
    assert_eq!(incoming.take_statistics().invalid_packets, 1);
    assert!(incoming.take().is_err());
    Ok(())
}

#[test]
fn full_backlog_can_be_cancelled_replaced_or_torn_down_without_waiting() -> TestResult {
    for control in ["cancel", "replace", "teardown"] {
        let now = Instant::now();
        let app = App::new();
        let (mut incoming, mut ingress) = Incoming::new();
        let mut playout = Playout::new()?;
        playout.tick(&app, &mut incoming, now)?;
        let payload = [0xf8, 0xff, 0xfe];
        for sequence in 0..AUDIO_SAMPLES / FRAME {
            assert!(enqueue(
                &mut ingress,
                sequence as u16,
                sequence as u32 * RTP_TICKS,
                &payload,
                now,
                true
            ));
        }
        // Keep leases in BOTH raw ingress and production jitter.
        playout.tick(&app, &mut incoming, now)?;
        assert_eq!(ingress.state.audio.available_permits(), 0);
        match control {
            "cancel" => app.cancel(),
            "replace" => app.sink.lock().playback = playback("replacement", 2),
            _ => app.current.store(false, Ordering::Release),
        }
        playout.tick(&app, &mut incoming, now)?;
        if control == "replace" {
            assert!(enqueue(&mut ingress, 500, 0, &payload, now, true));
            app.stop(now);
            advance(
                &mut playout,
                &app,
                &mut incoming,
                now,
                now + Duration::from_secs(1),
            )?;
            assert_eq!(app.sink.lock().decoded, 1);
            assert_eq!(app.sink.lock().finished, ["replacement"]);
        } else {
            assert!(app.sink.lock().samples.is_empty());
        }
        // Matches media-loop/transport teardown: dropping both owners releases
        // every lease even when no consumer tick can run again.
        drop(playout);
        drop(incoming);
        assert_eq!(ingress.state.packets.available_permits(), PACKETS);
        assert_eq!(ingress.state.bytes.available_permits(), BYTES);
        assert_eq!(ingress.state.audio.available_permits(), AUDIO_SAMPLES);
    }
    Ok(())
}
