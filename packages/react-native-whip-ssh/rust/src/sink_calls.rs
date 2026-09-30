//! Coordinates foreign event-sink calls with React bridge teardown.
//!
//! Each sink registry is cleared while background tasks may already hold a
//! clone of the outgoing sink. Teardown waits for those calls to finish so a
//! JS callback does not fire into a bridge that has reported itself detached.
//!
//! The wait is bounded. UniFFI delivers sink calls with blocking JS-thread
//! dispatch, so an in-flight call can be waiting on the very thread that is
//! tearing the bridge down (or on a JS thread that no longer drains work).
//! Waiting forever would turn a rare crash into a guaranteed hang; after
//! [`DRAIN_TIMEOUT`] teardown proceeds and logs the calls it left behind.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Upper bound on how long teardown waits for in-flight sink calls.
pub(crate) const DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

/// Counts sink calls that have read a live sink but not finished invoking it.
pub(crate) struct SinkCalls {
    in_flight: AtomicU64,
}

impl SinkCalls {
    pub(crate) const fn new() -> Self {
        Self {
            in_flight: AtomicU64::new(0),
        }
    }

    /// Marks a sink call as in flight until the returned guard drops. Take
    /// the guard before reading the sink registry so teardown cannot miss a
    /// call that has already cloned the outgoing sink. The guard also
    /// releases the count if the foreign callback unwinds.
    #[must_use = "the call is only tracked while the guard is alive"]
    pub(crate) fn enter(&self) -> SinkCallGuard<'_> {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        SinkCallGuard {
            in_flight: &self.in_flight,
        }
    }

    /// Waits up to `timeout` for in-flight calls to finish. Returns whether
    /// every call finished.
    pub(crate) fn drain(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while self.in_flight.load(Ordering::SeqCst) != 0 {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::yield_now();
        }
        true
    }

    /// Bridge-teardown variant of [`Self::drain`] that logs a timeout.
    pub(crate) fn drain_for_teardown(&self, sink: &str) {
        if !self.drain(DRAIN_TIMEOUT) {
            crate::host_runtime::log_lifecycle(format_args!(
                "{sink} event sink still had {} in-flight call(s) after {}ms; detaching anyway",
                self.in_flight.load(Ordering::SeqCst),
                DRAIN_TIMEOUT.as_millis(),
            ));
        }
    }
}

pub(crate) struct SinkCallGuard<'a> {
    in_flight: &'a AtomicU64,
}

impl Drop for SinkCallGuard<'_> {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, mpsc};

    #[test]
    fn drain_returns_immediately_without_calls() {
        let calls = SinkCalls::new();
        let started = Instant::now();
        assert!(calls.drain(Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn drain_waits_for_an_in_flight_call_to_finish() {
        let calls = Arc::new(SinkCalls::new());
        let entered = Arc::new(Barrier::new(2));
        let worker = {
            let calls = calls.clone();
            let entered = entered.clone();
            std::thread::spawn(move || {
                let _call = calls.enter();
                entered.wait();
                std::thread::sleep(Duration::from_millis(50));
            })
        };
        entered.wait();
        assert!(calls.drain(Duration::from_secs(5)));
        assert_eq!(calls.in_flight.load(Ordering::SeqCst), 0);
        worker.join().unwrap();
    }

    #[test]
    fn drain_gives_up_when_the_call_waits_on_the_draining_thread() {
        // Models blocking JS-thread dispatch: the sink call cannot finish
        // until the thread running teardown services it.
        let calls = Arc::new(SinkCalls::new());
        let (js_thread_work, service) = mpsc::channel::<mpsc::Sender<()>>();
        let worker = {
            let calls = calls.clone();
            std::thread::spawn(move || {
                let _call = calls.enter();
                let (done, finished) = mpsc::channel();
                js_thread_work.send(done).unwrap();
                finished.recv().unwrap();
            })
        };
        let pending = service.recv().unwrap();

        let started = Instant::now();
        assert!(!calls.drain(Duration::from_millis(100)));
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(100));
        assert!(waited < Duration::from_secs(2), "drain must stay bounded");

        // Once teardown returns, the "JS thread" runs the queued callback and
        // the stranded call completes normally.
        pending.send(()).unwrap();
        worker.join().unwrap();
        assert!(calls.drain(Duration::from_secs(5)));
    }

    #[test]
    fn a_panicking_call_does_not_leave_the_count_raised() {
        let calls = Arc::new(SinkCalls::new());
        let worker = {
            let calls = calls.clone();
            std::thread::spawn(move || {
                let _call = calls.enter();
                panic!("foreign callback failed");
            })
        };
        assert!(worker.join().is_err());
        assert!(calls.drain(Duration::from_millis(100)));
    }
}
