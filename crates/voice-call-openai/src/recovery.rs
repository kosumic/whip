//! One startup retry after acknowledged retirement, following Codex's
//! StartupRetry/attempt_id gates (ede589336e9ecc64cb05045c2961fb1277858f1d,
//! codex-rs/tui/src/chatwidget/realtime.rs). Established sessions never replay.
use serde::Serialize;
use std::time::Duration;

// Server hangup precedes peer close. Keep the owned worker budget
// longer than peer close (two seconds) plus the HTTP hangup deadline.
pub const HANGUP_TIMEOUT: Duration = Duration::from_secs(5);
pub const WORKER_DRAIN_TIMEOUT: Duration = Duration::from_secs(8);

pub const CANCELLED: &str = "Realtime startup was cancelled.";
pub const CLEANUP_FAILED: &str =
    "Realtime cleanup could not be confirmed. Start a new call manually.";

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    #[default]
    Starting,
    Retiring,
    Retrying,
    Active,
    Ended,
}

pub use voice_call_media::Failure;
