//! Native ownership of browser identities, leases and platform-effect lifetimes.
mod session;
mod types;

pub use session::BrowserOperationSession;
pub use types::*;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::{
    engine::{self, Bridge, Context, Primitive},
    model::{BrowserAction, BrowserError, ErrorCode, SessionId},
};
use crate::reverse_control::{ReverseControl, ReverseControlSession};

static CURRENT: OnceLock<Mutex<Weak<BrowserOperationCoordinator>>> = OnceLock::new();
const EFFECT_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_EFFECT_TIMEOUT: Duration = Duration::from_secs(115);

fn registry() -> &'static Mutex<Weak<BrowserOperationCoordinator>> {
    CURRENT.get_or_init(Mutex::default)
}

#[derive(uniffi::Object)]
pub struct BrowserOperationCoordinator {
    platform: Arc<dyn BrowserOperationPlatform>,
    closed: AtomicBool,
    active: Mutex<HashMap<String, Weak<Request>>>,
}

#[uniffi::export]
impl BrowserOperationCoordinator {
    #[uniffi::constructor]
    pub fn new(platform: Arc<dyn BrowserOperationPlatform>) -> Arc<Self> {
        let coordinator = Arc::new(Self {
            platform,
            closed: AtomicBool::new(false),
            active: Mutex::default(),
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
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let active = self
            .active
            .lock()
            .values()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        for request in active {
            if let Some(owner) = request.owner.upgrade() {
                owner.reject_host_action(&request.parent, error(BrowserOperationError::Cancelled));
            }
            request.stop();
        }
    }
}

pub(crate) fn detach() {
    if let Some(current) = registry().lock().upgrade() {
        current.close();
    }
}

struct Request {
    id: String,
    coordinator: Arc<BrowserOperationCoordinator>,
    owner: Weak<ReverseControl>,
    identity: ReverseControlSession,
    session: Arc<BrowserOperationSession>,
    parent: String,
    owner_epoch: u64,
    transport: Option<(u64, u64)>,
    stopped: AtomicBool,
    route: Mutex<Option<u64>>,
    created: Mutex<Vec<String>>,
    committed: AtomicBool,
    last_read: Mutex<Option<Fence>>,
}

impl Request {
    fn check(&self) -> Result<(), BrowserOperationError> {
        if self.stopped.load(Ordering::Acquire) || self.coordinator.closed.load(Ordering::Acquire) {
            return Err(BrowserOperationError::Cancelled);
        }
        if !self.session.live() {
            return Err(BrowserOperationError::SessionClosed);
        }
        let route = *self.route.lock();
        if route.is_some_and(|epoch| epoch != self.session.route_epoch()) {
            return Err(BrowserOperationError::Unavailable);
        }
        let last_read = self.last_read.lock().clone();
        if let Some(fence) = last_read {
            fence.check_view(&self.session.tab(fence.tab.clone())?)?;
        }
        let owner = self
            .owner
            .upgrade()
            .ok_or(BrowserOperationError::SessionClosed)?;
        let bridge = owner.bridge.lock();
        if owner.epoch.load(Ordering::Acquire) != self.owner_epoch
            || bridge
                .as_ref()
                .map(|bridge| (bridge.epoch, bridge.transport_epoch))
                != self.transport
            || bridge.as_ref().is_some_and(|bridge| !bridge.connected())
        {
            return Err(BrowserOperationError::Unauthorized);
        }
        let sessions = owner.sessions.lock();
        let current = sessions
            .get(&self.identity.session_id)
            .ok_or(BrowserOperationError::SessionClosed)?;
        if BrowserOwner::from(&current.info) != self.session.owner {
            return Err(BrowserOperationError::Unauthorized);
        }
        if owner
            .pending
            .lock()
            .get(&self.parent)
            .is_none_or(|pending| pending.session != self.identity.session_id)
        {
            return Err(BrowserOperationError::Cancelled);
        }
        drop(sessions);
        drop(bridge);
        Ok(())
    }

    fn stop(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        self.session.release_lease(self.parent.clone());
        if !self.committed.load(Ordering::Acquire) {
            for id in self.created.lock().iter() {
                let _ = self.session.close_tab(id.clone());
            }
        }
        self.session.wake();
        self.coordinator.active.lock().remove(&self.id);
        let platform = self.coordinator.platform.clone();
        let id = self.identity.session_id.clone();
        if let Ok(runtime) = crate::runtime() {
            runtime.spawn(async move {
                platform.changed(id);
            });
        }
    }

    fn finish(&self, result: Value) {
        let Some(owner) = self.owner.upgrade() else {
            return;
        };
        let last_read = self.last_read.lock().clone();
        let checked = self.session.with_live(|route_epoch, tabs| {
            let bridge = owner.bridge.lock();
            let sessions = owner.sessions.lock();
            let valid = !self.stopped.load(Ordering::Acquire)
                && !self.coordinator.closed.load(Ordering::Acquire)
                && owner.epoch.load(Ordering::Acquire) == self.owner_epoch
                && bridge
                    .as_ref()
                    .map(|bridge| (bridge.epoch, bridge.transport_epoch))
                    == self.transport
                && bridge
                    .as_ref()
                    .is_none_or(crate::reverse_control::Bridge::connected)
                && sessions
                    .get(&self.identity.session_id)
                    .is_some_and(|current| BrowserOwner::from(&current.info) == self.session.owner);
            let pending = owner.pending.lock().remove(&self.parent);
            if let Some(pending) = pending {
                let result = if !valid {
                    error(BrowserOperationError::Cancelled).mcp()
                } else if self.route.lock().is_some_and(|epoch| epoch != route_epoch) {
                    error(BrowserOperationError::Unavailable).mcp()
                } else if result["isError"] != true {
                    last_read
                        .as_ref()
                        .and_then(|fence| {
                            tabs.iter()
                                .find(|tab| tab.id == fence.tab)
                                .map_or(Some(BrowserOperationError::TabClosed), |tab| {
                                    fence.check(tab).err()
                                })
                        })
                        .map_or(result, |failure| error(failure).mcp())
                } else {
                    result
                };
                if valid && result["isError"] != true {
                    self.committed.store(true, Ordering::Release);
                }
                let _ = pending.response.send(result);
            }
            drop(sessions);
            drop(bridge);
        });
        if let Err(failure) = checked {
            owner.reject_host_action(&self.parent, error(failure));
        }
    }

    fn permit(self: &Arc<Self>, fence: Option<Fence>) -> Arc<BrowserEffectPermit> {
        let permit = Arc::new(BrowserEffectPermit {
            id: uuid::Uuid::new_v4().to_string(),
            request: Arc::downgrade(self),
            fence,
            stopped: AtomicBool::new(false),
            changed: Notify::new(),
        });
        self.session.add_effect(&permit);
        permit
    }

    async fn effect<T>(
        self: &Arc<Self>,
        fence: Option<Fence>,
        duration: Duration,
        call: impl FnOnce(
            Arc<BrowserEffectPermit>,
        ) -> BoxFuture<'static, Result<T, BrowserPlatformError>>,
    ) -> Result<T, BrowserError> {
        let permit = self.permit(fence);
        let _guard = EffectGuard(permit.clone());
        let changed = permit.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        permit.check_active().map_err(error)?;
        let work = call(permit.clone());
        tokio::pin!(work);
        engine::deadline(duration, async {
            loop {
                tokio::select! {
                    result = &mut work => {
                        permit.check_active().map_err(error)?;
                        return result.map_err(platform_error);
                    }
                    () = &mut changed => {
                        permit.check_active().map_err(error)?;
                        changed.set(permit.changed.notified());
                        changed.as_mut().enable();
                    }
                }
            }
        })
        .await
    }
}

struct RequestGuard(Arc<Request>);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.0.stop();
    }
}
struct EffectGuard(Arc<BrowserEffectPermit>);
impl Drop for EffectGuard {
    fn drop(&mut self) {
        self.0.stop();
    }
}

