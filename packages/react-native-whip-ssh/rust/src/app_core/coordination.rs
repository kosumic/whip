//! AppCore owns connection admission, restoration dependencies and restore order.
use super::{AppConnectionStatus, AppCore, AppCoreView};
use futures::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Weak,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::watch;

pub(super) struct Coordination {
    attempts: Mutex<HashMap<String, AttemptState>>,
    connecting: Mutex<HashSet<String>>,
    next: AtomicU64,
    generation: AtomicU64,
    cancellation: watch::Sender<u64>,
    restore: Mutex<Option<watch::Receiver<Option<RestoreResult>>>>,
}
struct AttemptState {
    token: u64,
    restoration: bool,
}

struct AttemptCompletion(Arc<SessionConnectionAttempt>);
impl Drop for AttemptCompletion {
    fn drop(&mut self) {
        self.0.finish();
    }
}

// watch::Sender has no default value; use a fresh channel for each AppCore.
impl Coordination {
    pub(super) fn new() -> Self {
        let (cancellation, _) = watch::channel(0);
        Self {
            attempts: Mutex::new(HashMap::new()),
            connecting: Mutex::new(HashSet::new()),
            next: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            cancellation,
            restore: Mutex::new(None),
        }
    }
    fn cancel_restore(&self) {
        self.attempts
            .lock()
            .retain(|_, attempt| !attempt.restoration);
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.cancellation.send_replace(generation);
        *self.restore.lock() = None;
    }
}

