//! One startup retry after acknowledged retirement, following Codex's
//! StartupRetry/attempt_id gates (ede589336e9ecc64cb05045c2961fb1277858f1d,
//! codex-rs/tui/src/chatwidget/realtime.rs). Logical-call continuity retires
//! established generations before admitting fresh sessions; work never replays.
use super::RealtimeVoiceAdapter;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::watch;

pub(super) use voice_call_openai::recovery::{CANCELLED, Failure, State};

pub(super) struct Attempt {
    pub id: u64,
    pub(super) owner: Arc<RealtimeVoiceAdapter>,
    active: AtomicBool,
    pub errors: watch::Sender<Option<Failure>>,
}
impl Attempt {
    pub fn new(owner: Arc<RealtimeVoiceAdapter>) -> Arc<Self> {
        let id = owner.attempt.fetch_add(1, Ordering::AcqRel) + 1;
        owner.continuity.lock().begin_attempt();
        if let Some(global) = owner.global.lock().take() {
            global.close();
        }
        let (errors, _) = watch::channel(None);
        Arc::new(Self {
            id,
            owner,
            active: AtomicBool::new(false),
            errors,
        })
    }
    pub fn current(&self) -> bool {
        self.owner.attempt.load(Ordering::Acquire) == self.id
            && !self.owner.closed.load(Ordering::Acquire)
            && !self.owner.retiring.load(Ordering::Acquire)
    }
    pub fn collecting_usage(&self) -> bool {
        self.active.load(Ordering::Acquire)
            && self.owner.attempt.load(Ordering::Acquire) == self.id
            && (self.owner.closed.load(Ordering::Acquire)
                || self.owner.retiring.load(Ordering::Acquire))
    }
    pub fn activate(&self) -> Result<(), Failure> {
        if !self.current() {
            return Err(CANCELLED.into());
        }
        self.active.store(true, Ordering::Release);
        if let Some(error) = *self.errors.borrow() {
            return Err(error);
        }
        Ok(())
    }
    pub fn fail(&self, error: Failure) {
        if !self.current() {
            return;
        }
        self.errors.send_replace(Some(error));
        if self.active.load(Ordering::Acquire) {
            if self.owner.continuity_enabled
                && (error.retryable
                    || voice_call_openai::continuity::connection_lost(error.message))
            {
                *self.owner.failure.lock() = Some(error);
                self.owner.ready.store(false, Ordering::Release);
                self.owner.input.set_muted(true);
                self.owner
                    .recovering(voice_call_openai::continuity::Reason::ConnectionLost);
            } else {
                self.owner.fail(error.message);
            }
        }
    }
}
