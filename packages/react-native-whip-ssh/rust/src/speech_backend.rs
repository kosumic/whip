//! Shared speech preferences, provider selection and native PCM dispatch.
//! Provider-specific synthesis lives in phonon and openai_tts.
use crate::{
    openai_tts,
    phonon::{self, ARTIFACTS, DEFAULT_VOICE, REVISION, download, supported, voices},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    ffi::{CStr, CString, c_char, c_void},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock,
        atomic::{AtomicBool, Ordering},
    },
};

pub(crate) const MAX_TEXT_UNITS: usize = 3_000;
pub(crate) const PCM_CHUNK_SAMPLES: usize = 1_920;
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
    preview_text: Option<String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            backend: Backend::System,
            voice: DEFAULT_VOICE.into(),
            system_voice: String::new(),
            openai_voice: openai_tts::DEFAULT_VOICE.into(),
            preview_text: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceDownload {
    id: String,
    downloaded_bytes: u64,
    total_bytes: u64,
}

struct State {
    root: PathBuf,
    preferences: Preferences,
    installed: bool,
    downloading: bool,
    downloaded_bytes: u64,
    cancel: Arc<AtomicBool>,
    error: Option<String>,
    fallback: Option<String>,
    runtime_failed: bool,
    generation: u64,
    installed_voices: BTreeSet<String>,
    voice_download: Option<VoiceDownload>,
}

impl State {
    fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
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
        let installed_voices: BTreeSet<_> = voices::CATALOG
            .iter()
            .filter(|voice| voices::installed(root, &voice.id))
            .map(|voice| voice.id.clone())
            .collect();
        if voices::CATALOG.is_empty() {
            error = Some(
                "The voice catalog is unavailable. The default Phonon voice remains available."
                    .into(),
            );
        }
        if preferences.voice != DEFAULT_VOICE && !installed_voices.contains(&preferences.voice) {
            preferences.voice = DEFAULT_VOICE.into();
            error = Some("The saved Phonon voice is unavailable. Using the default voice.".into());
        }
        let installed = download::verify(root.join(REVISION).as_path()).is_ok();
        let downloaded_bytes = if installed {
            total_bytes()
        } else {
            download::partial_bytes(root)
        };
        Ok(Self {
            root: root.into(),
            preferences,
            installed,
            downloading: false,
            downloaded_bytes,
            cancel: Arc::default(),
            error,
            fallback: None,
            runtime_failed: false,
            generation: 0,
            installed_voices,
            voice_download: None,
        })
    }

    fn select(&mut self, backend: Backend) -> Result<(), String> {
        if backend == Backend::Phonon && (!supported() || !self.installed) {
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
        if voice != DEFAULT_VOICE && !voices::installed(&self.root, voice) {
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
        let preferences = Preferences {
            openai_voice: voice.into(),
            ..self.preferences.clone()
        };
        self.save(preferences)?;
        self.fallback = None;
        Ok(())
    }

    fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "backend": self.preferences.backend, "voice": self.preferences.voice, "supported": supported(),
            "systemVoice": self.preferences.system_voice,
            "openaiVoice": self.preferences.openai_voice,
            "openaiVoices": openai_tts::VOICES,
            "previewText": self.preferences.preview_text,
            "maxTextUnits": MAX_TEXT_UNITS,
            "voiceDownload": self.voice_download,
            "voices": voices::CATALOG.iter().map(|voice| serde_json::json!({
                "id": voice.id, "name": voice.name, "language": voice.locale,
                "description": voice.description, "bytes": voice.bytes,
                "installed": self.installed_voices.contains(&voice.id),
            })).collect::<Vec<_>>(),
            "installed": self.installed, "downloading": self.downloading,
            "downloadedBytes": self.downloaded_bytes, "totalBytes": total_bytes(),
            "error": self.error, "fallback": self.fallback,
            "requiredStorageBytes": if cfg!(target_os = "ios") { 600_000_000u64 } else { total_bytes() },
        })
    }
}

fn total_bytes() -> u64 {
    ARTIFACTS.iter().map(|a| a.bytes).sum()
}

static STATE: LazyLock<Mutex<Option<Arc<Mutex<State>>>>> = LazyLock::new(Mutex::default);
fn state() -> Result<Arc<Mutex<State>>, String> {
    STATE
        .lock()
        .clone()
        .ok_or_else(|| "Speech backend is not initialized".into())
}

