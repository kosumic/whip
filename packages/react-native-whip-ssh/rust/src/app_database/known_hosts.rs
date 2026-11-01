//! Durable SSH trust operations share the application database's native FIFO.
//! No foreign storage callback can acknowledge or publish a prepared trust list.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, OnceLock, Weak};

use parking_lot::Mutex;
use tokio::sync::oneshot;

use super::{AppDatabase, AppStorageEntry, Store, database};
use crate::ssh::known_hosts::{HostKeyChallenge, KnownHostRecord, KnownHostStore};

pub const KNOWN_HOSTS_STORAGE_KEY: &str = "herdr.known-hosts.v1";
const PENDING: u8 = 0;
const CANCELLED: u8 = 1;
const COMMITTING: u8 = 2;
const FINISHED: u8 = 3;
static CORE: OnceLock<Arc<Core>> = OnceLock::new();
static OWNERS: OnceLock<Mutex<Vec<Weak<KnownHostRepository>>>> = OnceLock::new();

type Result<T> = std::result::Result<T, KnownHostRepositoryError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum KnownHostRepositoryStatus {
    Loading,
    Loaded,
    ReadFailed,
    InvalidData,
}

/// Errors deliberately exclude foreign exception text and host-key material.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum KnownHostRepositoryError {
    #[error("known SSH hosts must be loaded successfully before they can be changed")]
    NotLoaded,
    #[error("known-host operation was cancelled or belongs to an older owner")]
    Cancelled,
    #[error("known SSH hosts could not be read; existing trust was preserved")]
    StorageRead,
    #[error("known SSH hosts could not be saved; existing trust was preserved")]
    StorageWrite,
    #[error("persisted known-host data is malformed; existing trust was preserved")]
    InvalidData,
    #[error("the SSH host-key trust record is invalid")]
    InvalidKey,
    #[error("known-host operation result was already consumed")]
    ResultConsumed,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct KnownHostRepositoryView {
    pub status: KnownHostRepositoryStatus,
    pub revision: u64,
    pub generation: u64,
    pub hosts: Vec<KnownHostRecord>,
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum KnownHostCommand {
    Load,
    Trust { challenge: HostKeyChallenge },
    Revoke { id: String },
}

struct State {
    owner: u64,
    generation: u64,
    revision: u64,
    status: KnownHostRepositoryStatus,
}

struct Core {
    state: Mutex<State>,
    store: Arc<KnownHostStore>,
}

impl Default for Core {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                owner: 0,
                generation: 0,
                revision: 0,
                status: KnownHostRepositoryStatus::Loading,
            }),
            store: KnownHostStore::new(),
        }
    }
}

impl Core {
    fn view(&self, state: &State) -> Result<KnownHostRepositoryView> {
        Ok(KnownHostRepositoryView {
            status: state.status,
            revision: state.revision,
            generation: state.generation,
            hosts: self
                .store
                .view()
                .map_err(|_| KnownHostRepositoryError::InvalidData)?
                .hosts,
        })
    }
}

#[derive(uniffi::Object)]
pub struct KnownHostRepository {
    core: Arc<Core>,
    owner: u64,
    closed: AtomicBool,
    // Production resolves the process-owned database on each admission so a
    // failed bootstrap can be retried. Tests use an isolated real database.
    database: Option<AppDatabase>,
}

#[uniffi::export]
impl KnownHostRepository {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        let repository = Self::attach(CORE.get_or_init(|| Arc::new(Core::default())).clone(), None);
        let mut owners = OWNERS.get_or_init(Mutex::default).lock();
        owners.retain(|owner| owner.strong_count() > 0);
        owners.push(Arc::downgrade(&repository));
        drop(owners);
        repository
    }

    /// Reserve native FIFO order before UniFFI async polling can reorder calls.
    pub fn begin(self: &Arc<Self>, command: KnownHostCommand) -> Arc<KnownHostOperation> {
        self.begin_with_fence(command, None)
    }

    pub fn view(&self) -> Result<KnownHostRepositoryView> {
        let state = self.core.state.lock();
        self.check_owner(&state)?;
        self.core.view(&state)
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let mut state = self.core.state.lock();
        if state.owner == self.owner {
            state.generation = state.generation.saturating_add(1);
            state.revision = state.revision.saturating_add(1);
            state.status = KnownHostRepositoryStatus::Loading;
        }
    }
}

impl KnownHostRepository {
    fn attach(core: Arc<Core>, database: Option<AppDatabase>) -> Arc<Self> {
        let mut state = core.state.lock();
        state.owner = state.owner.saturating_add(1);
        state.generation = state.generation.saturating_add(1);
        state.revision = state.revision.saturating_add(1);
        state.status = KnownHostRepositoryStatus::Loading;
        let owner = state.owner;
        drop(state);
        Arc::new(Self {
            core,
            owner,
            closed: AtomicBool::new(false),
            database,
        })
    }

