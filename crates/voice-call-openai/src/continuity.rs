//! Logical-call policy. No audio, credentials, prompts or tool state survive here.
use crate::recovery::Failure;
use serde::Serialize;
use std::time::Duration;
use tokio::time::Instant;

const ROTATE_AFTER: Duration = Duration::from_mins(50);
const EXPIRY_MARGIN: Duration = Duration::from_mins(5);
const DRAIN: Duration = Duration::from_secs(60);
const STABLE: Duration = Duration::from_secs(30);
const RETRY_WINDOW: Duration = Duration::from_secs(120);
const MAX_RETRIES: u32 = 5;
const HISTORY: usize = 16;
pub const EXHAUSTED: &str = "Voice connection recovery exhausted. Please call again.";

/// Select a replacement after the previous provider session is retired.
/// The host still decides whether this call can recover and whether it ever
/// reached readiness. A failure during cleanup must be handled by the caller
/// before considering replacement.
pub fn replacement(
    enabled: bool,
    established: bool,
    requested: Option<Reason>,
    result: Result<(), Failure>,
) -> Result<Option<Reason>, Failure> {
    match result {
        Ok(()) => Ok(requested.filter(|_| enabled)),
        Err(failure) if enabled && established && failure.retryable => {
            Ok(Some(Reason::ConnectionLost))
        }
        Err(failure) => Err(failure),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Lifetime,
    DrainDeadline,
    ConnectionLost,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    #[default]
    Connecting,
    Connected,
    Reconnecting,
    Failed,
    Ended,
}

#[derive(Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub status: Status,
    pub last_reason: Option<Reason>,
    pub retry_count: u32,
    pub replacements: u64,
    pub sessions: u64,
    pub attempts: Vec<Attempt>,
}
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub generation: u64,
    pub elapsed_ms: u64,
    pub connected: bool,
}

