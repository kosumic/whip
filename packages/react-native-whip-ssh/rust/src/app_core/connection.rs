//! Application connection transactions, layered over HostRuntime's SSH state machine.
mod types;
pub use types::*;

use super::{AppCore, SessionConnectionAttempt};
use crate::{
    CredentialCommand, CredentialCoordinator, CredentialResult, HostAuthMode, HostProfileRecord,
    HostProfileStore, HostRuntime,
};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Arc, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::Instant,
};
use tokio::sync::{Semaphore, oneshot};

type EffectResult<T> = Result<T, SessionConnectionPlatformError>;
static LANES: OnceLock<Mutex<HashMap<String, Weak<Semaphore>>>> = OnceLock::new();

fn lane(id: &str) -> Arc<Semaphore> {
    let mut lanes = LANES.get_or_init(Mutex::default).lock();
    lanes.retain(|_, lane| lane.strong_count() > 0);
    let result = lanes
        .get(id)
        .and_then(Weak::upgrade)
        .unwrap_or_else(|| Arc::new(Semaphore::new(1)));
    lanes.insert(id.to_owned(), Arc::downgrade(&result));
    result
}

fn platform_failure(kind: SessionConnectionFailureKind) -> SessionConnectionPlatformError {
    SessionConnectionPlatformError::Failed {
        kind,
        expected_protocol: None,
        received_protocol: None,
    }
}

// Connection identity excludes display metadata and last-connected timestamps.
fn same_target(a: &HostProfileRecord, b: &HostProfileRecord) -> bool {
    a.id == b.id
        && a.created_at == b.created_at
        && a.host == b.host
        && a.port == b.port
        && a.username == b.username
        && a.auth_mode == b.auth_mode
        && a.jump_host_id == b.jump_host_id
        && a.forward_agent == b.forward_agent
        && a.tailcat_enabled == b.tailcat_enabled
        && a.tailcat_ssh_server == b.tailcat_ssh_server
        && a.herdr_enabled == b.herdr_enabled
        && a.herdr_backend == b.herdr_backend
        && a.herdr_command == b.herdr_command
        && a.herdr_socket_path == b.herdr_socket_path
        && a.session_name == b.session_name
}

#[repr(u8)]
enum Settlement {
    Pending,
    Cancelled,
    Completed,
}

struct Transaction {
    id: String,
    core: Arc<AppCore>,
    credentials: Arc<CredentialCoordinator>,
    platform: Arc<dyn SessionConnectionPlatform>,
    attempt: Arc<SessionConnectionAttempt>,
    settlement: AtomicU8,
    prepared: AtomicBool,
    fences: Mutex<Vec<HostProfileRecord>>,
}
impl Transaction {
    fn cancel(&self) {
        if self
            .settlement
            .compare_exchange(
                Settlement::Pending as u8,
                Settlement::Cancelled as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            return;
        }
        if self.prepared.load(Ordering::Acquire) {
            self.core
                .fail_connection(&self.attempt, self.attempt.host_id(), None, false, None);
        }
        if self.attempt.finish() {
            self.platform
                .connecting_changed(self.core.connecting_hosts());
            self.platform.state_changed();
        }
    }
    fn check(&self) -> EffectResult<()> {
        if self.settlement.load(Ordering::Acquire) != Settlement::Pending as u8
            || !self.attempt.is_current()
            || !self.credentials.is_active()
        {
            return Err(SessionConnectionPlatformError::Cancelled);
        }
        if !self.scope_current() {
            return Err(platform_failure(SessionConnectionFailureKind::StaleProfile));
        }
        Ok(())
    }
    fn scope_current(&self) -> bool {
        let current = self.credentials.view().hosts;
        !self
            .fences
            .lock()
            .iter()
            .any(|expected| !current.iter().any(|host| same_target(expected, host)))
    }
    fn pin(&self, host: HostProfileRecord) {
        let mut fences = self.fences.lock();
        fences.retain(|previous| previous.id != host.id);
        fences.push(host);
    }
    fn permit(self: &Arc<Self>, cleanup: bool) -> Arc<SessionConnectionPermit> {
        Arc::new(SessionConnectionPermit {
            transaction: Arc::downgrade(self),
            active: AtomicBool::new(true),
            cleanup,
        })
    }
}

