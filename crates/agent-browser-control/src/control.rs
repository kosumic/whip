//! Cancellation and expiry shared by all work belonging to one operation.
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::{sync::Notify, time::Instant};

use crate::model::{BrowserError, ErrorCode};

#[derive(Debug)]
struct State {
    cancelled: AtomicBool,
    changed: Notify,
    expires: Instant,
}

/// A clonable operation lifetime. Cancellation or expiry drops pending work.
///
/// Bridges must arrange for dropping a call to revoke its native effect permit.
/// Neither dropping a future nor cancelling this control can undo page effects
/// that have already completed.
#[derive(Clone, Debug)]
pub struct OperationControl(Arc<State>);

impl OperationControl {
    pub fn new(timeout: Duration) -> Self {
        Self(Arc::new(State {
            cancelled: AtomicBool::new(false),
            changed: Notify::new(),
            expires: Instant::now() + timeout,
        }))
    }

    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
        self.0.changed.notify_waiters();
    }

    /// Check before committing an effect or accepting its result.
    pub fn check(&self) -> Result<(), BrowserError> {
        if self.0.cancelled.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        if Instant::now() >= self.0.expires {
            return Err(timed_out());
        }
        Ok(())
    }

    pub async fn run<T>(
        &self,
        work: impl Future<Output = Result<T, BrowserError>>,
    ) -> Result<T, BrowserError> {
        let changed = self.0.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        self.check()?;
        let result = tokio::select! {
            biased;
            () = &mut changed => Err(cancelled()),
            result = tokio::time::timeout_at(self.0.expires, work) => result.map_err(|_| timed_out())?,
        };
        self.check()?;
        result
    }
}

fn cancelled() -> BrowserError {
    BrowserError::new(ErrorCode::Cancelled, "Browser operation cancelled")
}

fn timed_out() -> BrowserError {
    BrowserError::new(ErrorCode::Timeout, "Browser operation timed out")
}
