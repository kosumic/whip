//! Backed-up, durable application data. Unlike transcript caches this database
//! is never deleted on an open, schema or corruption error. One worker orders
//! transactions and performs portable Turso I/O away from UI/Tokio threads.

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, mpsc};

use parking_lot::Mutex;
use tokio::sync::oneshot;

const SCHEMA_VERSION: i64 = 1;
const LEGACY_IMPORT: &str = "async-storage-v1";
static DATABASE: OnceLock<Mutex<Option<AppDatabase>>> = OnceLock::new();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum AppStorageError {
    #[error("application storage is unavailable: {0}")]
    Unavailable(String),
    #[error("application database schema is unsupported; data was preserved")]
    Incompatible,
    #[error("legacy application data must be imported before accessing storage")]
    MigrationRequired,
    #[error("invalid application storage entry: {0}")]
    InvalidEntry(String),
}

impl From<turso::Error> for AppStorageError {
    fn from(error: turso::Error) -> Self {
        Self::Unavailable(error.to_string())
    }
}

/// None means absent when reading, and deletion when writing. The entire batch
/// is one transaction; errors never acknowledge a partially applied batch.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct AppStorageEntry {
    pub key: String,
    pub value: Option<String>,
}

type Job = Box<dyn FnOnce(&mut Worker) + Send>;

#[derive(Clone)]
struct AppDatabase {
    sender: mpsc::Sender<Job>,
}

impl AppDatabase {
    fn open(path: PathBuf) -> Result<Self, AppStorageError> {
        let runtime = crate::runtime().map_err(AppStorageError::Unavailable)?;
        let (sender, receiver) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("whip-app-data".into())
            .spawn(move || {
                let mut worker = Worker {
                    path,
                    runtime,
                    store: None,
                };
                while let Ok(job) = receiver.recv() {
                    job(&mut worker);
                }
                // Last sender drains admitted transactions before closing. FULL
                // WAL commits also survive process death without this shutdown.
            })
            .map_err(|error| AppStorageError::Unavailable(error.to_string()))?;
        Ok(Self { sender })
    }

    async fn request<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Store) -> Result<T, AppStorageError> + Send + 'static,
    ) -> Result<T, AppStorageError> {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send(Box::new(move |worker| {
                let result = worker.with_store(operation);
                let _ = sender.send(result);
            }))
            .map_err(|_| {
                AppStorageError::Unavailable("application storage worker stopped".into())
            })?;
        receiver.await.map_err(|_| {
            AppStorageError::Unavailable("application storage worker stopped".into())
        })?
    }
}

struct Worker {
    path: PathBuf,
    runtime: &'static tokio::runtime::Runtime,
    store: Option<Store>,
}

impl Worker {
    fn with_store<T>(
        &mut self,
        operation: impl FnOnce(&mut Store) -> Result<T, AppStorageError>,
    ) -> Result<T, AppStorageError> {
        if self.store.is_none() {
            self.store = Some(Store::open(&self.path, self.runtime)?);
        }
        operation(self.store.as_mut().ok_or_else(|| {
            AppStorageError::Unavailable("application storage did not open".into())
        })?)
    }
}

struct Store {
    connection: turso::Connection,
    _database: turso::Database,
    runtime: &'static tokio::runtime::Runtime,
}

