//! Private launch recovery records, loaded on a fresh snapshot or explicit launch.
use super::*;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;

const VERSION: u32 = 1;
const MAX_BYTES: u64 = 1024 * 1024;
static DIRECTORY: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

/// # Safety
/// `path` must be a live NUL-terminated UTF-8 string for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_set_reverse_control_recovery_directory(
    path: *const std::ffi::c_char,
) {
    if path.is_null() {
        return;
    }
    // SAFETY: The native caller owns this string until the call returns.
    let path = unsafe { std::ffi::CStr::from_ptr(path) };
    if let Ok(path) = path.to_str() {
        *DIRECTORY.get_or_init(|| RwLock::new(None)).write() = Some(path.into());
    }
}

#[derive(Default)]
pub(super) struct Recovery {
    path: Option<PathBuf>,
    loaded: bool,
    pub(super) port: Option<u16>,
    waiting: Vec<SavedSession>,
    last_saved: Option<Vec<u8>>,
}

#[derive(Serialize, Deserialize)]
struct SavedBridge {
    version: u32,
    port: u16,
    sessions: Vec<SavedSession>,
}

#[derive(Clone, Serialize, Deserialize)]
struct SavedSession {
    runtime_id: String,
    session_id: String,
    pane_id: String,
    terminal_id: String,
    agent: HerdrAgentKind,
    conversation: String,
    token_hash: [u8; 32],
    protocol: String,
}

pub(super) fn conversation(pane: &HerdrPaneInfo) -> Option<&str> {
    let identity = pane.agent_session.as_ref()?;
    (identity.kind == crate::herdr_api::HerdrAgentSessionKind::Id
        && pane.agent.as_deref() == Some(identity.agent.as_str())
        && !identity.value.trim().is_empty())
    .then(|| identity.value.trim())
}

impl Recovery {
    pub(super) fn waiting_for(&self, terminal: &str) -> bool {
        self.waiting
            .iter()
            .any(|session| session.terminal_id == terminal)
    }

    pub(super) fn forget_terminal(&mut self, terminal: &str) {
        if self.load().is_ok() {
            self.waiting
                .retain(|session| session.terminal_id != terminal);
        }
    }

    pub(super) fn clear(&mut self) {
        self.loaded = true;
        self.waiting.clear();
        self.port = None;
        self.last_saved = None;
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }

    pub(super) fn for_host(config: &crate::host_runtime::HostRuntimeConfig) -> Self {
        // Scope records to the profile and endpoint, never to a credential.
        let identity = json!([
            config.runtime_id,
            config.ssh.host,
            config.ssh.port,
            config.ssh.username,
            config.session_name,
            config.socket_path,
            config
                .jump_hosts
                .iter()
                .map(|host| (&host.host, host.port, &host.username))
                .collect::<Vec<_>>(),
        ]);
        let key = crate::lower_hex(&Sha256::digest(identity.to_string().as_bytes()));
        let path = DIRECTORY.get().and_then(|directory| {
            directory
                .read()
                .as_ref()
                .map(|root| root.join(format!("{key}.json")))
        });
        Self {
            path,
            ..Self::default()
        }
    }

    #[cfg(test)]
    pub(super) fn at(path: PathBuf) -> Self {
        Self {
            path: Some(path),
            ..Self::default()
        }
    }

    pub(super) fn load(&mut self) -> std::io::Result<()> {
        if self.loaded {
            return Ok(());
        }
        let Some(path) = &self.path else {
            self.loaded = true;
            return Ok(());
        };
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.loaded = true;
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        self.loaded = true;
        self.last_saved = Some(bytes.clone());
        let saved = serde_json::from_slice::<SavedBridge>(&bytes)
            .ok()
            .filter(|saved| {
                bytes.len() as u64 <= MAX_BYTES
                    && saved.version == VERSION
                    && saved.port != 0
                    && saved.sessions.len() <= 4096
                    && saved.sessions.iter().all(|session| {
                        session.session_id.len() == 64
                            && !session.terminal_id.is_empty()
                            && !session.pane_id.is_empty()
                            && !session.conversation.is_empty()
                            && http::PROTOCOLS.contains(&session.protocol.as_str())
                    })
            });
        if let Some(saved) = saved {
            self.port = Some(saved.port);
            self.waiting = saved.sessions;
        }
        Ok(())
    }
}

