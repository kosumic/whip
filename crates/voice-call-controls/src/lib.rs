//! Whip's microphone intent policy, without audio devices, providers or timers.
//!
//! Hosts supply monotonic time and a current logical-call identity. A successful
//! intent change is not permission to open capture: native readiness, provider
//! acknowledgements and capture generation admission remain host responsibilities.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub const TOOL: &str = "voice_set_microphone";
pub const MAX_MINUTES: u32 = 60;
pub const MAX_ARGUMENTS: usize = 16 * 1024;
const INVALID_DURATION: &str = "Use a positive duration_minutes of at most 60, only when muting.";
const ENDED: &str = "The voice call has ended.";

/// Provider-neutral JSON parameters. Hosts attach their own tool description.
pub fn parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "muted": {"type": "boolean"},
            "duration_minutes": {
                "type": "number", "exclusiveMinimum": 0, "maximum": MAX_MINUTES
            }
        },
        "required": ["muted"],
        "additionalProperties": false
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub muted: bool,
    #[serde(default, deserialize_with = "minutes")]
    duration_minutes: Option<f64>,
}

fn minutes<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    f64::deserialize(deserializer).map(Some)
}

impl Request {
    /// Parse the original JSON rather than a `Value`, preserving duplicate-field
    /// rejection. Validation must complete before a host dispatches any effect.
    pub fn parse(arguments: &str) -> Result<Self, String> {
        if arguments.len() > MAX_ARGUMENTS {
            return Err("Arguments exceed global call limit".into());
        }
        if !arguments.trim_start().starts_with('{') {
            return Err("Expected JSON object arguments".into());
        }
        let request: Self = serde_json::from_str(arguments).map_err(|error| error.to_string())?;
        request.duration()?;
        Ok(request)
    }

    pub fn duration(&self) -> Result<Option<Duration>, &'static str> {
        let Some(minutes) = self.duration_minutes else {
            return Ok(None);
        };
        if !self.muted || !minutes.is_finite() || minutes <= 0.0 || minutes > f64::from(MAX_MINUTES)
        {
            return Err(INVALID_DURATION);
        }
        Duration::try_from_secs_f64(minutes * 60.0)
            .ok()
            .filter(|duration| !duration.is_zero())
            .map(Some)
            .ok_or("Invalid mute duration.")
    }
}

/// Intent acknowledgement, emitted only after the host accepts the control.
/// This is not a provider acknowledgement or an audio-readiness token.
#[derive(Debug, PartialEq, Serialize)]
pub struct Acknowledgement {
    pub muted: bool,
    pub duration_minutes: Option<f64>,
}

impl Acknowledgement {
    pub fn new(muted: bool, duration: Option<Duration>) -> Self {
        Self {
            muted,
            duration_minutes: duration.map(|duration| duration.as_secs_f64() / 60.0),
        }
    }
}

/// Host snapshot taken while serializing logical-call controls. The identity
/// stays constant across provider rotation, and changes for a replacement call.
#[derive(Clone, Copy, Debug)]
pub struct Context {
    pub call_id: u64,
    pub current: bool,
    pub provider_ready: bool,
    pub suspended: bool,
}

/// One logical call's intent. This type owns no capture or admission machinery.
#[derive(Debug)]
pub struct Policy {
    call_id: u64,
    muted: bool,
    deadline: Option<Instant>,
    ended: bool,
}

impl Policy {
    pub fn new(call_id: u64, muted: bool) -> Self {
        Self {
            call_id,
            muted,
            deadline: None,
            ended: false,
        }
    }

    pub fn muted(&self) -> bool {
        self.muted
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    /// Hangup/revocation permanently cancels timers without changing intent.
    pub fn cancel(&mut self) {
        self.deadline = None;
        self.ended = true;
    }

    /// Every explicit command replaces the deadline, even if intent is unchanged.
    /// Returns whether the host must perform a mute edge (retire capture and cue).
    /// Manual controls remain available during recovery and audio suspension;
    /// new timed mutes require an active provider, as in Whip.
    pub fn set(
        &mut self,
        context: Context,
        muted: bool,
        duration: Option<Duration>,
        now: Instant,
    ) -> Result<bool, &'static str> {
        if self.ended || context.call_id != self.call_id || !context.current {
            return Err(ENDED);
        }
        if duration.is_some() && !context.provider_ready {
            return Err("Wait for the voice call to reconnect before setting a timed mute.");
        }
        if duration.is_some_and(|duration| {
            !muted || duration.is_zero() || duration > Duration::from_mins(u64::from(MAX_MINUTES))
        }) {
            return Err(INVALID_DURATION);
        }
        let deadline = if muted {
            duration
                .map(|duration| now.checked_add(duration).ok_or("Invalid mute duration."))
                .transpose()?
        } else {
            None
        };
        let changed = self.muted != muted;
        self.muted = muted;
        self.deadline = deadline;
        Ok(changed)
    }

    /// Poll with the host's monotonic clock. Due deadlines survive suspension and
    /// eligible reconnects without restarting their duration. A stale callback
    /// for another call cannot cancel or mutate this policy.
    pub fn expire(&mut self, context: Context, now: Instant) -> bool {
        if context.call_id != self.call_id || self.ended {
            return false;
        }
        if !context.current {
            self.cancel();
            return false;
        }
        if context.suspended || !context.provider_ready || self.deadline.is_none_or(|due| now < due)
        {
            return false;
        }
        self.deadline = None;
        self.muted = false;
        true
    }
}
