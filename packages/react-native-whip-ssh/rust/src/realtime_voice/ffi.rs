//! Raw PCM FFI. Handles are monotonic, process-local and never reused.
use super::{Command, Config, FRAME, RealtimeVoiceAdapter, peak};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

static NEXT: AtomicU64 = AtomicU64::new(1);
static CALLS: OnceLock<Mutex<HashMap<u64, Arc<RealtimeVoiceAdapter>>>> = OnceLock::new();
fn calls() -> &'static Mutex<HashMap<u64, Arc<RealtimeVoiceAdapter>>> {
    CALLS.get_or_init(Mutex::default)
}
fn call(id: u64) -> Option<Arc<RealtimeVoiceAdapter>> {
    calls().lock().get(&id).cloned()
}

// Serializes credential reads and admission against Settings mutations.
static CREDENTIAL_UPDATE: AtomicBool = AtomicBool::new(false);

/// Native callers bracket Settings replacement/deletion, even on failure.
#[unsafe(no_mangle)]
pub extern "C" fn whip_voice_credentials_updating(updating: bool) {
    let calls = calls().lock();
    CREDENTIAL_UPDATE.store(updating, Ordering::Relaxed);
    if updating {
        for call in calls.values() {
            call.close();
        }
    }
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
    use native_credentials::{CredentialError, NativeCredential};
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
    let mut calls = calls().lock();
    calls.retain(|_, call| !call.stopped.load(Ordering::Acquire));
    if !calls.is_empty() {
        return 0;
    }
    if CREDENTIAL_UPDATE.load(Ordering::Relaxed) {
        return i64::from(CredentialError::Unavailable as i32);
    }
    let Some(reader) = reader else {
        return i64::from(CredentialError::Unavailable as i32);
    };
    let adapter = match RealtimeVoiceAdapter::start(config, || {
        // SAFETY: The native callback/context contract is required by this entrypoint.
        unsafe { NativeCredential::read(reader, context) }
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
        if (action == 3 || action == 4) && !call.input.set_muted(action == 3) {
            return;
        }
        if action == 3 {
            call.view.lock().muted = true;
        }
        match action {
            1 => call.command(Command::Skip),
            3 => call.command(Command::Mute(true)),
            4 => call.command(Command::Mute(false)),
            6 => super::webrtc::devices_started(&call),
            5 => call.fail("The native audio device was interrupted or became unavailable."),
            _ => {}
        }
    }
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
    let mut output = call.output.lock();
    // SAFETY: epoch is a non-null writable pointer supplied by native code.
    unsafe {
        *epoch = output.epoch;
    }
    let count = output.read(samples);
    drop(output);
    if count > 0 {
        call.view.lock().playback_level = peak(&samples[..count]);
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

/// Audio actually submitted to the device, including silence that keeps AEC clocked.
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
    let messages = call.output.lock().transcript.snapshot();
    let mut view = call.view.lock();
    view.messages = messages;
    serde_json::to_string(&*view)
        .ok()
        .and_then(|value| CString::new(value).ok())
        .map_or(std::ptr::null_mut(), CString::into_raw)
}

/// # Safety
/// value must be null or a live result from whip_realtime_view, freed once.
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
