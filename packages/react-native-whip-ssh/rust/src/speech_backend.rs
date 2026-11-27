//! Shared speech preferences, provider selection and native PCM dispatch.
//! Provider-specific synthesis lives in phonon and openai_tts.
use crate::{
    openai_tts,
    phonon::{self, DEFAULT_VOICE, supported, voices},
};
use parking_lot::Mutex;
use phonon_local::Installation;
use serde::{Deserialize, Serialize};
use std::{
    ffi::{CStr, CString, c_char, c_void},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
};

pub(crate) const MAX_TEXT_UNITS: usize = 3_000;
pub(crate) const PCM_CHUNK_SAMPLES: usize = phonon_local::PCM_CHUNK_SAMPLES;
const PREVIEW_TEXT_COMMAND: &str = "preview-text:";

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Backend {
    #[default]
    System,
    Phonon,
    Openai,
}

impl Backend {
    const fn uses_network(self) -> bool {
        match self {
            Self::System | Self::Phonon => false,
            Self::Openai => true,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default)]
struct Preferences {
    backend: Backend,
    voice: String,
    system_voice: String,
    openai_voice: String,
    openai_voice_generation: u64,
    preview_text: Option<String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            backend: Backend::System,
            voice: DEFAULT_VOICE.into(),
            system_voice: String::new(),
            openai_voice: openai_tts::DEFAULT_VOICE.into(),
            openai_voice_generation: 0,
            preview_text: None,
        }
    }
}

struct State {
    root: PathBuf,
    installation: Installation,
    preferences: Preferences,
    error: Option<String>,
    fallback: Option<String>,
    runtime_failed: bool,
}

impl State {
    fn open(root: &Path) -> Result<Self, String> {
        let installation = Installation::open(root)?;
        let (mut preferences, mut error) = match fs::read(root.join("preferences.json")) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(preferences) => (preferences, None),
                Err(_) => (
                    Preferences::default(),
                    Some("Saved speech preferences could not be read. Using system speech.".into()),
                ),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Preferences::default(), None),
            Err(e) => (Preferences::default(), Some(e.to_string())),
        };
        if voices::CATALOG.is_empty() {
            error = Some(
                "The voice catalog is unavailable. The default Phonon voice remains available."
                    .into(),
            );
        }
        if !installation.has_voice(&preferences.voice) {
            preferences.voice = DEFAULT_VOICE.into();
            error = Some("The saved Phonon voice is unavailable. Using the default voice.".into());
        }
        let installed = installation.status().installed;
        let mut state = Self {
            root: root.into(),
            installation,
            preferences,
            error,
            fallback: None,
            runtime_failed: false,
        };
        if !installed || !supported() {
            state.fallback_from(Backend::Phonon)?;
        }
        Ok(state)
    }

    fn fallback_from(&mut self, backend: Backend) -> Result<(), String> {
        if self.preferences.backend == backend {
            self.select(Backend::System)?;
        }
        Ok(())
    }

    fn select(&mut self, backend: Backend) -> Result<(), String> {
        if backend == Backend::Phonon && (!supported() || !self.installation.status().installed) {
            return Err("Download and install Phonon on a supported device first".into());
        }
        let preferences = Preferences {
            backend,
            ..self.preferences.clone()
        };
        self.save(preferences)?;
        self.fallback = None;
        self.runtime_failed = false;
        Ok(())
    }

    fn save(&mut self, preferences: Preferences) -> Result<(), String> {
        let bytes = serde_json::to_vec(&preferences).map_err(|e| e.to_string())?;
        let temporary = self.root.join("preferences.tmp");
        fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
        fs::rename(temporary, self.root.join("preferences.json")).map_err(|e| e.to_string())?;
        self.preferences = preferences;
        Ok(())
    }

    fn select_voice(&mut self, voice: &str) -> Result<(), String> {
        if !self.installation.has_voice(voice) {
            return Err("Download this Phonon voice first".into());
        }
        self.save(Preferences {
            voice: voice.into(),
            ..self.preferences.clone()
        })?;
        self.fallback = None;
        self.runtime_failed = false;
        Ok(())
    }

    fn set_preview_text(&mut self, text: String) -> Result<(), String> {
        if text.encode_utf16().count() > MAX_TEXT_UNITS {
            return Err("Preview text exceeds the speech utterance limit".into());
        }
        self.save(Preferences {
            preview_text: Some(text),
            ..self.preferences.clone()
        })
    }

    fn select_openai_voice(&mut self, voice: &str) -> Result<(), String> {
        if !openai_tts::VOICES.contains(&voice) {
            return Err("Choose a supported OpenAI TTS voice".into());
        }
        if self.preferences.openai_voice == voice {
            self.fallback = None;
            return Ok(());
        }
        let preferences = Preferences {
            openai_voice: voice.into(),
            openai_voice_generation: self.preferences.openai_voice_generation.wrapping_add(1),
            ..self.preferences.clone()
        };
        self.save(preferences)?;
        self.fallback = None;
        Ok(())
    }

    fn cached_phrase(&self, text: &str) -> Option<openai_tts::CachedPhrase> {
        openai_tts::CachedPhrase::new(
            &self.root,
            self.preferences.openai_voice_generation,
            &self.preferences.openai_voice,
            text,
        )
    }

    fn status(&self) -> serde_json::Value {
        let status = self.installation.status();
        serde_json::json!({
            "backend": self.preferences.backend, "voice": self.preferences.voice, "supported": supported(),
            "systemVoice": self.preferences.system_voice,
            "openaiVoice": self.preferences.openai_voice,
            "openaiVoices": openai_tts::VOICES,
            "previewText": self.preferences.preview_text,
            "maxTextUnits": MAX_TEXT_UNITS,
            "voiceDownload": status.voice_download,
            "voices": voices::CATALOG.iter().map(|voice| serde_json::json!({
                "id": voice.id, "name": voice.name, "language": voice.locale,
                "description": voice.description, "bytes": voice.bytes,
                "installed": status.installed_voices.contains(&voice.id),
            })).collect::<Vec<_>>(),
            "installed": status.installed, "downloading": status.downloading,
            "downloadedBytes": status.downloaded_bytes, "totalBytes": Installation::total_bytes(),
            "error": status.error.or_else(|| self.error.clone()), "fallback": self.fallback,
            "requiredStorageBytes": if cfg!(target_os = "ios") { 600_000_000u64 } else { Installation::total_bytes() },
        })
    }
}

