//! Authenticated application host workflows. The native MCP owner remains the
//! authority for request/session lifetime; the platform only executes effects.
mod operation;
mod types;

pub(super) use operation::HostAction;
pub use types::*;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};

use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::Mutex as AsyncMutex;

use super::ReverseControl;
use super::browser::model::{BrowserError, ErrorCode};

static CURRENT: OnceLock<Mutex<Weak<HostActionCoordinator>>> = OnceLock::new();

fn registry() -> &'static Mutex<Weak<HostActionCoordinator>> {
    CURRENT.get_or_init(Mutex::default)
}

struct State {
    context: HostActionContext,
    epoch: u64,
    closed: bool,
    active: HashMap<String, Weak<HostActionPermit>>,
}

#[derive(uniffi::Object)]
pub struct HostActionCoordinator {
    state: Mutex<State>,
    platform: Arc<dyn HostActionPlatform>,
    // Serialize app-level mutations, including credential source/target races.
    // HostProfileRepository retains the separate cross-store commit policy.
    mutation: AsyncMutex<()>,
}

#[uniffi::export]
impl HostActionCoordinator {
    #[uniffi::constructor]
    pub fn new(platform: Arc<dyn HostActionPlatform>) -> Arc<Self> {
        let coordinator = Arc::new(Self {
            state: Mutex::new(State {
                context: HostActionContext::default(),
                epoch: 0,
                closed: false,
                active: HashMap::new(),
            }),
            platform,
            mutation: AsyncMutex::new(()),
        });
        let previous = {
            let mut current = registry().lock();
            let previous = current.upgrade();
            *current = Arc::downgrade(&coordinator);
            previous
        };
        if let Some(previous) = previous {
            previous.close();
        }
        coordinator
    }

    pub fn update_context(&self, context: HostActionContext) {
        let revoked = {
            let mut state = self.state.lock();
            if state.closed {
                return;
            }
            let changed = state.context.ready != context.ready
                || state.context.locked != context.locked
                || state.context.biometric_for_keys != context.biometric_for_keys;
            let reason = if context.locked {
                HostActionPermitError::Locked
            } else if !context.ready {
                HostActionPermitError::Unavailable
            } else {
                HostActionPermitError::Cancelled
            };
            state.context = context;
            if changed {
                state.epoch = state.epoch.wrapping_add(1);
            }
            state
                .active
                .values()
                .filter_map(Weak::upgrade)
                .filter(|permit| changed || !permit.matches_profiles(&state.context))
                .map(|permit| {
                    (
                        permit,
                        if changed {
                            reason
                        } else {
                            HostActionPermitError::Cancelled
                        },
                    )
                })
                .collect::<Vec<_>>()
        };
        for (permit, reason) in revoked {
            permit.revoke(reason);
        }
    }

    pub fn close(&self) {
        {
            let mut current = registry().lock();
            if current
                .upgrade()
                .is_some_and(|coordinator| std::ptr::eq(coordinator.as_ref(), self))
            {
                *current = Weak::new();
            }
        }
        let active = {
            let mut state = self.state.lock();
            state.closed = true;
            state.epoch = state.epoch.wrapping_add(1);
            state
                .active
                .values()
                .filter_map(Weak::upgrade)
                .collect::<Vec<_>>()
        };
        for permit in active {
            permit.revoke(HostActionPermitError::Cancelled);
        }
    }
}

pub(super) fn detach() {
    let current = registry().lock().upgrade();
    if let Some(current) = current {
        current.close();
    }
}

#[derive(Default)]
struct Progress {
    current: Option<&'static str>,
    completed: Vec<&'static str>,
}

enum ProfileFence {
    Credential {
        id: String,
        auth_mode: crate::host_profiles::HostAuthMode,
        created_at: String,
    },
    Connection(Box<crate::host_profiles::HostProfileRecord>),
}

#[derive(uniffi::Object)]
pub struct HostActionPermit {
    operation_id: String,
    coordinator: Weak<HostActionCoordinator>,
    owner: Weak<ReverseControl>,
    session: super::ReverseControlSession,
    parent: String,
    coordinator_epoch: u64,
    runtime_epoch: u64,
    stopped: AtomicBool,
    progress: Mutex<Progress>,
    profiles: Mutex<Vec<ProfileFence>>,
}

