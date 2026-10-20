//! Local conversation storage. One worker owns all database handles and orders
//! writes, reads and authoritative deletion. Nothing here runs on a UI or Tokio
//! executor thread (Turso's portable I/O backend can perform synchronous I/O).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, mpsc};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use tokio::sync::oneshot;

use crate::agent_sessions::AgentSessionError;
use crate::agent_transcript::{AgentTranscriptKind, AgentTranscriptState};

const SCHEMA_VERSION: i64 = 1;
const DATABASE_NAME: &str = "conversations.db";
const LEGACY_DATABASE_NAME: &str = "whip-agent-chat.db";
static DATABASE: OnceLock<Mutex<Option<TranscriptDatabase>>> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
enum StorageError {
    #[error(transparent)]
    Database(#[from] turso::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("incompatible conversation cache schema")]
    Incompatible,
}

impl StorageError {
    fn recreatable(&self) -> bool {
        matches!(
            self,
            Self::Incompatible | Self::Database(turso::Error::Corrupt(_) | turso::Error::NotAdb(_))
        )
    }
}

impl From<StorageError> for AgentSessionError {
    fn from(error: StorageError) -> Self {
        Self::CacheStorage(error.to_string())
    }
}

/// Identity and checkpoint serialization stay inside Rust, including when new
/// message/search tables are added alongside the conversation catalog.
#[derive(Clone, Debug)]
pub(crate) struct TranscriptIdentity {
    pub namespace: String,
    pub agent: AgentTranscriptKind,
    pub session_id: String,
}

impl TranscriptIdentity {
    pub(crate) fn key(&self) -> String {
        format!(
            "{}\n{}\n{}",
            self.namespace,
            agent_name(self.agent),
            self.session_id
        )
    }
}

fn agent_name(agent: AgentTranscriptKind) -> &'static str {
    match agent {
        AgentTranscriptKind::Claude => "claude",
        AgentTranscriptKind::Codex => "codex",
        AgentTranscriptKind::OpenCode => "opencode",
    }
}

