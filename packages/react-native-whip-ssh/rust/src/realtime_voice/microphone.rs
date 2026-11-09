//! Logical-call microphone intent, deadline and backend-driven transition speech.
use super::{Command, Duration, Instant, Ordering, RealtimeVoiceAdapter};
use serde::Deserialize;
use std::collections::VecDeque;

pub(crate) const TOOL: &str = "voice_set_microphone";
pub(crate) const MAX_MINUTES: u32 = 60;
const OUTPUT_TAIL: Duration = Duration::from_millis(500);
const MAX_ANNOUNCEMENTS: usize = 128;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub muted: bool,
    #[serde(default, deserialize_with = "minutes")]
    duration_minutes: Option<f64>,
}

fn minutes<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    f64::deserialize(deserializer).map(Some)
}

impl Request {
    pub fn duration(&self) -> Result<Option<Duration>, &'static str> {
        let Some(minutes) = self.duration_minutes else {
            return Ok(None);
        };
        if !self.muted || !minutes.is_finite() || minutes <= 0.0 || minutes > f64::from(MAX_MINUTES)
        {
            return Err("Use a positive duration_minutes of at most 60, only when muting.");
        }
        Duration::try_from_secs_f64(minutes * 60.0)
            .ok()
            .filter(|duration| !duration.is_zero())
            .map(Some)
            .ok_or("Invalid mute duration.")
    }
}

#[derive(Default)]
pub(super) struct State {
    pub muted: bool,
    deadline: Option<Instant>,
    announcements: VecDeque<bool>,
    announcement_id: u64,
    capture_after: Option<Instant>,
}

impl State {
    pub fn new(muted: bool) -> Self {
        Self {
            muted,
            ..Self::default()
        }
    }

    pub fn cancel(&mut self) {
        self.deadline = None;
        self.announcements.clear();
        self.announcement_id = self.announcement_id.saturating_add(1);
        self.capture_after = None;
    }

    pub fn blocks_capture(&self, now: Instant) -> bool {
        self.muted
            || !self.announcements.is_empty()
            || self.capture_after.is_some_and(|after| now < after)
    }

    pub fn announcement(&self, lease: u64) -> Option<serde_json::Value> {
        self.announcements.front().map(|muted| {
            serde_json::json!({
                "id": self.announcement_id,
                "lease": lease,
                "text": if *muted { "Muted" } else { "Unmuted" },
            })
        })
    }

    pub fn announcement_finished(&mut self, id: u64, now: Instant) {
        if self.announcement_id == id && !self.announcements.is_empty() {
            self.announcements.pop_front();
            self.announcement_id = self.announcement_id.saturating_add(1);
            self.capture_after = Some(now + OUTPUT_TAIL);
        }
    }
}

impl RealtimeVoiceAdapter {
    /// All callers, including repeated manual commands, replace the deadline.
    pub(crate) fn set_microphone(
        &self,
        muted: bool,
        duration: Option<Duration>,
    ) -> Result<(), &'static str> {
        let mut state = self.microphone.lock();
        if self.closed.load(Ordering::Acquire) || !self.allow_input || !self.speech.is_current() {
            return Err("The voice call has ended.");
        }
        if duration.is_some()
            && (!self.ready.load(Ordering::Acquire) || self.retiring.load(Ordering::Acquire))
        {
            return Err("Wait for the voice call to reconnect before setting a timed mute.");
        }
        self.update_microphone(&mut state, muted, duration, Instant::now())?;
        drop(state);
        self.command(Command::Mute(muted));
        if self.closed.load(Ordering::Acquire) {
            Err("The microphone control failed.")
        } else {
            Ok(())
        }
    }

    fn update_microphone(
        &self,
        state: &mut State,
        muted: bool,
        duration: Option<Duration>,
        now: Instant,
    ) -> Result<(), &'static str> {
        if state.muted != muted && state.announcements.len() >= MAX_ANNOUNCEMENTS {
            return Err("Microphone announcements are still playing. Try again shortly.");
        }
        state.deadline = if muted {
            duration.map(|duration| now + duration)
        } else {
            None
        };
        if state.muted != muted {
            state.muted = muted;
            state.announcements.push_back(muted);
            // Invalidate queued and in-flight PCM on both edges. Live unmute
            // still waits for its matching provider acknowledgement.
            self.input.set_muted(true);
            if !self.live
                && self.ready.load(Ordering::Acquire)
                && !self.retiring.load(Ordering::Acquire)
            {
                self.input.set_muted(muted);
            }
        }
        let mut view = self.view.lock();
        view.muted = muted;
        view.level = 0.0;
        if matches!(view.phase, "listening" | "muted") {
            view.phase = if muted { "muted" } else { "listening" };
        }
        Ok(())
    }

    pub(super) fn microphone_tick(&self, now: Instant) {
        let mut state = self.microphone.lock();
        // A timer cannot reactivate an interrupted/expired/replaced audio owner.
        if self.closed.load(Ordering::Acquire)
            || !self.speech.is_current()
            || !voice_call_openai::session::Audio::credentials_current(self)
        {
            state.cancel();
            return;
        }
        // Recovery may outlast the deadline. Leave it due until this logical
        // call has an active provider again; never restart the mute duration.
        if self.retiring.load(Ordering::Acquire)
            || !self.ready.load(Ordering::Acquire)
            || state.deadline.is_none_or(|deadline| now < deadline)
        {
            return;
        }
        if self
            .update_microphone(&mut state, false, None, now)
            .is_err()
        {
            return;
        }
        drop(state);
        self.command(Command::Mute(false));
    }
}

#[cfg(test)]
mod tests;
