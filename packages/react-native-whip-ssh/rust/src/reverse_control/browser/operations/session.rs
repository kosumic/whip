use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, OnceLock, Weak};

use parking_lot::Mutex;
use serde_json::json;

use super::{
    BrowserEffectPermit, BrowserOperationError, BrowserOwner, BrowserTabChange,
    BrowserTabLifecycle, BrowserTabProjection,
};
use crate::reverse_control::browser::{
    engine::Context,
    model::{TabId, TabInfo},
};

static SESSIONS: OnceLock<Mutex<HashMap<String, Weak<BrowserOperationSession>>>> = OnceLock::new();

struct State {
    closed: bool,
    ready: bool,
    initial: Option<Context>,
    sequence: u64,
    route_epoch: u64,
    selected: Option<String>,
    tabs: Vec<BrowserTabProjection>,
    queue: VecDeque<String>,
    leases: HashMap<String, HashSet<String>>,
    effects: HashMap<String, Weak<BrowserEffectPermit>>,
}

#[derive(uniffi::Object)]
pub struct BrowserOperationSession {
    pub(super) owner: BrowserOwner,
    state: Mutex<State>,
    queue_changed: tokio::sync::Notify,
}

#[uniffi::export]
impl BrowserOperationSession {
    #[uniffi::constructor]
    pub fn new(owner: BrowserOwner) -> Result<Arc<Self>, BrowserOperationError> {
        let mut sessions = SESSIONS.get_or_init(Mutex::default).lock();
        if let Some(existing) = sessions.get(&owner.session_id).and_then(Weak::upgrade)
            && !existing.state.lock().closed
        {
            return if existing.owner == owner {
                Ok(existing)
            } else {
                Err(BrowserOperationError::Unauthorized)
            };
        }
        let session = Arc::new(Self {
            owner,
            state: Mutex::new(State {
                closed: false,
                ready: false,
                initial: None,
                sequence: 0,
                route_epoch: 0,
                selected: None,
                tabs: vec![],
                queue: VecDeque::new(),
                leases: HashMap::new(),
                effects: HashMap::new(),
            }),
            queue_changed: tokio::sync::Notify::new(),
        });
        sessions.insert(session.owner.session_id.clone(), Arc::downgrade(&session));
        drop(sessions);
        Ok(session)
    }

    pub fn initialize(&self) {
        let mut state = self.state.lock();
        if state.ready || state.closed {
            return;
        }
        state.initial = Self::context_locked(&state, None).ok();
        if let Some(selected) = state
            .initial
            .as_ref()
            .map(|context| context.tab_id.0.clone())
            .filter(|id| !id.is_empty())
        {
            let requests = state.queue.iter().cloned().collect::<Vec<_>>();
            for request in requests {
                state
                    .leases
                    .entry(request)
                    .or_default()
                    .insert(selected.clone());
            }
        }
        state.ready = true;
    }

    pub fn tabs(&self) -> Vec<BrowserTabProjection> {
        self.state
            .lock()
            .tabs
            .iter()
            .filter(|tab| tab.lifecycle != BrowserTabLifecycle::Closed)
            .cloned()
            .collect()
    }

    pub fn tab(&self, id: String) -> Result<BrowserTabProjection, BrowserOperationError> {
        self.state
            .lock()
            .tabs
            .iter()
            .find(|tab| tab.id == id)
            .cloned()
            .ok_or(BrowserOperationError::TabClosed)
    }

    pub fn initial_tab(&self, active: bool) -> Result<BrowserTabProjection, BrowserOperationError> {
        if let Some(tab) = self.tabs().into_iter().next() {
            return Ok(tab);
        }
        self.create_tab(active)
    }

    pub fn create_tab(&self, active: bool) -> Result<BrowserTabProjection, BrowserOperationError> {
        let mut state = self.state.lock();
        if state.closed {
            return Err(BrowserOperationError::SessionClosed);
        }
        state.sequence = state.sequence.wrapping_add(1);
        let tab = BrowserTabProjection {
            id: format!(
                "{}-tab-{}-{}",
                self.owner.session_id,
                state.sequence,
                uuid::Uuid::new_v4()
            ),
            generation: 0,
            view_generation: 0,
            lifecycle: if active {
                BrowserTabLifecycle::Active
            } else {
                BrowserTabLifecycle::Suspended
            },
            driver_generation: 0,
            interaction_generation: 0,
            attached: false,
            url: "about:blank".into(),
            title: String::new(),
        };
        state.selected = Some(tab.id.clone());
        state.tabs.push(tab.clone());
        drop(state);
        Ok(tab)
    }