    fn check_owner(&self, state: &State) -> Result<()> {
        if self.closed.load(Ordering::Acquire) || state.owner != self.owner {
            Err(KnownHostRepositoryError::Cancelled)
        } else {
            Ok(())
        }
    }
}

pub(crate) fn detach() {
    if let Some(owners) = OWNERS.get() {
        for owner in owners.lock().iter().filter_map(Weak::upgrade) {
            owner.close();
        }
    }
}

struct WorkflowTrustFence {
    revision: u64,
    generation: u64,
    control: Arc<crate::ssh_workflows::Control>,
}
struct Request {
    fence: Option<WorkflowTrustFence>,
    repository: Arc<KnownHostRepository>,
    generation: u64,
    phase: AtomicU8,
}

impl Request {
    fn check_locked(&self, state: &State) -> Result<()> {
        self.repository.check_owner(state)?;
        if self.fence.as_ref().is_some_and(|fence| {
            state.revision != fence.revision
                || state.generation != fence.generation
                || fence.control.check().is_err()
        }) {
            return Err(KnownHostRepositoryError::Cancelled);
        }
        if state.generation != self.generation || self.phase.load(Ordering::Acquire) == CANCELLED {
            return Err(KnownHostRepositoryError::Cancelled);
        }
        Ok(())
    }

    fn check(&self) -> Result<()> {
        self.check_locked(&self.repository.core.state.lock())
    }

    fn cancel(&self) -> bool {
        self.phase
            .compare_exchange(PENDING, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn seal(&self, state: &State, phase: u8) -> Result<()> {
        self.check_locked(state)?;
        self.phase
            .compare_exchange(PENDING, phase, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| KnownHostRepositoryError::Cancelled)
    }

    fn fail_load(&self, error: KnownHostRepositoryError) -> Result<KnownHostRepositoryView> {
        let mut state = self.repository.core.state.lock();
        self.seal(&state, FINISHED)?;
        state.status = if error == KnownHostRepositoryError::InvalidData {
            KnownHostRepositoryStatus::InvalidData
        } else {
            KnownHostRepositoryStatus::ReadFailed
        };
        state.revision = state.revision.saturating_add(1);
        drop(state);
        Err(error)
    }

    fn run(
        &self,
        database: &mut Store,
        command: KnownHostCommand,
    ) -> Result<KnownHostRepositoryView> {
        if matches!(command, KnownHostCommand::Load) {
            let persisted = match database.read(vec![KNOWN_HOSTS_STORAGE_KEY.into()]) {
                Ok(mut entries) if entries.len() == 1 => entries.remove(0).value,
                _ => return self.fail_load(KnownHostRepositoryError::StorageRead),
            };
            let mut state = self.repository.core.state.lock();
            self.seal(&state, FINISHED)?;
            if self.repository.core.store.hydrate(persisted).is_err() {
                state.status = KnownHostRepositoryStatus::InvalidData;
                state.revision = state.revision.saturating_add(1);
                drop(state);
                return Err(KnownHostRepositoryError::InvalidData);
            }
            state.status = KnownHostRepositoryStatus::Loaded;
            state.revision = state.revision.saturating_add(1);
            let view = self.repository.core.view(&state);
            drop(state);
            return view;
        }

        let state = self.repository.core.state.lock();
        self.check_locked(&state)?;
        if state.status != KnownHostRepositoryStatus::Loaded {
            return Err(KnownHostRepositoryError::NotLoaded);
        }
        let store = &self.repository.core.store;
        let mutation = match command {
            KnownHostCommand::Trust { challenge } => store.prepare_add(
                challenge,
                format!("known-host-{}", uuid::Uuid::new_v4()),
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            ),
            KnownHostCommand::Revoke { id } => store.prepare_remove(id),
            KnownHostCommand::Load => unreachable!("loads return before mutation preparation"),
        }
        .map_err(|_| KnownHostRepositoryError::InvalidKey)?;
        if !mutation.changed {
            self.seal(&state, FINISHED)?;
            return self.repository.core.view(&state);
        }
        if let Err(error) = self.seal(&state, COMMITTING) {
            let _ = store.rollback(mutation.token);
            return Err(error);
        }
        drop(state);
        // This is the cancellation boundary: an admitted native database commit
        // runs to completion. cancel() returns false once COMMITTING is sealed.
        if database
            .write(
                vec![AppStorageEntry {
                    key: KNOWN_HOSTS_STORAGE_KEY.into(),
                    value: Some(mutation.view.persisted_value),
                }],
                false,
            )
            .is_err()
        {
            let _ = store.rollback(mutation.token);
            return Err(KnownHostRepositoryError::StorageWrite);
        }
        let committed = store.commit(mutation.token);
        let mut state = self.repository.core.state.lock();
        state.revision = state.revision.saturating_add(1);
        if committed.is_err() {
            state.status = KnownHostRepositoryStatus::InvalidData;
            drop(state);
            return Err(KnownHostRepositoryError::InvalidData);
        }
        // A newer owner's load remains Loading until its own queued read. The
        // completed durable write cannot publish the old owner's Loaded state.
        self.repository.core.view(&state)
    }
}

#[derive(uniffi::Object)]
pub struct KnownHostOperation {
    request: Arc<Request>,
    response: Mutex<Option<oneshot::Receiver<Result<KnownHostRepositoryView>>>>,
    unavailable: KnownHostRepositoryError,
}

struct CallerGuard<'a> {
    request: &'a Request,
    settled: bool,
}

impl Drop for CallerGuard<'_> {
    fn drop(&mut self) {
        if !self.settled {
            self.request.cancel();
        }
    }
}