fn command(root: &str, action: &str) -> Result<serde_json::Value, String> {
    let state = {
        let mut slot = STATE.lock();
        if slot.is_none() {
            *slot = Some(Arc::new(Mutex::new(State::open(Path::new(root))?)));
        }
        slot.as_ref()
            .cloned()
            .ok_or("Speech backend is not initialized")?
    };
    let mut current = state.lock();
    match action {
        "status" => {}
        "system" => {
            current.select(Backend::System)?;
            drop(current);
            phonon::clear_model();
            return Ok(state.lock().status());
        }
        "phonon" => current.select(Backend::Phonon)?,
        "openai" => current.select(Backend::Openai)?,
        "cancel" => current.cancel.store(true, Ordering::Release),
        "download" => {
            if !supported() {
                return Err("Phonon requires Android arm64 or iOS 18 or later. System speech remains available on this device.".into());
            }
            if current.voice_download.is_some() {
                return Err("Wait for the voice download or cancel it first".into());
            }
            if !current.downloading && !current.installed {
                current.cancel = Arc::default();
                current.downloading = true;
                current.error = None;
                let root = current.root.clone();
                let cancel = current.cancel.clone();
                let download_state = state.clone();
                std::thread::Builder::new()
                    .name("phonon-download".into())
                    .spawn(move || {
                        let result = download::install(&root, &cancel, |bytes| {
                            download_state.lock().downloaded_bytes = bytes;
                        });
                        let mut done = download_state.lock();
                        done.downloading = false;
                        done.installed = result.is_ok();
                        done.error = result.err().filter(|_| !cancel.load(Ordering::Acquire));
                        if done.installed {
                            done.installed_voices.clear();
                            if let Err(error) = done.select_voice(DEFAULT_VOICE) {
                                done.error = Some(error);
                            }
                        }
                        done.downloaded_bytes = if done.installed {
                            total_bytes()
                        } else {
                            download::partial_bytes(&root)
                        };
                    })
                    .map_err(|e| {
                        current.downloading = false;
                        e.to_string()
                    })?;
            }
        }
        "delete" => {
            if current.downloading || current.voice_download.is_some() {
                return Err("Cancel the download before removing Phonon".into());
            }
            current.select(Backend::System)?;
            // Invalidate a cached model without waiting for a cancelled inference on the UI thread.
            current.generation = current.generation.wrapping_add(1);
            let root = current.root.clone();
            drop(current);
            // Wait on the settings worker for model compilation/generation to
            // release its files before deleting them. Never hold STATE while
            // waiting for the Phonon model; synthesis may publish fallback status.
            phonon::clear_model();
            for dir in [
                root.join(REVISION),
                download::staging(&root),
                root.join("voice-downloads"),
            ] {
                match fs::remove_dir_all(dir) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            let mut current = state.lock();
            current.installed = false;
            current.downloaded_bytes = 0;
            current.error = None;
            current.installed_voices.clear();
            current.select_voice(DEFAULT_VOICE)?;
            drop(current);
            return Ok(state.lock().status());
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
            if !current.installed || !supported() {
                return Err("Install Phonon on a supported device before choosing a voice".into());
            }
            if current.downloading || current.voice_download.is_some() {
                return Err(
                    "Wait for the download or cancel it before choosing another voice".into(),
                );
            }
            let id = action.trim_start_matches("voice:");
            if id == DEFAULT_VOICE || voices::installed(&current.root, id) {
                current.select_voice(id)?;
            } else {
                let voice = voices::find(id)?;
                current.cancel = Arc::default();
                current.error = None;
                current.voice_download = Some(VoiceDownload {
                    id: voice.id.clone(),
                    downloaded_bytes: 0,
                    total_bytes: voice.bytes,
                });
                let root = current.root.clone();
                let cancel = current.cancel.clone();
                let shared = state.clone();
                std::thread::Builder::new()
                    .name("phonon-voice-download".into())
                    .spawn(move || {
                        let result = download::install_voice(&root, voice, &cancel, |bytes| {
                            if let Some(progress) = &mut shared.lock().voice_download {
                                progress.downloaded_bytes = bytes;
                            }
                        });
                        let mut done = shared.lock();
                        done.voice_download = None;
                        match result {
                            Ok(()) => {
                                done.installed_voices.insert(voice.id.clone());
                                if cfg!(target_os = "ios") {
                                    done.generation = done.generation.wrapping_add(1);
                                }
                                done.error = done.select_voice(&voice.id).err();
                            }
                            Err(error) if !cancel.load(Ordering::Acquire) => {
                                done.error = Some(error);
                            }
                            Err(_) => {}
                        }
                    })
                    .map_err(|error| {
                        current.voice_download = None;
                        error.to_string()
                    })?;
            }
        }
        _ if action.starts_with("remove-voice:") => {
            if current.voice_download.is_some() {
                return Err("Cancel the voice download first".into());
            }
            let voice = voices::find(action.trim_start_matches("remove-voice:"))?;
            if current.preferences.voice == voice.id {
                current.select_voice(DEFAULT_VOICE)?;
            }
            current.generation = current.generation.wrapping_add(1);
            let path = voices::path(&current.root, &voice.id);
            let partial = voices::partial(&current.root, &voice.id);
            drop(current);
            phonon::clear_model();
            for file in [path, partial] {
                match fs::remove_file(file) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
            let mut current = state.lock();
            current.installed_voices.remove(&voice.id);
            return Ok(current.status());
        }
        _ => return Err("Unknown speech backend action".into()),
    }
    Ok(current.status())
}

pub(crate) type PcmCallback = unsafe extern "C" fn(*mut c_void, *const f32, usize) -> bool;

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
    callback: PcmCallback,
    context: *mut c_void,
    reader: Option<native_credentials::ReadCredential>,
    credential_context: *mut c_void,
) -> i32 {
    let Ok(shared) = state() else {
        return -1;
    };
    let preferences = shared.lock().preferences.clone();
    let voice = match preferences.backend {
        Backend::System => return -1,
        Backend::Phonon => {
            // SAFETY: This entrypoint has the same PCM contract as Phonon.
            return unsafe { phonon::whip_phonon_speak(lease, text, callback, context) };
        }
        Backend::Openai => preferences.openai_voice,
    };
    if text.is_null() {
        return -1;
    }
    // SAFETY: The caller guarantees a live NUL-terminated text string.
    let Ok(text) = (unsafe { CStr::from_ptr(text) }).to_str() else {
        return -1;
    };
    let result = (|| {
        if text.encode_utf16().count() > MAX_TEXT_UNITS {
            return Err("Speech text exceeds the utterance limit".into());
        }
        // SAFETY: The native caller supplies the synchronous reader/context.
        let credential = unsafe { crate::voice_credentials::read(reader, credential_context) }
            .map_err(crate::voice_credentials::message)?;
        openai_tts::speak(lease, text, &voice, credential, |samples| {
            // SAFETY: Samples are borrowed only for this synchronous callback.
            unsafe { callback(context, samples.as_ptr(), samples.len()) }
        })
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

pub(super) fn phonon_model() -> Result<(PathBuf, u64, String), String> {
    let state = state()?;
    let state = state.lock();
    if !state.installed {
        return Err("Phonon files are missing; using system speech".into());
    }
    Ok((
        state.root.join(REVISION),
        state.generation,
        state.preferences.voice.clone(),
    ))
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
    if !state.installed || state.runtime_failed {
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
        assert!(!restored.downloading);
        assert!(!restored.installed);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        assert!(restored.select_openai_voice("unknown").is_err());
        assert_eq!(restored.status()["openaiVoice"], "cedar");
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
        assert!(!restored.downloading);
        assert!(restored.voice_download.is_none());
    }

    #[test]
    fn fresh_install_uses_system_and_creates_no_model_files() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = State::open(directory.path()).unwrap();
        assert_eq!(state.status()["backend"], "system");
        assert!(!state.installed);
        assert!(!state.downloading);
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
        assert!(!state.installed);
        assert!(!state.downloading);
        assert_eq!(state.downloaded_bytes, 3);
        state.select(Backend::System).unwrap();
        let restored = State::open(directory.path()).unwrap();
        assert_eq!(restored.status()["backend"], "system");
        assert_eq!(restored.downloaded_bytes, 3);
    }
}