static OPERATIONS: Mutex<()> = Mutex::new(());
static STATE: LazyLock<Mutex<Option<Arc<Mutex<State>>>>> = LazyLock::new(Mutex::default);
fn state() -> Result<Arc<Mutex<State>>, String> {
    STATE
        .lock()
        .clone()
        .ok_or_else(|| "Speech backend is not initialized".into())
}

fn command(root: &str, action: &str) -> Result<serde_json::Value, String> {
    if let Some(result) = crate::openai_stt::command(action) {
        return result;
    }
    let state = {
        let mut slot = STATE.lock();
        if slot.is_none() {
            *slot = Some(Arc::new(Mutex::new(State::open(Path::new(root))?)));
        }
        slot.as_ref()
            .cloned()
            .ok_or("Speech backend is not initialized")?
    };
    let _operation = (action != "status").then(|| OPERATIONS.lock());
    let mut current = state.lock();
    let installation = current.installation.clone();
    match action {
        "status" => {}
        "system" => {
            current.select(Backend::System)?;
            drop(current);
            installation.clear();
            return Ok(state.lock().status());
        }
        "phonon" => current.select(Backend::Phonon)?,
        "openai" => current.select(Backend::Openai)?,
        "system-if-openai" => current.fallback_from(Backend::Openai)?,
        "cancel" => installation.cancel_download(),
        "download" => {
            if !supported() {
                return Err("Phonon requires Android arm64 or iOS 18 or later. System speech remains available on this device.".into());
            }
            let shared = state.clone();
            if installation.download_model(move |voice| shared.lock().select_voice(voice))? {
                current.error = None;
            }
        }
        "delete" => {
            drop(current);
            installation.remove_model(|| state.lock().fallback_from(Backend::Phonon))?;
            let mut current = state.lock();
            current.error = None;
            current.select_voice(DEFAULT_VOICE)?;
            return Ok(current.status());
        }
        _ if action.starts_with(PREVIEW_TEXT_COMMAND) => {
            let text = serde_json::from_str(&action[PREVIEW_TEXT_COMMAND.len()..])
                .map_err(|error| format!("Invalid preview text: {error}"))?;
            current.set_preview_text(text)?;
        }
        _ if action.starts_with("openai-voice:") => {
            let voice = &action["openai-voice:".len()..];
            current.select_openai_voice(voice)?;
        }
        _ if action.starts_with("system-voice:") => {
            let id = action.trim_start_matches("system-voice:");
            if id.len() > 1_024 {
                return Err("Invalid system voice identifier".into());
            }
            let preferences = Preferences {
                system_voice: id.into(),
                ..current.preferences.clone()
            };
            current.save(preferences)?;
        }
        _ if action.starts_with("voice:") => {
            if !installation.status().installed || !supported() {
                return Err("Install Phonon on a supported device before choosing a voice".into());
            }
            let id = action.trim_start_matches("voice:");
            let shared = state.clone();
            if installation.download_voice(id, move |voice| shared.lock().select_voice(voice))? {
                current.error = None;
            } else {
                current.select_voice(id)?;
            }
        }
        _ if action.starts_with("remove-voice:") => {
            let id = action.trim_start_matches("remove-voice:");
            drop(current);
            installation.remove_voice(id, |voice| {
                let mut current = state.lock();
                if current.preferences.voice == voice {
                    current.select_voice(DEFAULT_VOICE)?;
                }
                drop(current);
                Ok(())
            })?;
            return Ok(state.lock().status());
        }
        _ => return Err("Unknown speech backend action".into()),
    }
    Ok(current.status())
}

