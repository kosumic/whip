//! Ordered application persistence. Debounce, revision cursors and transaction
//! admission belong here; the platform only prepares legacy storage migration.
use crate::{AppStorageEntry, HostRuntime, get_host_runtime, read_app_data, write_app_data};
use async_trait::async_trait;
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{OnceCell, mpsc, watch};

const SNAPSHOTS: &str = "herdr.host.snapshot.v1.";
const TERMINALS: &str = "herdr.terminal.sessions.v1.";
const FONTS: &str = "herdr.terminal.font-sizes.v1.";
const WRITE_DELAY: Duration = Duration::from_millis(1500);

#[derive(Clone, Debug, thiserror::Error, uniffi::Error)]
pub enum SessionPersistenceError {
    #[error("{message}")]
    Failed { message: String },
}
type Result<T> = std::result::Result<T, SessionPersistenceError>;
fn failure(message: impl Into<String>) -> SessionPersistenceError {
    SessionPersistenceError::Failed {
        message: message.into(),
    }
}
impl From<uniffi::UnexpectedUniFFICallbackError> for SessionPersistenceError {
    fn from(error: uniffi::UnexpectedUniFFICallbackError) -> Self {
        failure(error.reason)
    }
}

#[uniffi::export(with_foreign)]
#[async_trait]
pub trait SessionPersistencePlatform: Send + Sync {
    async fn prepare(&self) -> Result<()>;
    fn write_failed(&self, host_id: String, message: String);
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct TerminalFontPreference {
    pub terminal_id: String,
    pub size: f64,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct SavedTerminalState {
    pub resume_blob: Option<String>,
    pub font_sizes: Vec<TerminalFontPreference>,
    pub invalid_fonts: bool,
}

#[async_trait]
trait Storage: Send + Sync {
    async fn read(&self, keys: Vec<String>) -> Result<Vec<AppStorageEntry>>;
    async fn write(&self, entries: Vec<AppStorageEntry>) -> Result<()>;
}
struct Database {
    platform: Arc<dyn SessionPersistencePlatform>,
    prepared: OnceCell<()>,
}
impl Database {
    async fn ready(&self) -> Result<()> {
        self.prepared
            .get_or_try_init(|| self.platform.prepare())
            .await
            .map(|_| ())
    }
}
#[async_trait]
impl Storage for Database {
    async fn read(&self, keys: Vec<String>) -> Result<Vec<AppStorageEntry>> {
        self.ready().await?;
        read_app_data(keys)
            .await
            .map_err(|error| failure(error.to_string()))
    }
    async fn write(&self, entries: Vec<AppStorageEntry>) -> Result<()> {
        self.ready().await?;
        write_app_data(entries)
            .await
            .map_err(|error| failure(error.to_string()))
    }
}

#[async_trait]
trait SnapshotSource: Send + Sync {
    fn incarnation(&self) -> u64;
    async fn export(&self, revision: Option<u64>) -> Result<Option<crate::HostOfflineCache>>;
}
#[async_trait]
impl SnapshotSource for HostRuntime {
    fn incarnation(&self) -> u64 {
        self.runtime_incarnation()
    }
    async fn export(&self, revision: Option<u64>) -> Result<Option<crate::HostOfflineCache>> {
        self.export_offline_cache(revision)
            .await
            .map_err(|error| failure(error.to_string()))
    }
}

#[derive(Clone)]
enum Outcome {
    Done(bool),
    Snapshot(Option<String>),
    Terminals(SavedTerminalState),
}
#[derive(uniffi::Object)]
pub struct SessionPersistenceOperation {
    result: watch::Receiver<Option<Result<Outcome>>>,
}
impl SessionPersistenceOperation {
    async fn result(&self) -> Result<Outcome> {
        let mut result = self.result.clone();
        loop {
            let completed = result.borrow_and_update().clone();
            if let Some(completed) = completed {
                return completed;
            }
            result
                .changed()
                .await
                .map_err(|_| failure("Session persistence worker stopped"))?;
        }
    }
}
#[uniffi::export]
impl SessionPersistenceOperation {
    pub async fn wait(&self) -> Result<bool> {
        match self.result().await? {
            Outcome::Done(changed) => Ok(changed),
            _ => Err(failure("Unexpected persistence result")),
        }
    }
    pub async fn snapshot(&self) -> Result<Option<String>> {
        match self.result().await? {
            Outcome::Snapshot(value) => Ok(value),
            _ => Err(failure("Unexpected persistence result")),
        }
    }
    pub async fn terminals(&self) -> Result<SavedTerminalState> {
        match self.result().await? {
            Outcome::Terminals(value) => Ok(value),
            _ => Err(failure("Unexpected persistence result")),
        }
    }
}

enum Command {
    Schedule(String, Arc<dyn SnapshotSource>),
    Flush(Option<String>),
    ReadSnapshot(String),
    DeleteSnapshot(String),
    ReadTerminals(String),
    SaveTerminals(String, String, String, Vec<TerminalFontPreference>),
    Retain(Vec<String>),
    ReadLiveHosts,
    SaveLiveHosts(String),
}
type Job = (Command, watch::Sender<Option<Result<Outcome>>>);
struct Pending {
    source: Arc<dyn SnapshotSource>,
    deadline: Option<tokio::time::Instant>,
}
#[derive(Clone, PartialEq, Eq)]
struct TerminalValue {
    resume: String,
    fonts: String,
}
struct Worker {
    storage: Arc<dyn Storage>,
    platform: Arc<dyn SessionPersistencePlatform>,
    pending: HashMap<String, Pending>,
    cursors: HashMap<String, (u64, u64)>,
    terminals: HashMap<String, TerminalValue>,
    observed: HashMap<String, (String, TerminalValue)>,
    membership: Option<String>,
}
impl Worker {
    async fn run(mut self, mut jobs: mpsc::UnboundedReceiver<Job>) {
        loop {
            let deadline = self
                .pending
                .values()
                .filter_map(|pending| pending.deadline)
                .min();
            let timer = async {
                match deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => futures::future::pending().await,
                }
            };
            tokio::select! {
                job = jobs.recv() => {
                    let Some((command, completed)) = job else { let _ = self.flush(None).await; return; };
                    let background = matches!(command, Command::SaveLiveHosts(_));
                    let result = self.execute(command).await;
                    if (background || completed.is_closed()) && let Err(error) = &result { self.platform.write_failed(String::new(), error.to_string()); }
                    let _ = completed.send(Some(result));
                }
                () = timer => {
                    let now = tokio::time::Instant::now();
                    let hosts: Vec<_> = self.pending.iter().filter(|(_, pending)| pending.deadline.is_some_and(|deadline| deadline <= now)).map(|(id, _)| id.clone()).collect();
                    for host in hosts {
                        if let Err(error) = self.flush(Some(&host)).await { self.platform.write_failed(host, error.to_string()); }
                    }
                }
            }
        }
    }
    async fn flush(&mut self, host: Option<&str>) -> Result<()> {
        let hosts: Vec<_> = host.map_or_else(
            || self.pending.keys().cloned().collect(),
            |host| vec![host.to_owned()],
        );
        let mut failed = None;
        for host in hosts {
            let Some(mut pending) = self.pending.remove(&host) else {
                continue;
            };
            pending.deadline = None;
            let incarnation = pending.source.incarnation();
            let revision = self
                .cursors
                .get(&host)
                .filter(|(saved, _)| *saved == incarnation)
                .map(|(_, revision)| *revision);
            let write = async {
                if let Some(snapshot) = pending.source.export(revision).await? {
                    self.storage
                        .write(vec![entry(
                            format!("{SNAPSHOTS}{host}"),
                            Some(snapshot.blob),
                        )])
                        .await?;
                    self.cursors
                        .insert(host.clone(), (incarnation, snapshot.revision));
                }
                Ok(())
            }
            .await;
            if let Err(error) = write {
                self.pending.insert(host, pending);
                failed = Some(error);
            }
        }
        failed.map_or(Ok(()), Err)
    }
    async fn execute(&mut self, command: Command) -> Result<Outcome> {
        match command {
            Command::Schedule(host, source) => {
                let deadline = self
                    .pending
                    .get(&host)
                    .and_then(|pending| pending.deadline)
                    .unwrap_or_else(|| tokio::time::Instant::now() + WRITE_DELAY);
                self.pending.insert(
                    host,
                    Pending {
                        source,
                        deadline: Some(deadline),
                    },
                );
                Ok(Outcome::Done(false))
            }
            Command::Flush(host) => {
                self.flush(host.as_deref()).await?;
                Ok(Outcome::Done(true))
            }
            Command::ReadSnapshot(host) => {
                // A failed fresh export must not hide the last durable offline snapshot.
                if let Err(error) = self.flush(Some(&host)).await {
                    self.platform.write_failed(host.clone(), error.to_string());
                }
                let values = self
                    .storage
                    .read(vec![format!("{SNAPSHOTS}{host}")])
                    .await?;
                Ok(Outcome::Snapshot(
                    values.into_iter().next().and_then(|entry| entry.value),
                ))
            }
            Command::DeleteSnapshot(host) => {
                self.pending.remove(&host);
                self.storage
                    .write(vec![entry(format!("{SNAPSHOTS}{host}"), None)])
                    .await?;
                self.cursors.remove(&host);
                Ok(Outcome::Done(true))
            }
            Command::ReadTerminals(host) => {
                let keys = vec![format!("{TERMINALS}{host}"), format!("{FONTS}{host}")];
                let mut values = self.storage.read(keys.clone()).await?;
                if values.len() != 2
                    || values
                        .iter()
                        .zip(&keys)
                        .any(|(entry, key)| &entry.key != key)
                {
                    return Err(failure("Incomplete terminal storage snapshot"));
                }
                let fonts = values.pop().and_then(|entry| entry.value);
                let resume = values.pop().and_then(|entry| entry.value);
                Ok(Outcome::Terminals(read_fonts(resume, fonts)))
            }
            Command::SaveTerminals(session, host, resume, fonts) => {
                let next = TerminalValue {
                    resume,
                    fonts: font_value(fonts)?,
                };
                if self
                    .observed
                    .get(&session)
                    .is_some_and(|(owner, value)| owner == &host && value == &next)
                    && self.terminals.get(&host) == Some(&next)
                {
                    return Ok(Outcome::Done(false));
                }
                let persisted = self.terminals.get(&host);
                let mut changes = Vec::new();
                if persisted.is_none_or(|value| value.fonts != next.fonts) {
                    changes.push(entry(format!("{FONTS}{host}"), Some(next.fonts.clone())));
                }
                if persisted.is_none_or(|value| value.resume != next.resume) {
                    changes.push(entry(
                        format!("{TERMINALS}{host}"),
                        Some(next.resume.clone()),
                    ));
                }
                if !changes.is_empty() {
                    self.storage.write(changes).await?;
                }
                self.terminals.insert(host.clone(), next.clone());
                self.observed.insert(session, (host, next));
                Ok(Outcome::Done(true))
            }
            Command::ReadLiveHosts => {
                let values = self
                    .storage
                    .read(vec!["herdr.live.hosts.v1".into()])
                    .await?;
                Ok(Outcome::Snapshot(
                    values.into_iter().next().and_then(|entry| entry.value),
                ))
            }
            Command::SaveLiveHosts(value) => {
                if self.membership.as_ref() == Some(&value) {
                    return Ok(Outcome::Done(false));
                }
                self.storage
                    .write(vec![entry(
                        "herdr.live.hosts.v1".into(),
                        Some(value.clone()),
                    )])
                    .await?;
                self.membership = Some(value);
                Ok(Outcome::Done(true))
            }
            Command::Retain(sessions) => {
                self.observed.retain(|id, _| sessions.contains(id));
                if sessions.is_empty() {
                    self.terminals.clear();
                }
                Ok(Outcome::Done(false))
            }
        }
    }
}
fn entry(key: String, value: Option<String>) -> AppStorageEntry {
    AppStorageEntry { key, value }
}
fn normalized_size(size: f64) -> Option<f64> {
    size.is_finite().then(|| size.round().clamp(8.0, 24.0))
}
fn font_value(fonts: Vec<TerminalFontPreference>) -> Result<String> {
    let normalized: BTreeMap<_, _> = fonts
        .into_iter()
        .filter_map(|font| normalized_size(font.size).map(|size| (font.terminal_id, size)))
        .collect();
    serde_json::to_string(&normalized).map_err(|_| failure("Could not encode terminal fonts"))
}
fn read_fonts(resume: Option<String>, fonts: Option<String>) -> SavedTerminalState {
    let mut state = SavedTerminalState {
        resume_blob: resume,
        font_sizes: Vec::new(),
        invalid_fonts: false,
    };
    let Some(value) = fonts.as_ref().or(state.resume_blob.as_ref()) else {
        return state;
    };
    let parsed = serde_json::from_str::<serde_json::Value>(value);
    let Ok(serde_json::Value::Object(object)) = parsed else {
        state.invalid_fonts = true;
        return state;
    };
    let values: Vec<_> = if fonts.is_some() {
        object.into_iter().collect()
    } else {
        object
            .get("sessions")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|value| {
                Some((
                    value["terminalId"].as_str()?.to_owned(),
                    value["fontSize"].clone(),
                ))
            })
            .collect()
    };
    state.font_sizes = values
        .into_iter()
        .filter_map(|(terminal_id, value)| {
            normalized_size(value.as_f64()?)
                .map(|size| TerminalFontPreference { terminal_id, size })
        })
        .collect();
    state
}

