//! Application SSH mutations. Platform effects cannot choose targets or retries.
mod runner;
#[cfg(test)]
mod tests;
use crate::{
    CredentialCoordinator, HostProfileRecord, HostRuntimeError, KnownHostRepository, PairHostError,
    PublicKeyInstallOutcome,
};
use crate::{pairing::PairHostResult, ssh::HostKeyChallenge};
use parking_lot::Mutex;
use std::{
    sync::{
        Arc, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
type Result<T> = std::result::Result<T, SshWorkflowError>;
const WORKFLOW_TIMEOUT: Duration = Duration::from_mins(12);
const EFFECT_TIMEOUT: Duration = Duration::from_mins(2);
#[derive(Default)]
pub(crate) struct Security {
    epoch: u64,
    writers: usize,
    locked: bool,
    biometric: bool,
    admission: Arc<tokio::sync::Mutex<()>>,
}
static SECURITY: OnceLock<Arc<Mutex<Security>>> = OnceLock::new();
pub(crate) fn security() -> &'static Arc<Mutex<Security>> {
    SECURITY.get_or_init(|| Arc::new(Mutex::new(Security::default())))
}
/// Fence credential edits before queued platform I/O, through cleanup.
pub(crate) struct CredentialMutation(Arc<Mutex<Security>>);
impl CredentialMutation {
    pub(crate) fn begin_for(security: Arc<Mutex<Security>>) -> Self {
        {
            let mut s = security.lock();
            s.epoch = s.epoch.wrapping_add(1);
            s.writers += 1;
        }
        Self(security)
    }
}
impl Drop for CredentialMutation {
    fn drop(&mut self) {
        let mut s = self.0.lock();
        s.epoch = s.epoch.wrapping_add(1);
        s.writers -= 1;
    }
}
#[uniffi::export]
pub fn set_ssh_workflow_locked(locked: bool) {
    set_locked_for(security(), locked);
}
fn set_locked_for(security: &Arc<Mutex<Security>>, locked: bool) {
    let mut s = security.lock();
    if s.locked != locked {
        s.locked = locked;
        s.epoch = s.epoch.wrapping_add(1);
    }
}
pub(crate) fn set_biometric(enabled: bool) {
    let mut s = security().lock();
    if s.biometric != enabled {
        s.biometric = enabled;
        s.epoch = s.epoch.wrapping_add(1);
    }
}
pub(crate) fn detach() {
    let mut s = security().lock();
    s.epoch = s.epoch.wrapping_add(1);
}
pub(crate) struct Control {
    credentials: Weak<CredentialCoordinator>,
    security: Arc<Mutex<Security>>,
    id: String,
    epoch: u64,
    cancelled: AtomicBool,
    finished: AtomicBool,
    mutation_started: AtomicBool,
}
impl Control {
    fn check_locked(&self, s: &Security) -> Result<()> {
        if self
            .credentials
            .upgrade()
            .is_none_or(|credentials| !credentials.is_active())
            || self.cancelled.load(Ordering::Acquire)
            || self.finished.load(Ordering::Acquire)
            || s.locked
            || s.writers != 0
            || s.epoch != self.epoch
        {
            Err(SshWorkflowError::Cancelled)
        } else {
            Ok(())
        }
    }
    pub(crate) fn check(&self) -> Result<()> {
        self.check_locked(&self.security.lock())
    }
    /// Dispatch and revocation share a lock. Lost acknowledgements after this
    /// boundary are indeterminate and never enter the trust retry loop.
    pub(crate) fn admit_mutation(&self) -> Result<()> {
        let s = self.security.lock();
        self.check_locked(&s)?;
        self.mutation_started.store(true, Ordering::Release);
        Ok(())
    }
}
#[derive(Clone, uniffi::Enum)]
#[allow(
    clippy::large_enum_variant,
    reason = "UniFFI records cannot be boxed across the generated mobile boundary"
)]
pub enum SshWorkflowRequest {
    Pair {
        code: String,
        public_key: String,
        device_name: String,
        jump_host_id: Option<String>,
    },
    Install {
        host: HostProfileRecord,
        public_key: String,
        connected: bool,
    },
}
#[derive(Clone, Debug, uniffi::Enum)]
#[allow(
    clippy::large_enum_variant,
    reason = "UniFFI records cannot be boxed across the generated mobile boundary"
)]
pub enum SshWorkflowResult {
    Paired { result: PairHostResult },
    Installed { outcome: PublicKeyInstallOutcome },
    Cancelled,
}
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum SshWorkflowError {
    #[error("SSH operation was cancelled or its host/credential identity changed")]
    Cancelled,
    #[error("Connect to this host before installing a public key")]
    NeverConnected,
    #[error("The SSH route or saved credential is unavailable; reload the host")]
    InvalidRoute,
    #[error("A saved SSH credential is required for every host in the route")]
    MissingCredential,
    #[error("SSH host-key approval did not match the exact host, port, and key")]
    InvalidChallenge,
    #[error("Known SSH hosts must be loaded and persisted before retrying")]
    TrustUnavailable,
    #[error("SSH platform prompt failed")]
    Platform,
    #[error("SSH operation timed out")]
    Timeout,
    #[error(
        "The remote change may have completed (operation {operation_id}). Check the host before trying again."
    )]
    OutcomeUnknown { operation_id: String },
    #[error("{0}")]
    Pairing(PairHostError),
    #[error("{0}")]
    Installation(HostRuntimeError),
    #[error("SSH operation result was already consumed")]
    ResultConsumed,
}
#[derive(Clone, Copy, Debug, thiserror::Error, uniffi::Error)]
pub enum SshWorkflowPlatformError {
    #[error("SSH prompt cancelled")]
    Cancelled,
    #[error("SSH prompt unavailable")]
    Unavailable,
}
#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait SshWorkflowPlatform: Send + Sync {
    async fn authenticate_private_key(
        &self,
        permit: Arc<SshWorkflowPermit>,
    ) -> std::result::Result<bool, SshWorkflowPlatformError>;
    async fn confirm_host_key(
        &self,
        permit: Arc<SshWorkflowPermit>,
        challenge: HostKeyChallenge,
    ) -> std::result::Result<bool, SshWorkflowPlatformError>;
    /// Post-commit UI refresh; cannot acknowledge native trust.
    async fn host_key_trusted(
        &self,
        permit: Arc<SshWorkflowPermit>,
        challenge: HostKeyChallenge,
    ) -> std::result::Result<(), SshWorkflowPlatformError>;
}
#[derive(uniffi::Object)]
pub struct SshWorkflowPermit {
    control: Weak<Control>,
    active: AtomicBool,
}
#[uniffi::export]
impl SshWorkflowPermit {
    pub fn check_active(&self) -> Result<()> {
        if !self.active.load(Ordering::Acquire) {
            return Err(SshWorkflowError::Cancelled);
        }
        self.control
            .upgrade()
            .ok_or(SshWorkflowError::Cancelled)?
            .check()
    }
}
struct EffectGuard(Arc<SshWorkflowPermit>);
impl Drop for EffectGuard {
    fn drop(&mut self) {
        self.0.active.store(false, Ordering::Release);
    }
}
struct RunGuard(Arc<Control>);
impl Drop for RunGuard {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}
#[derive(uniffi::Object)]
pub struct SshWorkflow {
    control: Arc<Control>,
    request: SshWorkflowRequest,
    hosts: Vec<HostProfileRecord>,
    biometric: bool,
    credentials: Arc<CredentialCoordinator>,
    known_hosts: Arc<KnownHostRepository>,
    platform: Arc<dyn SshWorkflowPlatform>,
    started: AtomicBool,
}
#[uniffi::export]
impl SshWorkflow {
    #[uniffi::constructor]
    pub fn new(
        request: SshWorkflowRequest,
        hosts: Vec<HostProfileRecord>,
        biometric: bool,
        credentials: Arc<CredentialCoordinator>,
        known_hosts: Arc<KnownHostRepository>,
        platform: Arc<dyn SshWorkflowPlatform>,
    ) -> Arc<Self> {
        let security = credentials.workflow_security.clone();
        let epoch = security.lock().epoch;
        Arc::new(Self {
            control: Arc::new(Control {
                credentials: Arc::downgrade(&credentials),
                security,
                id: uuid::Uuid::new_v4().to_string(),
                epoch,
                cancelled: AtomicBool::new(false),
                finished: AtomicBool::new(false),
                mutation_started: AtomicBool::new(false),
            }),
            request,
            hosts,
            biometric,
            credentials,
            known_hosts,
            platform,
            started: AtomicBool::new(false),
        })
    }
    pub fn cancel(&self) {
        self.control.cancelled.store(true, Ordering::Release);
    }
    pub async fn run(self: Arc<Self>) -> Result<SshWorkflowResult> {
        if self.started.swap(true, Ordering::AcqRel) {
            return Err(SshWorkflowError::ResultConsumed);
        }
        let _guard = RunGuard(self.control.clone());
        let owner = self.clone();
        crate::runtime()
            .map_err(|_| SshWorkflowError::Platform)?
            .spawn(async move {
                let result = owner.execute().await;
                owner.control.finished.store(true, Ordering::Release);
                result
            })
            .await
            .map_err(|_| SshWorkflowError::Platform)?
    }
}
