//! Phonon model artifacts, platform inference and native PCM generation.
#[cfg(target_os = "ios")]
mod bundle;
#[cfg(not(target_os = "ios"))]
mod cpu;
pub(super) mod download;
pub(super) mod voices;
#[cfg(not(target_os = "ios"))]
use cpu as runtime;
#[cfg(target_os = "ios")]
mod coreml;
#[cfg(target_os = "ios")]
use coreml as runtime;

use crate::speech_backend::{MAX_TEXT_UNITS, PCM_CHUNK_SAMPLES, PcmCallback};
use parking_lot::Mutex;
use std::{
    ffi::{CStr, c_char, c_void},
    path::PathBuf,
    sync::{
        LazyLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

pub(super) const REVISION: &str = "8c64b55ec301728e2d1695bfea87a08a267d0c2d";
pub(super) const SAMPLE_RATE: u32 = 24_000;
pub(super) const DEFAULT_VOICE: &str = "default";

#[derive(Clone, Copy)]
pub(super) struct Artifact {
    pub(super) name: &'static str,
    pub(super) bytes: u64,
    sha256: &'static str,
}

#[cfg(not(target_os = "ios"))]
pub(super) const ARTIFACTS: &[Artifact] = &[
    Artifact {
        name: "config.json",
        bytes: 2_851,
        sha256: "7062ea376e6b158543c8abec8e5af67df171c49ad70eb7e2a0fb25c16f265e06",
    },
    Artifact {
        name: "tokenizer.json",
        bytes: 277_967,
        sha256: "691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936",
    },
    Artifact {
        name: "default-voice.safetensors",
        bytes: 256_136,
        sha256: "f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18",
    },
    Artifact {
        name: "model.q8.gguf",
        bytes: 64_512_352,
        sha256: "a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae",
    },
];

#[cfg(target_os = "ios")]
pub(super) const ARTIFACTS: &[Artifact] = &[Artifact {
    name: "phonon-31m-en-coreml.zip",
    bytes: 137_300_815,
    sha256: "2869326ab074f55ed5b644e68b1befef69dc51545b73296d49f5b4dab14c4218",
}];

pub(super) fn supported() -> bool {
    PLATFORM_SUPPORTED.load(Ordering::Acquire)
}

static PLATFORM_SUPPORTED: AtomicBool =
    AtomicBool::new(cfg!(all(target_os = "android", target_arch = "aarch64")));

#[unsafe(no_mangle)]
pub extern "C" fn whip_phonon_set_supported(supported: bool) {
    PLATFORM_SUPPORTED.store(
        supported && cfg!(target_arch = "aarch64"),
        Ordering::Release,
    );
}

struct LoadedModel {
    path: PathBuf,
    generation: u64,
    engine: runtime::Engine,
}
static SYNTH: LazyLock<Mutex<Option<LoadedModel>>> = LazyLock::new(Mutex::default);
static INFERENCE_POOL: LazyLock<()> = LazyLock::new(|| {
    // Set a conservative phone budget before xn first uses Rayon. An existing
    // process-wide pool (e.g. from image rendering) retains its configuration.
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(2)
        .build_global();
});

pub(super) fn clear_model() {
    SYNTH.lock().take();
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
    let mut loaded = SYNTH.lock();
    if !crate::speech_playback::is_current(lease) {
        return Ok(false);
    }
    let started = Instant::now();
    let cold = loaded
        .as_ref()
        .is_none_or(|model| model.path != path || model.generation != generation);
    if cold {
        download::verify(&path)?;
        let synth = runtime::load(&path)?;
        *loaded = Some(LoadedModel {
            path,
            generation,
            engine: synth,
        });
    }
    if !crate::speech_playback::is_current(lease) {
        return Ok(false);
    }
    let model_load_ms = started.elapsed().as_millis();
    let synth = &mut loaded.as_mut().ok_or("Phonon failed to load")?.engine;
    let mut samples = 0usize;
    let mut first_pcm_ms = None;
    let mut cancelled = false;
    runtime::speak(synth, text, &voice, &mut |pcm| {
        for chunk in pcm.chunks(PCM_CHUNK_SAMPLES) {
            if !crate::speech_playback::is_current(lease) {
                cancelled = true;
                return false;
            }
            first_pcm_ms.get_or_insert_with(|| started.elapsed().as_millis());
            // SAFETY: the native callback consumes this borrowed slice synchronously.
            if !unsafe { callback(context, chunk.as_ptr(), chunk.len()) } {
                cancelled = true;
                return false;
            }
            samples += chunk.len();
        }
        true
    })?;
    drop(loaded);
    if cancelled {
        return Ok(false);
    }
    crate::speech_backend::phonon_succeeded();
    eprintln!(
        "[Phonon] cold={cold} load_ms={model_load_ms} first_pcm_ms={} synthesis_and_backpressure_ms={} audio_ms={}",
        first_pcm_ms.unwrap_or_default(),
        started.elapsed().as_millis(),
        samples * 1000 / SAMPLE_RATE as usize
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