fn agent_kind(name: &str) -> Result<AgentTranscriptKind, StorageError> {
    match name {
        "claude" => Ok(AgentTranscriptKind::Claude),
        "codex" => Ok(AgentTranscriptKind::Codex),
        "opencode" => Ok(AgentTranscriptKind::OpenCode),
        _ => Err(StorageError::Incompatible),
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct SavedAgentTranscript {
    pub key: String,
    pub namespace: String,
    pub agent: AgentTranscriptKind,
    pub session_id: String,
    pub updated_at: i64,
    pub cache_bytes: i64,
}

type Job = Box<dyn FnOnce(&mut Worker) + Send>;

#[derive(Clone)]
pub(crate) struct TranscriptDatabase {
    sender: mpsc::Sender<Job>,
}

impl TranscriptDatabase {
    pub(crate) fn open(
        path: PathBuf,
        legacy_paths: Vec<PathBuf>,
    ) -> Result<Self, AgentSessionError> {
        let runtime = crate::runtime().map_err(AgentSessionError::CacheStorage)?;
        let (sender, receiver) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("whip-conversations".into())
            .spawn(move || {
                // Legacy caches are disposable. Delete only the named DB and its
                // sidecars, never a directory or unrelated Expo storage.
                for legacy in legacy_paths {
                    let _ = remove_database(&legacy);
                }
                let mut worker = Worker {
                    path,
                    runtime,
                    store: None,
                    authorities: HashMap::new(),
                };
                while let Ok(job) = receiver.recv() {
                    job(&mut worker);
                }
                // Dropping the last sender drains admitted work before closing.
                // Each checkpoint is already durable at COMMIT, including on kill.
            })
            .map_err(|error| AgentSessionError::CacheStorage(error.to_string()))?;
        Ok(Self { sender })
    }

    fn enqueue(
        &self,
        job: impl FnOnce(&mut Worker) + Send + 'static,
    ) -> Result<(), AgentSessionError> {
        self.sender
            .send(Box::new(job))
            .map_err(|_| AgentSessionError::CacheStorage("conversation worker stopped".into()))
    }

    async fn request<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Worker) -> Result<T, AgentSessionError> + Send + 'static,
    ) -> Result<T, AgentSessionError> {
        let (sender, receiver) = oneshot::channel();
        self.enqueue(move |worker| {
            let _ = sender.send(operation(worker));
        })?;
        receiver
            .await
            .map_err(|_| AgentSessionError::CacheStorage("conversation worker stopped".into()))?
    }

    pub(crate) fn activate(&self, namespace: String, incarnation: u64) {
        let _ = self.enqueue(move |worker| {
            let authority = worker.authorities.entry(namespace).or_default();
            if incarnation > authority.incarnation {
                *authority = Authority {
                    incarnation,
                    ..Authority::default()
                };
            }
        });
    }

    /// Call while holding the session lock: admission order is mutation order.
    /// Completion executes only after the transaction commits (or fails).
    pub(crate) fn save(
        &self,
        identity: TranscriptIdentity,
        incarnation: u64,
        blob: Vec<u8>,
        complete: impl FnOnce(Result<bool, AgentSessionError>) + Send + 'static,
    ) -> Result<(), AgentSessionError> {
        self.enqueue(move |worker| {
            let key = identity.key();
            let allowed = worker
                .authorities
                .get(&identity.namespace)
                .is_none_or(|authority| {
                    !authority.deleted
                        && authority.incarnation == incarnation
                        && authority
                            .retained
                            .as_ref()
                            .is_none_or(|keys| keys.contains(&key))
                });
            let result = if allowed {
                worker
                    .with_store(|store| store.save(&identity, &blob))
                    .map(|()| true)
            } else {
                Ok(false)
            };
            complete(result);
        })
    }

    pub(crate) async fn load(&self, key: String) -> Result<Option<Vec<u8>>, AgentSessionError> {
        self.request(move |worker| worker.with_store(|store| store.load(&key)))
            .await
    }

    pub(crate) async fn read_transcript(
        &self,
        identity: TranscriptIdentity,
    ) -> Result<Option<AgentTranscriptState>, AgentSessionError> {
        // Decoding a large checkpoint belongs on the database worker too.
        self.request(move |worker| {
            let blob = worker.with_store(|store| store.load(&identity.key()))?;
            blob.map(|blob| {
                crate::agent_sessions::decode_cached_agent_transcript(
                    identity.agent,
                    identity.session_id,
                    blob,
                )
            })
            .transpose()
        })
        .await
    }

    pub(crate) async fn list(&self) -> Result<Vec<SavedAgentTranscript>, AgentSessionError> {
        self.request(|worker| worker.with_store(Store::list)).await
    }

    #[cfg(test)]
    pub(crate) fn hold_worker(&self) -> mpsc::Sender<()> {
        let (entered, ready) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        self.enqueue(move |_| {
            entered.send(()).unwrap();
            resume.recv().unwrap();
        })
        .unwrap();
        ready.recv().unwrap();
        release
    }

    pub(crate) fn retain(
        &self,
        namespace: String,
        incarnation: u64,
        revision: u64,
        retained: HashSet<String>,
    ) {
        let _ = self.enqueue(move |worker| {
            let authority = worker.authorities.entry(namespace.clone()).or_default();
            if authority.deleted
                || incarnation < authority.incarnation
                || (incarnation == authority.incarnation && revision < authority.revision)
            {
                return;
            }
            if authority.incarnation == incarnation
                && authority.revision == revision
                && authority.retained.as_ref() == Some(&retained)
                && authority.pruned
            {
                return;
            }
            *authority = Authority {
                incarnation,
                revision,
                retained: Some(retained.clone()),
                deleted: false,
                pruned: false,
            };
            // Keep the guard even if pruning fails; a later fresh projection
            // retries pruning and delayed writes cannot resurrect removed rows.
            match worker.with_store(|store| store.retain(&namespace, &retained)) {
                Ok(()) => {
                    if let Some(authority) = worker.authorities.get_mut(&namespace) {
                        authority.pruned = true;
                    }
                }
                Err(error) => {
                    crate::host_runtime::record_transcript_cache_failure(&error.to_string());
                }
            }
        });
    }

    pub(crate) async fn delete_host(&self, namespace: String) -> Result<(), AgentSessionError> {
        self.request(move |worker| {
            worker
                .authorities
                .entry(namespace.clone())
                .or_default()
                .deleted = true;
            worker.with_store(|store| store.retain(&namespace, &HashSet::new()))
        })
        .await
    }
}

#[derive(Default)]
struct Authority {
    incarnation: u64,
    revision: u64,
    retained: Option<HashSet<String>>,
    deleted: bool,
    pruned: bool,
}

struct Worker {
    path: PathBuf,
    runtime: &'static tokio::runtime::Runtime,
    store: Option<Store>,
    authorities: HashMap<String, Authority>,
}