#[uniffi::export]
impl HostActionPermit {
    pub fn operation_id(&self) -> String {
        self.operation_id.clone()
    }

    pub fn check_active(&self) -> Result<(), HostActionPermitError> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(HostActionPermitError::Cancelled);
        }
        let coordinator = self
            .coordinator
            .upgrade()
            .ok_or(HostActionPermitError::Cancelled)?;
        {
            let state = coordinator.state.lock();
            if state.closed || state.epoch != self.coordinator_epoch {
                return Err(HostActionPermitError::Cancelled);
            }
            if !state.context.ready {
                return Err(HostActionPermitError::Unavailable);
            }
            if state.context.locked {
                return Err(HostActionPermitError::Locked);
            }
            if !self.matches_profiles(&state.context) {
                return Err(HostActionPermitError::Cancelled);
            }
        }
        let owner = self
            .owner
            .upgrade()
            .ok_or(HostActionPermitError::Unauthorized)?;
        let bridge = owner.bridge.lock();
        if owner.epoch.load(Ordering::Acquire) != self.runtime_epoch
            || bridge.as_ref().is_some_and(|bridge| !bridge.connected())
        {
            return Err(HostActionPermitError::Unauthorized);
        }
        let sessions = owner.sessions.lock();
        let current = sessions
            .get(&self.session.session_id)
            .ok_or(HostActionPermitError::Unauthorized)?;
        if current.info.runtime_id != self.session.runtime_id
            || current.info.pane_id != self.session.pane_id
            || current.info.terminal_id != self.session.terminal_id
        {
            return Err(HostActionPermitError::Unauthorized);
        }
        if owner
            .pending
            .lock()
            .get(&self.parent)
            .is_none_or(|call| call.session != self.session.session_id)
        {
            return Err(HostActionPermitError::Cancelled);
        }
        // Keep transport, session and request ownership in the same snapshot.
        drop(sessions);
        drop(bridge);
        Ok(())
    }
}

impl HostActionPermit {
    fn matches_profiles(&self, context: &HostActionContext) -> bool {
        self.profiles.lock().iter().all(|fence| match fence {
            ProfileFence::Credential {
                id,
                auth_mode,
                created_at,
            } => context.hosts.iter().any(|host| {
                host.id == *id && host.auth_mode == *auth_mode && host.created_at == *created_at
            }),
            ProfileFence::Connection(expected) => context
                .hosts
                .iter()
                .any(|host| same_connection_profile(host, expected)),
        })
    }

    fn pin_credential(
        &self,
        host: &crate::host_profiles::HostProfileRecord,
    ) -> Result<(), BrowserError> {
        self.profiles.lock().push(ProfileFence::Credential {
            id: host.id.clone(),
            auth_mode: host.auth_mode,
            created_at: host.created_at.clone(),
        });
        self.check()
    }

    fn pin_connections(
        &self,
        hosts: impl Iterator<Item = crate::host_profiles::HostProfileRecord>,
    ) -> Result<(), BrowserError> {
        self.profiles
            .lock()
            .extend(hosts.map(|host| ProfileFence::Connection(Box::new(host))));
        self.check()
    }

    fn check(&self) -> Result<(), BrowserError> {
        self.check_active().map_err(|error| self.error(error))
    }

    fn error(&self, error: HostActionPermitError) -> BrowserError {
        let code = match error {
            HostActionPermitError::Cancelled => ErrorCode::Cancelled,
            HostActionPermitError::Unauthorized => ErrorCode::Unauthorized,
            HostActionPermitError::Locked => ErrorCode::PermissionDenied,
            HostActionPermitError::Unavailable => ErrorCode::DeviceUnavailable,
        };
        self.with_progress(BrowserError::new(code, error.to_string()))
    }