#[derive(uniffi::Object)]
pub struct SessionConnectionAttempt {
    owner: Weak<Coordination>,
    host_id: String,
    token: u64,
}
#[uniffi::export]
impl SessionConnectionAttempt {
    pub fn is_current(&self) -> bool {
        self.owner.upgrade().is_some_and(|owner| {
            owner
                .attempts
                .lock()
                .get(&self.host_id)
                .is_some_and(|attempt| attempt.token == self.token)
        })
    }
    pub fn finish(&self) -> bool {
        let Some(owner) = self.owner.upgrade() else {
            return false;
        };
        let mut attempts = owner.attempts.lock();
        if attempts
            .get(&self.host_id)
            .is_none_or(|attempt| attempt.token != self.token)
        {
            return false;
        }
        attempts.remove(&self.host_id);
        owner.connecting.lock().remove(&self.host_id);
        drop(attempts);
        true
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct StartupSessionHost {
    pub host_id: String,
    pub jump_host_id: Option<String>,
    pub key_auth: bool,
}
#[derive(Clone, Debug, thiserror::Error, uniffi::Error)]
pub enum SessionRestoreError {
    #[error("{message}")]
    Failed { message: String },
}
fn failure(message: impl Into<String>) -> SessionRestoreError {
    SessionRestoreError::Failed {
        message: message.into(),
    }
}
impl From<uniffi::UnexpectedUniFFICallbackError> for SessionRestoreError {
    fn from(error: uniffi::UnexpectedUniFFICallbackError) -> Self {
        failure(error.reason)
    }
}
#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait SessionRestorePlatform: Send + Sync {
    async fn prepare(&self) -> Result<(), SessionRestoreError>;
    async fn verify_keys(&self) -> Result<bool, SessionRestoreError>;
    async fn connect_host(
        &self,
        host_id: String,
        biometric_verified: bool,
        attempt: Arc<SessionConnectionAttempt>,
    ) -> Result<bool, SessionRestoreError>;
    fn state_changed(&self);
    fn host_failed(&self, host_id: String, message: String);
    fn terminal_ready(&self, session_id: String);
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct StartupSessionResult {
    pub view: AppCoreView,
}
type RestoreResult = Result<StartupSessionResult, SessionRestoreError>;
#[derive(uniffi::Object)]
pub struct StartupSessionRestore {
    result: watch::Receiver<Option<RestoreResult>>,
}
#[uniffi::export]
impl StartupSessionRestore {
    pub async fn wait(&self) -> Result<StartupSessionResult, SessionRestoreError> {
        let mut result = self.result.clone();
        loop {
            let completed = result.borrow_and_update().clone();
            if let Some(completed) = completed {
                return completed;
            }
            result
                .changed()
                .await
                .map_err(|_| failure("Startup restoration stopped"))?;
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Membership {
    host_ids: Vec<String>,
    active_host_id: Option<String>,
}
fn membership(value: Option<&str>) -> Result<Membership, SessionRestoreError> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(Membership::default());
    };
    let value: serde_json::Value = serde_json::from_str(value)
        .map_err(|_| failure("Stored live hosts are invalid; data was preserved"))?;
    if !value.is_object() {
        return Err(failure("Stored live hosts are invalid; data was preserved"));
    }
    let mut seen = HashSet::new();
    let host_ids: Vec<_> = value["hostIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .filter(|id| !id.is_empty() && seen.insert((*id).to_owned()))
        .map(str::to_owned)
        .collect();
    let active_host_id = value["activeHostId"]
        .as_str()
        .filter(|id| host_ids.iter().any(|host| host == id))
        .map(str::to_owned)
        .or_else(|| host_ids.first().cloned());
    Ok(Membership {
        host_ids,
        active_host_id,
    })
}
fn protected_host(
    id: &str,
    hosts: &HashMap<String, StartupSessionHost>,
    protect_keys: bool,
) -> bool {
    if !protect_keys {
        return false;
    }
    let mut seen = HashSet::new();
    let mut next = Some(id);
    while let Some(id) = next {
        if !seen.insert(id) {
            break;
        }
        let Some(host) = hosts.get(id) else {
            break;
        };
        if host.key_auth {
            return true;
        }
        next = host.jump_host_id.as_deref();
    }
    false
}

struct RestoreRequest {
    raw: Option<String>,
    loaded: bool,
    hosts: Vec<StartupSessionHost>,
    protect_keys: bool,
    reopen_terminal: bool,
}

impl AppCore {
    async fn restore_startup(
        self: Arc<Self>,
        request: RestoreRequest,
        platform: Arc<dyn SessionRestorePlatform>,
        generation: u64,
    ) -> RestoreResult {
        let RestoreRequest {
            raw,
            loaded,
            hosts,
            protect_keys,
            reopen_terminal,
        } = request;
        if self.coordination.generation.load(Ordering::Acquire) != generation {
            return Err(failure("Startup restoration canceled"));
        }
        platform.prepare().await?;
        let raw = if loaded {
            raw
        } else {
            let persistence = self
                .state
                .lock()
                .persistence
                .clone()
                .ok_or_else(|| failure("Session persistence is unavailable"))?;
            persistence
                .read_live_hosts()
                .map_err(|error| failure(error.to_string()))?
                .snapshot()
                .await
                .map_err(|error| failure(error.to_string()))?
        };
        let persisted = membership(raw.as_deref())?;
        let hosts: HashMap<_, _> = hosts
            .into_iter()
            .map(|host| (host.host_id.clone(), host))
            .collect();
        let host_ids: Vec<_> = persisted
            .host_ids
            .into_iter()
            .filter(|id| hosts.contains_key(id))
            .collect();
        let active = persisted
            .active_host_id
            .filter(|id| host_ids.contains(id))
            .or_else(|| host_ids.first().cloned());
        {
            let mut state = self.state.lock();
            if self.coordination.generation.load(Ordering::Acquire) != generation {
                return Err(failure("Startup restoration canceled"));
            }
            for id in &host_ids {
                state.open_session(id.clone(), id.clone(), false);
            }
            if active.is_some() {
                state.active_session_id.clone_from(&active);
            }
        }
        platform.state_changed();
        let has_protected = host_ids
            .iter()
            .any(|id| protected_host(id, &hosts, protect_keys));
        let granted = !has_protected || platform.verify_keys().await?;
        let current = || self.coordination.generation.load(Ordering::Acquire) == generation;
        let restore = |id: String| {
            let core = self.clone();
            let platform = platform.clone();
            let protected = protected_host(&id, &hosts, protect_keys);
            async move {
                if !current() {
                    return;
                }
                if protected && !granted {
                    core.close_session(id);
                    platform.state_changed();
                    return;
                }
                let attempt = {
                    let state = core.state.lock();
                    if !current() || !state.sessions.iter().any(|session| session.id == id) {
                        return;
                    }
                    let Some(attempt) = core.claim_connection(id.clone(), true) else {
                        return;
                    };
                    drop(state);
                    attempt
                };
                let completion = AttemptCompletion(attempt.clone());
                let result = platform
                    .connect_host(id.clone(), protected && granted, attempt.clone())
                    .await;
                if let Err(error) = result {
                    let mut state = core.state.lock();
                    if !current() || !attempt.is_current() {
                        return;
                    }
                    let message = error.to_string();
                    state.set_placeholder_connection(
                        id.clone(),
                        AppConnectionStatus::Error,
                        Some(message.clone()),
                        None,
                    );
                    drop(state);
                    platform.host_failed(id, message);
                    platform.state_changed();
                }
                drop(completion);
            }
        };
        let mut reopened = false;
        if let Some(active) = &active {
            restore(active.clone()).await;
            if current()
                && reopen_terminal
                && self.view().active_session_id.as_ref() == Some(active)
                && self.state.lock().restored_terminals.contains(active)
            {
                platform.terminal_ready(active.clone());
                reopened = true;
            }
        }
        futures::stream::iter(
            host_ids
                .iter()
                .filter(|id| Some(*id) != active.as_ref())
                .cloned(),
        )
        .for_each_concurrent(2, restore)
        .await;
        if !current() {
            return Err(failure("Startup restoration canceled"));
        }
        if reopen_terminal && !reopened && self.view().active_session_id == active {
            let restored = self.state.lock().restored_terminals.clone();
            let terminal = active
                .as_ref()
                .filter(|id| restored.contains(*id))
                .cloned()
                .or_else(|| {
                    host_ids
                        .iter()
                        .rev()
                        .find(|id| restored.contains(*id))
                        .cloned()
                });
            if let Some(terminal) = terminal {
                self.select_host(terminal.clone());
                platform.terminal_ready(terminal);
            }
        }
        {
            let mut state = self.state.lock();
            if !current() {
                return Err(failure("Startup restoration canceled"));
            }
            state.restore_can_persist = true;
        }
        let view = self.view();
        platform.state_changed();
        Ok(StartupSessionResult { view })
    }
}

#[uniffi::export]
impl AppCore {
    pub fn begin_connection(&self, host_id: String) -> Option<Arc<SessionConnectionAttempt>> {
        self.claim_connection(host_id, false)
    }
    pub fn connection_pending(&self, host_id: String) -> bool {
        self.coordination.attempts.lock().contains_key(&host_id)
    }
}

impl AppCore {
    fn claim_connection(
        &self,
        host_id: String,
        restoration: bool,
    ) -> Option<Arc<SessionConnectionAttempt>> {
        let mut attempts = self.coordination.attempts.lock();
        if attempts.contains_key(&host_id) {
            return None;
        }
        let token = self.coordination.next.fetch_add(1, Ordering::Relaxed) + 1;
        attempts.insert(host_id.clone(), AttemptState { token, restoration });
        drop(attempts);
        Some(Arc::new(SessionConnectionAttempt {
            owner: Arc::downgrade(&self.coordination),
            host_id,
            token,
        }))
    }
}

#[uniffi::export]
impl AppCore {
    pub fn cancel_connection(&self, host_id: String) {
        let mut attempts = self.coordination.attempts.lock();
        attempts.remove(&host_id);
        self.coordination.connecting.lock().remove(&host_id);
        drop(attempts);
    }
    pub fn cancel_session_restore(&self) {
        let _state = self.state.lock();
        self.coordination.cancel_restore();
    }
    pub fn cancel_connections(&self) {
        let _state = self.state.lock();
        self.coordination.cancel_restore();
        self.coordination.attempts.lock().clear();
        self.coordination.connecting.lock().clear();
    }
    pub fn set_connecting(&self, host_id: String, connecting: bool) -> Vec<String> {
        let mut hosts = self.coordination.connecting.lock();
        if connecting {
            hosts.insert(host_id);
        } else {
            hosts.remove(&host_id);
        }
        let mut result: Vec<_> = hosts.iter().cloned().collect();
        drop(hosts);
        result.sort();
        result
    }
    pub fn set_session_persistence(&self, persistence: Arc<super::SessionPersistence>) {
        self.state.lock().persistence = Some(persistence);
    }
    pub fn start_session_restore(
        &self,
        raw: Option<String>,
        loaded: bool,
        hosts: Vec<StartupSessionHost>,
        protect_keys: bool,
        reopen_terminal: bool,
        platform: Arc<dyn SessionRestorePlatform>,
    ) -> Result<Arc<StartupSessionRestore>, SessionRestoreError> {
        let mut restore = self.coordination.restore.lock();
        if let Some(result) = restore.as_ref() {
            return Ok(Arc::new(StartupSessionRestore {
                result: result.clone(),
            }));
        }
        let generation = self.coordination.generation.load(Ordering::Acquire);
        let mut cancellation = self.coordination.cancellation.subscribe();
        let (completed, result) = watch::channel(None);
        let core = Arc::new(Self {
            state: self.state.clone(),
            coordination: self.coordination.clone(),
        });
        crate::runtime().map_err(failure)?.spawn(async move {
            let result = tokio::select! {
                result = core.restore_startup(RestoreRequest { raw, loaded, hosts, protect_keys, reopen_terminal }, platform, generation) => result,
                _ = cancellation.changed() => Err(failure("Startup restoration canceled")),
            };
            let _ = completed.send(Some(result));
        });
        *restore = Some(result.clone());
        drop(restore);
        Ok(Arc::new(StartupSessionRestore { result }))
    }
    pub fn persist_session_terminals(
        &self,
        session_id: String,
        fonts: Vec<super::TerminalFontPreference>,
    ) -> Result<Option<Arc<super::SessionPersistenceOperation>>, super::SessionPersistenceError>
    {
        let state = self.state.lock();
        if !state.terminal_storage_loaded.contains(&session_id) {
            return Ok(None);
        }
        let Some(session) = state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
        else {
            return Ok(None);
        };
        let Some(persistence) = &state.persistence else {
            return Ok(None);
        };
        let operation = persistence.save_terminals(
            session_id,
            session.host_id.clone(),
            session.view().terminal_rail.resume_blob,
            fonts,
        )?;
        drop(state);
        Ok(Some(operation))
    }
}

#[cfg(test)]
mod tests;