/// A callback lease is retired on completion; a retained lease cannot authorize
/// effects in a later phase or a replacement attempt.
#[derive(uniffi::Object)]
pub struct SessionConnectionPermit {
    transaction: Weak<Transaction>,
    active: AtomicBool,
    cleanup: bool,
}
#[uniffi::export]
impl SessionConnectionPermit {
    pub fn is_current(&self) -> bool {
        self.active.load(Ordering::Acquire)
            && self
                .transaction
                .upgrade()
                .is_some_and(|transaction| self.cleanup || transaction.check().is_ok())
    }
    pub fn operation_id(&self) -> String {
        self.transaction
            .upgrade()
            .map(|transaction| transaction.id.clone())
            .unwrap_or_default()
    }
}

#[derive(uniffi::Object)]
pub struct SessionConnectionOperation {
    transaction: Option<Arc<Transaction>>,
    response: Mutex<Option<oneshot::Receiver<SessionConnectionOutcome>>>,
}
impl Drop for SessionConnectionOperation {
    fn drop(&mut self) {
        if self.response.get_mut().is_some()
            && let Some(transaction) = &self.transaction
        {
            transaction.cancel();
        }
    }
}
struct CancelOnDrop(Option<Arc<Transaction>>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(transaction) = &self.0 {
            transaction.cancel();
        }
    }
}
#[uniffi::export]
impl SessionConnectionOperation {
    pub fn cancel(&self) {
        if let Some(transaction) = &self.transaction {
            transaction.cancel();
        }
    }
    pub async fn result(&self) -> SessionConnectionOutcome {
        let _cancel = CancelOnDrop(self.transaction.clone());
        let receiver = self.response.lock().take();
        match receiver {
            Some(receiver) => receiver
                .await
                .unwrap_or(SessionConnectionOutcome::Cancelled),
            None => SessionConnectionOutcome::Cancelled,
        }
    }
}

