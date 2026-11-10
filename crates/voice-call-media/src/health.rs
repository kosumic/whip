//! Remote RTP progress is independent of local sends and ICE keepalives.
use serde::Serialize;
use std::time::{Duration, Instant};

pub const STALLED: &str = "Voice server stopped receiving microphone audio.";
const REMOTE_TIMEOUT: Duration = Duration::from_secs(15);
const SEND_RECENT: Duration = Duration::from_secs(2);

/// A snapshot, not additive counters. No addresses, audio or provider payloads.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Statistics {
    pub sent_packets: u64,
    pub remote_sequence: Option<u64>,
    pub remote_lost_packets: Option<u64>,
    pub remote_jitter_ms: Option<f64>,
    pub round_trip_ms: Option<u64>,
    pub remote_progress_ms: Option<u64>,
}

#[derive(Default)]
pub(super) struct RemoteProgress {
    sent: u64,
    sent_at: Option<Instant>,
    sequence: Option<u64>,
    progressed_at: Option<Instant>,
    sent_at_progress: u64,
}
impl RemoteProgress {
    pub fn observe(&mut self, sent: u64, sequence: Option<u64>, now: Instant) {
        if sent > self.sent {
            self.sent = sent;
            self.sent_at = Some(now);
        }
        if let Some(sequence) = sequence
            && self.sequence.is_none_or(|previous| sequence > previous)
        {
            self.sequence = Some(sequence);
            self.progressed_at = Some(now);
            self.sent_at_progress = sent;
        }
    }
    pub fn age_ms(&self, now: Instant) -> Option<u64> {
        self.progressed_at.map(|at| {
            now.saturating_duration_since(at)
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX)
        })
    }
    pub fn check(&self, now: Instant) -> Result<(), &'static str> {
        // Some peers do not publish usable receiver reports. Never infer an
        // outage from missing support, silence, or an idle local sender.
        if self.sent > self.sent_at_progress
            && self
                .sent_at
                .is_some_and(|at| now.saturating_duration_since(at) <= SEND_RECENT)
            && self
                .progressed_at
                .is_some_and(|at| now.saturating_duration_since(at) >= REMOTE_TIMEOUT)
        {
            return Err(STALLED);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_sends_and_unchanged_receiver_reports_cannot_hide_a_one_way_stall() {
        let now = Instant::now();
        let mut health = RemoteProgress::default();
        health.observe(100, Some(90), now);
        for second in 1..=15 {
            health.observe(
                100 + second * 50,
                Some(90),
                now + Duration::from_secs(second),
            );
        }
        assert_eq!(health.check(now + REMOTE_TIMEOUT), Err(STALLED));
        health.observe(900, Some(890), now + REMOTE_TIMEOUT);
        assert!(health.check(now + REMOTE_TIMEOUT).is_ok());
    }

    #[test]
    fn silence_without_reports_and_an_idle_sender_do_not_fail() {
        let now = Instant::now();
        let mut health = RemoteProgress::default();
        for second in 0..100 {
            let at = now + Duration::from_secs(second);
            health.observe(second * 50, None, at);
            assert!(health.check(at).is_ok());
        }
        health.observe(5000, Some(4990), now + Duration::from_secs(100));
        assert!(health.check(now + Duration::from_secs(200)).is_ok());
    }

    #[test]
    fn receiver_progress_during_muted_silence_keeps_the_connection_healthy() {
        let now = Instant::now();
        let mut health = RemoteProgress::default();
        for second in 0..100 {
            let at = now + Duration::from_secs(second);
            health.observe(second * 50, Some(second * 50), at);
            assert!(health.check(at).is_ok());
        }
    }
}
