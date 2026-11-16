//! Logical-call microphone intent, deadline and backend-driven transition speech.
use super::{Command, Duration, Instant, Ordering, RealtimeVoiceAdapter};
use serde::Deserialize;
use std::collections::VecDeque;

pub(crate) const TOOL: &str = "voice_set_microphone";
pub(crate) const MAX_MINUTES: u32 = 60;
const OUTPUT_TAIL: Duration = Duration::from_millis(500);
// A real pause in the continuous GPT-Live PCM stream is a speech boundary.
const BOUNDARY_QUIET_MS: usize = 160;
pub(super) const BOUNDARY_QUIET: Duration = Duration::from_millis(BOUNDARY_QUIET_MS as u64);
pub(super) const QUIET_SAMPLES: usize = super::RATE * BOUNDARY_QUIET_MS / 1000;

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
    pub(super) active: bool,
    speaking: bool,
    cancelled: bool,
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
        self.cancel_speech();
    }

    pub(super) fn cancel_speech(&mut self) {
        // Keep an admitted cue reserved until native acknowledges stopping it.
        // Otherwise a replacement response could start over its device tail.
        if self.active {
            self.announcements.truncate(1);
            self.cancelled = true;
            return;
        }
        self.announcements.clear();
        self.announcement_id = self.announcement_id.saturating_add(1);
    }

    pub fn blocks_capture(&self, now: Instant) -> bool {
        self.muted || self.speaking || self.capture_after.is_some_and(|after| now < after)
    }

    pub fn announcement(&self, lease: u64) -> Option<serde_json::Value> {
        self.announcements.front().map(|muted| {
            serde_json::json!({
                "id": self.announcement_id,
                "lease": lease,
                "text": if *muted { "Muted" } else { "Unmuted" },
                "cancelled": self.cancelled,
            })
        })
    }

    pub fn announcement_finished(&mut self, id: u64, now: Instant) {
        if self.announcement_id == id && !self.announcements.is_empty() {
            self.announcements.pop_front();
            self.announcement_id = self.announcement_id.saturating_add(1);
            if self.speaking {
                self.capture_after = Some(now + OUTPUT_TAIL);
            }
            self.active = false;
            self.speaking = false;
            self.cancelled = false;
        }
    }

    fn queue(&mut self, muted: bool) {
        if self.active {
            if !self.speaking {
                self.cancelled = true;
            }
            self.announcements.truncate(1);
            if self.announcements.front() != Some(&muted) || self.cancelled {
                self.announcements.push_back(muted);
            }
        } else {
            self.announcements.clear();
            self.announcement_id = self.announcement_id.saturating_add(1);
            self.announcements.push_back(muted);
        }
    }
}

impl RealtimeVoiceAdapter {
    /// The output lock serializes reservation with native PCM reads. A stale
    /// snapshot cannot admit speech or release another cue's reservation.
    pub(super) fn announcement_start(&self, id: u64) -> bool {
        let mut state = self.microphone.lock();
        if self.suspended.load(Ordering::Acquire)
            || self.closed.load(Ordering::Acquire)
            || !self.speech.is_current()
            || state.announcement_id != id
            || state.active
            || state.announcements.is_empty()
        {
            return false;
        }
        let output = self.output.lock();
        if !output.announcement_boundary || output.played != output.delivered {
            return false;
        }
        state.active = true;
        drop(output);
        drop(state);
        true
    }

    /// Called synchronously before native playback. Model initialization must
    /// not keep an unmuted microphone closed while the cue is being prepared.
    pub(super) fn announcement_playing(&self, id: u64) -> bool {
        let mut state = self.microphone.lock();
        if self.suspended.load(Ordering::Acquire)
            || self.closed.load(Ordering::Acquire)
            || !self.speech.is_current()
            || state.announcement_id != id
            || !state.active
            || state.cancelled
        {
            return false;
        }
        state.speaking = true;
        true
    }

    pub(super) fn read_output(&self, samples: &mut [i16]) -> (u64, usize) {
        let state = self.microphone.lock();
        let mut output = self.output.lock();
        let epoch = output.epoch;
        if self.suspended.load(Ordering::Acquire) || state.active {
            return (epoch, 0);
        }
        let pending = !state.announcements.is_empty();
        if !pending {
            output.announcement_boundary = false;
        }
        if pending && output.at_speech_boundary(Instant::now()) {
            output.announcement_boundary = true;
        }
        if output.announcement_boundary {
            return (epoch, 0);
        }
        let limit = if pending {
            output
                .items
                .iter()
                .find(|item| item.end > output.delivered)
                .filter(|item| item.finished)
                .map_or(samples.len(), |item| item.end - output.delivered)
                .min(samples.len())
        } else {
            samples.len()
        };
        let count = if pending {
            output.read_until_boundary(&mut samples[..limit], true)
        } else {
            output.read(samples)
        };
        drop(output);
        drop(state);
        (epoch, count)
    }

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
        self.update_microphone(&mut state, muted, duration, Instant::now());
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
    ) {
        state.deadline = if muted {
            duration.map(|duration| now + duration)
        } else {
            None
        };
        if state.muted != muted {
            state.muted = muted;
            state.queue(muted);
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
        if self.suspended.load(Ordering::Acquire)
            || self.retiring.load(Ordering::Acquire)
            || !self.ready.load(Ordering::Acquire)
            || state.deadline.is_none_or(|deadline| now < deadline)
        {
            return;
        }
        self.update_microphone(&mut state, false, None, now);
        drop(state);
        self.command(Command::Mute(false));
    }
}

#[cfg(test)]
mod tests;
