//! Raw PCM FFI. Handles are monotonic, process-local and never reused.
use super::{Command, Config, FRAME, RealtimeVoiceAdapter, peak};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use voice_call_openai::prepared;

static NEXT: AtomicU64 = AtomicU64::new(1);
static CALLS: OnceLock<Mutex<HashMap<u64, Arc<RealtimeVoiceAdapter>>>> = OnceLock::new();
fn calls() -> &'static Mutex<HashMap<u64, Arc<RealtimeVoiceAdapter>>> {
    CALLS.get_or_init(Mutex::default)
}
fn call(id: u64) -> Option<Arc<RealtimeVoiceAdapter>> {
    calls().lock().get(&id).cloned()
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_cue_begin(id: u64) -> u64 {
    call(id)
        .filter(|call| call.allow_input && !call.closed.load(Ordering::Acquire))
        .map_or(0, |call| call.cue.lock().begin())
}

/// Load a bounded bundled PCM WAV off the device and UI threads.
/// # Safety
/// path is a live NUL-terminated UTF-8 path for this synchronous call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_realtime_cue_load(
    id: u64,
    generation: u64,
    path: *const c_char,
) -> bool {
    if path.is_null() {
        return false;
    }
    // SAFETY: The native adapter lends this NUL-terminated path until return.
    let path = unsafe { CStr::from_ptr(path) };
    let Some(path) = path.to_str().ok().filter(|path| path.len() <= 4096) else {
        return false;
    };
    let Some(call) = call(id).filter(|call| !call.closed.load(Ordering::Acquire)) else {
        return false;
    };
    if !call.cue.lock().playing(generation) {
        return false;
    }
    let Ok(samples) = super::cue::load(path) else {
        call.cue.lock().stop(generation);
        return false;
    };
    if call.closed.load(Ordering::Acquire) {
        return false;
    }
    call.cue.lock().load(generation, samples)
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_cue_playing(id: u64, generation: u64) -> bool {
    call(id).is_some_and(|call| {
        !call.closed.load(Ordering::Acquire) && call.cue.lock().playing(generation)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_cue_stop(id: u64, generation: u64) {
    if let Some(call) = call(id) {
        call.cue.lock().stop(generation);
    }
}

/// Mix only local device output; provider reads and playback acknowledgements
/// retain their original sample counts. The native render callback supplies
/// the complete mix actually accepted by the device as the echo reference.
/// # Safety
/// samples points to count writable PCM16 samples until this call returns.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_realtime_mix_cue(id: u64, samples: *mut i16, count: usize) {
    if samples.is_null() || count > FRAME * 4 {
        return;
    }
    if let Some(call) = call(id).filter(|call| !call.closed.load(Ordering::Acquire)) {
        // SAFETY: The native output adapter owns this bounded writable buffer.
        let samples = unsafe { std::slice::from_raw_parts_mut(samples, count) };
        call.cue.lock().mix(samples);
    }
}

/// Native callers bracket Settings replacement/deletion, even on failure.
#[unsafe(no_mangle)]
pub extern "C" fn whip_voice_credentials_updating(updating: bool) {
    let calls = calls().lock();
    crate::voice_credentials::updating(updating);
    if updating {
        prepared::configure_webrtc(false);
        for call in calls.values() {
            call.close();
        }
    }
}

/// Prepare local WebRTC resources and anonymous HTTPS; no key, mic or API session.
#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_prepare(enabled: bool) -> bool {
    if !enabled {
        return prepared::configure_webrtc(false);
    }
    let Ok(runtime) = crate::runtime() else {
        return false;
    };
    let _guard = runtime.enter();
    prepared::configure_webrtc(true)
}

/// # Safety
/// config is a live NUL-terminated UTF-8 string. reader synchronously fills
/// at most capacity bytes and retains no pointers; context lives until return.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_realtime_start(
    config: *const c_char,
    reader: Option<native_credentials::ReadCredential>,
    context: *mut std::ffi::c_void,
) -> i64 {
    use native_credentials::CredentialError;
    if config.is_null() {
        return 0;
    }
    // SAFETY: Native callers supply a borrowed NUL-terminated string.
    let config = unsafe { CStr::from_ptr(config) };
    if config.to_bytes().len() > 8192 {
        return 0;
    }
    let Ok(config) = serde_json::from_slice::<Config>(config.to_bytes()) else {
        return 0;
    };
    if config.session_id.as_ref().is_some_and(|id| {
        config.preview
            || !crate::voice_session_coordinator().accepts_realtime(
                id,
                config.live,
                config.global,
                config.agent_source.as_ref(),
                config.target.as_ref(),
                config.terminal_target.as_ref(),
            )
    }) {
        return 0;
    }
    let mut calls = calls().lock();
    calls.retain(|_, call| !call.stopped.load(Ordering::Acquire));
    if !calls.is_empty() {
        return 0;
    }
    if crate::voice_credentials::is_updating() {
        return i64::from(CredentialError::Unavailable as i32);
    }
    let Some(reader) = reader else {
        return i64::from(CredentialError::Unavailable as i32);
    };
    let adapter = match RealtimeVoiceAdapter::start(config, || {
        // SAFETY: The native callback/context contract is required by this entrypoint.
        unsafe { crate::voice_credentials::read(Some(reader), context) }.map(|(key, _)| key)
    }) {
        Ok(adapter) => adapter,
        Err(super::StartError::Credential(error)) => return i64::from(error as i32),
        Err(super::StartError::Session) => return 0,
    };
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    calls.insert(id, adapter);
    drop(calls);
    i64::try_from(id).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_stop(id: u64) {
    if let Some(call) = call(id) {
        call.close();
    }
}

/// Native close promises wait for transport and owned tool tasks to drain.
#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_stopped(id: u64) -> bool {
    let mut calls = calls().lock();
    if calls
        .get(&id)
        .is_none_or(|call| call.stopped.load(Ordering::Acquire))
    {
        calls.remove(&id);
        true
    } else {
        false
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_control(id: u64, action: u8) {
    if let Some(call) = call(id) {
        match action {
            1 => call.command(Command::Skip),
            3 | 4 => {
                let _ = call.set_microphone(action == 3, None);
            }
            6 => super::webrtc::devices_started(&call),
            7 => call.suspend_audio(),
            8 => call.resume_audio(),
            9 => call.fail("Audio recovery was not authorized. Start a new call or resume from call history."),
            10 => call.fail("The native audio engine could not recover. Start a new call."),
            11 => call.fail("The audio output was disconnected."),
            12 => call.fail("Audio did not become available again. Start a new call or resume from call history."),
            5 => call.fail("The native audio device was interrupted or became unavailable."),
            _ => {}
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_announcement_finished(id: u64, announcement: u64) {
    if let Some(call) = call(id).filter(|call| !call.closed.load(Ordering::Acquire)) {
        call.microphone
            .lock()
            .announcement_finished(announcement, Instant::now());
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_announcement_start(id: u64, announcement: u64) -> bool {
    call(id).is_some_and(|call| call.announcement_start(announcement))
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_announcement_playing(id: u64, announcement: u64) -> bool {
    call(id).is_some_and(|call| call.announcement_playing(announcement))
}

/// # Safety
/// `text` points to `length` live UTF-8 bytes for this synchronous call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_realtime_submitted(id: u64, text: *const u8, length: usize) -> bool {
    if text.is_null() || length == 0 || length > super::MAX_TEXT {
        return false;
    }
    // SAFETY: The native adapter owns and bounds these bytes until return.
    let Ok(text) = std::str::from_utf8(unsafe { std::slice::from_raw_parts(text, length) }) else {
        return false;
    };
    if super::submitted_message(text).is_err() {
        return false;
    }
    let Some(call) = call(id) else {
        return false;
    };
    if !call.allow_input || call.closed.load(Ordering::Acquire) {
        return false;
    }
    call.commands
        .try_send(Command::Submitted(text.to_owned()))
        .is_ok()
}

/// # Safety
/// samples must reference count initialized PCM16 samples for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_realtime_capture(id: u64, samples: *const i16, count: usize) -> bool {
    if samples.is_null() || count > FRAME * 4 {
        return false;
    }
    // SAFETY: Native microphone passes a borrowed buffer of count samples.
    let samples = unsafe { std::slice::from_raw_parts(samples, count) };
    call(id).is_some_and(|call| {
        let generation = call.input.generation();
        call.capture(samples, generation, Instant::now())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_input_generation(id: u64) -> u64 {
    call(id).map_or(0, |call| call.input.generation())
}

/// # Safety
/// samples must reference count initialized PCM16 samples for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_realtime_capture_timed(
    id: u64,
    samples: *const i16,
    count: usize,
    generation: u64,
    age_ns: u64,
) -> bool {
    if samples.is_null() || count > FRAME * 4 {
        return false;
    }
    let Some(call) = call(id) else {
        return false;
    };
    let now = Instant::now();
    let age = Duration::from_nanos(age_ns);
    if age > super::processing::MAX_DELAY {
        return true;
    }
    let Some(at) = now.checked_sub(age) else {
        return false;
    };
    // SAFETY: Android supplies a borrowed microphone buffer for this call.
    call.capture(
        unsafe { std::slice::from_raw_parts(samples, count) },
        generation,
        at,
    )
}

/// # Safety
/// samples must reference capacity writable samples; epoch a writable u64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_realtime_read(
    id: u64,
    samples: *mut i16,
    capacity: usize,
    epoch: *mut u64,
) -> usize {
    if samples.is_null() || epoch.is_null() || capacity > FRAME * 4 {
        return 0;
    }
    let Some(call) = call(id) else {
        return 0;
    };
    if !call.speech.is_current() {
        call.fail("Voice audio was replaced by another speech session.");
        return 0;
    }
    // SAFETY: Native output worker owns these buffers throughout the call.
    let samples = unsafe { std::slice::from_raw_parts_mut(samples, capacity) };
    let (generation, count) = call.read_output(samples);
    // SAFETY: epoch is a non-null writable pointer supplied by native code.
    unsafe {
        *epoch = generation;
    }
    if count > 0 {
        let mut view = call.view.lock();
        view.fields.playback_level = peak(&samples[..count]);
        view.media.read_samples += u64::try_from(count).unwrap_or(u64::MAX);
    }
    count
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_played(id: u64, epoch: u64, samples: u64) {
    if let Some(call) = call(id) {
        let samples = usize::try_from(samples).unwrap_or(usize::MAX);
        let samples = call
            .echo
            .lock()
            .as_mut()
            .map_or(samples, |echo| echo.played(epoch, samples));
        call.output.lock().acknowledge(epoch, samples);
    }
}

/// Complete PCM mix accepted by the device, including cues and silence for AEC.
/// `audio` identifies provider output for assistant playback accounting only.
/// # Safety
/// samples must reference count initialized PCM16 samples for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_realtime_render(
    id: u64,
    epoch: u64,
    samples: *const i16,
    count: usize,
    audio: bool,
    delay_ns: i64,
) -> bool {
    if samples.is_null() || count > FRAME * 4 || delay_ns.unsigned_abs() > 500_000_000 {
        return false;
    }
    let Some(call) = call(id) else {
        return false;
    };
    // SAFETY: Native playback supplies the borrowed buffer it just submitted.
    let samples = unsafe { std::slice::from_raw_parts(samples, count) };
    let result = call
        .echo
        .lock()
        .as_mut()
        .map(|echo| echo.render(epoch, samples, audio, delay_ns))
        .transpose();
    if let Err(error) = result {
        call.fail(error);
        return false;
    }
    true
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_epoch(id: u64) -> u64 {
    call(id).map_or(0, |call| call.output.lock().epoch)
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_view(id: u64) -> *mut c_char {
    let Some(call) = call(id) else {
        return std::ptr::null_mut();
    };
    native_view(&call)
        .and_then(|value| CString::new(value).ok())
        .map_or(std::ptr::null_mut(), CString::into_raw)
}

/// Control state borrowed by the native audio owner. Announcement text points
/// to a static UTF-8 literal and is null when the queue is empty.
#[repr(C)]
pub struct ControlState {
    ended: bool,
    reconnecting: bool,
    media_ready: bool,
    muted: bool,
    announcement_id: u64,
    lease: u64,
    announcement_text: *const c_char,
    cancelled: bool,
}
#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_control_state(id: u64) -> ControlState {
    let mut state = ControlState {
        ended: true,
        reconnecting: false,
        media_ready: false,
        muted: false,
        announcement_id: 0,
        lease: 0,
        announcement_text: std::ptr::null(),
        cancelled: false,
    };
    if let Some(call) = call(id) {
        let view = call.view.lock();
        state.ended = matches!(view.fields.phase, "closed" | "error");
        state.reconnecting = view.fields.phase == "reconnecting" && !call.is_suspended();
        state.media_ready = view.media_ready;
        state.muted = view.fields.muted;
        drop(view);
        if let Some(announcement) = call.microphone.lock().announcement(call.speech.id()) {
            state.announcement_id = announcement.id;
            state.lease = announcement.lease;
            state.announcement_text = announcement.text.as_c_str().as_ptr();
            state.cancelled = announcement.cancelled;
        }
    }
    state
}

fn diagnostics(call: &RealtimeVoiceAdapter) -> Option<serde_json::Value> {
    let (playback, live_timing) = {
        let output = call.output.lock();
        (
            output.transcript.timing(),
            output
                .live_transcript
                .as_ref()
                .map(super::live::captions::Transcript::clock_timing),
        )
    };
    let signal = call.echo.lock().as_ref().map_or_else(
        super::echo::Signal::default,
        super::echo::MediaEchoCanceller::diagnostics,
    );
    let view = call.view.lock();
    let mut value = serde_json::to_value(&*view).ok()?;
    drop(view);
    let (packets, gaps) = call.input.diagnostics();
    value["capturePackets"] = packets.into();
    value["captureGaps"] = gaps.into();
    value["signal"] = serde_json::to_value(signal).ok()?;
    value["playback"] = serde_json::to_value(playback).ok()?;
    if let Some(timing) = live_timing {
        value["liveCaptionTiming"] = timing;
    }
    Some(value)
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_realtime_diagnostics(id: u64) -> *mut c_char {
    call(id)
        .and_then(|call| {
            let mut value = diagnostics(&call)?;
            let fields = call.view.lock().fields;
            value["phase"] = fields.phase.into();
            value["level"] = fields.level.into();
            Some(value)
        })
        .and_then(|value| CString::new(value.to_string()).ok())
        .map_or(std::ptr::null_mut(), CString::into_raw)
}

fn native_view(call: &RealtimeVoiceAdapter) -> Option<String> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct NativeView<'a> {
        #[serde(flatten)]
        fields: super::presentation::Fields,
        #[serde(flatten)]
        text: super::presentation::TextFields,
        #[serde(flatten)]
        diagnostics: serde_json::Value,
        messages: &'a serde_json::value::RawValue,
        microphone_announcement: Option<super::microphone::Announcement>,
        continuity: voice_call_openai::continuity::Diagnostics,
    }
    let mut diagnostics = diagnostics(call)?;
    let (fields, text) = call.fields();
    let working = fields.working();
    let messages = call.presentation.lock().messages(call, working).ok()?;
    if let Some(live) = diagnostics.get_mut("liveCaptionTiming") {
        live["textUtf16"] = messages.text_utf16.into();
        live["spokenUtf16"] = messages.spoken_utf16.into();
    }
    let microphone_announcement = call.microphone.lock().announcement(call.speech.id());
    let continuity = call.continuity.lock().diagnostics.clone();
    serde_json::to_string(&NativeView {
        fields,
        text,
        diagnostics,
        messages: &messages.raw,
        microphone_announcement,
        continuity,
    })
    .ok()
}

#[cfg(test)]
pub(crate) fn snapshot(call: &RealtimeVoiceAdapter) -> Option<serde_json::Value> {
    serde_json::from_str(&native_view(call)?).ok()
}

/// # Safety
/// value must be null or a live result from whip_realtime_view or whip_realtime_diagnostics, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_realtime_free(value: *mut c_char) {
    if !value.is_null() {
        // SAFETY: view transfers exactly one CString allocation to the caller.
        drop(unsafe { CString::from_raw(value) });
    }
}

#[cfg(test)]
mod credential_admission_tests {
    use super::{whip_realtime_start, whip_voice_credentials_updating};
    use std::ffi::c_void;

    unsafe extern "C" fn missing(context: *mut c_void, _: *mut u8, _: usize) -> i32 {
        // SAFETY: The test provides a live, uniquely borrowed read counter.
        unsafe { *context.cast::<usize>() += 1 };
        -1
    }

    #[test]
    fn secure_storage_is_read_only_after_valid_explicit_admission_and_never_during_revocation() {
        let mut reads = 0_usize;
        let context = (&raw mut reads).cast();
        // SAFETY: All C strings and the callback context live through each call.
        let invalid = unsafe { whip_realtime_start(c"{}".as_ptr(), Some(missing), context) };
        assert_eq!(invalid, 0);
        assert_eq!(reads, 0);
        let preview = c"{\"preview\":true,\"voice\":\"cedar\"}";
        whip_voice_credentials_updating(true);
        // SAFETY: The callback and arguments follow the entrypoint contract.
        let blocked = unsafe { whip_realtime_start(preview.as_ptr(), Some(missing), context) };
        whip_voice_credentials_updating(false);
        assert_eq!(blocked, -3);
        assert_eq!(reads, 0);
        // SAFETY: The callback and arguments follow the entrypoint contract.
        let absent = unsafe { whip_realtime_start(preview.as_ptr(), Some(missing), context) };
        assert_eq!(absent, -1);
        assert_eq!(reads, 1);
    }
}