// Keep native records/UniFFI in the app; the fence policy is shared Rust.
use agent_browser_control::fence::{FenceError, TabFence as Fence, TabState};

trait NativeFence {
    fn check(&self, tab: &BrowserTabProjection) -> Result<(), BrowserOperationError>;
    fn check_view(&self, tab: &BrowserTabProjection) -> Result<(), BrowserOperationError>;
}

fn tab_state(tab: &BrowserTabProjection) -> TabState<'_> {
    TabState {
        tab: &tab.id,
        generation: tab.generation,
        view_generation: tab.view_generation,
        driver_generation: tab.driver_generation,
        interaction_generation: tab.interaction_generation,
        closed: tab.lifecycle == BrowserTabLifecycle::Closed,
    }
}

impl From<FenceError> for BrowserOperationError {
    fn from(error: FenceError) -> Self {
        match error {
            FenceError::Unauthorized => Self::Unauthorized,
            FenceError::TabClosed => Self::TabClosed,
            FenceError::StalePage => Self::StalePage,
        }
    }
}

impl NativeFence for Fence {
    fn check(&self, tab: &BrowserTabProjection) -> Result<(), BrowserOperationError> {
        self.validate(tab_state(tab)).map_err(Into::into)
    }
    fn check_view(&self, tab: &BrowserTabProjection) -> Result<(), BrowserOperationError> {
        self.validate_view(tab_state(tab)).map_err(Into::into)
    }
}

