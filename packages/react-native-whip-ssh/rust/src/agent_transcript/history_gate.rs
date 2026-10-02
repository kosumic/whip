//! Shared initial-history readiness and failure policy for every agent adapter.

use super::model::{AgentTranscriptDelta, AgentTranscriptStatus};

/// Owns presentation eligibility, independently of an agent's transport cursor.
/// Adapters call `complete` only after processing their captured opening boundary.
/// Cached data and replacement sources must pass through `reset` first.
#[derive(Clone, Debug)]
pub(super) struct InitialHistoryGate {
    status: AgentTranscriptStatus,
    error: Option<String>,
}

impl Default for InitialHistoryGate {
    fn default() -> Self {
        Self {
            status: AgentTranscriptStatus::Loading,
            error: None,
        }
    }
}

impl InitialHistoryGate {
    pub(super) fn status(&self) -> AgentTranscriptStatus {
        self.status
    }

    pub(super) fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// Forget previous readiness when restoring cache or binding a new source.
    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }

    /// Report successful boundary processing. Returns whether status changed,
    /// so adapters can include it in the same revision as the final history data.
    pub(super) fn complete(&mut self) -> bool {
        if matches!(
            self.status,
            AgentTranscriptStatus::Live | AgentTranscriptStatus::Closed
        ) {
            return false;
        }
        self.status = AgentTranscriptStatus::Live;
        self.error = None;
        true
    }

    pub(super) fn restart(&mut self, reason: impl Into<String>) {
        if self.has_ready_history() {
            self.status = AgentTranscriptStatus::Stale;
            self.error = Some(reason.into());
        } else {
            self.reset();
        }
    }

    pub(super) fn mark_stale(&mut self, error: impl Into<String>) {
        self.fail(AgentTranscriptStatus::Error, error.into());
    }

    pub(super) fn mark_unavailable(&mut self, error: impl Into<String>) {
        self.fail(AgentTranscriptStatus::Unavailable, error.into());
    }

    pub(super) fn close(&mut self) {
        self.status = AgentTranscriptStatus::Closed;
        self.error = None;
    }

    pub(super) fn status_delta(&self) -> AgentTranscriptDelta {
        AgentTranscriptDelta::StatusChanged {
            status: self.status,
            error: self.error.clone(),
        }
    }

    fn has_ready_history(&self) -> bool {
        matches!(
            self.status,
            AgentTranscriptStatus::Live | AgentTranscriptStatus::Stale
        )
    }

    fn fail(&mut self, initial_status: AgentTranscriptStatus, error: String) {
        if self.status == AgentTranscriptStatus::Closed {
            return;
        }
        self.status = if self.has_ready_history() {
            AgentTranscriptStatus::Stale
        } else {
            initial_status
        };
        self.error = Some(error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_initial_history_stays_hidden_through_retries() {
        let mut gate = InitialHistoryGate::default();
        gate.mark_stale("disconnected during history");
        assert_eq!(gate.status(), AgentTranscriptStatus::Error);
        assert_eq!(gate.error(), Some("disconnected during history"));
        gate.restart("retrying");
        assert_eq!(gate.status(), AgentTranscriptStatus::Loading);
        assert_eq!(gate.error(), None);
        gate.mark_unavailable("source missing");
        assert_eq!(gate.status(), AgentTranscriptStatus::Unavailable);
        gate.restart("retrying");
        assert_eq!(gate.status(), AgentTranscriptStatus::Loading);
        assert!(gate.complete());
        assert_eq!(gate.status(), AgentTranscriptStatus::Live);
        assert!(!gate.complete());
    }

    #[test]
    fn completed_history_remains_usable_during_recovery() {
        let mut gate = InitialHistoryGate::default();
        gate.complete();
        gate.mark_stale("disconnected");
        assert_eq!(gate.status(), AgentTranscriptStatus::Stale);
        gate.restart("reconnecting");
        assert_eq!(gate.status(), AgentTranscriptStatus::Stale);
        assert_eq!(gate.error(), Some("reconnecting"));
        gate.mark_unavailable("source missing");
        assert_eq!(gate.status(), AgentTranscriptStatus::Stale);
        assert!(gate.complete());
        assert_eq!(gate.error(), None);
        assert_eq!(
            gate.status_delta(),
            AgentTranscriptDelta::StatusChanged {
                status: AgentTranscriptStatus::Live,
                error: None,
            }
        );
    }

    #[test]
    fn restored_cache_or_replacement_source_requires_new_completion() {
        let mut gate = InitialHistoryGate::default();
        gate.complete();
        gate.reset();
        assert_eq!(gate.status(), AgentTranscriptStatus::Loading);
        gate.mark_stale("could not synchronize cache");
        assert_eq!(gate.status(), AgentTranscriptStatus::Error);
        assert!(gate.complete());
        assert_eq!(gate.status(), AgentTranscriptStatus::Live);
    }

    #[test]
    fn closed_history_ignores_late_events_until_explicit_restart() {
        let mut gate = InitialHistoryGate::default();
        gate.complete();
        gate.close();
        assert!(!gate.complete());
        gate.mark_stale("late stream failure");
        gate.mark_unavailable("late discovery failure");
        assert_eq!(gate.status(), AgentTranscriptStatus::Closed);
        assert_eq!(gate.error(), None);
        gate.restart("Reopening released transcript");
        assert_eq!(gate.status(), AgentTranscriptStatus::Loading);
        assert!(gate.complete());
    }
}