impl Drop for KnownHostOperation {
    fn drop(&mut self) {
        self.request.cancel();
    }
}

#[uniffi::export]
impl KnownHostOperation {
    /// False means the operation has settled or crossed its durable commit point.
    pub fn cancel(&self) -> bool {
        self.request.cancel()
    }

    pub async fn result(&self) -> Result<KnownHostRepositoryView> {
        let receiver = self
            .response
            .lock()
            .take()
            .ok_or(KnownHostRepositoryError::ResultConsumed)?;
        let mut guard = CallerGuard {
            request: &self.request,
            settled: false,
        };
        let result = receiver.await.map_err(|_| self.unavailable.clone())?;
        guard.settled = true;
        result
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
impl KnownHostRepository {
    pub(crate) fn workflow_test_repository(path: std::path::PathBuf) -> Arc<Self> {
        let database = AppDatabase::open(path).unwrap();
        crate::runtime()
            .unwrap()
            .block_on(database.request(|store| store.write(vec![], true)))
            .unwrap();
        Self::attach(Arc::new(Core::default()), Some(database))
    }
}

impl KnownHostRepository {
    pub(crate) fn begin_workflow_trust(
        self: &Arc<Self>,
        challenge: HostKeyChallenge,
        expected: &KnownHostRepositoryView,
        control: Arc<crate::ssh_workflows::Control>,
    ) -> Arc<KnownHostOperation> {
        self.begin_with_fence(
            KnownHostCommand::Trust { challenge },
            Some(WorkflowTrustFence {
                revision: expected.revision,
                generation: expected.generation,
                control,
            }),
        )
    }
    fn begin_with_fence(
        self: &Arc<Self>,
        command: KnownHostCommand,
        fence: Option<WorkflowTrustFence>,
    ) -> Arc<KnownHostOperation> {
        let (sender, receiver) = oneshot::channel();
        let mut state = self.core.state.lock();
        let loading = matches!(command, KnownHostCommand::Load);
        let admitted = self.check_owner(&state).and_then(|()| {
            if loading {
                state.generation = state.generation.saturating_add(1);
                state.revision = state.revision.saturating_add(1);
                state.status = KnownHostRepositoryStatus::Loading;
                Ok(())
            } else if state.status == KnownHostRepositoryStatus::Loaded {
                Ok(())
            } else {
                Err(KnownHostRepositoryError::NotLoaded)
            }
        });
        let request = Arc::new(Request {
            repository: self.clone(),
            fence,
            generation: state.generation,
            phase: AtomicU8::new(PENDING),
        });
        let operation = Arc::new(KnownHostOperation {
            request: request.clone(),
            response: Mutex::new(Some(receiver)),
            unavailable: if loading {
                KnownHostRepositoryError::StorageRead
            } else {
                KnownHostRepositoryError::StorageWrite
            },
        });
        if let Err(error) = admitted {
            request.phase.store(FINISHED, Ordering::Release);
            let _ = sender.send(Err(error));
            return operation;
        }
        // Hold only the admission lock while sending. Disk I/O runs exclusively
        // on the database worker and never holds this UI-facing state mutex.
        let db = self.database.clone().map_or_else(database, Ok);
        let submitted = db.and_then(|db| {
            db.sender
                .send(Box::new(move |worker| {
                    let result = request.check().and_then(|()| match worker.store() {
                        Ok(store) => request.run(store, command),
                        Err(_) if loading => {
                            request.fail_load(KnownHostRepositoryError::StorageRead)
                        }
                        Err(_) => Err(KnownHostRepositoryError::StorageWrite),
                    });
                    request.phase.store(FINISHED, Ordering::Release);
                    let _ = sender.send(result);
                }))
                .map_err(|_| {
                    super::AppStorageError::Unavailable("application storage worker stopped".into())
                })
        });
        drop(state);
        if submitted.is_err() {
            // Dropping the unsent job closes the channel. result() translates
            // that failure, and loading remains closed to new trust mutations.
            let mut state = self.core.state.lock();
            if self.check_owner(&state).is_ok() && state.generation == operation.request.generation
            {
                if loading {
                    state.status = KnownHostRepositoryStatus::ReadFailed;
                    state.revision = state.revision.saturating_add(1);
                }
                drop(state);
                operation.request.phase.store(FINISHED, Ordering::Release);
            }
        }
        operation
    }
}