#[derive(uniffi::Object)]
pub struct BrowserEffectPermit {
    id: String,
    request: Weak<Request>,
    fence: Option<Fence>,
    stopped: AtomicBool,
    changed: Notify,
}

#[uniffi::export]
impl BrowserEffectPermit {
    pub fn effect_id(&self) -> String {
        self.id.clone()
    }
    pub fn check_active(&self) -> Result<(), BrowserOperationError> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(BrowserOperationError::Cancelled);
        }
        let request = self
            .request
            .upgrade()
            .ok_or(BrowserOperationError::Cancelled)?;
        request.check()?;
        if let Some(fence) = &self.fence {
            let tab = request.session.tab(fence.tab.clone())?;
            fence.check(&tab)?;
        }
        Ok(())
    }
}

impl BrowserEffectPermit {
    fn stop(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(request) = self.request.upgrade() {
            request.session.remove_effect(&self.id);
            let platform = request.coordinator.platform.clone();
            let id = self.id.clone();
            if let Ok(runtime) = crate::runtime() {
                runtime.spawn(async move {
                    platform.cancel(id);
                });
            }
        }
    }
}

pub(crate) struct Admission {
    session: Arc<BrowserOperationSession>,
    context: Option<Context>,
    parent: String,
    scope: (u64, Option<(u64, u64)>),
}

impl Admission {
    pub(crate) fn new(
        owner: &ReverseControlSession,
        parent: String,
        action: &BrowserAction,
        session: Arc<BrowserOperationSession>,
        scope: (u64, Option<(u64, u64)>),
    ) -> Result<Self, BrowserError> {
        if session.owner != BrowserOwner::from(owner) {
            return Err(error(BrowserOperationError::Unauthorized));
        }
        let context = session.admit(action.tab_id(), &parent).map_err(error)?;
        Ok(Self {
            session,
            context,
            parent,
            scope,
        })
    }

    pub(crate) async fn run(
        mut self,
        owner: Arc<ReverseControl>,
        identity: ReverseControlSession,
        action: BrowserAction,
    ) -> Result<Value, BrowserError> {
        let coordinator = registry()
            .lock()
            .upgrade()
            .filter(|coordinator| !coordinator.closed.load(Ordering::Acquire))
            .ok_or_else(|| error(BrowserOperationError::Unavailable))?;
        let request = Arc::new(Request {
            id: uuid::Uuid::new_v4().to_string(),
            coordinator: coordinator.clone(),
            owner: Arc::downgrade(&owner),
            owner_epoch: self.scope.0,
            transport: self.scope.1,
            identity,
            session: self.session.clone(),
            parent: self.parent.clone(),
            stopped: AtomicBool::new(false),
            route: Mutex::new(None),
            created: Mutex::default(),
            committed: AtomicBool::new(false),
            last_read: Mutex::new(None),
        });
        let _guard = RequestGuard(request.clone());
        coordinator
            .active
            .lock()
            .insert(request.id.clone(), Arc::downgrade(&request));
        self.session.wait_turn(&self.parent).await.map_err(error)?;
        request.check().map_err(error)?;
        let platform = coordinator.platform.clone();
        let identity = request.session.owner.clone();
        let activate_route = !matches!(
            action,
            BrowserAction::ListTabs(_) | BrowserAction::CloseTab(_)
        );
        request
            .effect(None, EFFECT_TIMEOUT, move |permit| {
                Box::pin(async move {
                    platform
                        .ensure_session(permit, identity, activate_route)
                        .await
                })
            })
            .await?;
        if activate_route {
            let epoch = self.session.route_epoch();
            *request.route.lock() = Some(epoch);
        }
        request.check().map_err(error)?;
        let context = match self.context.take() {
            Some(context) => context,
            None => self
                .session
                .initial_context(action.tab_id())
                .map_err(error)?,
        };
        if !context.tab_id.0.is_empty() {
            self.session
                .hold_tab(context.tab_id.0.clone(), self.parent.clone())
                .map_err(error)?;
        }
        request.check().map_err(error)?;
        let bridge: Arc<dyn Bridge> = Arc::new(OperationBridge {
            request: request.clone(),
        });
        let result = engine::run(
            bridge,
            &SessionId(request.identity.session_id.clone()),
            &self.parent,
            action,
            context,
        )
        .await;
        let result = result
            .and_then(|result| result.mcp())
            .unwrap_or_else(|error| error.mcp());
        request.finish(result);
        Ok(Value::Null)
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        self.session.release_lease(self.parent.clone());
    }
}

