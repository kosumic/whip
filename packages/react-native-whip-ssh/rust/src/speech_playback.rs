//! Process-wide speech admission and ownership, shared by both native players.
//!
//! Native code owns OS resources and runs on its main thread. A monotonically
//! increasing lease prevents late engine callbacks and old session teardown from
//! cancelling a newer speaker. Chat transcript ordering remains in ChatSpeechQueue.

use std::{
    ffi::{CStr, c_char},
    sync::LazyLock,
};

use parking_lot::Mutex;

// Values form the small C ABI in cpp/WhipSpeechPolicy.h.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum SpeechKind {
    Chat = 1,
    Announcement = 2,
    Device = 3,
}

impl TryFrom<u8> for SpeechKind {
    type Error = ();

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Chat),
            2 => Ok(Self::Announcement),
            3 => Ok(Self::Device),
            _ => Err(()),
        }
    }
}

impl SpeechKind {
    fn timeout_ms(self, text_units: u64) -> u64 {
        match self {
            Self::Chat => text_units.saturating_mul(250).clamp(30_000, 600_000),
            Self::Announcement => 10_000,
            Self::Device => 60_000,
        }
    }
}

#[derive(Debug)]
struct Lease {
    id: u64,
    kind: SpeechKind,
    owner: String,
    request: String,
}

#[derive(Default)]
struct SpeechPlayback {
    sequence: u64,
    active: Option<Lease>,
}

impl SpeechPlayback {
    fn claim(&mut self, kind: SpeechKind, owner: &str, request: &str) -> u64 {
        if owner.is_empty() {
            return 0;
        }
        if let Some(active) = &self.active {
            let allowed = match kind {
                SpeechKind::Chat => true,
                SpeechKind::Announcement => active.kind == SpeechKind::Announcement,
                SpeechKind::Device => active.kind == kind && active.owner == owner,
            };
            if !allowed {
                return 0;
            }
        }
        // Zero denotes denied admission. Never reuse a live callback's lease.
        let Some(id) = self.sequence.checked_add(1) else {
            return 0;
        };
        self.sequence = id;
        self.active = Some(Lease {
            id,
            kind,
            owner: owner.into(),
            request: request.into(),
        });
        id
    }

    fn is_current(&self, id: u64) -> bool {
        self.active.as_ref().is_some_and(|active| active.id == id)
    }

    fn complete(&mut self, id: u64) -> bool {
        if !self.is_current(id) {
            return false;
        }
        // Listening chat owns speech even between replies. One-shot callers
        // release it as soon as their utterance finishes.
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.kind != SpeechKind::Chat)
        {
            self.active = None;
        }
        true
    }

    fn stop(&mut self, id: u64) -> bool {
        if !self.is_current(id) {
            return false;
        }
        self.active = None;
        true
    }

    fn stop_matching(
        &mut self,
        kind: SpeechKind,
        owner: Option<&str>,
        request: Option<&str>,
    ) -> u64 {
        let Some(active) = &self.active else { return 0 };
        if active.kind != kind
            || owner.is_some_and(|owner| owner != active.owner)
            || request.is_some_and(|request| request != active.request)
        {
            return 0;
        }
        let id = active.id;
        self.active = None;
        id
    }
}

static PLAYBACK: LazyLock<Mutex<SpeechPlayback>> = LazyLock::new(Mutex::default);