    pub(super) fn with_progress(&self, mut error: BrowserError) -> BrowserError {
        let progress = self.progress.lock();
        error.details = json!({
            "stage": progress.current,
            "completed_stages": progress.completed,
            "outcome_unknown": progress.current.is_some(),
        });
        error
    }

    fn stop(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(coordinator) = self.coordinator.upgrade() {
            coordinator.state.lock().active.remove(&self.operation_id);
            let platform = coordinator.platform.clone();
            let operation_id = self.operation_id.clone();
            if let Ok(runtime) = crate::runtime() {
                runtime.spawn(async move {
                    platform.cancel(operation_id);
                });
            }
        }
    }

    fn revoke(&self, reason: HostActionPermitError) {
        let error = self.error(reason);
        self.stop();
        if let Some(owner) = self.owner.upgrade() {
            owner.reject_host_action(&self.parent, error);
        }
    }
}

struct Operation {
    coordinator: Arc<HostActionCoordinator>,
    permit: Arc<HostActionPermit>,
}

impl Drop for Operation {
    fn drop(&mut self) {
        self.permit.stop();
    }
}

impl Operation {
    fn begin(
        owner: &Arc<ReverseControl>,
        session: &str,
        parent: &str,
    ) -> Result<Self, BrowserError> {
        let coordinator = registry().lock().upgrade().ok_or_else(|| {
            BrowserError::new(
                ErrorCode::DeviceUnavailable,
                "Whip host actions are unavailable",
            )
        })?;
        let session = owner
            .sessions
            .lock()
            .get(session)
            .map(|session| session.info.clone())
            .ok_or_else(|| {
                BrowserError::new(
                    ErrorCode::Unauthorized,
                    "Reverse Control session is no longer authorized",
                )
            })?;
        let permit = {
            let mut state = coordinator.state.lock();
            let permit = Arc::new(HostActionPermit {
                operation_id: uuid::Uuid::new_v4().to_string(),
                coordinator: Arc::downgrade(&coordinator),
                owner: Arc::downgrade(owner),
                session,
                parent: parent.to_owned(),
                coordinator_epoch: state.epoch,
                runtime_epoch: owner.epoch.load(Ordering::Acquire),
                stopped: AtomicBool::new(false),
                progress: Mutex::new(Progress::default()),
                profiles: Mutex::new(Vec::new()),
            });
            state
                .active
                .insert(permit.operation_id.clone(), Arc::downgrade(&permit));
            permit
        };
        let operation = Self {
            coordinator,
            permit,
        };
        operation.permit.check()?;
        if let Some(call) = owner.pending.lock().get_mut(parent) {
            call.host = Some(Arc::downgrade(&operation.permit));
        }
        Ok(operation)
    }

    fn context(&self) -> Result<HostActionContext, BrowserError> {
        self.permit.check()?;
        Ok(self.coordinator.state.lock().context.clone())
    }

    fn host_snapshot(
        &self,
        id: &str,
    ) -> Result<Option<crate::host_profiles::HostProfileRecord>, BrowserError> {
        self.permit.check()?;
        Ok(self
            .coordinator
            .state
            .lock()
            .context
            .hosts
            .iter()
            .find(|host| host.id == id)
            .cloned())
    }

    fn connection_snapshot(&self, id: &str) -> Result<Option<HostActionConnection>, BrowserError> {
        self.permit.check()?;
        Ok(self
            .coordinator
            .state
            .lock()
            .context
            .connections
            .iter()
            .find(|connection| connection.host_id == id)
            .cloned())
    }

    fn confirm_host(
        &self,
        id: &str,
        previous: Option<&crate::host_profiles::HostProfileRecord>,
        saved: Option<crate::host_profiles::HostProfileRecord>,
    ) {
        let mut state = self.coordinator.state.lock();
        if state.closed || state.context.hosts.iter().find(|host| host.id == id) != previous {
            return;
        }
        if let Some(saved) = saved {
            if let Some(current) = state.context.hosts.iter_mut().find(|host| host.id == id) {
                *current = saved;
            } else {
                state.context.hosts.push(saved);
            }
        } else {
            state.context.hosts.retain(|host| host.id != id);
        }
        crate::host_profiles::sort_hosts(&mut state.context.hosts);
    }

