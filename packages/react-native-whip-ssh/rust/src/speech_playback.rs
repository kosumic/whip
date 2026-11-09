//! Process-wide speech admission and ownership, shared by both native players.
//!
//! Native code owns OS resources and runs on its main thread. A monotonically
//! increasing lease prevents late engine callbacks and old session teardown from
//! cancelling a newer speaker. Chat transcript ordering remains in ChatSpeechQueue.

use std::{
    ffi::{CStr, CString, c_char},
    sync::{
        LazyLock,
        atomic::{AtomicU64, Ordering},
    },
};

use parking_lot::Mutex;

mod playback_units;
static PLAYBACK_UNITS: LazyLock<Mutex<playback_units::PlaybackUnits>> =
    LazyLock::new(Mutex::default);

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
        const MS_PER_TEXT_UNIT: u64 = 250;
        const MAX_BUDGET_MS: u64 = 600_000;
        let minimum = match self {
            Self::Chat => 30_000,
            Self::Announcement => 10_000,
            Self::Device => 60_000,
        };
        text_units
            .saturating_mul(MS_PER_TEXT_UNIT)
            .clamp(minimum, MAX_BUDGET_MS)
    }
}

impl SpeechKind {
    const fn admission(self) -> mobile_speech::Admission {
        use mobile_speech::{Admission, Preemption};
        Admission {
            preemption: match self {
                Self::Chat => Preemption::Any,
                Self::Announcement => Preemption::SameClass,
                Self::Device => Preemption::SameOwner,
            },
            retain_on_complete: matches!(self, Self::Chat),
        }
    }
}

/// Whip's class mapping and policy over the reusable ownership authority.
#[derive(Default)]
struct SpeechPlayback(mobile_speech::Arbiter);

impl SpeechPlayback {
    fn claim(&mut self, kind: SpeechKind, owner: &str, request: &str) -> u64 {
        self.0
            .claim(kind as u8, owner, request, kind.admission())
            .map_or(0, mobile_speech::LeaseId::get)
    }
    fn claim_status_at_boundary(&mut self, owner: &str, observed: u64) -> u64 {
        self.0
            .handoff(
                mobile_speech::LeaseId::new(observed),
                SpeechKind::Chat as u8,
                SpeechKind::Announcement as u8,
                owner,
                SpeechKind::Announcement.admission(),
            )
            .map_or(0, mobile_speech::LeaseId::get)
    }
    fn is_current(&self, id: u64) -> bool {
        mobile_speech::LeaseId::new(id).is_some_and(|id| self.0.is_current(id))
    }
    fn complete(&mut self, id: u64) -> bool {
        mobile_speech::LeaseId::new(id).is_some_and(|id| self.0.complete(id))
    }
    fn stop(&mut self, id: u64) -> bool {
        mobile_speech::LeaseId::new(id).is_some_and(|id| self.0.stop(id))
    }
    fn stop_matching(
        &mut self,
        kind: SpeechKind,
        owner: Option<&str>,
        request: Option<&str>,
    ) -> u64 {
        self.0
            .stop_matching(kind as u8, owner, request)
            .map_or(0, mobile_speech::LeaseId::get)
    }
}

static PLAYBACK: LazyLock<Mutex<SpeechPlayback>> = LazyLock::new(Mutex::default);

/// Realtime output shares admission with local previews, chat and device speech.
pub(crate) struct RealtimeSpeechLease {
    id: AtomicU64,
    suppress_automatic: std::sync::atomic::AtomicBool,
}

impl RealtimeSpeechLease {
    pub(crate) fn id(&self) -> u64 {
        self.id.load(Ordering::Acquire)
    }

    pub(crate) fn claim(preview: bool) -> Option<Self> {
        let kind = if preview {
            SpeechKind::Announcement
        } else {
            SpeechKind::Chat
        };
        let id = PLAYBACK.lock().claim(kind, "openai-realtime", "");
        if id == 0 {
            return None;
        }
        if !preview {
            crate::automatic_speech::voice_call_started();
        }
        Some(Self {
            id: AtomicU64::new(id),
            suppress_automatic: std::sync::atomic::AtomicBool::new(!preview),
        })
    }

    pub(crate) fn is_current(&self) -> bool {
        is_current(self.id.load(Ordering::Acquire))
    }