struct OperationBridge {
    request: Arc<Request>,
}

impl Bridge for OperationBridge {
    fn call(&self, operation: Primitive) -> BoxFuture<'_, Result<Value, BrowserError>> {
        Box::pin(self.perform(operation))
    }
}

struct Plan {
    tab_id: String,
    action: BrowserPlatformAction,
    identity: Option<String>,
    read: bool,
    prepare: bool,
    recover: bool,
}

impl OperationBridge {
    fn plan(&self, operation: &Primitive) -> Result<Plan, BrowserError> {
        let request = &self.request;
        let session = &request.session;
        let (tab_id, action, identity, read, prepare, recover) = match operation {
            Primitive::NewTab => {
                let tab = session.create_tab(false).map_err(error)?;
                request.created.lock().push(tab.id.clone());
                session
                    .hold_tab(tab.id.clone(), request.parent.clone())
                    .map_err(error)?;
                (
                    tab.id.clone(),
                    BrowserPlatformAction::CreateTab { tab_id: tab.id },
                    None,
                    false,
                    false,
                    false,
                )
            }
            Primitive::CloseTab { tab_id } => (
                tab_id.0.clone(),
                BrowserPlatformAction::CloseTab {
                    tab_id: tab_id.0.clone(),
                },
                None,
                false,
                false,
                false,
            ),
            Primitive::DocumentState { tab_id } => (
                tab_id.0.clone(),
                BrowserPlatformAction::Document {
                    tab_id: tab_id.0.clone(),
                },
                None,
                true,
                true,
                false,
            ),
            Primitive::Evaluate {
                tab_id,
                identity,
                js,
            } => (
                tab_id.0.clone(),
                BrowserPlatformAction::Evaluate {
                    tab_id: tab_id.0.clone(),
                    script: js.clone(),
                },
                Some(identity.clone()),
                true,
                true,
                false,
            ),
            Primitive::Navigate { tab_id, url } => (
                tab_id.0.clone(),
                BrowserPlatformAction::Navigate {
                    tab_id: tab_id.0.clone(),
                    url: url.clone(),
                },
                None,
                false,
                true,
                true,
            ),
            Primitive::Screenshot {
                tab_id,
                identity,
                annotations,
            } => (
                tab_id.0.clone(),
                BrowserPlatformAction::Screenshot {
                    tab_id: tab_id.0.clone(),
                    annotations_json: annotations.as_ref().map(Value::to_string),
                },
                Some(identity.clone()),
                true,
                true,
                false,
            ),
            Primitive::Download {
                tab_id,
                identity,
                url,
                max_bytes,
                ..
            } => (
                tab_id.0.clone(),
                BrowserPlatformAction::Download {
                    tab_id: tab_id.0.clone(),
                    url: url.clone(),
                    max_bytes: *max_bytes,
                },
                Some(identity.clone()),
                true,
                true,
                false,
            ),
            Primitive::Back { tab_id } => (
                tab_id.0.clone(),
                BrowserPlatformAction::Back {
                    tab_id: tab_id.0.clone(),
                },
                None,
                false,
                true,
                false,
            ),
            Primitive::Forward { tab_id } => (
                tab_id.0.clone(),
                BrowserPlatformAction::Forward {
                    tab_id: tab_id.0.clone(),
                },
                None,
                false,
                true,
                false,
            ),
            Primitive::Reload { tab_id } => (
                tab_id.0.clone(),
                BrowserPlatformAction::Reload {
                    tab_id: tab_id.0.clone(),
                },
                None,
                false,
                true,
                true,
            ),
            Primitive::ListTabs => return Err(invalid_result()),
        };

        Ok(Plan {
            tab_id,
            action,
            identity,
            read,
            prepare,
            recover,
        })
    }
    async fn perform(&self, operation: Primitive) -> Result<Value, BrowserError> {
        let request = &self.request;
        request.check().map_err(error)?;
        let session = &request.session;
        if matches!(operation, Primitive::ListTabs) {
            return Ok(session.tab_info());
        }

        let Plan {
            tab_id,
            action,
            identity,
            read,
            prepare,
            recover,
        } = self.plan(&operation)?;
        session
            .hold_tab(tab_id.clone(), request.parent.clone())
            .map_err(error)?;
        if prepare {
            let tab = session.tab(tab_id.clone()).map_err(error)?;
            if !recover
                && matches!(
                    tab.lifecycle,
                    BrowserTabLifecycle::Crashed | BrowserTabLifecycle::Cleared
                )
            {
                return Err(error(BrowserOperationError::Unavailable));
            }
            let resume = tab.lifecycle != BrowserTabLifecycle::Active;
            let tab = if resume {
                session
                    .change(tab_id.clone(), BrowserTabChange::Resume)
                    .map_err(error)?
            } else {
                tab
            };
            if resume || !tab.attached {
                let mut restoration = ResumeGuard {
                    session: session.clone(),
                    tab: tab_id.clone(),
                    view: tab.view_generation,
                    rollback: resume,
                };
                let fence = Fence {
                    tab: tab_id.clone(),
                    generation: None,
                    view_generation: tab.view_generation,
                    driver_generation: None,
                    interaction_generation: tab.interaction_generation,
                    allow_closed: false,
                };
                let platform = request.coordinator.platform.clone();
                let id = request.identity.session_id.clone();
                let target = tab_id.clone();
                let navigation = matches!(operation, Primitive::Navigate { .. });
                request
                    .effect(Some(fence), EFFECT_TIMEOUT, move |permit| {
                        Box::pin(async move {
                            platform
                                .prepare_tab(permit, id, target, resume, navigation)
                                .await
                        })
                    })
                    .await?;
                restoration.rollback = false;
            }
        }
        let mut tab = session.tab(tab_id.clone()).map_err(error)?;
        if identity.is_some_and(|identity| identity != document_identity(&tab)) {
            return Err(error(BrowserOperationError::StalePage));
        }
        if matches!(operation, Primitive::CloseTab { .. }) {
            session.close_tab(tab_id.clone()).map_err(error)?;
            tab = session.tab(tab_id.clone()).map_err(error)?;
        }
        let fence = Fence {
            tab: tab_id.clone(),
            generation: read.then_some(tab.generation),
            view_generation: tab.view_generation,
            driver_generation: prepare.then_some(tab.driver_generation),
            interaction_generation: tab.interaction_generation,
            allow_closed: matches!(operation, Primitive::CloseTab { .. }),
        };
        let platform = request.coordinator.platform.clone();
        let id = request.identity.session_id.clone();
        let duration = if matches!(operation, Primitive::Download { .. }) {
            DOWNLOAD_EFFECT_TIMEOUT
        } else {
            EFFECT_TIMEOUT
        };
        let result = request
            .effect(Some(fence.clone()), duration, move |permit| {
                Box::pin(async move { platform.perform(permit, id, action).await })
            })
            .await;
        if result.is_err() && matches!(operation, Primitive::NewTab) {
            let _ = session.close_tab(tab_id.clone());
        }
        let result = result?;
        if read {
            *request.last_read.lock() = Some(fence);
        }
        match (operation, result) {
            (Primitive::NewTab, BrowserPlatformResult::Done) => Ok(json!({"tab_id":tab_id})),
            (Primitive::CloseTab { .. }, BrowserPlatformResult::Done) => Ok(json!({"closed":true})),
            (Primitive::DocumentState { .. }, BrowserPlatformResult::Document { document }) => {
                for url in [&document.url, &document.public_url] {
                    if url != "about:blank" {
                        super::model::validate_url(url).map_err(|_| invalid_result())?;
                    }
                }
                if document.id.is_empty() || document.id.len() > 1024 {
                    return Err(invalid_result());
                }
                Ok(
                    json!({"id":document.id,"url":document.url,"public_url":session::public_url(&document.public_url),"ready":document.ready,"identity":document_identity(&tab)}),
                )
            }
            (Primitive::Evaluate { .. }, BrowserPlatformResult::Json { value_json }) => {
                if value_json.len() > super::model::MAX_IMAGE_RESULT {
                    return Err(BrowserError::new(
                        ErrorCode::ResultTooLarge,
                        "Browser response too large",
                    ));
                }
                serde_json::from_str(&value_json).map_err(|_| invalid_result())
            }
            (
                Primitive::Navigate { .. }
                | Primitive::Back { .. }
                | Primitive::Forward { .. }
                | Primitive::Reload { .. },
                BrowserPlatformResult::Navigation { target, navigated },
            ) => Ok(json!({"target":target,"navigated":navigated})),
            (Primitive::Screenshot { .. }, BrowserPlatformResult::Image { image }) => {
                Ok(json!({"image":image}))
            }
            (
                Primitive::Download {
                    destination_path,
                    max_bytes,
                    ..
                },
                BrowserPlatformResult::Download {
                    local_path,
                    bytes,
                    mime_type,
                },
            ) => {
                let value = json!({"local_path":local_path,"bytes":bytes,"mime_type":mime_type});
                let _cleanup = crate::reverse_control::download::cleanup_guard(&value, max_bytes)?;
                let owner = request
                    .owner
                    .upgrade()
                    .ok_or_else(|| error(BrowserOperationError::SessionClosed))?;
                let ssh = owner
                    .bridge
                    .lock()
                    .as_ref()
                    .and_then(|bridge| bridge.transport.as_ref())
                    .map(|transport| transport.ssh.clone())
                    .filter(|ssh| ssh.is_alive())
                    .ok_or_else(|| {
                        BrowserError::new(
                            ErrorCode::DownloadFailed,
                            "Download requires a connected SSH host",
                        )
                    })?;
                let fence = Fence {
                    tab: tab.id,
                    generation: Some(tab.generation),
                    view_generation: tab.view_generation,
                    driver_generation: Some(tab.driver_generation),
                    interaction_generation: tab.interaction_generation,
                    allow_closed: false,
                };
                request
                    .effect(Some(fence), DOWNLOAD_EFFECT_TIMEOUT, move |_| {
                        Box::pin(async move {
                            crate::reverse_control::download::transfer(
                                ssh,
                                value,
                                &destination_path,
                                max_bytes,
                            )
                            .await
                            .map_err(|_| BrowserPlatformError::DownloadFailed)
                        })
                    })
                    .await
            }
            _ => Err(invalid_result()),
        }
    }
}

