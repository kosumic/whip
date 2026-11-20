//! Whip's native speech boundary; model storage and inference live in phonon-local.
use crate::speech_backend::{MAX_TEXT_UNITS, PcmCallback};
pub(super) use phonon_local::{ARTIFACTS, DEFAULT_VOICE, REVISION, download, voices};
use phonon_local::{Model, Synthesizer};
use std::{
    ffi::{CStr, c_char, c_void},
    sync::{
        LazyLock,
        atomic::{AtomicBool, Ordering},
    },
};

pub(super) fn supported() -> bool {
    PLATFORM_SUPPORTED.load(Ordering::Acquire)
}

static PLATFORM_SUPPORTED: AtomicBool =
    AtomicBool::new(cfg!(all(target_os = "android", target_arch = "aarch64")));

#[unsafe(no_mangle)]
pub extern "C" fn whip_phonon_set_supported(supported: bool) {
    PLATFORM_SUPPORTED.store(
        supported && phonon_local::native_supported(),
        Ordering::Release,
    );
}

static SYNTH: LazyLock<Synthesizer> = LazyLock::new(Synthesizer::default);
static INFERENCE_POOL: LazyLock<()> = LazyLock::new(|| {
    // Preserve Whip's phone budget before xn first uses Rayon.
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(2)
        .build_global();
});

pub(super) fn clear_model() {
    SYNTH.clear();
}

fn synthesize(
    lease: u64,
    text: &str,
    callback: PcmCallback,
    context: *mut c_void,
) -> Result<bool, String> {
    if text.encode_utf16().count() > MAX_TEXT_UNITS {
        return Err("Speech text exceeds the utterance limit".into());
    }
    if !crate::speech_playback::is_current(lease) {
        return Ok(false);
    }
    let (path, generation, voice) = crate::speech_backend::phonon_model()?;
    let report = SYNTH.synthesize(
        Model {
            directory: &path,
            generation,
            voice: &voice,
        },
        text,
        || crate::speech_playback::is_current(lease),
        |chunk| {
            // SAFETY: the native callback consumes this borrowed slice synchronously.
            unsafe { callback(context, chunk.as_ptr(), chunk.len()) }
        },
    )?;
    if !report.completed {
        return Ok(false);
    }
    crate::speech_backend::phonon_succeeded();
    eprintln!(
        "[Phonon] cold={} load_ms={} first_pcm_ms={} synthesis_and_backpressure_ms={} audio_ms={}",
        report.cold,
        report.model_load.as_millis(),
        report.first_pcm.unwrap_or_default().as_millis(),
        report.elapsed.as_millis(),
        report.samples * 1000 / phonon_local::SAMPLE_RATE as usize,
    );
    Ok(true)
}

/// # Safety
/// The caller supplies a live NUL-terminated language tag.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_phonon_enabled(language: *const c_char) -> bool {
    if !supported() || language.is_null() {
        return false;
    }
    // SAFETY: The caller guarantees the borrowed language string is live.
    let Ok(language) = (unsafe { CStr::from_ptr(language) }).to_str() else {
        return false;
    };
    crate::speech_backend::phonon_available(language)
}

/// Runs on a native audio worker. Returns 1 on synthesis completion, 0 on cancellation,
/// -1 on failure. Completion does not imply native playback has drained.
/// # Safety
/// `text` is valid UTF-8; `callback` and `context` remain valid until this call returns.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_phonon_speak(
    lease: u64,
    text: *const c_char,
    callback: PcmCallback,
    context: *mut c_void,
) -> i32 {
    if text.is_null() {
        return -1;
    }
    // SAFETY: caller guarantees a NUL-terminated string for this call.
    let Ok(text) = (unsafe { CStr::from_ptr(text) }).to_str() else {
        return -1;
    };
    // Keep the native context on this thread; pool workers only execute inference operations.
    LazyLock::force(&INFERENCE_POOL);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        synthesize(lease, text, callback, context)
    }))
    .unwrap_or_else(|_| Err("The speech runtime failed".into()));
    match result {
        Ok(completed) => i32::from(completed),
        Err(error) => {
            crate::speech_backend::phonon_failed(&error);
            -1
        }
    }
}