    pub fn selected_tab(&self) -> Option<String> {
        self.state.lock().selected.clone()
    }

    pub fn select(&self, id: String) -> Result<(), BrowserOperationError> {
        let mut state = self.state.lock();
        if state.closed {
            return Err(BrowserOperationError::SessionClosed);
        }
        if !state
            .tabs
            .iter()
            .any(|tab| tab.id == id && tab.lifecycle != BrowserTabLifecycle::Closed)
        {
            return Err(BrowserOperationError::TabClosed);
        }
        state.selected = Some(id);
        drop(state);
        Ok(())
    }

    pub fn change(
        &self,
        id: String,
        change: BrowserTabChange,
    ) -> Result<BrowserTabProjection, BrowserOperationError> {
        let projection = {
            let mut state = self.state.lock();
            if state.closed {
                return Err(BrowserOperationError::SessionClosed);
            }
            if change == BrowserTabChange::Route {
                state.route_epoch = state.route_epoch.wrapping_add(1);
            }
            let tab = state
                .tabs
                .iter_mut()
                .find(|tab| tab.id == id && tab.lifecycle != BrowserTabLifecycle::Closed)
                .ok_or(BrowserOperationError::TabClosed)?;
            if !matches!(
                change,
                BrowserTabChange::ReserveView
                    | BrowserTabChange::ClearFinished
                    | BrowserTabChange::UserAction
            ) {
                tab.generation = tab.generation.wrapping_add(1);
            }
            if change == BrowserTabChange::UserAction {
                tab.interaction_generation = tab.interaction_generation.wrapping_add(1);
            }
            if matches!(
                change,
                BrowserTabChange::ProcessRestart | BrowserTabChange::Clear
            ) {
                tab.driver_generation = tab.driver_generation.wrapping_add(1);
            }
            if matches!(
                change,
                BrowserTabChange::Route
                    | BrowserTabChange::Crash
                    | BrowserTabChange::Suspend
                    | BrowserTabChange::Resume
                    | BrowserTabChange::ClearFinished
            ) {
                tab.view_generation = tab.view_generation.wrapping_add(1);
            }
            if matches!(
                change,
                BrowserTabChange::Route
                    | BrowserTabChange::Crash
                    | BrowserTabChange::Suspend
                    | BrowserTabChange::Resume
                    | BrowserTabChange::Clear
            ) {
                tab.attached = false;
            }
            match change {
                BrowserTabChange::Crash => tab.lifecycle = BrowserTabLifecycle::Crashed,
                BrowserTabChange::Suspend => tab.lifecycle = BrowserTabLifecycle::Suspended,
                BrowserTabChange::Resume | BrowserTabChange::ReserveView => {
                    tab.lifecycle = BrowserTabLifecycle::Active;
                }
                BrowserTabChange::Clear | BrowserTabChange::ClearFinished => {
                    tab.lifecycle = BrowserTabLifecycle::Cleared;
                }
                BrowserTabChange::Document
                | BrowserTabChange::Route
                | BrowserTabChange::UserAction
                | BrowserTabChange::ProcessRestart => {}
            }
            let projection = tab.clone();
            drop(state);
            projection
        };
        self.wake();
        Ok(projection)
    }

    pub fn location(
        &self,
        id: String,
        url: String,
        title: String,
    ) -> Result<BrowserTabProjection, BrowserOperationError> {
        let projection = {
            let mut state = self.state.lock();
            let tab = state
                .tabs
                .iter_mut()
                .find(|tab| tab.id == id && tab.lifecycle != BrowserTabLifecycle::Closed)
                .ok_or(BrowserOperationError::TabClosed)?;
            if tab.url != url {
                tab.generation = tab.generation.wrapping_add(1);
            }
            tab.url = url;
            tab.title = title;
            let projection = tab.clone();
            drop(state);
            projection
        };
        self.wake();
        Ok(projection)
    }

