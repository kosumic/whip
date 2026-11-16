//! Device interruptions retain the logical call, provider and microphone intent.
use super::{Command, Duration, Instant, Ordering, RealtimeVoiceAdapter};

const RECOVERY_TIMEOUT: Duration = Duration::from_secs(60);

impl RealtimeVoiceAdapter {
    pub(super) fn suspend_audio(&self) {
        let mut interruption = self.interruption.lock();
        if self.closed.load(Ordering::Acquire) || interruption.is_some() {
            return;
        }
        *interruption = Some(Instant::now());
        self.suspended.store(true, Ordering::Release);
        self.input.discard();
        self.cue.lock().clear();
        // The normal skip protocol truncates at the heard position and cancels
        // speech; it does not cancel tools or replace the conversation.
        self.command(Command::SuspendAudio);
        drop(interruption);
        tracing::info!(call_id = ?self.session_id, attempt = self.attempt.load(Ordering::Acquire), event = "audio_suspended");
    }

    /// Native calls this only after OS permission/focus and device startup.
    /// Ingress discard preserves both user intent and Live's provider mute gate.
    pub(super) fn resume_audio(&self) {
        let mut interruption = self.interruption.lock();
        if self.closed.load(Ordering::Acquire) || interruption.take().is_none() {
            return;
        }
        self.output.lock().clear();
        self.input.discard();
        self.suspended.store(false, Ordering::Release);
        drop(interruption);
        tracing::info!(call_id = ?self.session_id, attempt = self.attempt.load(Ordering::Acquire), event = "audio_resumed");
    }

    pub(super) fn interruption_tick(&self, now: Instant) {
        let expired = self
            .interruption
            .lock()
            .is_some_and(|since| now.saturating_duration_since(since) >= RECOVERY_TIMEOUT);
        if expired && !self.closed.load(Ordering::Acquire) {
            self.fail("Audio did not become available again. Start a new call or resume from call history.");
        }
    }
}

#[cfg(test)]
mod tests;