impl Worker {
    fn with_store<T>(
        &mut self,
        mut operation: impl FnMut(&mut Store) -> Result<T, StorageError>,
    ) -> Result<T, AgentSessionError> {
        for attempt in 0..2 {
            let result = (|| {
                if self.store.is_none() {
                    self.store = Some(Store::open(&self.path, self.runtime)?);
                }
                match &mut self.store {
                    Some(store) => operation(store),
                    None => Err(StorageError::Incompatible),
                }
            })();
            match result {
                Err(error) if attempt == 0 && error.recreatable() => {
                    self.store = None; // close all handles before unlinking
                    remove_database(&self.path).map_err(StorageError::from)?;
                }
                other => return other.map_err(Into::into),
            }
        }
        unreachable!("recovery has one retry")
    }
}

struct Store {
    connection: turso::Connection,
    #[allow(
        dead_code,
        reason = "owns the engine until the connection closes; tests also use observer connections"
    )]
    database: turso::Database,
    runtime: &'static tokio::runtime::Runtime,
}

impl Store {
    fn open(path: &Path, runtime: &'static tokio::runtime::Runtime) -> Result<Self, StorageError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        runtime.block_on(async {
            let database = turso::Builder::new_local(&path.to_string_lossy()).build().await?;
            let connection = database.connect()?;
            // WAL with FULL synchronization is required for confirmation after
            // COMMIT to mean durable storage, rather than just an in-memory ack.
            {
                // journal_mode returns a row; execute/execute_batch reject it.
                let mut journal = connection.query("PRAGMA journal_mode = WAL", ()).await?;
                while journal.next().await?.is_some() {}
            }
            connection.execute("PRAGMA synchronous = FULL", ()).await?;
            connection.execute("PRAGMA foreign_keys = ON", ()).await?;
            let version = {
                let mut rows = connection.query("PRAGMA user_version", ()).await?;
                rows.next().await?.ok_or(StorageError::Incompatible)?.get::<i64>(0)?
            };
            if version != 0 && version != SCHEMA_VERSION { return Err(StorageError::Incompatible); }
            if version == SCHEMA_VERSION {
                for (table, expected) in [
                    ("conversations", &["id", "namespace", "agent", "session_id", "created_at", "updated_at", "cache_bytes"][..]),
                    ("transcript_checkpoints", &["conversation_id", "checkpoint"][..]),
                ] {
                    let mut columns = connection.query(format!("PRAGMA table_info({table})"), ()).await?;
                    let mut names = Vec::new();
                    while let Some(column) = columns.next().await? { names.push(column.get::<String>(1)?); }
                    if names != expected { return Err(StorageError::Incompatible); }
                }
            } else {
                let mut tables = connection.query("SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1", ()).await?;
                if tables.next().await?.is_some() { return Err(StorageError::Incompatible); }
            }
            let mut connection = connection;
            let tx = connection.transaction().await?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY NOT NULL,
                namespace TEXT NOT NULL,
                agent TEXT NOT NULL,
                session_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                cache_bytes INTEGER NOT NULL,
                UNIQUE(namespace, agent, session_id)
            );
            CREATE TABLE IF NOT EXISTS transcript_checkpoints (
                conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                checkpoint BLOB NOT NULL
            );
            CREATE INDEX IF NOT EXISTS conversations_namespace_updated ON conversations(namespace, updated_at DESC, id);
            CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated_at DESC, id);").await?;
            tx.execute(format!("PRAGMA user_version = {SCHEMA_VERSION}"), ()).await?;
            tx.commit().await?;
            Ok(Self { connection, database, runtime })
        })
    }

    fn save(&mut self, identity: &TranscriptIdentity, blob: &[u8]) -> Result<(), StorageError> {
        let cache_bytes = i64::try_from(blob.len())
            .map_err(|_| turso::Error::ConversionFailure("checkpoint is too large".into()))?;
        let now = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        )
        .unwrap_or(i64::MAX);
        self.runtime.block_on(async {
            let tx = self.connection.transaction().await?;
            tx.execute("INSERT INTO conversations (id, namespace, agent, session_id, created_at, updated_at, cache_bytes)
                VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
                ON CONFLICT(id) DO UPDATE SET cache_bytes = excluded.cache_bytes, updated_at = excluded.updated_at",
                (identity.key(), identity.namespace.as_str(), agent_name(identity.agent), identity.session_id.as_str(), now, cache_bytes)).await?;
            tx.execute("INSERT INTO transcript_checkpoints (conversation_id, checkpoint) VALUES (?1, ?2)
                ON CONFLICT(conversation_id) DO UPDATE SET checkpoint = excluded.checkpoint", (identity.key(), blob)).await?;
            tx.commit().await?;
            Ok(())
        })
    }

    fn load(&mut self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        self.runtime.block_on(async {
            let mut rows = self
                .connection
                .query(
                    "SELECT checkpoint FROM transcript_checkpoints WHERE conversation_id = ?1",
                    [key],
                )
                .await?;
            rows.next()
                .await?
                .map(|row| row.get(0))
                .transpose()
                .map_err(Into::into)
        })
    }

    fn list(&mut self) -> Result<Vec<SavedAgentTranscript>, StorageError> {
        self.runtime.block_on(async {
            let mut rows = self.connection.query("SELECT id, namespace, agent, session_id, updated_at, cache_bytes FROM conversations ORDER BY updated_at DESC, id ASC", ()).await?;
            let mut saved = Vec::new();
            while let Some(row) = rows.next().await? {
                saved.push(SavedAgentTranscript { key: row.get(0)?, namespace: row.get(1)?, agent: agent_kind(&row.get::<String>(2)?)?, session_id: row.get(3)?, updated_at: row.get(4)?, cache_bytes: row.get(5)? });
            }
            Ok(saved)
        })
    }

    fn retain(&mut self, namespace: &str, retained: &HashSet<String>) -> Result<(), StorageError> {
        self.runtime.block_on(async {
            let tx = self.connection.transaction().await?;
            if retained.is_empty() {
                tx.execute(
                    "DELETE FROM conversations WHERE namespace = ?1",
                    [namespace],
                )
                .await?;
                tx.commit().await?;
                return Ok(());
            }
            let mut rows = tx
                .query(
                    "SELECT id FROM conversations WHERE namespace = ?1",
                    [namespace],
                )
                .await?;
            let mut removed = Vec::new();
            while let Some(row) = rows.next().await? {
                let key: String = row.get(0)?;
                if !retained.contains(&key) {
                    removed.push(key);
                }
            }
            drop(rows);
            for key in removed {
                tx.execute(
                    "DELETE FROM conversations WHERE id = ?1 AND namespace = ?2",
                    (key, namespace),
                )
                .await?;
            }
            tx.commit().await?;
            Ok(())
        })
    }
}