    pub fn close_tab(&self, id: String) -> Result<(), BrowserOperationError> {
        let mut state = self.state.lock();
        let tab = state
            .tabs
            .iter_mut()
            .find(|tab| tab.id == id)
            .ok_or(BrowserOperationError::TabClosed)?;
        if tab.lifecycle != BrowserTabLifecycle::Closed {
            tab.generation = tab.generation.wrapping_add(1);
            tab.view_generation = tab.view_generation.wrapping_add(1);
            tab.lifecycle = BrowserTabLifecycle::Closed;
        }
        if state.selected.as_ref() == Some(&id) {
            state.selected = state
                .tabs
                .iter()
                .find(|tab| tab.lifecycle != BrowserTabLifecycle::Closed)
                .map(|tab| tab.id.clone());
        }
        drop(state);
        self.wake();
        Ok(())
    }

    pub fn hold_tab(&self, tab_id: String, lease: String) -> Result<(), BrowserOperationError> {
        let mut state = self.state.lock();
        if state.closed {
            return Err(BrowserOperationError::SessionClosed);
        }
        if !state
            .tabs
            .iter()
            .any(|tab| tab.id == tab_id && tab.lifecycle != BrowserTabLifecycle::Closed)
        {
            return Err(BrowserOperationError::TabClosed);
        }
        state.leases.entry(lease).or_default().insert(tab_id);
        drop(state);
        Ok(())
    }

    pub fn release_lease(&self, lease: String) {
        let mut state = self.state.lock();
        state.leases.remove(&lease);
        state.queue.retain(|request| request != &lease);
        drop(state);
        self.queue_changed.notify_waiters();
    }
    pub fn new_lease(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    pub fn set_driver_attached(
        &self,
        id: String,
        attached: bool,
    ) -> Result<(), BrowserOperationError> {
        let mut state = self.state.lock();
        let tab = state
            .tabs
            .iter_mut()
            .find(|tab| tab.id == id && tab.lifecycle != BrowserTabLifecycle::Closed)
            .ok_or(BrowserOperationError::TabClosed)?;
        tab.attached = attached;
        tab.driver_generation = tab.driver_generation.wrapping_add(1);
        drop(state);
        self.wake();
        Ok(())
    }

    pub fn can_suspend(&self, tab_id: String) -> bool {
        let state = self.state.lock();
        state
            .tabs
            .iter()
            .any(|tab| tab.id == tab_id && tab.lifecycle == BrowserTabLifecycle::Active)
            && !state.leases.values().any(|tabs| tabs.contains(&tab_id))
    }

    pub fn close(&self) {
        let mut state = self.state.lock();
        state.closed = true;
        state.selected = None;
        for tab in &mut state.tabs {
            if tab.lifecycle != BrowserTabLifecycle::Closed {
                tab.generation = tab.generation.wrapping_add(1);
                tab.view_generation = tab.view_generation.wrapping_add(1);
                tab.lifecycle = BrowserTabLifecycle::Closed;
                tab.attached = false;
            }
        }
        drop(state);
        self.wake();
    }
}

impl BrowserOperationSession {
    pub(super) fn admit(
        &self,
        requested: Option<&TabId>,
        parent: &str,
    ) -> Result<Option<Context>, BrowserOperationError> {
        let mut state = self.state.lock();
        if state.closed {
            return Err(BrowserOperationError::SessionClosed);
        }
        let context = state
            .ready
            .then(|| Self::context_locked(&state, requested))
            .transpose()?;
        if let Some(context) = &context
            && !context.tab_id.0.is_empty()
        {
            state
                .leases
                .entry(parent.to_owned())
                .or_default()
                .insert(context.tab_id.0.clone());
        }
        state.queue.push_back(parent.to_owned());
        drop(state);
        Ok(context)
    }

    pub(super) async fn wait_turn(&self, parent: &str) -> Result<(), BrowserOperationError> {
        loop {
            let changed = self.queue_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let state = self.state.lock();
                if state.closed {
                    return Err(BrowserOperationError::SessionClosed);
                }
                if state.queue.front().is_some_and(|request| request == parent) {
                    return Ok(());
                }
                if !state.queue.iter().any(|request| request == parent) {
                    return Err(BrowserOperationError::Cancelled);
                }
            }
            changed.await;
        }
    }