struct Workflow {
    transaction: Arc<Transaction>,
    platform: Arc<dyn SessionConnectionPlatform>,
    request: SessionConnectionRequest,
    phase: SessionConnectionPhase,
    runtime: Option<Arc<HostRuntime>>,
    started_runtime: bool,
    attached: bool,
    selected: bool,
}
impl Workflow {
    async fn effect<T, F, Fut>(&self, phase: SessionConnectionPhase, action: F) -> EffectResult<T>
    where
        F: FnOnce(Arc<SessionConnectionPermit>) -> Fut,
        Fut: Future<Output = EffectResult<T>>,
    {
        self.transaction.check()?;
        let permit = self.transaction.permit(false);
        let start = Instant::now();
        // Drain physical callbacks. Cancellation fences their result, rather than
        // dropping a future while a Keychain/transport operation can still commit.
        let result = action(permit.clone()).await;
        permit.active.store(false, Ordering::Release);
        self.platform.diagnostic(
            self.request.host.id.clone(),
            phase,
            u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
            result.is_err(),
        );
        self.transaction.check()?;
        result
    }
    fn present(&self, presentation: SessionConnectionPresentation) -> EffectResult<()> {
        self.transaction.check()?;
        let permit = self.transaction.permit(false);
        self.platform.present(permit.clone(), presentation);
        permit.active.store(false, Ordering::Release);
        self.transaction.check()
    }
    async fn canonical(&self) -> EffectResult<Vec<HostProfileRecord>> {
        self.transaction.check()?;
        let result = self
            .transaction
            .credentials
            .begin(
                CredentialCommand::LoadHosts {
                    from_storage: true,
                    hosts: None,
                    legacy: None,
                },
                None,
            )
            .result()
            .await
            .map_err(|_| platform_failure(SessionConnectionFailureKind::Credential))?;
        self.transaction.check()?;
        match result {
            CredentialResult::Hosts { hosts } => Ok(hosts),
            _ => Err(platform_failure(SessionConnectionFailureKind::Platform)),
        }
    }
    async fn run(&mut self) -> EffectResult<()> {
        let Some((mut profile, hosts)) = self.admit_profile().await? else {
            return Ok(());
        };
        let jumps = self.prepare_jumps(&profile, &hosts).await?;
        self.authorize_and_persist(&mut profile, &jumps).await?;
        self.connect_transport(&profile, &jumps).await?;
        self.attach_and_restore(&profile).await
    }
    async fn admit_profile(
        &mut self,
    ) -> EffectResult<Option<(SessionConnectionProfile, Vec<HostProfileRecord>)>> {
        let host_id = self.request.host.id.clone();
        self.phase = SessionConnectionPhase::Credentials;
        let hosts = self.canonical().await?;
        let saved = hosts.iter().find(|host| host.id == host_id).cloned();
        if self.request.saved || !self.request.persist_profile {
            let saved = saved
                .as_ref()
                .ok_or_else(|| platform_failure(SessionConnectionFailureKind::StaleProfile))?;
            if !same_target(saved, &self.request.host) {
                return Err(platform_failure(SessionConnectionFailureKind::StaleProfile));
            }
            self.transaction.pin(saved.clone());
        } else if let Some(saved) = &saved {
            self.transaction.pin(saved.clone());
        }

        if self.request.attempt.is_none()
            && self.transaction.core.has_connection_runtime(&host_id)
            && self
                .request
                .existing_host
                .as_ref()
                .is_some_and(|host| same_target(host, &self.request.host))
            && saved
                .as_ref()
                .is_some_and(|host| same_target(host, &self.request.host))
        {
            self.transaction.core.select_host(host_id.clone());
            let view = self.transaction.core.view();
            let terminal = view
                .sessions
                .iter()
                .find(|session| session.host_id == host_id)
                .is_some_and(|session| {
                    session.connection_status == super::AppConnectionStatus::Ready
                });
            self.platform.state_changed();
            self.present(SessionConnectionPresentation::Selected {
                session_id: host_id,
                terminal: if self.request.saved { terminal } else { true },
                refresh: self.request.saved,
            })?;
            self.selected = true;
            return Ok(None);
        }

        self.begin_session().await?;
        let profile = if self.request.saved {
            self.effect(self.phase, |permit| {
                self.platform.load_profile(
                    permit,
                    self.request.host.clone(),
                    self.request.activate || self.request.navigate,
                )
            })
            .await?
            .ok_or_else(|| platform_failure(SessionConnectionFailureKind::Credential))?
        } else {
            SessionConnectionProfile {
                host: self.request.host.clone(),
                credential: self.request.credential.clone().unwrap_or_default(),
            }
        };
        if !same_target(&profile.host, &self.request.host) {
            return Err(platform_failure(SessionConnectionFailureKind::StaleProfile));
        }

        Ok(Some((profile, hosts)))
    }
    async fn begin_session(&mut self) -> EffectResult<()> {
        let host_id = self.request.host.id.clone();
        self.phase = SessionConnectionPhase::Admission;
        if self.request.saved || self.request.existing_host.is_some() {
            self.transaction.prepared.store(true, Ordering::Release);
            self.runtime = self.transaction.core.prepare_connection(
                &self.transaction.attempt,
                &host_id,
                self.request.activate,
            )?;
            self.platform.state_changed();
        }
        self.present(SessionConnectionPresentation::Started {
            host: self.request.host.clone(),
            show_placeholder: self.request.saved && self.request.activate,
            replace_runtime: self.runtime.is_some() || self.request.existing_host.is_some(),
        })?;
        if self.runtime.is_some() || self.request.existing_host.is_some() {
            self.started_runtime = true;
            if !self.cleanup_transport(false).await {
                return Err(platform_failure(SessionConnectionFailureKind::Platform));
            }
            self.runtime = None;
            self.started_runtime = false;
            self.transaction.check()?;
        }
        self.phase = SessionConnectionPhase::Admission;
        self.effect(self.phase, |permit| {
            self.platform.wait_for_cleanup(permit, host_id.clone())
        })
        .await?;
        self.phase = SessionConnectionPhase::Credentials;

        Ok(())
    }
    async fn prepare_jumps(
        &mut self,
        profile: &SessionConnectionProfile,
        hosts: &[HostProfileRecord],
    ) -> EffectResult<Vec<SessionConnectionProfile>> {
        self.phase = SessionConnectionPhase::JumpCredentials;
        let store = HostProfileStore::new();
        store
            .hydrate(Some(serde_json::to_string(&hosts).map_err(|_| {
                platform_failure(SessionConnectionFailureKind::Platform)
            })?))
            .map_err(|_| platform_failure(SessionConnectionFailureKind::Credential))?;
        let chain = store
            .resolve_jump_chain(profile.host.id.clone(), profile.host.jump_host_id.clone())
            .map_err(|_| platform_failure(SessionConnectionFailureKind::Credential))?;
        let mut jumps = Vec::with_capacity(chain.len());
        for host in chain {
            self.transaction.pin(host.clone());
            let jump = self
                .effect(self.phase, |permit| {
                    self.platform.load_profile(
                        permit,
                        host.clone(),
                        self.request.activate || self.request.navigate,
                    )
                })
                .await?
                .filter(|profile| {
                    !profile.credential.secret.is_empty() && same_target(&profile.host, &host)
                })
                .ok_or_else(|| platform_failure(SessionConnectionFailureKind::Credential))?;
            jumps.push(jump);
        }

        Ok(jumps)
    }
    async fn authorize_and_persist(
        &mut self,
        profile: &mut SessionConnectionProfile,
        jumps: &[SessionConnectionProfile],
    ) -> EffectResult<()> {
        self.phase = SessionConnectionPhase::Biometric;
        let protected = self.request.protect_keys
            && std::iter::once(&*profile)
                .chain(jumps.iter())
                .any(|profile| profile.host.auth_mode == HostAuthMode::Key);
        if protected
            && !self.request.biometric_verified
            && !self
                .effect(self.phase, |permit| self.platform.verify_keys(permit))
                .await?
        {
            return Err(SessionConnectionPlatformError::Cancelled);
        }
        self.canonical().await?;
        self.phase = SessionConnectionPhase::Persistence;
        if self.request.persist_profile {
            let result = self
                .transaction
                .credentials
                .begin(
                    CredentialCommand::SaveHost {
                        profile: profile.host.clone(),
                        credential: profile.credential.clone(),
                    },
                    None,
                )
                .result()
                .await
                .map_err(|_| platform_failure(SessionConnectionFailureKind::Credential))?;
            if let CredentialResult::Saved { host, .. } = result {
                self.transaction.pin(host.clone());
                profile.host = host;
            } else {
                return Err(platform_failure(SessionConnectionFailureKind::Platform));
            }
            self.transaction.check()?;
        }
        Ok(())
    }
    async fn connect_transport(
        &mut self,
        profile: &SessionConnectionProfile,
        jumps: &[SessionConnectionProfile],
    ) -> EffectResult<()> {
        let mut approvals = 0;
        loop {
            self.phase = SessionConnectionPhase::Transport;
            self.started_runtime = true;
            match self
                .effect(self.phase, |permit| {
                    self.platform
                        .connect_runtime(permit, profile.clone(), jumps.to_vec())
                })
                .await
            {
                Ok(runtime) => {
                    if runtime.runtime_id() != self.request.host.id {
                        return Err(platform_failure(SessionConnectionFailureKind::StaleProfile));
                    }
                    self.runtime = Some(runtime);
                    break;
                }
                Err(SessionConnectionPlatformError::UnknownHostKey { challenge })
                    if self.request.prompt_for_trust && approvals <= jumps.len() =>
                {
                    self.phase = SessionConnectionPhase::Trust;
                    if !self
                        .effect(self.phase, |permit| {
                            self.platform.confirm_trust(permit, challenge.clone())
                        })
                        .await?
                    {
                        return Err(SessionConnectionPlatformError::UnknownHostKey { challenge });
                    }
                    self.effect(self.phase, |permit| {
                        self.platform.record_trust(permit, challenge)
                    })
                    .await?;
                    approvals += 1;
                }
                Err(error) => return Err(error),
            }
            self.canonical().await?;
        }
        self.canonical().await?;

        Ok(())
    }
    async fn attach_and_restore(&mut self, profile: &SessionConnectionProfile) -> EffectResult<()> {
        let host_id = profile.host.id.clone();
        self.phase = SessionConnectionPhase::Attach;
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| platform_failure(SessionConnectionFailureKind::Platform))?;
        if runtime.runtime_id() != host_id
            || runtime.herdr_enabled() != profile.host.herdr_enabled
            || runtime.herdr_backend() != profile.host.herdr_backend
        {
            return Err(platform_failure(SessionConnectionFailureKind::StaleProfile));
        }
        self.present(SessionConnectionPresentation::Prepared {
            host: profile.host.clone(),
        })?;
        self.transaction.prepared.store(true, Ordering::Release);
        self.transaction
            .core
            .attach_connection(
                &self.transaction.attempt,
                &host_id,
                self.request.activate,
                runtime.clone(),
            )
            .ok_or(SessionConnectionPlatformError::Cancelled)?;
        self.attached = true;
        self.platform.state_changed();
        self.phase = SessionConnectionPhase::TerminalRestore;
        let active_terminal = self
            .effect(self.phase, |permit| {
                self.platform.restore_terminals(permit, host_id.clone())
            })
            .await?;
        self.canonical().await?;
        if !profile.host.herdr_enabled && !active_terminal {
            self.transaction
                .core
                .open_connection_shell(
                    &self.transaction.attempt,
                    &host_id,
                    self.request.ssh_shell_title.clone(),
                )
                .ok_or(SessionConnectionPlatformError::Cancelled)?;
        }
        self.platform.state_changed();
        let terminal = !profile.host.herdr_enabled || runtime.host_state().snapshot.is_some();
        self.phase = SessionConnectionPhase::Ready;
        self.present(SessionConnectionPresentation::Ready {
            session_id: host_id,
            terminal,
            navigate: self.request.navigate,
        })
    }
    async fn cleanup_transport(&self, retain_transport: bool) -> bool {
        let permit = self.transaction.permit(true);
        let start = Instant::now();
        let native_failed = if !retain_transport {
            if let Some(runtime) = &self.runtime {
                runtime.disconnect().await.is_err()
            } else {
                false
            }
        } else {
            false
        };
        let result = self
            .platform
            .cleanup(
                permit.clone(),
                self.request.host.id.clone(),
                retain_transport,
            )
            .await;
        permit.active.store(false, Ordering::Release);
        self.platform.diagnostic(
            self.request.host.id.clone(),
            SessionConnectionPhase::Cleanup,
            u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
            result.is_err() || native_failed,
        );
        result.is_ok() && !native_failed
    }
    async fn complete(mut self) -> SessionConnectionOutcome {
        let result = self.run().await.and_then(|()| self.transaction.check());
        // Completion and cancellation share one linearization point. A later
        // abort cannot tear down a connection whose successful result settled.
        let committed = result.is_ok()
            && self.transaction.attempt.finish_if(|| {
                self.transaction.credentials.is_active()
                    && self.transaction.scope_current()
                    && self
                        .transaction
                        .settlement
                        .compare_exchange(
                            Settlement::Pending as u8,
                            Settlement::Completed as u8,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
            });
        let result = if result.is_ok() && !committed {
            Err(SessionConnectionPlatformError::Cancelled)
        } else {
            result
        };
        let current = self.transaction.check().is_ok();
        let outcome = match result {
            Ok(()) => {
                if self.selected {
                    SessionConnectionOutcome::Selected
                } else {
                    SessionConnectionOutcome::Ready
                }
            }
            Err(error) => {
                let mut canceled = matches!(error, SessionConnectionPlatformError::Cancelled)
                    || !self.transaction.attempt.is_current()
                    || !self.transaction.credentials.is_active()
                    || self.transaction.settlement.load(Ordering::Acquire)
                        == Settlement::Cancelled as u8;
                let failure = self.failure(&error);
                let message = (!canceled).then(|| self.platform.failure_message(failure.clone()));
                if self.transaction.prepared.load(Ordering::Acquire) {
                    self.transaction.core.fail_connection(
                        &self.transaction.attempt,
                        &self.request.host.id,
                        self.runtime.as_ref(),
                        self.request.reuse_placeholder || self.request.saved,
                        message,
                    );
                }
                self.platform.state_changed();
                let cleanup_failed = if self.started_runtime {
                    // A healthy transport survives terminal/UI restore failure;
                    // canceled and stale transactions must release their transport.
                    let retain = !canceled
                        && current
                        && self.attached
                        && self.phase == SessionConnectionPhase::TerminalRestore;
                    let mut failed = !self.cleanup_transport(retain).await;
                    canceled |= !self.transaction.attempt.is_current()
                        || self.transaction.settlement.load(Ordering::Acquire)
                            == Settlement::Cancelled as u8;
                    if retain && canceled {
                        failed |= !self.cleanup_transport(false).await;
                    }
                    failed
                } else {
                    false
                };
                if cleanup_failed {
                    SessionConnectionOutcome::CleanupFailed {
                        failure: SessionConnectionFailure {
                            phase: SessionConnectionPhase::Cleanup,
                            kind: SessionConnectionFailureKind::Platform,
                            ..failure
                        },
                    }
                } else if canceled {
                    SessionConnectionOutcome::Cancelled
                } else {
                    if current {
                        let _ = self.present(SessionConnectionPresentation::Failed {
                            navigate: self.request.navigate,
                            failure: failure.clone(),
                        });
                    }
                    SessionConnectionOutcome::Failed { failure }
                }
            }
        };
        if committed || self.transaction.attempt.finish() {
            self.platform
                .connecting_changed(self.transaction.core.connecting_hosts());
        }
        outcome
    }
    fn failure(&self, error: &SessionConnectionPlatformError) -> SessionConnectionFailure {
        let (kind, host, expected_protocol, received_protocol) = match error {
            SessionConnectionPlatformError::Failed {
                kind,
                expected_protocol,
                received_protocol,
            } => (
                *kind,
                self.request.host.host.clone(),
                expected_protocol.clone(),
                received_protocol.clone(),
            ),
            SessionConnectionPlatformError::UnknownHostKey { challenge }
            | SessionConnectionPlatformError::ChangedHostKey { challenge } => (
                SessionConnectionFailureKind::HostKey,
                challenge.host.clone(),
                None,
                None,
            ),
            SessionConnectionPlatformError::Cancelled => (
                SessionConnectionFailureKind::Unknown,
                self.request.host.host.clone(),
                None,
                None,
            ),
        };
        SessionConnectionFailure {
            phase: self.phase,
            kind,
            host_id: self.request.host.id.clone(),
            host,
            expected_protocol,
            received_protocol,
        }
    }
}

