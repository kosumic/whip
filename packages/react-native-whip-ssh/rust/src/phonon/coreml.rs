//! The official Core ML runtime, linked into the existing Rust archive. Native
//! iOS code enables it only on iOS 18+, preserving Whip's iOS 16.4 deployment.
use ptts_ffi::{PttsHandle, PttsResult};
use std::{
    ffi::{CStr, CString, c_void},
    path::Path,
};

pub(super) struct Engine {
    handle: Box<PttsHandle>,
    default_voice: String,
}

fn error(handle: *const PttsHandle) -> String {
    // SAFETY: the handle is either null (thread-local initialization error), or
    // a live handle exclusively borrowed by this worker under SYNTH's mutex.
    let message = unsafe { ptts_ffi::ptts_last_error(handle) };
    if message.is_null() {
        return "Core ML speech failed".into();
    }
    // SAFETY: ptts owns the error string until its next operation on this thread.
    unsafe { CStr::from_ptr(message) }
        .to_string_lossy()
        .into_owned()
}

pub(super) fn load(path: &Path) -> Result<Engine, String> {
    let directory = CString::new(path.join("Models").to_string_lossy().as_bytes())
        .map_err(|e| e.to_string())?;
    // SAFETY: both strings are live and NUL-terminated. The unique handle will
    // be kept under SYNTH's mutex, exactly as the official Swift serial queue.
    let handle =
        unsafe { ptts_ffi::ptts_new(directory.as_ptr(), ptts_ffi::PTTS_UNIT_ANE, c"en".as_ptr()) };
    if handle.is_null() {
        return Err(error(handle));
    }
    // SAFETY: ptts_new allocated this unique handle with Box::into_raw.
    let handle = unsafe { Box::from_raw(handle) };
    Ok(Engine {
        handle,
        default_voice: super::bundle::default_voice_name(path)?,
    })
}

struct Sink<'a>(&'a mut dyn FnMut(&[f32]) -> bool);

extern "C" fn emit(samples: *const f32, count: usize, context: *mut c_void) -> bool {
    // SAFETY: ptts_speak calls synchronously with the live Sink and borrowed PCM.
    let sink = unsafe { &mut *context.cast::<Sink<'_>>() };
    // SAFETY: the official runtime guarantees count initialized samples.
    (sink.0)(unsafe { std::slice::from_raw_parts(samples, count) })
}

pub(super) fn speak(
    engine: &mut Engine,
    text: &str,
    voice: &str,
    sink: &mut dyn FnMut(&[f32]) -> bool,
) -> Result<(), String> {
    let text = CString::new(text).map_err(|e| e.to_string())?;
    let voice = CString::new(if voice == super::DEFAULT_VOICE {
        &engine.default_voice
    } else {
        voice
    })
    .map_err(|e| e.to_string())?;
    // SAFETY: the handle is exclusively held by the audio worker, and the
    // selected voice is a verified file enumerated when this handle was opened.
    if !unsafe { ptts_ffi::ptts_set_voice(engine.handle.as_mut(), voice.as_ptr()) } {
        return Err(error(engine.handle.as_ref()));
    }
    let mut sink = Sink(sink);
    let mut result = PttsResult {
        frames: 0,
        samples: 0,
        ttfa_ms: 0.0,
        total_ms: 0.0,
    };
    // SAFETY: the handle is uniquely borrowed under SYNTH's mutex; text, Sink,
    // and result all outlive this synchronous call and all its callbacks.
    if !unsafe {
        ptts_ffi::ptts_speak(
            engine.handle.as_mut(),
            text.as_ptr(),
            emit,
            std::ptr::from_mut(&mut sink).cast(),
            &mut result,
        )
    } {
        return Err(error(engine.handle.as_ref()));
    }
    Ok(())
}