#[derive(Default)]
pub struct Policy {
    pub diagnostics: Diagnostics,
    created: Option<Instant>,
    rotate_at: Option<Instant>,
    retire_by: Option<Instant>,
    outage: Option<Instant>,
    connected: Option<Instant>,
}
impl Policy {
    pub fn begin_attempt(&mut self) {
        self.created = None;
        self.rotate_at = None;
        self.retire_by = None;
        self.connected = None;
    }
    /// Called once per *accepted provider creation*, never on lock/unlock.
    pub fn created(&mut self, expires_in: Option<Duration>) {
        if self.created.is_some() {
            return;
        }
        let now = Instant::now();
        let remaining = expires_in.unwrap_or(ROTATE_AFTER + EXPIRY_MARGIN);
        let after = ROTATE_AFTER.min(remaining.saturating_sub(EXPIRY_MARGIN));
        self.created = Some(now);
        self.rotate_at = Some(now + after);
        self.retire_by = Some(
            (now + after + DRAIN).min(now + remaining.saturating_sub(Duration::from_secs(30))),
        );
        self.diagnostics.sessions += 1;
    }
    pub fn is_connected(&self) -> bool {
        self.connected.is_some() && self.diagnostics.status == Status::Connected
    }
    pub fn connected(&mut self) {
        self.connected.get_or_insert_with(Instant::now);
        self.diagnostics.status = Status::Connected;
    }
    /// Server expiry may shorten, but never extend, the accepted-creation clock.
    pub fn expires_in(&mut self, remaining: Duration) {
        let now = Instant::now();
        let rotate = now + remaining.saturating_sub(EXPIRY_MARGIN);
        self.rotate_at = Some(self.rotate_at.map_or(rotate, |at| at.min(rotate)));
        let retire = now + remaining.saturating_sub(Duration::from_secs(30));
        self.retire_by = Some(self.retire_by.map_or(retire, |at| at.min(retire)));
    }
    pub fn rotation(&self, idle: bool) -> Option<Reason> {
        let now = Instant::now();
        if self.retire_by.is_some_and(|at| now >= at) {
            Some(Reason::DrainDeadline)
        } else if idle && self.rotate_at.is_some_and(|at| now >= at) {
            Some(Reason::Lifetime)
        } else {
            None
        }
    }
    pub fn replacing(&mut self, reason: Reason) -> bool {
        let stable = self.connected.is_some_and(|at| at.elapsed() >= STABLE);
        if stable {
            self.outage = None;
            self.diagnostics.retry_count = 0;
        }
        self.begin_attempt();
        self.diagnostics.status = Status::Reconnecting;
        self.diagnostics.last_reason = Some(reason);
        self.diagnostics.replacements += 1;
        stable
    }
    /// Only call after acknowledged cleanup. Jitter is supplied by the caller
    /// so tests need no randomness. Rapid brief reconnections share one budget.
    pub fn retry(&mut self, jitter: u64) -> Result<Duration, &'static str> {
        let since = self.outage.get_or_insert_with(Instant::now);
        if self.diagnostics.retry_count >= MAX_RETRIES || since.elapsed() >= RETRY_WINDOW {
            return Err(EXHAUSTED);
        }
        let delay = Duration::from_millis(
            (1000 << self.diagnostics.retry_count).min(16_000) + jitter % 501,
        );
        self.diagnostics.retry_count += 1;
        if since.elapsed() + delay > RETRY_WINDOW {
            return Err(EXHAUSTED);
        }
        Ok(delay)
    }
    pub fn attempt(&mut self, generation: u64, elapsed: Duration, connected: bool) {
        if self.diagnostics.attempts.len() == HISTORY {
            self.diagnostics.attempts.remove(0);
        }
        self.diagnostics.attempts.push(Attempt {
            generation,
            elapsed_ms: elapsed.as_millis().try_into().unwrap_or(u64::MAX),
            connected,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_requires_readiness_for_failure_and_never_replays_uncertain_cleanup() {
        let lost = Failure::transport("Connection unavailable.");
        let cleanup = Failure::from(crate::recovery::CLEANUP_FAILED);
        assert!(replacement(true, false, None, Err(lost)).is_err());
        assert!(replacement(false, true, None, Err(lost)).is_err());
        assert!(replacement(true, true, None, Err(cleanup)).is_err());
        assert!(matches!(
            replacement(true, true, None, Err(lost)),
            Ok(Some(Reason::ConnectionLost))
        ));
        assert!(replacement(true, true, None, Err(Failure::from(lost.message))).is_err());
        assert!(matches!(
            replacement(true, true, Some(Reason::Lifetime), Ok(())),
            Ok(Some(Reason::Lifetime))
        ));
    }
    #[tokio::test(start_paused = true)]
    async fn two_rotations_use_fresh_creation_deadlines() {
        let mut call = Policy::default();
        for _ in 0..2 {
            call.created(Some(Duration::from_secs(310)));
            call.connected();
            tokio::time::advance(Duration::from_secs(9)).await;
            assert_eq!(call.rotation(true), None);
            tokio::time::advance(Duration::from_secs(1)).await;
            assert_eq!(call.rotation(true), Some(Reason::Lifetime));
            call.replacing(Reason::Lifetime);
        }
        assert_eq!(call.diagnostics.sessions, 2);
        assert_eq!(call.diagnostics.replacements, 2);
    }
    #[tokio::test(start_paused = true)]
    async fn activity_drains_but_cannot_extend_retirement_forever() {
        let mut call = Policy::default();
        call.created(None);
        tokio::time::advance(ROTATE_AFTER).await;
        assert_eq!(call.rotation(false), None);
        // A mirrored session.created must never push the deadline back.
        call.created(None);
        tokio::time::advance(DRAIN).await;
        assert_eq!(call.rotation(false), Some(Reason::DrainDeadline));
    }
    #[tokio::test(start_paused = true)]
    async fn rapid_network_flaps_share_one_bounded_retry_budget() {
        let mut call = Policy::default();
        for _ in 0..MAX_RETRIES {
            call.replacing(Reason::ConnectionLost);
            let delay = call.retry(500).unwrap();
            tokio::time::advance(delay).await;
            call.connected();
            tokio::time::advance(Duration::from_secs(1)).await;
        }
        call.replacing(Reason::ConnectionLost);
        assert_eq!(call.retry(0), Err(EXHAUSTED));
    }
    #[tokio::test(start_paused = true)]
    async fn suspension_exhausts_outage_budget_and_stable_audio_resets_it() {
        let mut call = Policy::default();
        call.retry(0).unwrap();
        tokio::time::advance(RETRY_WINDOW).await;
        assert_eq!(call.retry(0), Err(EXHAUSTED));
        call.connected();
        tokio::time::advance(STABLE).await;
        call.replacing(Reason::ConnectionLost);
        assert!(call.retry(0).is_ok());
        assert_eq!(call.diagnostics.retry_count, 1);
    }
}
