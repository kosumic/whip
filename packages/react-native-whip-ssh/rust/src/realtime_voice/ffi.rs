//! Raw PCM FFI. Handles are monotonic, process-local and never reused.
use super::{Command, Config, FRAME, RealtimeVoiceAdapter, peak};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(1);
static CALLS: OnceLock<Mutex<HashMap<u64, Arc<RealtimeVoiceAdapter>>>> = OnceLock::new();
fn calls() -> &'static Mutex<HashMap<u64, Arc<RealtimeVoiceAdapter>>> {
    CALLS.get_or_init(Mutex::default)
}
fn call(id: u64) -> Option<Arc<RealtimeVoiceAdapter>> {
    calls().lock().get(&id).cloned()
}

/// # Safety
/// Both arguments must be live NUL-terminated UTF-8 strings for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_realtime_start(config: *const c_char, key: *const c_char) -> u64 {
    if config.is_null() || key.is_null() {
        return 0;
    }
    // SAFETY: Native callers supply borrowed NUL-terminated strings.
    let config = unsafe { CStr::from_ptr(config) };
    // SAFETY: key is separately guaranteed to be a borrowed C string.
    let key = unsafe { CStr::from_ptr(key) };
    if config.to_bytes().len() > 8192 || key.to_bytes().len() > 1024 {
        return 0;
    }
    let Ok(config) = serde_json::from_slice::<Config>(config.to_bytes()) else {
        return 0;
    };
    let Ok(key) = key.to_str() else {
        return 0;
    };
    let mut calls = calls().lock();
    calls.retain(|_, call| !call.stopped.load(Ordering::Acquire));
    if !calls.is_empty() {
        return 0;
    }
    let Ok(adapter) = RealtimeVoiceAdapter::start(config, key.to_owned()) else {
        return 0;
    };
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    calls.insert(id, adapter);
    id
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
        if action == 3 {
            call.view.lock().muted = true;
        }
        match action {
            1 => call.command(Command::Skip),
            3 => call.command(Command::Mute(true)),
            4 => call.command(Command::Mute(false)),
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
    call(id).is_some_and(|call| call.capture(samples))
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
        call.output
            .lock()
            .acknowledge(epoch, usize::try_from(samples).unwrap_or(usize::MAX));
    }
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
    serde_json::to_string(&*call.view.lock())
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
