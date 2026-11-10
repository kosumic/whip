use super::*;
use crate::{Capture, FRAME, Host, Playback, RATE, Statistics, Tag, playout::Playout};
use std::sync::atomic::AtomicBool;

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

// Model already accepted/authenticated RTP. Use the producer's admission lock
// and actual packet/byte leases so sealing, backlogs and epoch disposal run
// through production Incoming rather than a second test queue.
fn enqueue(
    ingress: &Ingress,
    sequence: u16,
    timestamp: u32,
    payload: &[u8],
    at: Instant,
    reliable: bool,
) -> bool {
    let epoch = ingress.state.epoch.lock();
    if *epoch % 2 == 1 {
        return false;
    }
    let mut data = vec![0x80, crate::audio_track::OPUS_PAYLOAD_TYPE];
    data.extend_from_slice(&sequence.to_be_bytes());
    data.extend_from_slice(&timestamp.to_be_bytes());
    data.extend_from_slice(&1_u32.to_be_bytes());
    data.extend_from_slice(payload);
    let packet = ingress.state.packets.clone().try_acquire_owned().unwrap();
    let bytes = ingress
        .state
        .bytes
        .clone()
        .try_acquire_many_owned(data.len() as u32)
        .unwrap();
    ingress
        .sender
        .try_send(ReceivedRtp {
            data,
            at,
            reliable,
            epoch: *epoch,
            _packet: packet,
            _bytes: bytes,
        })
        .is_ok()
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
        for frames in [20, PACKETS] {
            let now = Instant::now();
            let app = App::new();
            let (mut incoming, ingress) = Incoming::new();
            let mut playout = Playout::new()?;
            playout.tick(&app, &mut incoming, now)?;
            let (packets, expected) = speech(frames)?;
            for (sequence, packet) in packets.iter().enumerate() {
                assert!(enqueue(
                    &ingress,
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
        let (mut incoming, ingress) = Incoming::new();
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
                    &ingress,
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
        let (mut incoming, ingress) = Incoming::new();
        let mut playout = Playout::new()?;
        playout.tick(&app, &mut incoming, now)?;
        let (packets, _) = speech(timestamps.len())?;
        for (sequence, timestamp) in timestamps.iter().enumerate() {
            assert!(enqueue(
                &ingress,
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
    let (mut incoming, ingress) = Incoming::new();
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
                &ingress,
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
    let (mut incoming, ingress) = Incoming::new();
    let mut playout = Playout::new()?;
    playout.tick(&app, &mut incoming, now)?;
    let (packets, expected) = speech(1)?;
    app.stop(now);
    for ms in (0..=300).step_by(5) {
        let at = now + Duration::from_millis(ms);
        enqueue(&ingress, 0, 0, &packets[0], at, false);
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
        let (mut incoming, ingress) = Incoming::new();
        let mut playout = Playout::new()?;
        playout.tick(&app, &mut incoming, now)?;
        let (packets, _) = speech(20)?;
        for (sequence, packet) in packets.iter().enumerate() {
            assert!(enqueue(
                &ingress,
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
            &ingress,
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
    let (mut incoming, ingress) = Incoming::new();
    let mut playout = Playout::new()?;
    playout.tick(&app, &mut incoming, now)?;
    let (packets, expected) = speech(22)?;
    for (sequence, packet) in packets[..20].iter().enumerate() {
        assert!(enqueue(
            &ingress,
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
        &ingress,
        20,
        20 * RTP_TICKS,
        &packets[20],
        now + Duration::from_millis(205),
        true
    ));
    assert!(enqueue(
        &ingress,
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
