//! Application credential transactions. Durable metadata never contains secrets.
mod global_keys;
mod journal;
mod profiles;
mod storage;
mod types;
mod vault;

pub use types::*;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};

use parking_lot::Mutex;
use tokio::sync::{Notify, oneshot};

use crate::{HostActionPermit, HostProfileStore};
use journal::Journal;

type Result<T> = std::result::Result<T, CredentialTransactionError>;
static QUEUE: OnceLock<Queue> = OnceLock::new();
static COORDINATORS: OnceLock<Mutex<Vec<Weak<CredentialCoordinator>>>> = OnceLock::new();

#[derive(Default)]
struct Queue {
    entries: Mutex<VecDeque<String>>,
    changed: Notify,
}
fn queue() -> &'static Queue {
    QUEUE.get_or_init(Queue::default)
}

struct QueueGuard(String);
impl Drop for QueueGuard {
    fn drop(&mut self) {
        queue().entries.lock().retain(|id| id != &self.0);
        queue().changed.notify_waiters();
    }
}

struct ProfileState {
    store: Arc<HostProfileStore>,
    loaded: bool,
    revision: u64,
    repairs: Vec<String>,
}

#[derive(uniffi::Object)]
pub struct CredentialCoordinator {
    pub(crate) workflow_security: Arc<Mutex<crate::ssh_workflows::Security>>,
    platform: Arc<dyn CredentialPlatform>,
    state: Mutex<ProfileState>,
    closed: AtomicBool,
}

#[uniffi::export]
impl CredentialCoordinator {
    #[uniffi::constructor]
    pub fn new(platform: Arc<dyn CredentialPlatform>) -> Arc<Self> {
        Self::with_workflow_security(platform, crate::ssh_workflows::security().clone())
    }

