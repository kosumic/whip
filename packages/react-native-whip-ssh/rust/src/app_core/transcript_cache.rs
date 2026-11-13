//! Device-wide admission policy over the existing native transcript owners.
//! No transcript bodies cross this API: React only adopts admitted bindings.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};

use parking_lot::Mutex;

use super::AppCore;
use crate::agent_sessions::{AgentBindingIdentity, AgentSessionManager};
use crate::host_runtime::HostRuntime;

const DEFAULT_CAPACITY: u32 = 20;
const MIN_CAPACITY: u32 = 3;

mod policy;

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TranscriptCacheBinding {
    pub host_session_id: String,
    pub terminal_id: String,
    pub binding_token: String,
    pub runtime_incarnation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TranscriptCacheSnapshot {
    pub revision: u64,
    pub bindings: Vec<TranscriptCacheBinding>,
}

#[uniffi::export(with_foreign)]
pub trait TranscriptCacheListener: Send + Sync {
    fn changed(&self);
}

#[derive(Clone)]
enum Pin {
    Foreground(String, String),
    Subscription(String),
}

#[derive(Clone)]
struct Host {
    id: String,
    runtime: Arc<HostRuntime>,
    attached: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Failure {
    incarnation: u64,
    generation: u64,
    terminal: String,
    pane: String,
    transcript_key: String,
}

type Identity = (u64, String);

#[derive(Default)]
struct State {
    next_token: u64,
    revision: u64,
    clock: u64,
    owners: Vec<(u64, u64)>,
    pins: HashMap<u64, (u64, Pin)>,
    listeners: HashMap<u64, Arc<dyn TranscriptCacheListener>>,
    hosts: Vec<Host>,
    failures: HashSet<Failure>,
    starting: HashSet<String>,
    start_errors: HashSet<String>,
    used: HashMap<Identity, u64>,
    bindings: Vec<TranscriptCacheBinding>,
    capacity: u32,
    sources: HashMap<u64, (Weak<AppCore>, u32)>,
    last_core: Weak<AppCore>,
    awaiting_restore: bool,
}

impl State {
    fn token(&mut self) -> u64 {
        self.next_token += 1;
        self.next_token
    }

    fn pinned(&self, host: &str, binding: &AgentBindingIdentity) -> bool {
        self.pins.values().any(|(_, pin)| match pin {
            Pin::Foreground(id, terminal) => id == host && terminal == binding.terminal_id.as_str(),
            Pin::Subscription(token) => token == &binding.binding_token,
        })
    }

    fn snapshot(&self) -> TranscriptCacheSnapshot {
        TranscriptCacheSnapshot {
            revision: self.revision,
            bindings: self.bindings.clone(),
        }
    }
}

#[derive(Default)]
struct Coordinator {
    // Serialize admission, eviction and owner replacement. Never call foreign
    // listeners while holding either mutex.
    reconciliation: Mutex<()>,
    state: Mutex<State>,
    scheduled: AtomicBool,
    dirty: AtomicBool,
}

static CACHE: OnceLock<Arc<Coordinator>> = OnceLock::new();

fn shared() -> Arc<Coordinator> {
    CACHE
        .get_or_init(|| Arc::new(Coordinator::default()))
        .clone()
}

pub(crate) fn transcript_cache_changed() {
    let Some(cache) = CACHE.get() else { return };
    cache.schedule();
    notify_listeners(cache);
}

fn notify_listeners(cache: &Coordinator) {
    let listeners = cache
        .state
        .lock()
        .listeners
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for listener in listeners {
        listener.changed();
    }
}

pub(crate) fn clear_transcript_cache_ui() {
    let Some(cache) = CACHE.get() else { return };
    let mut state = cache.state.lock();
    state.listeners.clear();
    state.owners.clear();
    state.pins.clear();
    state.sources.clear();
    // Native residents survive a bridge reload; the new bridge adopts them.
}

pub(crate) fn transcript_preload_allowed(runtime: &HostRuntime, terminal: &str) -> bool {
    let Some(cache) = CACHE.get() else {
        return false;
    };
    let state = cache.state.lock();
    let id = runtime.runtime_id();
    let incarnation = runtime.runtime_incarnation();
    let generation = runtime.host_state().connection_generation;
    !state.failures.iter().any(|failure| failure.incarnation == incarnation && failure.generation == generation && failure.terminal == terminal)
        && state.pins.values().any(|(_, pin)| matches!(pin, Pin::Foreground(host, target) if host == &id && target == terminal))
}

pub(crate) fn transcript_chat_opened(runtime: &HostRuntime, terminal: &str) {
    shared().requested(runtime, terminal);
    transcript_cache_changed();
}

pub(crate) fn start_transcript_preload(manager: AgentSessionManager, token: String) {
    let cache = shared();
    let mut state = cache.state.lock();
    let should_start = !state.start_errors.contains(&token)
        && manager.binding_needs_start(&token)
        && state.starting.insert(token.clone());
    drop(state);
    if should_start {
        start(cache, manager, token);
    }
}

fn start(cache: Arc<Coordinator>, manager: AgentSessionManager, token: String) {
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            let result = manager.start_bound(&token).await;
            let mut state = cache.state.lock();
            if !matches!(result, Ok(crate::AgentChatStartResult::Started { .. })) {
                state.start_errors.insert(token.clone());
            }
            state.starting.remove(&token);
            drop(state);
            transcript_cache_changed();
        });
    } else {
        cache.state.lock().starting.remove(&token);
    }
}