    pub(crate) fn release(&self) {
        let id = self.id.swap(0, Ordering::AcqRel);
        PLAYBACK.lock().stop(id);
        self.end_call();
    }

    pub(crate) fn end_call(&self) {
        if self.suppress_automatic.swap(false, Ordering::AcqRel) {
            crate::automatic_speech::voice_call_ended();
        }
    }
}

impl Drop for RealtimeSpeechLease {
    fn drop(&mut self) {
        self.release();
    }
}

pub(crate) fn claim_status_at_boundary(owner: &str, observed_lease: u64) -> u64 {
    PLAYBACK
        .lock()
        .claim_status_at_boundary(owner, observed_lease)
}

/// # Safety
/// Both string arguments must be live NUL-terminated UTF-8 for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_alert_speech_command(
    action: *const c_char,
    token: *const c_char,
    observed_lease: u64,
) -> *mut c_char {
    if action.is_null() || token.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: Both platform adapters supply live NUL-terminated strings.
    let action = unsafe { CStr::from_ptr(action) }.to_string_lossy();
    // SAFETY: Both platform adapters supply live NUL-terminated strings.
    let token = unsafe { CStr::from_ptr(token) }.to_string_lossy();
    let result = if let Some(command) = action.strip_prefix("playback-") {
        PLAYBACK_UNITS.lock().command(command, &token)
    } else {
        crate::app_core::native_speech_command(&action, &token, observed_lease)
    };
    CString::new(result).map_or(std::ptr::null_mut(), CString::into_raw)
}

/// # Safety
/// The argument must be null or a live result of whip_alert_speech_command,
/// and must be freed exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_alert_speech_free(value: *mut c_char) {
    if !value.is_null() {
        // SAFETY: Ownership of this allocation is returned by the native caller.
        drop(unsafe { CString::from_raw(value) });
    }
}

pub(crate) fn is_current(lease: u64) -> bool {
    PLAYBACK.lock().is_current(lease)
}

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
    fn status_handoff_is_fenced_by_the_observed_chat_lease() {
        let mut speech = SpeechPlayback::default();
        let chat = speech.claim(Chat, "reader", "");
        assert_eq!(speech.claim_status_at_boundary("alert", 0), 0);
        assert!(speech.complete(chat));
        let alert = speech.claim_status_at_boundary("alert", chat);
        assert_ne!(alert, 0);
        assert!(!speech.complete(chat));
        assert_eq!(speech.stop_matching(Chat, Some("reader"), None), 0);
        assert_eq!(speech.claim_status_at_boundary("another-alert", chat), 0);
        assert!(speech.complete(alert));
        let resumed = speech.claim(Chat, "reader", "");
        assert_ne!(resumed, chat);
        assert_eq!(speech.stop_matching(Announcement, Some("alert"), None), 0);
        assert!(!speech.stop(alert));
        assert!(speech.is_current(resumed));
    }

    #[test]
    fn stale_boundary_cannot_displace_device_or_a_new_chat_owner() {
        let mut speech = SpeechPlayback::default();
        let old = speech.claim(Chat, "old", "");
        let current = speech.claim(Chat, "current", "");
        assert_eq!(speech.claim_status_at_boundary("alert", old), 0);
        assert!(speech.stop(current));
        let device = speech.claim(Device, "tool", "request");
        assert_eq!(speech.claim_status_at_boundary("alert", device), 0);
        assert_eq!(speech.claim_status_at_boundary("alert", 0), 0);
        assert!(speech.is_current(device));
        assert!(speech.complete(device));
        assert_ne!(speech.claim_status_at_boundary("alert", 0), 0);
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
    fn long_readings_get_chat_sized_budgets_with_each_kinds_short_minimum() {
        assert_eq!(Announcement.timeout_ms(1), 10_000);
        assert_eq!(Device.timeout_ms(1), 60_000);
        assert_eq!(Chat.timeout_ms(1), 30_000);
        for kind in [Chat, Announcement, Device] {
            assert_eq!(kind.timeout_ms(1_000), 250_000);
            assert_eq!(kind.timeout_ms(2_000), 500_000);
            assert_eq!(kind.timeout_ms(u64::MAX), 600_000);
        }
    }
}