    fn confirm_connection(
        &self,
        id: &str,
        previous: Option<&HostActionConnection>,
        connected: Option<HostActionConnection>,
    ) {
        let mut state = self.coordinator.state.lock();
        if state.closed
            || state
                .context
                .connections
                .iter()
                .find(|connection| connection.host_id == id)
                != previous
        {
            return;
        }
        state
            .context
            .connections
            .retain(|connection| connection.host_id != id);
        if let Some(connected) = connected {
            state.context.connections.push(connected);
        }
    }

    async fn effect<T>(
        &self,
        stage: &'static str,
        effect: impl Future<Output = Result<T, HostActionPlatformError>>,
    ) -> Result<T, BrowserError> {
        self.permit.check()?;
        self.permit.progress.lock().current = Some(stage);
        let result = effect.await;
        self.permit.check()?;
        let value = result.map_err(|error| {
            let code = match error {
                HostActionPlatformError::PermissionDenied => ErrorCode::PermissionDenied,
                HostActionPlatformError::CredentialMissing => ErrorCode::InvalidArgument,
                HostActionPlatformError::Unavailable => ErrorCode::DeviceUnavailable,
            };
            self.permit
                .with_progress(BrowserError::new(code, error.to_string()))
        })?;
        let mut progress = self.permit.progress.lock();
        progress.current = None;
        progress.completed.push(stage);
        drop(progress);
        Ok(value)
    }

    /// Linearize the final response with lock/session revocation. Release all
    /// native locks before emitting events or calling foreign platform code.
    fn finish(&self, result: Result<serde_json::Value, BrowserError>) {
        let Some(owner) = self.permit.owner.upgrade() else {
            return;
        };
        let state = self.coordinator.state.lock();
        let bridge = owner.bridge.lock();
        let sessions = owner.sessions.lock();
        let mut pending = owner.pending.lock();
        let identity = &self.permit.session;
        let valid_session = sessions.get(&identity.session_id).is_some_and(|session| {
            session.info.runtime_id == identity.runtime_id
                && session.info.pane_id == identity.pane_id
                && session.info.terminal_id == identity.terminal_id
        });
        if pending
            .get(&self.permit.parent)
            .is_none_or(|call| call.session != identity.session_id)
        {
            return;
        }
        let error = if self.permit.stopped.load(Ordering::Acquire)
            || state.closed
            || state.epoch != self.permit.coordinator_epoch
            || !self.permit.matches_profiles(&state.context)
        {
            Some(HostActionPermitError::Cancelled)
        } else if state.context.locked {
            Some(HostActionPermitError::Locked)
        } else if !state.context.ready {
            Some(HostActionPermitError::Unavailable)
        } else if !valid_session
            || owner.epoch.load(Ordering::Acquire) != self.permit.runtime_epoch
            || bridge.as_ref().is_some_and(|bridge| !bridge.connected())
        {
            Some(HostActionPermitError::Unauthorized)
        } else {
            None
        };
        let result = error.map_or(result, |error| Err(self.permit.error(error)));
        let info = sessions
            .get(&identity.session_id)
            .map(|session| session.info.clone());
        if let Some(call) = pending.remove(&self.permit.parent) {
            let _ = call
                .response
                .send(result.unwrap_or_else(|error| error.mcp()));
        }
        drop(pending);
        drop(sessions);
        drop(bridge);
        drop(state);
        owner.tasks.lock().remove(&self.permit.parent);
        owner.cancel_steps(&self.permit.parent);
        if let Some(info) = info {
            super::emit(
                &info,
                "release",
                &self.permit.parent,
                "",
                serde_json::Value::Null,
            );
        }
    }
}

fn same_connection_profile(
    a: &crate::host_profiles::HostProfileRecord,
    b: &crate::host_profiles::HostProfileRecord,
) -> bool {
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
        && a.herdr_command == b.herdr_command
        && a.herdr_socket_path == b.herdr_socket_path
        && a.session_name == b.session_name
}

#[cfg(test)]
pub(super) mod tests;