pub(crate) type PcmCallback = unsafe extern "C" fn(*mut c_void, *const f32, usize) -> bool;

pub(crate) fn phonon_selected() -> bool {
    state().is_ok_and(|state| state.lock().preferences.backend == Backend::Phonon)
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_speech_network_selected() -> bool {
    state().is_ok_and(|state| state.lock().preferences.backend.uses_network())
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_speech_pcm_playback_failed() {
    if let Ok(shared) = state() {
        let mut state = shared.lock();
        if state.preferences.backend == Backend::Phonon {
            state.runtime_failed = true;
            state.fallback =
                Some("Phonon playback is unavailable on this device. Using system speech.".into());
        } else {
            state.fallback = Some("Speech audio playback is unavailable on this device.".into());
        }
    }
}

/// # Safety
/// `language` must be a live NUL-terminated language tag.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_speech_pcm_enabled(
    language: *const c_char,
    local_only: bool,
) -> bool {
    if !local_only && whip_speech_network_selected() {
        return true;
    }
    // SAFETY: The caller supplies the borrowed language tag.
    unsafe { phonon::whip_phonon_enabled(language) }
}

/// Shared worker entrypoint for Phonon and OpenAI, using the same native PCM sink.
/// # Safety
/// Text, callback and both contexts must remain valid until return. The credential
/// reader follows native_credentials::ReadCredential's synchronous contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_speech_pcm_speak(
    lease: u64,
    text: *const c_char,
    caption_id: u64,
    callback: PcmCallback,
    context: *mut c_void,
    reader: Option<native_credentials::ReadCredential>,
    credential_context: *mut c_void,
) -> i32 {
    if text.is_null() {
        return -1;
    }
    // SAFETY: The caller guarantees a live NUL-terminated text string.
    let Ok(text) = (unsafe { CStr::from_ptr(text) }).to_str() else {
        return -1;
    };
    if text.encode_utf16().count() > MAX_TEXT_UNITS {
        return -1;
    }
    crate::speech_captions::synthesize(
        caption_id,
        text,
        |segment, is_prefix, sink| {
            // SAFETY: All borrowed strings and contexts live for the synchronous
            // call. The adapter consumes each PCM slice before returning.
            unsafe {
                pcm_speak_segment(
                    lease,
                    segment,
                    is_prefix || crate::speech_playback::is_tts_announcement(lease),
                    sink,
                    reader,
                    credential_context,
                )
            }
        },
        |samples| {
            // SAFETY: The caller consumes this borrowed PCM synchronously.
            unsafe { callback(context, samples.as_ptr(), samples.len()) }
        },
    )
}

struct PcmSink<'a>(&'a mut dyn FnMut(&[f32]) -> bool);