#[derive(uniffi::Object)]
pub struct SessionPersistence {
    jobs: mpsc::UnboundedSender<Job>,
}
impl SessionPersistence {
    fn with_storage(
        storage: Arc<dyn Storage>,
        platform: Arc<dyn SessionPersistencePlatform>,
    ) -> Result<Arc<Self>> {
        let (jobs, receiver) = mpsc::unbounded_channel();
        crate::runtime().map_err(failure)?.spawn(
            Worker {
                storage,
                platform,
                pending: HashMap::new(),
                cursors: HashMap::new(),
                terminals: HashMap::new(),
                observed: HashMap::new(),
                membership: None,
            }
            .run(receiver),
        );
        Ok(Arc::new(Self { jobs }))
    }
    fn submit(&self, command: Command) -> Result<Arc<SessionPersistenceOperation>> {
        let (completed, result) = watch::channel(None);
        self.jobs
            .send((command, completed))
            .map_err(|_| failure("Session persistence worker stopped"))?;
        Ok(Arc::new(SessionPersistenceOperation { result }))
    }
}
#[uniffi::export]
impl SessionPersistence {
    #[uniffi::constructor]
    pub fn new(platform: Arc<dyn SessionPersistencePlatform>) -> Result<Arc<Self>> {
        Self::with_storage(
            Arc::new(Database {
                platform: platform.clone(),
                prepared: OnceCell::new(),
            }),
            platform,
        )
    }
    pub fn schedule_snapshot(
        &self,
        host_id: String,
        runtime_id: String,
        incarnation: u64,
    ) -> Result<()> {
        let Some(source) = get_host_runtime(runtime_id)
            .filter(|runtime| runtime.runtime_incarnation() == incarnation)
        else {
            return Ok(());
        };
        self.submit(Command::Schedule(host_id, source))?;
        Ok(())
    }
    pub fn flush(&self, host_id: Option<String>) -> Result<Arc<SessionPersistenceOperation>> {
        self.submit(Command::Flush(host_id))
    }
    pub fn read_snapshot(&self, host_id: String) -> Result<Arc<SessionPersistenceOperation>> {
        self.submit(Command::ReadSnapshot(host_id))
    }
    pub fn delete_snapshot(&self, host_id: String) -> Result<Arc<SessionPersistenceOperation>> {
        self.submit(Command::DeleteSnapshot(host_id))
    }
    pub fn read_terminals(&self, host_id: String) -> Result<Arc<SessionPersistenceOperation>> {
        self.submit(Command::ReadTerminals(host_id))
    }
}

impl SessionPersistence {
    pub(super) fn save_terminals(
        &self,
        session_id: String,
        host_id: String,
        resume: String,
        fonts: Vec<TerminalFontPreference>,
    ) -> Result<Arc<SessionPersistenceOperation>> {
        self.submit(Command::SaveTerminals(session_id, host_id, resume, fonts))
    }
    pub(super) fn read_live_hosts(&self) -> Result<Arc<SessionPersistenceOperation>> {
        self.submit(Command::ReadLiveHosts)
    }
    pub(super) fn save_live_hosts(
        &self,
        host_ids: Vec<String>,
        active_host_id: Option<String>,
    ) -> Result<()> {
        let value =
            serde_json::json!({"hostIds":host_ids,"activeHostId":active_host_id}).to_string();
        self.submit(Command::SaveLiveHosts(value))?;
        Ok(())
    }
    pub(super) fn retain_sessions(&self, sessions: Vec<String>) -> Result<()> {
        self.submit(Command::Retain(sessions))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