    pub(super) fn live(&self) -> bool {
        !self.state.lock().closed
    }
    pub(super) fn route_epoch(&self) -> u64 {
        self.state.lock().route_epoch
    }
    pub(super) fn rollback_resume(&self, id: &str, view: u64) {
        let mut state = self.state.lock();
        if let Some(tab) = state.tabs.iter_mut().find(|tab| {
            tab.id == id
                && tab.view_generation == view
                && tab.lifecycle == BrowserTabLifecycle::Active
        }) {
            tab.generation = tab.generation.wrapping_add(1);
            tab.view_generation = tab.view_generation.wrapping_add(1);
            tab.lifecycle = BrowserTabLifecycle::Suspended;
            tab.attached = false;
        }
        drop(state);
        self.wake();
    }
    pub(super) fn context(
        &self,
        requested: Option<&TabId>,
    ) -> Result<Context, BrowserOperationError> {
        let state = self.state.lock();
        Self::context_locked(&state, requested)
    }
    pub(super) fn initial_context(
        &self,
        requested: Option<&TabId>,
    ) -> Result<Context, BrowserOperationError> {
        let state = self.state.lock();
        if state.closed {
            return Err(BrowserOperationError::SessionClosed);
        }
        let mut context = state
            .initial
            .clone()
            .ok_or(BrowserOperationError::Unavailable)?;
        drop(state);
        if let Some(id) = requested {
            context.tab_id = id.clone();
        }
        Ok(context)
    }
    fn context_locked(
        state: &State,
        requested: Option<&TabId>,
    ) -> Result<Context, BrowserOperationError> {
        if state.closed {
            return Err(BrowserOperationError::SessionClosed);
        }
        let tab_id = requested
            .map(|id| id.0.clone())
            .or_else(|| state.selected.clone())
            .unwrap_or_default();
        if !tab_id.is_empty()
            && !state
                .tabs
                .iter()
                .any(|tab| tab.id == tab_id && tab.lifecycle != BrowserTabLifecycle::Closed)
        {
            return Err(BrowserOperationError::TabClosed);
        }
        let tabs = state
            .tabs
            .iter()
            .filter(|tab| tab.lifecycle != BrowserTabLifecycle::Closed)
            .map(|tab| TabInfo {
                tab_id: TabId(tab.id.clone()),
                url: public_url(&tab.url),
                title: tab.title.chars().take(160).collect(),
                selected: state.selected.as_ref() == Some(&tab.id),
            })
            .collect();
        Ok(Context {
            tab_id: TabId(tab_id),
            tabs,
        })
    }
    pub(super) fn add_effect(&self, permit: &Arc<BrowserEffectPermit>) {
        self.state
            .lock()
            .effects
            .insert(permit.id.clone(), Arc::downgrade(permit));
    }
    pub(super) fn remove_effect(&self, id: &str) {
        self.state.lock().effects.remove(id);
    }
    pub(super) fn wake(&self) {
        self.queue_changed.notify_waiters();
        let effects = self
            .state
            .lock()
            .effects
            .values()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        for effect in effects {
            effect.changed.notify_waiters();
        }
    }
    pub(super) fn tab_info(&self) -> serde_json::Value {
        json!({"tabs":self.context(None).map(|context|context.tabs).unwrap_or_default()})
    }
    pub(super) fn with_live<T>(
        &self,
        call: impl FnOnce(u64, &[BrowserTabProjection]) -> T,
    ) -> Result<T, BrowserOperationError> {
        let state = self.state.lock();
        if state.closed {
            return Err(BrowserOperationError::SessionClosed);
        }
        let result = call(state.route_epoch, &state.tabs);
        drop(state);
        Ok(result)
    }
}

pub(super) fn public_url(value: &str) -> String {
    if value == "about:blank" {
        return value.into();
    }
    url::Url::parse(value).map_or_else(
        |_| "about:blank".into(),
        |url| format!("{}{}", url.origin().ascii_serialization(), url.path()),
    )
}