unsafe extern "C" fn consume_pcm(context: *mut c_void, samples: *const f32, count: usize) -> bool {
    // SAFETY: pcm_speak_segment passes the live PcmSink and a borrowed PCM slice.
    let sink = unsafe { &mut *context.cast::<PcmSink<'_>>() };
    // SAFETY: The backend supplies count live samples for this synchronous call.
    (sink.0)(unsafe { std::slice::from_raw_parts(samples, count) })
}

unsafe fn pcm_speak_segment(
    lease: u64,
    text: &str,
    cacheable: bool,
    sink: &mut dyn FnMut(&[f32]) -> bool,
    reader: Option<native_credentials::ReadCredential>,
    credential_context: *mut c_void,
) -> i32 {
    let Ok(shared) = state() else {
        return -1;
    };
    let settings = shared.lock();
    let (voice, cached_phrase) = match settings.preferences.backend {
        Backend::System => return -1,
        Backend::Phonon => {
            drop(settings);
            let Ok(text) = CString::new(text) else {
                return -1;
            };
            let mut sink = PcmSink(sink);
            // SAFETY: The string and borrowed sink are live throughout synthesis.
            return unsafe {
                phonon::whip_phonon_speak(lease, text.as_ptr(), consume_pcm, (&raw mut sink).cast())
            };
        }
        Backend::Openai => (
            settings.preferences.openai_voice.clone(),
            if cacheable {
                settings.cached_phrase(text)
            } else {
                None
            },
        ),
    };
    drop(settings);
    let result = (|| {
        // SAFETY: The native caller supplies the synchronous reader/context.
        let credential = unsafe { crate::voice_credentials::read(reader, credential_context) }
            .map_err(crate::voice_credentials::message)?;
        openai_tts::speak(lease, text, &voice, credential, cached_phrase, sink)
    })();
    match result {
        Ok(completed) => {
            if completed && let Ok(state) = state() {
                state.lock().fallback = None;
            }
            i32::from(completed)
        }
        Err(error) => {
            if let Ok(state) = state() {
                state.lock().fallback = Some(error);
            }
            -1
        }
    }
}

/// # Safety
/// Arguments must be NUL-terminated UTF-8 for the call. Free the result with `whip_speech_backend_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_speech_backend_command(
    root: *const c_char,
    action: *const c_char,
) -> *mut c_char {
    let result = if root.is_null() || action.is_null() {
        Err("Missing speech backend arguments".into())
    } else {
        // SAFETY: caller guarantees both strings live for this call.
        let root = unsafe { CStr::from_ptr(root) }.to_str();
        // SAFETY: caller guarantees both strings live for this call.
        let action = unsafe { CStr::from_ptr(action) }.to_str();
        match (root, action) {
            (Ok(root), Ok(action)) => command(root, action),
            _ => Err("Invalid speech backend arguments".into()),
        }
    };
    let value = match result {
        Ok(value) => value,
        Err(error) => serde_json::json!({ "commandError": error }),
    };
    // serde_json escapes embedded NULs.
    CString::new(value.to_string()).map_or(std::ptr::null_mut(), CString::into_raw)
}

/// # Safety
/// `value` must be a live pointer returned by `whip_speech_backend_command`, or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_speech_backend_free(value: *mut c_char) {
    if !value.is_null() {
        // SAFETY: caller transfers the unique allocation back to Rust.
        drop(unsafe { CString::from_raw(value) });
    }
}

pub(super) fn phonon_model() -> Result<(Installation, String), String> {
    let state = state()?;
    let state = state.lock();
    Ok((state.installation.clone(), state.preferences.voice.clone()))
}

pub(super) fn phonon_succeeded() {
    if let Ok(state) = state() {
        state.lock().fallback = None;
    }
}

pub(super) fn phonon_failed(error: &str) {
    if let Ok(state) = state() {
        let mut state = state.lock();
        state.runtime_failed = true;
        state.fallback = Some(format!("Phonon failed: {error}. Using system speech."));
    }
}