/// # Safety
/// `owner` and `request` must point to NUL-terminated UTF-8 strings for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_speech_claim(
    kind: u8,
    owner: *const c_char,
    request: *const c_char,
) -> u64 {
    let Ok(kind) = SpeechKind::try_from(kind) else {
        return 0;
    };
    if owner.is_null() || request.is_null() {
        return 0;
    }
    // SAFETY: The native adapters provide live, NUL-terminated strings.
    let owner = unsafe { CStr::from_ptr(owner) }.to_string_lossy();
    // SAFETY: The native adapters provide live, NUL-terminated strings.
    let request = unsafe { CStr::from_ptr(request) }.to_string_lossy();
    PLAYBACK.lock().claim(kind, &owner, &request)
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_speech_is_current(id: u64) -> bool {
    PLAYBACK.lock().is_current(id)
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_speech_complete(id: u64) -> bool {
    PLAYBACK.lock().complete(id)
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_speech_stop(id: u64) -> bool {
    PLAYBACK.lock().stop(id)
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_speech_timeout_ms(kind: u8, text_units: u64) -> u64 {
    SpeechKind::try_from(kind).map_or(0, |kind| kind.timeout_ms(text_units))
}

/// # Safety
/// `owner` must point to a NUL-terminated UTF-8 string for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_speech_stop_owner(kind: u8, owner: *const c_char) -> u64 {
    let Ok(kind) = SpeechKind::try_from(kind) else {
        return 0;
    };
    if owner.is_null() {
        return 0;
    }
    // SAFETY: The native adapters provide a live, NUL-terminated string.
    let owner = unsafe { CStr::from_ptr(owner) }.to_string_lossy();
    PLAYBACK.lock().stop_matching(kind, Some(&owner), None)
}

/// # Safety
/// `request` must point to a NUL-terminated UTF-8 string for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_speech_cancel_request(kind: u8, request: *const c_char) -> u64 {
    let Ok(kind) = SpeechKind::try_from(kind) else {
        return 0;
    };
    if request.is_null() {
        return 0;
    }
    // SAFETY: The native adapters provide a live, NUL-terminated string.
    let request = unsafe { CStr::from_ptr(request) }.to_string_lossy();
    PLAYBACK.lock().stop_matching(kind, None, Some(&request))
}

#[cfg(test)]
mod tests {
    use super::{
        SpeechKind::{Announcement, Chat, Device},
        SpeechPlayback,
    };

    #[test]
    fn chat_preempts_other_speech_and_reserves_playback_between_replies() {
        let mut speech = SpeechPlayback::default();
        let device = speech.claim(Device, "launch", "request");
        let chat = speech.claim(Chat, "chat", "");
        assert!(!speech.complete(device));
        assert!(!speech.stop(device));
        assert!(speech.complete(chat));
        assert_eq!(speech.claim(Announcement, "alert", ""), 0);
        assert_eq!(speech.claim(Device, "launch", "request-2"), 0);
        assert!(speech.stop(chat));
        assert_ne!(speech.claim(Announcement, "alert", ""), 0);
    }

    #[test]
    fn device_teardown_only_stops_its_own_live_request() {
        let mut speech = SpeechPlayback::default();
        let first = speech.claim(Device, "launch", "first");
        assert_eq!(speech.claim(Device, "another-launch", "request"), 0);
        let second = speech.claim(Device, "launch", "second");
        assert_ne!(first, second);
        assert_eq!(speech.stop_matching(Device, None, Some("first")), 0);
        assert_eq!(
            speech.stop_matching(Device, Some("another-launch"), None),
            0
        );
        assert_eq!(speech.stop_matching(Announcement, Some("launch"), None), 0);
        assert!(speech.is_current(second));
        assert_eq!(speech.stop_matching(Device, Some("launch"), None), second);
        assert!(!speech.is_current(second));
    }

    #[test]
    fn one_shot_completion_releases_speech_and_late_callbacks_are_ignored() {
        let mut speech = SpeechPlayback::default();
        let first = speech.claim(Announcement, "first", "");
        let second = speech.claim(Announcement, "second", "");
        assert!(!speech.complete(first));
        assert_eq!(speech.stop_matching(Announcement, Some("first"), None), 0);
        assert!(speech.complete(second));
        assert!(!speech.is_current(second));
        let device = speech.claim(Device, "launch", "request");
        assert_eq!(speech.claim(Announcement, "alert", ""), 0);
        assert!(speech.complete(device));
        assert_ne!(speech.claim(Announcement, "alert", ""), 0);
    }

    #[test]
    fn native_cancellation_invalidates_every_kind_of_speech() {
        for kind in [Chat, Announcement, Device] {
            let mut speech = SpeechPlayback::default();
            let cancelled = speech.claim(kind, "owner", "request");
            assert!(speech.stop(cancelled));
            let next = speech.claim(kind, "next", "next-request");
            assert_ne!(cancelled, next);
            assert!(!speech.complete(cancelled));
            assert!(speech.is_current(next));
        }
    }

    #[test]
    fn playback_deadlines_preserve_short_alert_and_device_limits() {
        assert_eq!(Announcement.timeout_ms(2_000), 10_000);
        assert_eq!(Device.timeout_ms(2_000), 60_000);
        assert_eq!(Chat.timeout_ms(1), 30_000);
        assert_eq!(Chat.timeout_ms(1_000), 250_000);
        assert_eq!(Chat.timeout_ms(u64::MAX), 600_000);
    }
}
