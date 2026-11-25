//! Logical-call microphone intent, deadline and backend-driven transition speech.
use super::{Command, Duration, Instant, Ordering, RealtimeVoiceAdapter};
use std::collections::VecDeque;
use voice_call_controls::{Context, Policy};

impl super::ToolLedger {
    pub(super) fn microphone_result(
        &mut self,
        owner: &RealtimeVoiceAdapter,
        call_id: &str,
        arguments: &str,
    ) -> Result<Option<serde_json::Value>, &'static str> {
        let result = match self.begin(call_id, voice_call_controls::TOOL, arguments) {
            Err("duplicate") => return Ok(None),
            Err("limit") => return Err("Realtime tool limit reached. Start a new call."),
            Err(error) => Err(error),
            Ok(_) => voice_call_controls::Request::parse(arguments)
                .map_err(|_| "invalid_arguments")
                .and_then(|request| owner.apply_microphone_request(&request)),
        };
        Ok(Some(match result {
            Ok(ack) => serde_json::json!(ack),
            Err(error) => serde_json::json!({"error":error}),
        }))
    }
}

const OUTPUT_TAIL: Duration = Duration::from_millis(500);
// A real pause in the continuous GPT-Live PCM stream is a speech boundary.
const BOUNDARY_QUIET_MS: usize = 160;
pub(super) const BOUNDARY_QUIET: Duration = Duration::from_millis(BOUNDARY_QUIET_MS as u64);
pub(super) const QUIET_SAMPLES: usize = super::RATE * BOUNDARY_QUIET_MS / 1000;

pub(super) struct State {
    pub(super) policy: Policy,
    announcements: VecDeque<bool>,
    announcement_id: u64,
    pub(super) active: bool,
    speaking: bool,
    cancelled: bool,
    capture_after: Option<Instant>,
}

impl State {
    pub fn new(call_id: u64, muted: bool) -> Self {
        Self {
            policy: Policy::new(call_id, muted),
            announcements: VecDeque::new(),
            announcement_id: 0,
            active: false,
            speaking: false,
            cancelled: false,
            capture_after: None,
        }
    }

    pub fn cancel(&mut self) {
        self.policy.cancel();
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
        self.policy.muted() || self.speaking || self.capture_after.is_some_and(|after| now < after)
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
    pub(crate) fn apply_microphone_request(
        &self,
        request: &voice_call_controls::Request,
    ) -> Result<voice_call_controls::Acknowledgement, &'static str> {
        let duration = request.duration()?;
        self.set_microphone(request.muted, duration)?;
        Ok(voice_call_controls::Acknowledgement::new(
            request.muted,
            duration,
        ))
    }

    fn microphone_context(&self) -> Context {
        Context {
            call_id: self.speech.id(),
            current: !self.closed.load(Ordering::Acquire) && self.speech.is_current(),
            provider_ready: self.ready.load(Ordering::Acquire)
                && !self.retiring.load(Ordering::Acquire),
            suspended: self.suspended.load(Ordering::Acquire),
        }
    }

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
        if !self.allow_input {
            return Err("The voice call has ended.");
        }
        let changed =
            state
                .policy
                .set(self.microphone_context(), muted, duration, Instant::now())?;
        self.update_microphone(&mut state, muted, changed);
        drop(state);
        self.command(Command::Mute(muted));
        if self.closed.load(Ordering::Acquire) {
            Err("The microphone control failed.")
        } else {
            Ok(())
        }
    }

    fn update_microphone(&self, state: &mut State, muted: bool, changed: bool) {
        if changed {
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
        if !state.policy.expire(self.microphone_context(), now) {
            return;
        }
        self.update_microphone(&mut state, false, true);
        drop(state);
        self.command(Command::Mute(false));
    }
}

#[cfg(test)]
mod tests;