impl Store {
    fn open(
        path: &Path,
        runtime: &'static tokio::runtime::Runtime,
    ) -> Result<Self, AppStorageError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| AppStorageError::Unavailable(error.to_string()))?;
        }
        runtime.block_on(async {
            let database = turso::Builder::new_local(&path.to_string_lossy())
                .build()
                .await?;
            let mut connection = database.connect()?;
            let version = {
                let mut rows = connection.query("PRAGMA user_version", ()).await?;
                rows.next()
                    .await?
                    .ok_or(AppStorageError::Incompatible)?
                    .get::<i64>(0)?
            };
            if version != 0 && version != SCHEMA_VERSION {
                return Err(AppStorageError::Incompatible);
            }
            if version == 0 {
                let mut rows = connection
                    .query(
                        "SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1",
                        (),
                    )
                    .await?;
                if rows.next().await?.is_some() {
                    return Err(AppStorageError::Incompatible);
                }
            } else {
                for (table, expected) in [
                    ("app_values", &["key", "value", "updated_at"][..]),
                    ("storage_migrations", &["id", "completed_at"][..]),
                ] {
                    let mut columns = connection
                        .query(format!("PRAGMA table_info({table})"), ())
                        .await?;
                    let mut names = Vec::new();
                    while let Some(row) = columns.next().await? {
                        names.push(row.get::<String>(1)?);
                    }
                    if names != expected {
                        return Err(AppStorageError::Incompatible);
                    }
                }
            }
            {
                let mut rows = connection.query("PRAGMA journal_mode = WAL", ()).await?;
                while rows.next().await?.is_some() {}
            }
            connection.execute("PRAGMA synchronous = FULL", ()).await?;
            let tx = connection.transaction().await?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS app_values (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS storage_migrations (
                id TEXT PRIMARY KEY NOT NULL,
                completed_at INTEGER NOT NULL
            );",
            )
            .await?;
            tx.execute(format!("PRAGMA user_version = {SCHEMA_VERSION}"), ())
                .await?;
            tx.commit().await?;
            Ok(Self {
                connection,
                _database: database,
                runtime,
            })
        })
    }

    fn migrated(&self) -> Result<bool, AppStorageError> {
        self.runtime.block_on(async {
            let mut rows = self
                .connection
                .query(
                    "SELECT id FROM storage_migrations WHERE id = ?1",
                    [LEGACY_IMPORT],
                )
                .await?;
            Ok(rows.next().await?.is_some())
        })
    }

    fn read(&self, keys: Vec<String>) -> Result<Vec<AppStorageEntry>, AppStorageError> {
        if !self.migrated()? {
            return Err(AppStorageError::MigrationRequired);
        }
        self.runtime.block_on(async {
            let mut entries = Vec::with_capacity(keys.len());
            for key in keys {
                let mut rows = self
                    .connection
                    .query(
                        "SELECT value FROM app_values WHERE key = ?1",
                        [key.as_str()],
                    )
                    .await?;
                let value = rows.next().await?.map(|row| row.get(0)).transpose()?;
                entries.push(AppStorageEntry { key, value });
            }
            Ok(entries)
        })
    }

    fn write(
        &mut self,
        entries: Vec<AppStorageEntry>,
        importing: bool,
    ) -> Result<(), AppStorageError> {
        // The receipt and every value commit together. A lost acknowledgement
        // can be retried after restart without overwriting edits or resurrecting
        // deleted values from the retained legacy source.
        if importing && self.migrated()? {
            return Ok(());
        }
        if !importing && !self.migrated()? {
            return Err(AppStorageError::MigrationRequired);
        }
        for entry in &entries {
            validate_entry(entry, importing)?;
        }
        self.runtime.block_on(async {
            let tx = self.connection.transaction().await?;
            for entry in entries {
                if let Some(value) = entry.value {
                    tx.execute("INSERT INTO app_values (key, value, updated_at) VALUES (?1, ?2, unixepoch())
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", (entry.key, value)).await?;
                } else {
                    tx.execute("DELETE FROM app_values WHERE key = ?1", [entry.key]).await?;
                }
            }
            if importing {
                tx.execute("INSERT INTO storage_migrations (id, completed_at) VALUES (?1, unixepoch())", [LEGACY_IMPORT]).await?;
            }
            tx.commit().await?;
            Ok(())
        })
    }
}