struct ResumeGuard {
    session: Arc<BrowserOperationSession>,
    tab: String,
    view: u64,
    rollback: bool,
}
impl Drop for ResumeGuard {
    fn drop(&mut self) {
        if self.rollback {
            self.session.rollback_resume(&self.tab, self.view);
        }
    }
}

fn document_identity(tab: &BrowserTabProjection) -> String {
    format!("{}-{}", tab.id, tab.generation)
}
fn invalid_result() -> BrowserError {
    BrowserError::new(ErrorCode::InvalidResult, "Invalid browser platform result")
}
fn platform_error(failure: BrowserPlatformError) -> BrowserError {
    BrowserError::new(
        match failure {
            BrowserPlatformError::Unavailable => ErrorCode::BrowserUnavailable,
            BrowserPlatformError::EvalFailed => ErrorCode::EvalFailed,
            BrowserPlatformError::DownloadFailed => ErrorCode::DownloadFailed,
        },
        failure.to_string(),
    )
}
pub(crate) fn error(failure: BrowserOperationError) -> BrowserError {
    BrowserError::new(
        match failure {
            BrowserOperationError::Cancelled => ErrorCode::Cancelled,
            BrowserOperationError::Unauthorized => ErrorCode::Unauthorized,
            BrowserOperationError::SessionClosed => ErrorCode::SessionClosed,
            BrowserOperationError::TabClosed => ErrorCode::TabClosed,
            BrowserOperationError::StalePage => ErrorCode::StalePage,
            BrowserOperationError::Unavailable => ErrorCode::BrowserUnavailable,
        },
        failure.to_string(),
    )
}

#[cfg(test)]
pub(crate) mod tests;
