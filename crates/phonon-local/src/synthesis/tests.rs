use super::*;
use std::cell::Cell;

thread_local! {
    static LOADS: Cell<usize> = const { Cell::new(0) };
    static CURRENT: Cell<bool> = const { Cell::new(true) };
}

// A model-free engine exercises the same cache, cancellation, and streaming
// contract as CPU/Core ML. Integration with real inference is explicitly opt-in.
struct FakeEngine;
impl Engine for FakeEngine {
    fn load(path: &Path) -> Result<Self, String> {
        LOADS.set(LOADS.get() + 1);
        if path == Path::new("cancel-on-load") {
            CURRENT.set(false);
        }
        if path == Path::new("cancel-on-failed-load") {
            CURRENT.set(false);
            return Err("cancelled load failed".into());
        }
        if path == Path::new("broken") {
            return Err("load failed".into());
        }
        Ok(Self)
    }
    fn speak(
        &mut self,
        text: &str,
        voice: &str,
        sink: &mut dyn FnMut(&[f32]) -> bool,
    ) -> Result<(), String> {
        if voice != "test-voice" {
            return Err("unknown voice".into());
        }
        if text == "broken" {
            return Err("inference failed".into());
        }
        let pcm = vec![0.25; PCM_CHUNK_SAMPLES * 3 + 1];
        if !sink(&pcm) {
            // Model a runtime which attempts one last callback and reports abort.
            assert!(!sink(&pcm));
            return Err("stream aborted".into());
        }
        Ok(())
    }
}

fn model() -> Model<'static> {
    Model {
        directory: Path::new("test-model"),
        generation: 0,
        voice: "test-voice",
    }
}

#[test]
fn caches_by_directory_and_generation_and_releases_on_clear() {
    LOADS.set(0);
    let cache = Cache::<FakeEngine>::default();
    let first = cache
        .synthesize(model(), "hello", || true, |_| true)
        .unwrap();
    assert!(first.completed && first.cold);
    let second = cache
        .synthesize(model(), "again", || true, |_| true)
        .unwrap();
    assert!(second.completed && !second.cold);
    assert_eq!(LOADS.get(), 1);
    let revised = Model {
        generation: 1,
        ..model()
    };
    assert!(
        cache
            .synthesize(revised, "hello", || true, |_| true)
            .unwrap()
            .cold
    );
    let moved = Model {
        directory: Path::new("moved"),
        ..revised
    };
    assert!(
        cache
            .synthesize(moved, "hello", || true, |_| true)
            .unwrap()
            .cold
    );
    cache.clear();
    assert!(
        cache
            .synthesize(moved, "hello", || true, |_| true)
            .unwrap()
            .cold
    );
    assert_eq!(LOADS.get(), 4);
}

#[test]
fn cancellation_before_and_during_load_never_emits_pcm() {
    LOADS.set(0);
    CURRENT.set(true);
    let cache = Cache::<FakeEngine>::default();
    let report = cache
        .synthesize(model(), "hello", || false, |_| panic!("stale PCM"))
        .unwrap();
    assert!(!report.completed);
    assert_eq!(LOADS.get(), 0);
    let loading = Model {
        directory: Path::new("cancel-on-load"),
        ..model()
    };
    let report = cache
        .synthesize(loading, "hello", || CURRENT.get(), |_| panic!("stale PCM"))
        .unwrap();
    assert!(!report.completed);
    CURRENT.set(true);
    let loading = Model {
        directory: Path::new("cancel-on-failed-load"),
        ..model()
    };
    let report = cache
        .synthesize(loading, "hello", || CURRENT.get(), |_| panic!("stale PCM"))
        .unwrap();
    assert!(!report.completed);
    CURRENT.set(true);
}

#[test]
fn chunks_are_bounded_and_a_declining_sink_stops_even_runtime_abort_callbacks() {
    let cache = Cache::<FakeEngine>::default();
    let mut chunks = Vec::new();
    let report = cache
        .synthesize(
            model(),
            "hello",
            || true,
            |pcm| {
                assert!(pcm.iter().all(|sample| *sample == 0.25));
                chunks.push(pcm.len());
                true
            },
        )
        .unwrap();
    assert_eq!(
        chunks,
        [PCM_CHUNK_SAMPLES, PCM_CHUNK_SAMPLES, PCM_CHUNK_SAMPLES, 1]
    );
    assert_eq!(report.samples, PCM_CHUNK_SAMPLES * 3 + 1);
    assert!(report.completed);
    let mut calls = 0;
    let report = cache
        .synthesize(
            model(),
            "hello",
            || true,
            |_| {
                calls += 1;
                false
            },
        )
        .unwrap();
    assert_eq!(calls, 1);
    assert!(!report.completed);
}

#[test]
fn a_new_lease_stops_the_previous_utterance_between_pcm_chunks() {
    CURRENT.set(true);
    let cache = Cache::<FakeEngine>::default();
    let mut calls = 0;
    let report = cache
        .synthesize(
            model(),
            "hello",
            || CURRENT.get(),
            |_| {
                calls += 1;
                CURRENT.set(false);
                true
            },
        )
        .unwrap();
    assert!(!report.completed);
    assert_eq!(calls, 1);
    CURRENT.set(true);
}

#[test]
fn load_and_inference_failures_reach_the_host_for_fallback() {
    let cache = Cache::<FakeEngine>::default();
    assert!(
        cache
            .synthesize(
                Model {
                    directory: Path::new("broken"),
                    ..model()
                },
                "hello",
                || true,
                |_| true
            )
            .is_err()
    );
    assert!(
        cache
            .synthesize(model(), "broken", || true, |_| true)
            .is_err()
    );
    assert!(
        cache
            .synthesize(
                Model {
                    voice: "unknown",
                    ..model()
                },
                "hello",
                || true,
                |_| true
            )
            .is_err()
    );
    assert!(
        cache
            .synthesize(model(), "recovered", || true, |_| true)
            .unwrap()
            .completed
    );
}

#[test]
fn sink_backpressure_holds_completion_and_stale_waiters_emit_nothing() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    let cache = Arc::new(Cache::<FakeEngine>::default());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let worker_cache = cache.clone();
    let worker = std::thread::spawn(move || {
        worker_cache
            .synthesize(
                model(),
                "hello",
                || true,
                |_| {
                    entered_tx.send(()).unwrap();
                    resume_rx.recv().unwrap();
                    false
                },
            )
            .unwrap()
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(!worker.is_finished());
    let current = Arc::new(AtomicBool::new(true));
    let waiter_current = current.clone();
    let (checked_tx, checked_rx) = mpsc::channel();
    let waiter_cache = cache.clone();
    let waiter = std::thread::spawn(move || {
        waiter_cache
            .synthesize(
                model(),
                "stale",
                || {
                    let live = waiter_current.load(Ordering::Acquire);
                    let _ = checked_tx.send(());
                    live
                },
                |_| panic!("stale waiter emitted PCM"),
            )
            .unwrap()
    });
    checked_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    current.store(false, Ordering::Release);
    resume_tx.send(()).unwrap();
    assert!(!worker.join().unwrap().completed);
    assert!(!waiter.join().unwrap().completed);
    cache.clear();
}