impl ReverseControl {
    pub(crate) fn for_host(config: &crate::host_runtime::HostRuntimeConfig) -> Self {
        Self {
            recovery: Mutex::new(Recovery::for_host(config)),
            ..Self::default()
        }
    }

    pub(super) fn recover_saved(&self, panes: &[HerdrPaneInfo]) {
        let mut recovery = self.recovery.lock();
        if recovery.load().is_err() {
            return; // A storage failure remains retryable on the next snapshot.
        }
        let mut sessions = self.sessions.lock();
        recovery.waiting.retain(|saved| {
            let Some(pane) = panes.iter().find(|pane| {
                pane.pane_id == saved.pane_id
                    && pane.terminal_id == saved.terminal_id
                    && pane.agent.as_deref() == Some(saved.agent.as_str())
            }) else {
                return false;
            };
            let Some(identity) = conversation(pane) else {
                return true;
            };
            if identity != saved.conversation {
                return false;
            }
            sessions
                .entry(saved.session_id.clone())
                .or_insert_with(|| Session {
                    info: ReverseControlSession {
                        runtime_id: saved.runtime_id.clone(),
                        session_id: saved.session_id.clone(),
                        pane_id: saved.pane_id.clone(),
                        terminal_id: saved.terminal_id.clone(),
                    },
                    agent: saved.agent,
                    token_hash: CtOutput::new(saved.token_hash.into()),
                    started: Instant::now(),
                    observed_agent: true,
                    conversation: Some(saved.conversation.clone()),
                    protocol: Some(saved.protocol.clone()),
                });
            false
        });
        if sessions.is_empty() && recovery.waiting.is_empty() {
            recovery.port = None;
        }
    }

    pub(super) fn save_recovery(&self) {
        let mut recovery = self.recovery.lock();
        if !recovery.loaded {
            return;
        }
        let Some(path) = recovery.path.clone() else {
            return;
        };
        let bridge = self.bridge.lock();
        let sessions = self.sessions.lock();
        let port = bridge
            .as_ref()
            .map(|bridge| bridge.remote_port)
            .or(recovery.port);
        let mut saved = recovery.waiting.clone();
        saved.extend(sessions.values().filter_map(|session| {
            Some(SavedSession {
                runtime_id: session.info.runtime_id.clone(),
                session_id: session.info.session_id.clone(),
                pane_id: session.info.pane_id.clone(),
                terminal_id: session.info.terminal_id.clone(),
                agent: session.agent,
                conversation: session.conversation.clone()?,
                token_hash: session.token_hash.clone().into_bytes().into(),
                protocol: session.protocol.clone()?,
            })
        }));
        drop(sessions);
        drop(bridge);
        saved.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        if saved.is_empty() || port.is_none() {
            if recovery.last_saved.is_none() {
                return;
            }
            let removed = std::fs::remove_file(&path);
            if removed.is_ok()
                || removed.is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                recovery.last_saved = None;
                recovery.port = None;
            }
            return;
        }
        let Some(port) = port else { return };
        let record = SavedBridge {
            version: VERSION,
            port,
            sessions: saved,
        };
        let Ok(bytes) = serde_json::to_vec(&record) else {
            return;
        };
        if recovery.last_saved.as_ref() == Some(&bytes) {
            return;
        }
        if write_atomic(&path, &bytes).is_ok() {
            recovery.last_saved = Some(bytes);
            recovery.port = Some(port);
        }
    }
}

fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(temporary, path)?;
    Ok(())
}