/// One bridge's leases over a process-owned cache. Dropping the bridge removes
/// its foreign callbacks and pins without destroying native conversation state.
#[derive(uniffi::Object)]
pub struct TranscriptCache {
    coordinator: Arc<Coordinator>,
    bridge: u64,
}

impl Drop for TranscriptCache {
    fn drop(&mut self) {
        let mut state = self.coordinator.state.lock();
        state.listeners.remove(&self.bridge);
        state.owners.retain(|(_, bridge)| *bridge != self.bridge);
        state.pins.retain(|_, (bridge, _)| *bridge != self.bridge);
        let owners = state
            .owners
            .iter()
            .map(|(token, _)| *token)
            .collect::<HashSet<_>>();
        state.sources.retain(|owner, _| owners.contains(owner));
        drop(state);
        transcript_cache_changed();
    }
}

#[uniffi::export]
impl TranscriptCache {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        let coordinator = shared();
        let bridge = coordinator.state.lock().token();
        Arc::new(Self {
            coordinator,
            bridge,
        })
    }

    pub fn set_listener(&self, listener: Arc<dyn TranscriptCacheListener>) {
        self.coordinator
            .state
            .lock()
            .listeners
            .insert(self.bridge, listener);
    }

    pub fn claim_owner(&self) -> u64 {
        let mut state = self.coordinator.state.lock();
        let token = state.token();
        state.owners.push((token, self.bridge));
        token
    }

    pub fn owner_is_current(&self, token: u64) -> bool {
        self.coordinator.state.lock().owners.last() == Some(&(token, self.bridge))
    }

    pub fn retain_foreground_terminal(&self, host: String, terminal: String) -> u64 {
        self.retain(Pin::Foreground(host, terminal))
    }

    pub fn retain_subscription(&self, binding_token: String) -> u64 {
        self.retain(Pin::Subscription(binding_token))
    }

    pub fn release(&self, token: u64) {
        let mut state = self.coordinator.state.lock();
        if state.owners.contains(&(token, self.bridge)) {
            state.owners.retain(|entry| *entry != (token, self.bridge));
            state.sources.remove(&token);
        }
        if state
            .pins
            .get(&token)
            .is_some_and(|(bridge, _)| *bridge == self.bridge)
        {
            state.pins.remove(&token);
        }
        drop(state);
        transcript_cache_changed();
    }

    /// Reconcile native snapshots and the unfiltered, cross-host Herd ranking.
    /// Superseded React surfaces cannot overwrite the current owner's hosts.
    pub fn reconcile(
        &self,
        core: Arc<AppCore>,
        owner: u64,
        capacity: u32,
    ) -> Option<TranscriptCacheSnapshot> {
        self.coordinator
            .reconcile(core, owner, self.bridge, capacity)
    }
}

impl TranscriptCache {
    fn retain(&self, pin: Pin) -> u64 {
        let mut state = self.coordinator.state.lock();
        let token = state.token();
        state.pins.insert(token, (self.bridge, pin));
        drop(state);
        transcript_cache_changed();
        token
    }
}