    /// Reserve FIFO position synchronously, before foreign async work can yield.
    pub fn begin(
        self: &Arc<Self>,
        command: CredentialCommand,
        guard: Option<Arc<HostActionPermit>>,
    ) -> Arc<CredentialOperation> {
        self.begin_guarded(command, guard, None)
    }
}
impl CredentialCoordinator {
    pub(crate) fn begin_workflow(
        self: &Arc<Self>,
        command: CredentialCommand,
        control: Arc<crate::ssh_workflows::Control>,
    ) -> Arc<CredentialOperation> {
        self.begin_guarded(command, None, Some(control))
    }
    fn begin_guarded(
        self: &Arc<Self>,
        command: CredentialCommand,
        guard: Option<Arc<HostActionPermit>>,
        workflow_guard: Option<Arc<crate::ssh_workflows::Control>>,
    ) -> Arc<CredentialOperation> {
        let invalidates_identity = workflow_guard.is_none()
            && matches!(&command, CredentialCommand::EnsureIdentity { .. });
        let mutation = (invalidates_identity
            || matches!(
                &command,
                CredentialCommand::SaveHost { .. }
                    | CredentialCommand::SaveMetadata { .. }
                    | CredentialCommand::DeleteHost { .. }
                    | CredentialCommand::RestoreBackups { .. }
                    | CredentialCommand::RecoverHost { .. }
                    | CredentialCommand::SaveGlobalKey { .. }
                    | CredentialCommand::DeleteGlobalKey { .. }
            ))
        .then(|| {
            crate::ssh_workflows::CredentialMutation::begin_for(self.workflow_security.clone())
        });
        let inner = Arc::new(Operation {
            id: uuid::Uuid::new_v4().to_string(),
            coordinator: self.clone(),
            cancelled: AtomicBool::new(false),
            guard,
            workflow_guard,
        });
        let (send, receive) = oneshot::channel();
        queue().entries.lock().push_back(inner.id.clone());
        let operation = Arc::new(CredentialOperation {
            inner: inner.clone(),
            response: Mutex::new(Some(receive)),
        });
        match crate::runtime() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    // The worker owns the queue position until every started
                    // storage callback settles, even if the caller disappears.
                    let _mutation = mutation;
                    let _queue = QueueGuard(inner.id.clone());
                    let result = async {
                        inner.wait_turn().await?;
                        let mut workflow = Workflow {
                            operation: inner,
                            journal: Journal::default(),
                        };
                        workflow.journal = workflow.load_journal().await?;
                        let result = workflow.run(command).await;
                        result.and_then(|value| {
                            workflow.operation.check()?;
                            Ok(value)
                        })
                    }
                    .await;
                    let _ = send.send(result);
                });
            }
            Err(_) => {
                drop(QueueGuard(inner.id.clone()));
                let _ = send.send(Err(CredentialTransactionError::SecureStorage));
            }
        }
        operation
    }
}
#[uniffi::export]
impl CredentialCoordinator {
    pub fn view(&self) -> CredentialProfileView {
        let state = self.state.lock();
        CredentialProfileView {
            loaded: state.loaded,
            revision: state.revision,
            hosts: state
                .store
                .view()
                .map(|view| view.hosts)
                .unwrap_or_default(),
            repair_host_ids: state.repairs.clone(),
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        queue().changed.notify_waiters();
    }
}

pub(crate) fn detach() {
    if let Some(owners) = COORDINATORS.get() {
        for owner in owners.lock().iter().filter_map(Weak::upgrade) {
            owner.close();
        }
    }
}

impl CredentialCoordinator {
    pub(crate) fn is_active(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
    }
}

struct Operation {
    id: String,
    coordinator: Arc<CredentialCoordinator>,
    cancelled: AtomicBool,
    guard: Option<Arc<HostActionPermit>>,
    workflow_guard: Option<Arc<crate::ssh_workflows::Control>>,
}

impl Operation {
    fn check(&self) -> Result<()> {
        if self
            .workflow_guard
            .as_ref()
            .is_some_and(|guard| guard.check().is_err())
            || self.cancelled.load(Ordering::Acquire)
            || self.coordinator.closed.load(Ordering::Acquire)
            || self
                .guard
                .as_ref()
                .is_some_and(|guard| guard.check_active().is_err())
        {
            return Err(CredentialTransactionError::Cancelled);
        }
        Ok(())
    }
    async fn wait_turn(&self) -> Result<()> {
        loop {
            let changed = queue().changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            self.check()?;
            if queue().entries.lock().front() == Some(&self.id) {
                return Ok(());
            }
            changed.await;
        }
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        queue().changed.notify_waiters();
    }
}

#[derive(uniffi::Object)]
pub struct CredentialOperation {
    inner: Arc<Operation>,
    response: Mutex<Option<oneshot::Receiver<Result<CredentialResult>>>>,
}

struct CallerGuard {
    operation: Arc<Operation>,
    settled: bool,
}
impl Drop for CallerGuard {
    fn drop(&mut self) {
        if !self.settled {
            self.operation.cancel();
        }
    }
}

#[uniffi::export]
impl CredentialOperation {
    pub fn cancel(&self) {
        self.inner.cancel();
    }
    pub async fn result(&self) -> Result<CredentialResult> {
        let mut guard = CallerGuard {
            operation: self.inner.clone(),
            settled: false,
        };
        let receive = self
            .response
            .lock()
            .take()
            .ok_or(CredentialTransactionError::Cancelled)?;
        let result = receive
            .await
            .map_err(|_| CredentialTransactionError::Cancelled)?;
        guard.settled = true;
        result
    }
}
impl Drop for CredentialOperation {
    fn drop(&mut self) {
        self.inner.cancel();
    }
}

#[derive(uniffi::Object)]
pub struct CredentialEffectPermit {
    operation: Weak<Operation>,
    active: AtomicBool,
    cleanup: bool,
}

#[uniffi::export]
impl CredentialEffectPermit {
    pub fn check_active(&self) -> Result<()> {
        if !self.active.load(Ordering::Acquire) {
            return Err(CredentialTransactionError::Cancelled);
        }
        let operation = self
            .operation
            .upgrade()
            .ok_or(CredentialTransactionError::Cancelled)?;
        if self.cleanup {
            Ok(())
        } else {
            operation.check()
        }
    }
}

struct EffectGuard(Arc<CredentialEffectPermit>);
impl Drop for EffectGuard {
    fn drop(&mut self) {
        self.0.active.store(false, Ordering::Release);
    }
}

struct Workflow {
    operation: Arc<Operation>,
    journal: Journal,
}

impl Workflow {
    async fn run(&mut self, command: CredentialCommand) -> Result<CredentialResult> {
        self.operation.check()?;
        if let Some(guard) = &self.operation.guard {
            guard
                .check_repository_profiles(&self.canonical_hosts().await?)
                .map_err(|_| CredentialTransactionError::Cancelled)?;
        }
        match command {
            CredentialCommand::LoadHosts {
                from_storage,
                hosts,
                legacy,
            } => self.load_hosts(from_storage, hosts, legacy).await,
            CredentialCommand::SaveHost {
                profile,
                credential,
            } => self.save_host(profile, credential).await,
            CredentialCommand::SaveMetadata { id, patch, source } => {
                self.save_metadata(id, patch, source).await
            }
            CredentialCommand::DeleteHost { id } => self.delete_host(id).await,
            CredentialCommand::MarkDisconnected { id } => self.mark_disconnected(id).await,
            CredentialCommand::ReadHost { host, strict } => self
                .read_bound_host(&host, strict)
                .await
                .map(|credential| CredentialResult::Material { credential }),
            CredentialCommand::EnsureIdentity { host, credential } => {
                self.ensure_identity(host, credential).await
            }
            CredentialCommand::Backup {
                id,
                credential,
                only_missing,
            } => self
                .backup(&id, &credential, only_missing)
                .await
                .map(|value| CredentialResult::Boolean { value }),
            CredentialCommand::HasBackup { id } => {
                self.backups()
                    .await
                    .map(|backups| CredentialResult::Boolean {
                        value: backups.contains_key(&id),
                    })
            }
            CredentialCommand::RemoveBackup { id } => {
                self.remove_backup(&id).await?;
                Ok(CredentialResult::Done)
            }
            CredentialCommand::RecoveryStatus => self.recovery_status().await,
            CredentialCommand::RestoreBackups { host_ids } => self.restore_backups(host_ids).await,
            CredentialCommand::RecoverHost { host } => self
                .recover_host(&host)
                .await
                .map(|credential| CredentialResult::Recovered { credential }),
            CredentialCommand::MigrateBackups => {
                self.migrate_backups().await?;
                Ok(CredentialResult::Done)
            }
            CredentialCommand::LoadGlobalKeys => self
                .global_metadata()
                .await
                .map(|keys| CredentialResult::GlobalKeys { keys }),
            CredentialCommand::UnlockGlobalKeys => {
                self.authenticate_global().await?;
                self.global_materials()
                    .await
                    .map(|keys| CredentialResult::GlobalMaterials { keys })
            }
            CredentialCommand::SaveGlobalKey { input } => self.save_global(input).await,
            CredentialCommand::DeleteGlobalKey { id } => self.delete_global(&id).await,
        }
    }

    fn diagnostic(&self, event: &str, id: Option<&str>) {
        self.operation
            .coordinator
            .platform
            .diagnostic(event.into(), id.map(str::to_owned));
    }
}

#[cfg(test)]
mod tests;

impl CredentialCoordinator {
    pub(crate) fn with_workflow_security(
        platform: Arc<dyn CredentialPlatform>,
        workflow_security: Arc<Mutex<crate::ssh_workflows::Security>>,
    ) -> Arc<Self> {
        let coordinator = Arc::new(Self {
            workflow_security,
            platform,
            state: Mutex::new(ProfileState {
                store: HostProfileStore::new(),
                loaded: false,
                revision: 0,
                repairs: vec![],
            }),
            closed: AtomicBool::new(false),
        });
        if Arc::ptr_eq(
            &coordinator.workflow_security,
            crate::ssh_workflows::security(),
        ) {
            let mut owners = COORDINATORS.get_or_init(Mutex::default).lock();
            owners.retain(|owner| owner.strong_count() > 0);
            owners.push(Arc::downgrade(&coordinator));
        }
        coordinator
    }
}