pub(super) fn phonon_available(language: &str) -> bool {
    let Ok(shared) = state() else {
        return false;
    };
    let mut state = shared.lock();
    if state.preferences.backend != Backend::Phonon {
        return false;
    }
    if !state.installation.status().installed || state.runtime_failed {
        state
            .fallback
            .get_or_insert_with(|| "Phonon files are unavailable. Using system speech.".into());
        return false;
    }
    if !language
        .split(['-', '_'])
        .next()
        .is_some_and(|l| l.eq_ignore_ascii_case("en"))
    {
        state.fallback =
            Some("Phonon speaks English. Using system speech for this language.".into());
        return false;
    }
    drop(state);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use phonon_local::{ARTIFACTS, REVISION, download};

    #[test]
    fn removing_phonon_clears_models_and_partials_but_preserves_host_preferences() {
        let root = tempfile::tempdir().unwrap();
        let mut state = State::open(root.path()).unwrap();
        state.select(Backend::Openai).unwrap();
        state.select_openai_voice("cedar").unwrap();
        for directory in [
            root.path().join(REVISION),
            download::staging(root.path()),
            root.path().join("voice-downloads"),
        ] {
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("fixture"), b"partial").unwrap();
        }
        state.installation.remove_model(|| Ok(())).unwrap();
        state.installation.remove_model(|| Ok(())).unwrap();
        let restored = State::open(root.path()).unwrap();
        assert_eq!(restored.status()["backend"], "openai");
        assert_eq!(restored.status()["openaiVoice"], "cedar");
        assert!(!restored.installation.status().installed);
        assert_eq!(restored.installation.status().downloaded_bytes, 0);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn missing_phonon_model_persists_system_selection_on_restore() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("preferences.json"),
            br#"{"backend":"phonon","system_voice":"installed-voice"}"#,
        )
        .unwrap();
        let state = State::open(directory.path()).unwrap();
        assert_eq!(state.status()["backend"], "system");
        assert_eq!(state.status()["systemVoice"], "installed-voice");
        assert_eq!(
            State::open(directory.path()).unwrap().status()["backend"],
            "system"
        );
    }

    #[test]
    fn provider_removal_only_resets_the_affected_selection_and_keeps_voice_settings() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = State::open(directory.path()).unwrap();
        state.select(Backend::Openai).unwrap();
        state.select_openai_voice("cedar").unwrap();
        state.fallback_from(Backend::Phonon).unwrap();
        assert_eq!(state.status()["backend"], "openai");
        state.fallback_from(Backend::Openai).unwrap();
        let restored = State::open(directory.path()).unwrap();
        assert_eq!(restored.status()["backend"], "system");
        assert_eq!(restored.status()["openaiVoice"], "cedar");
    }

    #[test]
    fn openai_selection_and_voice_survive_switching_and_restart_without_downloads() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = State::open(directory.path()).unwrap();
        state.select(Backend::Openai).unwrap();
        state.select_openai_voice("cedar").unwrap();
        state.select(Backend::System).unwrap();
        let mut restored = State::open(directory.path()).unwrap();
        assert_eq!(restored.status()["backend"], "system");
        assert_eq!(restored.status()["openaiVoice"], "cedar");
        restored.select(Backend::Openai).unwrap();
        assert_eq!(restored.status()["backend"], "openai");
        assert!(!restored.installation.status().downloading);
        assert!(!restored.installation.status().installed);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        assert!(restored.select_openai_voice("unknown").is_err());
        assert_eq!(restored.status()["openaiVoice"], "cedar");
    }

    #[test]
    fn changing_the_openai_voice_invalidates_clips_even_after_switching_back_and_restarting() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = State::open(directory.path()).unwrap();
        let phrase = "Muted";
        let original = state.cached_phrase(phrase).unwrap();
        assert!(
            original
                .play(&mut |_| true, |out| Ok(out(&[0.25])))
                .unwrap()
        );
        state
            .select_openai_voice(openai_tts::DEFAULT_VOICE)
            .unwrap();
        assert!(
            state
                .cached_phrase(phrase)
                .unwrap()
                .play(&mut |_| true, |_| panic!("same voice should hit"))
                .unwrap()
        );
        state.select_openai_voice("cedar").unwrap();
        state
            .select_openai_voice(openai_tts::DEFAULT_VOICE)
            .unwrap();
        let restored = State::open(directory.path()).unwrap();
        let mut played = Vec::new();
        assert!(
            restored
                .cached_phrase(phrase)
                .unwrap()
                .play(
                    &mut |pcm| {
                        played.extend_from_slice(pcm);
                        true
                    },
                    |out| Ok(out(&[0.5]))
                )
                .unwrap()
        );
        assert_eq!(played, [0.5]);
    }

    #[test]
    fn older_preferences_keep_system_voice_and_preview_when_openai_defaults_are_added() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("preferences.json"),
            br#"{
            "backend":"system", "voice":"default", "system_voice":"installed-voice",
            "preview_text":"Saved sample"
        }"#,
        )
        .unwrap();
        let state = State::open(directory.path()).unwrap();
        assert_eq!(state.status()["systemVoice"], "installed-voice");
        assert_eq!(state.status()["previewText"], "Saved sample");
        assert_eq!(state.status()["openaiVoice"], openai_tts::DEFAULT_VOICE);
        assert!(state.error.is_none());
    }

    #[test]
    fn preview_text_starts_unset_and_preserves_the_users_text_including_empty_input() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = State::open(directory.path()).unwrap();
        assert!(state.status()["previewText"].is_null());
        state
            .set_preview_text("A custom sample. 😊".into())
            .unwrap();
        state.select(Backend::System).unwrap();
        let mut restored = State::open(directory.path()).unwrap();
        assert_eq!(restored.status()["previewText"], "A custom sample. 😊");
        restored.set_preview_text(String::new()).unwrap();
        assert_eq!(
            State::open(directory.path()).unwrap().status()["previewText"],
            ""
        );
    }

    #[test]
    fn oversized_preview_text_preserves_the_last_saved_sample() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = State::open(directory.path()).unwrap();
        state.set_preview_text("Saved sample".into()).unwrap();
        assert!(
            state
                .set_preview_text("😊".repeat(MAX_TEXT_UNITS / 2 + 1))
                .is_err()
        );
        assert_eq!(
            State::open(directory.path()).unwrap().status()["previewText"],
            "Saved sample"
        );
    }

    #[test]
    fn changing_backends_preserves_the_system_voice_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = State::open(directory.path()).unwrap();
        state
            .save(Preferences {
                system_voice: "installed-system-voice".into(),
                ..Preferences::default()
            })
            .unwrap();
        state.select(Backend::System).unwrap();
        state.select_voice(DEFAULT_VOICE).unwrap();
        let restored = State::open(directory.path()).unwrap();
        assert_eq!(restored.preferences.system_voice, "installed-system-voice");
        assert_eq!(restored.preferences.voice, DEFAULT_VOICE);
        assert!(restored.preferences.backend == Backend::System);
    }

    #[test]
    fn a_missing_selected_voice_keeps_the_model_and_system_preference_usable() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = State::open(directory.path()).unwrap();
        let voice = &voices::CATALOG[0].id;
        assert!(state.select_voice(voice).is_err());
        assert_eq!(state.preferences.voice, DEFAULT_VOICE);
        state
            .save(Preferences {
                voice: voice.clone(),
                system_voice: "system-voice".into(),
                ..Preferences::default()
            })
            .unwrap();
        let restored = State::open(directory.path()).unwrap();
        assert_eq!(restored.preferences.voice, DEFAULT_VOICE);
        assert_eq!(restored.preferences.system_voice, "system-voice");
        assert!(restored.error.is_some());
        assert!(!restored.installation.status().downloading);
        assert!(restored.installation.status().voice_download.is_none());
    }

    #[test]
    fn fresh_install_uses_system_and_creates_no_model_files() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = State::open(directory.path()).unwrap();
        assert_eq!(state.status()["backend"], "system");
        assert!(!state.installation.status().installed);
        assert!(!state.installation.status().downloading);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
        assert!(state.select(Backend::Phonon).is_err());
        assert_eq!(state.status()["backend"], "system");
    }

    #[test]
    fn restart_retains_partial_progress_without_installing_or_downloading_it() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir_all(download::staging(directory.path())).unwrap();
        fs::write(
            download::staging(directory.path()).join(ARTIFACTS[0].name),
            b"abc",
        )
        .unwrap();
        let mut state = State::open(directory.path()).unwrap();
        assert!(!state.installation.status().installed);
        assert!(!state.installation.status().downloading);
        assert_eq!(state.installation.status().downloaded_bytes, 3);
        state.select(Backend::System).unwrap();
        let restored = State::open(directory.path()).unwrap();
        assert_eq!(restored.status()["backend"], "system");
        assert_eq!(restored.installation.status().downloaded_bytes, 3);
    }
}