impl Coordinator {
    fn requested(&self, runtime: &HostRuntime, terminal: &str) {
        let binding = runtime
            .transcript_manager()
            .terminal_binding_metadata(terminal);
        let mut state = self.state.lock();
        let incarnation = runtime.runtime_incarnation();
        state
            .failures
            .retain(|failure| failure.incarnation != incarnation || failure.terminal != terminal);
        if let Some(binding) = binding {
            state.start_errors.remove(&binding.binding_token);
            state.clock += 1;
            let clock = state.clock;
            state
                .used
                .insert((incarnation, binding.transcript_key.into()), clock);
        }
        drop(state);
    }

    fn reconcile(
        self: &Arc<Self>,
        core: Arc<AppCore>,
        owner: u64,
        bridge: u64,
        capacity: u32,
    ) -> Option<TranscriptCacheSnapshot> {
        let _reconciliation = self.reconciliation.lock();
        if self.state.lock().owners.last() != Some(&(owner, bridge)) {
            return None;
        }
        let (retained, previous_core, awaiting_restore) = {
            let state = self.state.lock();
            (
                state.hosts.clone(),
                state.last_core.clone(),
                state.awaiting_restore,
            )
        };
        let (hosts, order, handoff) = {
            let mut app = core.state.lock();
            let handoff = app.sessions.is_empty()
                && !app.restore_can_persist
                && (awaiting_restore || !Weak::ptr_eq(&previous_core, &Arc::downgrade(&core)));
            let herd = super::herd::project(&mut app, vec![], None, None);
            let mut hosts = app
                .sessions
                .iter()
                .filter_map(|session| {
                    Some(Host {
                        id: session.id.clone(),
                        runtime: session.runtime.clone().or_else(|| {
                            retained
                                .iter()
                                .find(|host| host.id == session.id)
                                .map(|host| host.runtime.clone())
                        })?,
                        attached: session.runtime.is_some(),
                    })
                })
                .collect::<Vec<_>>();
            drop(app);
            if handoff {
                hosts = retained
                    .into_iter()
                    .map(|mut host| {
                        host.attached = false;
                        host
                    })
                    .collect();
            }
            let order = herd
                .agents
                .into_iter()
                .map(|agent| (agent.host_id, agent.agent.terminal_id))
                .collect::<Vec<_>>();
            (hosts, order, handoff)
        };
        let (snapshot, starts) = self.reconcile_hosts(hosts, order, capacity, owner, bridge)?;
        for (manager, token) in starts {
            start(self.clone(), manager, token);
        }
        let mut state = self.state.lock();
        if state.owners.last() == Some(&(owner, bridge)) {
            state
                .sources
                .insert(owner, (Arc::downgrade(&core), capacity));
            state.last_core = Arc::downgrade(&core);
            state.awaiting_restore = handoff;
        }
        drop(state);
        Some(snapshot)
    }

    fn schedule(self: &Arc<Self>) {
        {
            let state = self.state.lock();
            let available = state.owners.last().is_some_and(|(owner, _)| {
                state
                    .sources
                    .get(owner)
                    .is_some_and(|(core, _)| core.strong_count() > 0)
            });
            drop(state);
            if !available {
                return;
            }
        }
        self.dirty.store(true, Ordering::Release);
        if self.scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        let Ok(runtime) = crate::runtime() else {
            self.scheduled.store(false, Ordering::Release);
            return;
        };
        let cache = self.clone();
        runtime.spawn(async move {
            tokio::task::yield_now().await;
            while cache.dirty.swap(false, Ordering::AcqRel) {
                let worker = cache.clone();
                let _ = tokio::task::spawn_blocking(move || worker.reconcile_background()).await;
            }
            cache.scheduled.store(false, Ordering::Release);
            if cache.dirty.load(Ordering::Acquire) {
                cache.schedule();
            }
        });
    }

    fn reconcile_background(self: &Arc<Self>) {
        let source = {
            let state = self.state.lock();
            state.owners.last().and_then(|(owner, bridge)| {
                let (core, capacity) = state.sources.get(owner)?;
                Some((core.upgrade()?, *owner, *bridge, *capacity, state.revision))
            })
        };
        if let Some((core, owner, bridge, capacity, previous_revision)) = source
            && let Some(snapshot) = self.reconcile(core, owner, bridge, capacity)
            && snapshot.revision != previous_revision
        {
            notify_listeners(self);
        }
    }
}