// Complete production inventory, including legacy formats used by direct
// upgrades. Unknown library keys stay in AsyncStorage; we never clear it.
fn legacy_app_key(key: &str) -> bool {
    const KEYS: &[&str] = &[
        "herdr.hosts.v2",
        "herdr.connection.v1",
        "herdr.known-hosts.v1",
        "herdr.device.preferences.v3",
        "herdr.device.preferences.v2",
        "herdr.device.preferences.v1",
        "herdr.live.hosts.v1",
        "herdr.terminal.history.v1",
        "herdr.api-socket-paths.v1",
        "herdr.global-ssh-keys.v1",
        "herdr.credential.backups.v1",
        "herdr.credentials.backup-migration",
        "whip.browser.tabs.v1",
        "whip.browser.library.v1",
        "whip.browser.search-history.v1",
        "whip.browser.preferences.v2",
        "whip.browser.user-agent.v1",
        "whip.remote-files.preferences.v1",
        "whip.remote-git-mode.v1",
        "whip.remote-git-tree.v1",
        "whip.git-review-context.v1",
        "whip.latency-diagnostics.v1",
        "whip.usage.expanded.v1",
        "whip.notifications.expanded.v1",
        "whip.security.expanded.v1",
        "whip.appearance.expanded.v1",
        "whip.herd.expanded.v1",
        "whip.reverse-control.expanded.v1",
        "whip.terminal.expanded.v1",
        "whip.developer.expanded.v1",
    ];
    const PREFIXES: &[&str] = &[
        "herdr.terminal.sessions.v1.",
        "herdr.terminal.font-sizes.v1.",
        "herdr.host.snapshot.v1.",
        "whip.terminal.composers.v1.",
        "whip.agent.preferences.v1.",
        "whip.remote-content-progress.v1:",
    ];
    KEYS.contains(&key) || PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}

fn validate_entry(entry: &AppStorageEntry, importing: bool) -> Result<(), AppStorageError> {
    if !legacy_app_key(&entry.key) || importing && entry.value.is_none() {
        return Err(AppStorageError::InvalidEntry(entry.key.clone()));
    }
    // These records have always stored metadata only. Fail closed on unexpected
    // plaintext without modifying either store; credentials remain in Keychain
    // and Android's encrypted backup envelope remains an opaque ciphertext map.
    if matches!(
        entry.key.as_str(),
        "herdr.hosts.v2" | "herdr.connection.v1" | "herdr.global-ssh-keys.v1"
    ) && let Some(value) = &entry.value
    {
        let value: serde_json::Value = serde_json::from_str(value)
            .map_err(|_| AppStorageError::InvalidEntry(entry.key.clone()))?;
        if contains_secret(&value) {
            return Err(AppStorageError::InvalidEntry(entry.key.clone()));
        }
    }
    Ok(())
}

fn contains_secret(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(fields) => fields.iter().any(|(name, value)| {
            matches!(
                name.as_str(),
                "secret" | "passphrase" | "password" | "privateKey"
            ) && value.as_str().is_some_and(|text| !text.is_empty())
                || contains_secret(value)
        }),
        serde_json::Value::Array(values) => values.iter().any(contains_secret),
        _ => false,
    }
}

fn database() -> Result<AppDatabase, AppStorageError> {
    DATABASE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .clone()
        .ok_or_else(|| {
            AppStorageError::Unavailable(
                "private application data directory is not configured".into(),
            )
        })
}

/// # Safety
/// Native bootstrap supplies a live NUL-terminated private, backed-up OS path.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_set_app_data_directory(directory: *const std::ffi::c_char) {
    if directory.is_null() {
        return;
    }
    // SAFETY: Native bootstrap owns this string until the call returns.
    let directory = unsafe { std::ffi::CStr::from_ptr(directory) };
    if let Ok(directory) = directory.to_str() {
        let mut database = DATABASE.get_or_init(|| Mutex::new(None)).lock();
        if database.is_none() {
            *database = AppDatabase::open(Path::new(directory).join("whip-app.db")).ok();
        }
    }
}

#[uniffi::export]
pub fn select_legacy_app_data_keys(keys: Vec<String>) -> Vec<String> {
    keys.into_iter().filter(|key| legacy_app_key(key)).collect()
}

#[uniffi::export]
pub async fn app_data_migration_complete() -> Result<bool, AppStorageError> {
    database()?.request(|store| store.migrated()).await
}

#[uniffi::export]
pub async fn import_legacy_app_data(entries: Vec<AppStorageEntry>) -> Result<(), AppStorageError> {
    database()?
        .request(move |store| store.write(entries, true))
        .await
}

#[uniffi::export]
pub async fn read_app_data(keys: Vec<String>) -> Result<Vec<AppStorageEntry>, AppStorageError> {
    database()?.request(move |store| store.read(keys)).await
}

#[uniffi::export]
pub async fn write_app_data(entries: Vec<AppStorageEntry>) -> Result<(), AppStorageError> {
    database()?
        .request(move |store| store.write(entries, false))
        .await
}

#[cfg(test)]
mod tests;
