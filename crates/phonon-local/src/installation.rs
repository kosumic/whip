use crate::{
    ARTIFACTS, DEFAULT_VOICE, Model, REVISION, SynthesisReport, Synthesizer, download, voices,
};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

const VOICE_DOWNLOADS: &str = "voice-downloads";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceDownload {
    pub id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

/// A cached snapshot. Reading it performs no disk operations.
#[derive(Clone)]
pub struct InstallationStatus {
    pub installed: bool,
    pub downloading: bool,
    pub downloaded_bytes: u64,
    pub installed_voices: BTreeSet<String>,
    pub voice_download: Option<VoiceDownload>,
    pub error: Option<String>,
}

struct State {
    status: InstallationStatus,
    cancel: Arc<AtomicBool>,
    generation: u64,
}

struct Inner {
    root: PathBuf,
    state: Mutex<State>,
    operations: Mutex<()>,
    runtime: RwLock<()>,
    synth: Synthesizer,
}

/// Owns the model and voice files and their synthesis cache for one private
/// storage root. Open once per root and clone the value to share that ownership.
/// Open, remove, clear, and synthesis are blocking operations for host workers.
#[derive(Clone)]
pub struct Installation(Arc<Inner>);

impl Installation {
    pub fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| error.to_string())?;
        let installed = download::verify(&root.join(REVISION)).is_ok();
        Ok(Self(Arc::new(Inner {
            root: root.into(),
            state: Mutex::new(State {
                status: InstallationStatus {
                    installed,
                    downloading: false,
                    downloaded_bytes: if installed {
                        Self::total_bytes()
                    } else {
                        download::partial_bytes(root)
                    },
                    installed_voices: voices::CATALOG
                        .iter()
                        .filter(|voice| voices::installed(root, &voice.id))
                        .map(|voice| voice.id.clone())
                        .collect(),
                    voice_download: None,
                    error: None,
                },
                cancel: Arc::default(),
                generation: 0,
            }),
            operations: Mutex::new(()),
            runtime: RwLock::new(()),
            synth: Synthesizer::default(),
        })))
    }

    pub fn total_bytes() -> u64 {
        ARTIFACTS.iter().map(|artifact| artifact.bytes).sum()
    }

    pub fn status(&self) -> InstallationStatus {
        self.0.state.lock().status.clone()
    }

    pub fn has_voice(&self, voice: &str) -> bool {
        voice == DEFAULT_VOICE || self.0.state.lock().status.installed_voices.contains(voice)
    }

    pub fn cancel_download(&self) {
        self.0.state.lock().cancel.store(true, Ordering::Release);
    }

    /// Starts an explicit installation. The completion callback may persist a
    /// host preference using the installed voice. It runs on the download worker
    /// outside the state lock, before another installation can start.
    pub fn download_model(
        &self,
        completed: impl FnOnce(&str) -> Result<(), String> + Send + 'static,
    ) -> Result<bool, String> {
        let _operation = self.0.operations.lock();
        let mut state = self.0.state.lock();
        if state.status.voice_download.is_some() {
            return Err("Wait for the voice download or cancel it first".into());
        }
        if state.status.installed || state.status.downloading {
            return Ok(false);
        }
        state.cancel = Arc::default();
        state.status.error = None;
        state.status.downloading = true;
        let inner = self.0.clone();
        let cancel = state.cancel.clone();
        std::thread::Builder::new()
            .name("phonon-download".into())
            .spawn(move || {
                let result = download::install(&inner.root, &cancel, |bytes| {
                    inner.state.lock().status.downloaded_bytes = bytes;
                });
                let mut state = inner.state.lock();
                state.status.installed = result.is_ok();
                state.status.downloaded_bytes = if state.status.installed {
                    state.status.installed_voices.clear();
                    Self::total_bytes()
                } else {
                    download::partial_bytes(&inner.root)
                };
                drop(state);
                let error = finish_download(result, &cancel, || completed(DEFAULT_VOICE));
                let mut state = inner.state.lock();
                state.status.error = error;
                state.status.downloading = false;
            })
            .map_err(|error| {
                state.status.downloading = false;
                error.to_string()
            })?;
        Ok(true)
    }

    /// Downloads an additional catalog voice for an installed model.
    pub fn download_voice(
        &self,
        id: &str,
        completed: impl FnOnce(&str) -> Result<(), String> + Send + 'static,
    ) -> Result<bool, String> {
        let _operation = self.0.operations.lock();
        let mut state = self.0.state.lock();
        if !state.status.installed {
            return Err("Install Phonon before choosing a voice".into());
        }
        if state.status.downloading || state.status.voice_download.is_some() {
            return Err("Wait for the download or cancel it before choosing another voice".into());
        }
        if id == DEFAULT_VOICE || state.status.installed_voices.contains(id) {
            return Ok(false);
        }
        let voice = voices::find(id)?;
        state.cancel = Arc::default();
        state.status.error = None;
        state.status.voice_download = Some(VoiceDownload {
            id: voice.id.clone(),
            downloaded_bytes: 0,
            total_bytes: voice.bytes,
        });
        let inner = self.0.clone();
        let cancel = state.cancel.clone();
        std::thread::Builder::new()
            .name("phonon-voice-download".into())
            .spawn(move || {
                let result = download::install_voice(&inner.root, voice, &cancel, |bytes| {
                    if let Some(progress) = &mut inner.state.lock().status.voice_download {
                        progress.downloaded_bytes = bytes;
                    }
                });
                if result.is_ok() {
                    let mut state = inner.state.lock();
                    state.status.installed_voices.insert(voice.id.clone());
                    if cfg!(target_os = "ios") {
                        state.generation = state.generation.wrapping_add(1);
                    }
                }
                let error = finish_download(result, &cancel, || completed(&voice.id));
                let mut state = inner.state.lock();
                state.status.error = error;
                state.status.voice_download = None;
            })
            .map_err(|error| {
                state.status.voice_download = None;
                error.to_string()
            })?;
        Ok(true)
    }

    /// Invalidates active synthesis and clears cached model resources.
    pub fn clear(&self) {
        let _operation = self.0.operations.lock();
        drop(self.retire_cache());
    }

    fn retire_cache(&self) -> parking_lot::RwLockWriteGuard<'_, ()> {
        let mut state = self.0.state.lock();
        state.generation = state.generation.wrapping_add(1);
        drop(state);
        let runtime = self.0.runtime.write();
        self.0.synth.clear();
        runtime
    }

    /// Removes model, additional voices, and partial downloads. The caller can
    /// persist a fallback selection before the files are removed.
    pub fn remove_model(&self, before: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        let _operation = self.0.operations.lock();
        let status = self.status();
        if status.downloading || status.voice_download.is_some() {
            return Err("Cancel the download before removing Phonon".into());
        }
        before()?;
        let _runtime = self.retire_cache();
        let result = [
            self.0.root.join(REVISION),
            download::staging(&self.0.root),
            self.0.root.join(VOICE_DOWNLOADS),
        ]
        .into_iter()
        .try_for_each(|path| missing_ok(fs::remove_dir_all(path)));
        let mut state = self.0.state.lock();
        state.status.installed = download::verify(&self.0.root.join(REVISION)).is_ok();
        state.status.downloaded_bytes = if state.status.installed {
            Self::total_bytes()
        } else {
            download::partial_bytes(&self.0.root)
        };
        state
            .status
            .installed_voices
            .retain(|id| voices::installed(&self.0.root, id));
        state.status.error = None;
        result
    }

    pub fn remove_voice(
        &self,
        id: &str,
        before: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        let _operation = self.0.operations.lock();
        let status = self.status();
        if status.downloading || status.voice_download.is_some() {
            return Err("Cancel the download before removing a voice".into());
        }
        let voice = voices::find(id)?;
        before(&voice.id)?;
        let _runtime = self.retire_cache();
        missing_ok(fs::remove_file(voices::path(&self.0.root, id)))?;
        self.0.state.lock().status.installed_voices.remove(id);
        missing_ok(fs::remove_file(voices::partial(&self.0.root, id)))
    }

    /// Synthesizes using the currently installed revision and caller's voice
    /// preference. PCM is borrowed for the duration of each callback.
    pub fn synthesize(
        &self,
        voice: &str,
        text: &str,
        active: impl Fn() -> bool,
        sink: impl FnMut(&[f32]) -> bool,
    ) -> Result<SynthesisReport, String> {
        let _runtime = self.0.runtime.read();
        let state = self.0.state.lock();
        if !state.status.installed {
            return Err("Phonon files are missing; using system speech".into());
        }
        let generation = state.generation;
        drop(state);
        self.0.synth.synthesize(
            Model {
                directory: &self.0.root.join(REVISION),
                generation,
                voice,
            },
            text,
            || active() && self.0.state.lock().generation == generation,
            sink,
        )
    }
}

fn finish_download(
    result: Result<(), String>,
    cancel: &AtomicBool,
    completed: impl FnOnce() -> Result<(), String>,
) -> Option<String> {
    match result {
        Ok(()) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(completed))
            .unwrap_or_else(|_| Err("Phonon download completion failed".into()))
            .err(),
        Err(error) => (!cancel.load(Ordering::Acquire)).then_some(error),
    }
}

fn missing_ok(result: std::io::Result<()>) -> Result<(), String> {
    result
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|error| error.to_string())
}