fn remove_database(path: &Path) -> Result<(), std::io::Error> {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut file = path.as_os_str().to_os_string();
        file.push(suffix);
        match std::fs::remove_file(PathBuf::from(file)) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

pub(crate) fn database() -> Result<TranscriptDatabase, AgentSessionError> {
    DATABASE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .clone()
        .ok_or_else(|| {
            AgentSessionError::CacheStorage(
                "private conversation directory is not configured".into(),
            )
        })
}

/// # Safety
/// Both paths must be live NUL-terminated UTF-8 strings until this call returns.
/// Native bootstrap supplies private OS application directories, never JS paths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_set_conversation_directories(
    directory: *const std::ffi::c_char,
    legacy_directory: *const std::ffi::c_char,
) {
    if directory.is_null() || legacy_directory.is_null() {
        return;
    }
    // SAFETY: Native bootstrap owns the strings until this function returns.
    let directory = unsafe { std::ffi::CStr::from_ptr(directory) };
    // SAFETY: Native bootstrap also owns the legacy path for this call.
    let legacy = unsafe { std::ffi::CStr::from_ptr(legacy_directory) };
    if let (Ok(directory), Ok(legacy)) = (directory.to_str(), legacy.to_str()) {
        let mut database = DATABASE.get_or_init(|| Mutex::new(None)).lock();
        if database.is_none() {
            *database = TranscriptDatabase::open(
                Path::new(directory).join(DATABASE_NAME),
                vec![Path::new(legacy).join(LEGACY_DATABASE_NAME)],
            )
            .ok();
        }
    }
}

#[uniffi::export]
pub async fn list_saved_agent_transcripts() -> Result<Vec<SavedAgentTranscript>, AgentSessionError>
{
    database()?.list().await
}

#[uniffi::export]
pub async fn delete_agent_transcripts_for_host(namespace: String) -> Result<(), AgentSessionError> {
    database()?.delete_host(namespace).await
}

#[uniffi::export]
pub async fn read_saved_agent_transcript(
    namespace: String,
    agent: AgentTranscriptKind,
    session_id: String,
) -> Result<Option<AgentTranscriptState>, AgentSessionError> {
    let identity = TranscriptIdentity {
        namespace,
        agent,
        session_id,
    };
    database()?.read_transcript(identity).await
}

#[cfg(test)]
mod tests;