fn immediate(outcome: SessionConnectionOutcome) -> Arc<SessionConnectionOperation> {
    let (sender, receiver) = oneshot::channel();
    let _ = sender.send(outcome);
    Arc::new(SessionConnectionOperation {
        transaction: None,
        response: Mutex::new(Some(receiver)),
    })
}

#[uniffi::export]
impl AppCore {
    pub fn start_connection(
        self: &Arc<Self>,
        request: SessionConnectionRequest,
        credentials: Arc<CredentialCoordinator>,
        platform: Arc<dyn SessionConnectionPlatform>,
    ) -> Arc<SessionConnectionOperation> {
        let host_id = request.host.id.clone();
        if request
            .attempt
            .as_ref()
            .is_some_and(|attempt| !attempt.belongs_to(self, &host_id) || !attempt.is_current())
        {
            return immediate(SessionConnectionOutcome::Cancelled);
        }
        if request.attempt.is_none() && self.connection_pending(host_id.clone()) {
            return immediate(SessionConnectionOutcome::Busy);
        }
        let Some(attempt) = request
            .attempt
            .clone()
            .or_else(|| self.begin_connection(host_id.clone()))
        else {
            return immediate(SessionConnectionOutcome::Busy);
        };
        let transaction = Arc::new(Transaction {
            id: uuid::Uuid::new_v4().to_string(),
            core: self.clone(),
            credentials,
            platform: platform.clone(),
            attempt,
            settlement: AtomicU8::new(Settlement::Pending as u8),
            prepared: AtomicBool::new(false),
            fences: Mutex::new(vec![]),
        });
        let (sender, receiver) = oneshot::channel();
        let operation = Arc::new(SessionConnectionOperation {
            transaction: Some(transaction.clone()),
            response: Mutex::new(Some(receiver)),
        });
        let lane = lane(&host_id);
        let worker = Workflow {
            transaction,
            platform: platform.clone(),
            request,
            phase: SessionConnectionPhase::Admission,
            runtime: None,
            started_runtime: false,
            attached: false,
            selected: false,
        };
        platform.connecting_changed(self.set_connecting(host_id, true));
        match crate::runtime() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    let Ok(_lane) = lane.acquire().await else {
                        worker.transaction.attempt.finish();
                        let _ = sender.send(SessionConnectionOutcome::Cancelled);
                        return;
                    };
                    let outcome = worker.complete().await;
                    let _ = sender.send(outcome);
                });
            }
            Err(_) => {
                worker.transaction.attempt.finish();
                let _ = sender.send(SessionConnectionOutcome::Cancelled);
            }
        }
        operation
    }
}

#[cfg(test)]
mod tests;
