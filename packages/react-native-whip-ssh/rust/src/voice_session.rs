//! One process-wide authority for call admission, replacement and cancellation.
//! React consumes effects; platform acknowledgements fence audio acquisition.
mod state;
use crate::host_runtime::{
    realtime_agent::PinnedAgent,
    realtime_terminal::{PinnedTerminal, TerminalTarget},
};
use crate::{VoiceChat, realtime_voice::RealtimeVoiceAdapter};
use parking_lot::Mutex;
use serde_json::{Value, json};
pub(crate) use state::Source;
use state::{Ack, Mode, Phase, Request, Scope, State};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, LazyLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const EFFECT_VERSION: u8 = 1;
const MAX_TOKEN_BYTES: usize = 256;

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum VoiceSessionError {
    #[error("Invalid voice session command. Install a matching Whip build.")]
    InvalidCommand,
    #[error("The voice call was cancelled or its destination changed.")]
    Cancelled,
}
#[uniffi::export(with_foreign)]
pub trait VoiceSessionObserver: Send + Sync {
    fn changed(&self);
}

#[derive(Clone)]
enum Resource {
    Local(Arc<VoiceChat>),
    Realtime(Arc<RealtimeVoiceAdapter>),
}
impl Resource {
    fn cancel(&self) {
        match self {
            Self::Local(call) => call.close(),
            Self::Realtime(call) => call.close(),
        }
    }
}
#[derive(Default)]
struct Observation {
    revision: u64,
    view: Value,
    waiting: bool,
}
#[derive(Default)]
struct Inner {
    state: State,
    resources: HashMap<String, Resource>,
    observations: HashMap<String, Observation>,
    submissions: HashMap<String, VecDeque<String>>,
    pins: HashMap<String, Pin>,
}
#[derive(Clone)]
enum Pin {
    Agent(Arc<PinnedAgent>),
    Terminal(Arc<PinnedTerminal>),
}

#[derive(Default, uniffi::Object)]
pub struct VoiceSessionCoordinator {
    inner: Mutex<Inner>,
    observer: Mutex<Option<Arc<dyn VoiceSessionObserver>>>,
    notified: AtomicBool,
}
static COORDINATOR: LazyLock<Arc<VoiceSessionCoordinator>> =
    LazyLock::new(|| Arc::new(VoiceSessionCoordinator::default()));

#[uniffi::export]
pub fn voice_session_coordinator() -> Arc<VoiceSessionCoordinator> {
    COORDINATOR.clone()
}

fn encode(value: &impl serde::Serialize) -> Result<String, VoiceSessionError> {
    serde_json::to_string(value).map_err(|_| VoiceSessionError::InvalidCommand)
}
fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, VoiceSessionError> {
    serde_json::from_str(value).map_err(|_| VoiceSessionError::InvalidCommand)
}

impl VoiceSessionCoordinator {
    pub(crate) fn accepts_realtime(
        &self,
        id: &str,
        live: bool,
        global: bool,
        source: Option<&Source>,
        target: Option<&crate::host_runtime::realtime_agent::AgentTarget>,
        terminal: Option<&crate::host_runtime::realtime_terminal::TerminalTarget>,
    ) -> bool {
        let inner = self.inner.lock();
        inner.state.is_current(id)
            && inner.state.phase(id) == Some(Phase::Starting)
            && inner.state.mode(id) == Some(if live { &Mode::Live } else { &Mode::Realtime })
            && match inner.state.scope(id) {
                Some(Scope::Global) => {
                    global && source.is_none() && target.is_none() && terminal.is_none()
                }
                Some(Scope::Agent {
                    source: Some(expected),
                    ..
                }) => !global && source == Some(expected) && target.is_none() && terminal.is_none(),
                Some(Scope::Agent { pane_id, .. }) => {
                    !global
                        && source.is_none()
                        && target.is_some_and(|target| target.pane_id == *pane_id)
                        && terminal.is_none()
                }
                Some(Scope::Terminal {
                    runtime_id,
                    incarnation,
                    connection_generation,
                    terminal_id,
                    pane_id,
                    ..
                }) => {
                    !global
                        && source.is_none()
                        && target.is_none()
                        && terminal.is_some_and(|target| {
                            target.runtime_id == *runtime_id
                                && target.runtime_incarnation == *incarnation
                                && target.connection_generation == *connection_generation
                                && target.terminal_id == *terminal_id
                                && target.pane_id == *pane_id
                        })
                }
                None => false,
            }
    }
    fn update<T>(&self, apply: impl FnOnce(&mut State) -> T) -> T {
        self.update_inner(|inner| apply(&mut inner.state))
    }
    fn update_inner<T>(&self, apply: impl FnOnce(&mut Inner) -> T) -> T {
        let (result, cancelled, changed) = {
            let mut inner = self.inner.lock();
            let previous = inner.state.current.clone();
            let result = apply(&mut inner);
            let changed = previous != inner.state.current;
            if changed {
                tracing::info!(call_id = ?previous, replacement = ?inner.state.current, "voice session ownership changed");
            }
            let mut cancelled = Vec::new();
            let Inner {
                state, resources, ..
            } = &mut *inner;
            resources.retain(|id, resource| {
                if state.is_current(id) {
                    true
                } else {
                    cancelled.push(resource.clone());
                    false
                }
            });
            let Inner {
                state, submissions, ..
            } = &mut *inner;
            submissions.retain(|id, _| state.is_current(id));
            let Inner { state, pins, .. } = &mut *inner;
            pins.retain(|id, _| state.is_current(id));
            drop(inner);
            (result, cancelled, changed)
        };
        // Never invoke a backend or a foreign callback under the authority lock.
        for resource in cancelled {
            resource.cancel();
        }
        if changed {
            wake_transcript_cache();
        }
        let observer = self.observer.lock().clone();
        if let Some(observer) = observer
            && !self.notified.swap(true, Ordering::AcqRel)
            && let Ok(runtime) = crate::runtime()
        {
            runtime.spawn_blocking(move || observer.changed());
        }
        result
    }
    pub(crate) fn pinned_agent(&self, id: &str) -> Option<Arc<PinnedAgent>> {
        match self.inner.lock().pins.get(id) {
            Some(Pin::Agent(pin)) => Some(pin.clone()),
            _ => None,
        }
    }
    pub(crate) fn pinned_terminal(&self, id: &str) -> Option<Arc<PinnedTerminal>> {
        match self.inner.lock().pins.get(id) {
            Some(Pin::Terminal(pin)) => Some(pin.clone()),
            _ => None,
        }
    }

    pub(crate) fn bind_realtime(
        &self,
        id: &str,
        call: &Arc<RealtimeVoiceAdapter>,
        live: bool,
    ) -> Result<(), VoiceSessionError> {
        let mut inner = self.inner.lock();
        if !inner.state.is_current(id)
            || inner.state.phase(id) != Some(Phase::Starting)
            || inner.state.mode(id) != Some(if live { &Mode::Live } else { &Mode::Realtime })
            || inner.resources.contains_key(id)
        {
            return Err(VoiceSessionError::Cancelled);
        }
        inner
            .resources
            .insert(id.into(), Resource::Realtime(call.clone()));
        tracing::info!(call_id = id, mode = ?inner.state.mode(id), "voice backend bound");
        for text in inner.submissions.remove(id).unwrap_or_default() {
            if !call.submit_context(text) {
                return Err(VoiceSessionError::Cancelled);
            }
        }
        drop(inner);
        Ok(())
    }
    pub(crate) fn backend_ended(&self, id: &str, error: Option<String>) {
        self.update(|state| state.end(id, error));
        // Provider/tool tasks may release their final native pins after initial
        // cancellation, so reconcile again when their shutdown has drained.
        wake_transcript_cache();
    }
    pub(crate) fn save_realtime(&self, id: &str, view: Value) {
        let mut inner = self.inner.lock();
        if inner.state.phase(id).is_some() {
            Self::observe(&mut inner, id, presentation(view));
        }
    }
    fn observe(inner: &mut Inner, id: &str, view: Value) {
        let observed = inner.observations.entry(id.into()).or_default();
        if observed.view != view {
            observed.revision += 1;
            observed.view = view;
        }
    }
    fn snapshot(&self, id: &str) -> Result<String, VoiceSessionError> {
        let resource = self.inner.lock().resources.get(id).cloned();
        let view = match resource {
            Some(Resource::Realtime(call)) => crate::realtime_voice::ffi::snapshot(&call),
            _ => None,
        };
        let mut inner = self.inner.lock();
        if let Some(view) = view
            && inner.state.is_current(id)
        {
            Self::observe(&mut inner, id, presentation(view));
        }
        let observed = inner.observations.get(id);
        encode(
            &json!({ "revision": observed.map_or(0, |view| view.revision).to_string(), "view": observed.map(|view| &view.view), "ended": !inner.state.is_current(id) }),
        )
    }
}

fn wake_transcript_cache() {
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn_blocking(crate::app_core::transcript_cache_changed);
    }
}

#[uniffi::export]
impl VoiceSessionCoordinator {
    pub fn set_observer(&self, observer: Arc<dyn VoiceSessionObserver>) {
        *self.observer.lock() = Some(observer);
    }
    pub fn request(&self, request: String) -> Result<String, VoiceSessionError> {
        let request: Request = decode(&request)?;
        let needs_pin = {
            let inner = self.inner.lock();
            inner.state.attachment(&request).is_none()
                && inner.state.admission_error(&request).is_none()
        };
        // Pin native session/process identity before permission can suspend startup.
        // Local may initially await a binding; its existing bounded acquisition
        // policy remains responsible when no agent session exists yet.
        let pin = if needs_pin {
            match &request.scope {
                Scope::Agent {
                    source: Some(source),
                    ..
                } => match PinnedAgent::pin_voice_source(source) {
                    Ok(pin) => Some(Pin::Agent(pin)),
                    Err(_) if request.mode == Mode::TurnBased => None,
                    Err(_) => {
                        return encode(&self.update(|state| {
                            state.reject(
                                "The bound agent disconnected or changed. Please call again.",
                            )
                        }));
                    }
                },
                Scope::Terminal {
                    runtime_id,
                    incarnation,
                    connection_generation,
                    terminal_id,
                    pane_id,
                    ..
                } => {
                    let target = TerminalTarget {
                        runtime_id: runtime_id.clone(),
                        runtime_incarnation: *incarnation,
                        connection_generation: *connection_generation,
                        terminal_id: terminal_id.clone(),
                        pane_id: pane_id.clone(),
                        operation_epoch: None,
                        recovery_revision: None,
                        process_epoch: None,
                    };
                    match PinnedTerminal::pin(target) {
                        Ok(pin) => Some(Pin::Terminal(pin)),
                        Err(error) => return encode(&self.update(|state| state.reject(error))),
                    }
                }
                _ => None,
            }
        } else {
            None
        };
        encode(&self.update_inner(|inner| {
            let admission = inner.state.request(request);
            if admission.error.is_none()
                && !admission.attached
                && let Some(pin) = pin
            {
                inner.pins.insert(admission.id.clone(), pin);
            }
            admission
        }))
    }
    pub fn take_effects(&self) -> Result<String, VoiceSessionError> {
        // No notification here: draining is the acknowledgement of invalidation.
        self.notified.store(false, Ordering::Release);
        let effects = self.inner.lock().state.take_effects();
        encode(&json!({"version":EFFECT_VERSION,"effects":effects}))
    }
    pub fn acknowledge(&self, id: String, event: String) -> Result<(), VoiceSessionError> {
        let ack: Ack = decode(&format!("\"{event}\""))?;
        self.update(|state| state.acknowledge(&id, ack));
        if matches!(ack, Ack::Closed | Ack::PrepareFailed) {
            self.inner.lock().observations.remove(&id);
        }
        Ok(())
    }
    pub fn end(&self, id: String, error: Option<String>) {
        self.update(|state| state.end(&id, error));
    }
    pub fn is_current(&self, id: String) -> bool {
        self.inner.lock().state.is_current(&id)
    }
    pub fn phase(&self, id: String) -> String {
        self.inner.lock().state.phase(&id).map_or_else(
            || "ended".into(),
            |phase| {
                serde_json::to_value(phase)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_default()
            },
        )
    }
    pub fn active_id(&self) -> Option<String> {
        self.inner.lock().state.current.clone()
    }
    pub fn set_locked(&self, locked: bool) {
        self.update(|state| state.set_locked(locked));
    }
    pub fn retain_hosts(&self, hosts: Vec<String>) {
        self.update(|state| state.retain_hosts(&hosts));
    }
    /// Typed context is admitted and bounded even before permission or media startup.
    pub fn submit_context(&self, id: String, text: String) -> Result<(), VoiceSessionError> {
        if text.trim().is_empty() {
            return Ok(());
        }
        let mut inner = self.inner.lock();
        if !inner.state.is_current(&id) || inner.state.mode(&id) == Some(&Mode::TurnBased) {
            return Err(VoiceSessionError::Cancelled);
        }
        if text.len() > crate::realtime_voice::MAX_TEXT {
            return Err(VoiceSessionError::InvalidCommand);
        }
        if let Some(Resource::Realtime(call)) = inner.resources.get(&id) {
            if call.submit_context(text) {
                return Ok(());
            }
            return Err(VoiceSessionError::Cancelled);
        }
        let pending = inner.submissions.entry(id).or_default();
        if pending.len() == 8 {
            return Err(VoiceSessionError::InvalidCommand);
        }
        pending.push_back(text);
        drop(inner);
        Ok(())
    }
    pub fn same_target(&self, left: String, right: String) -> Result<bool, VoiceSessionError> {
        Ok(State::same_target(decode(&left)?, decode(&right)?))
    }

    /// A Local backend can only attach while its generation holds startup admission.
    pub fn bind_local(
        &self,
        id: String,
        call: Arc<VoiceChat>,
        source: String,
    ) -> Result<(), VoiceSessionError> {
        let source: state::Source = decode(&source)?;
        let mut inner = self.inner.lock();
        if !inner.state.is_current(&id)
            || inner.state.phase(&id) != Some(Phase::Starting)
            || inner.state.mode(&id) != Some(&Mode::TurnBased)
            || inner.resources.contains_key(&id)
            || !matches!(inner.state.scope(&id), Some(Scope::Agent { source: Some(expected), .. }) if *expected == source)
        {
            return Err(VoiceSessionError::Cancelled);
        }
        inner
            .resources
            .insert(id.clone(), Resource::Local(call.clone()));
        call.attach_app_session(id.clone());
        tracing::info!(call_id = id, mode = "TurnBased", "voice backend bound");
        if let Some(Pin::Agent(pin)) = inner.pins.get(&id) {
            call.pin_agent_source(source.runtime_id, &pin.binding_identity());
        }
        drop(inner);
        Ok(())
    }
    pub async fn realtime_snapshot(
        self: Arc<Self>,
        id: String,
    ) -> Result<String, VoiceSessionError> {
        crate::runtime()
            .map_err(|_| VoiceSessionError::Cancelled)?
            .spawn_blocking(move || self.snapshot(&id))
            .await
            .map_err(|_| VoiceSessionError::Cancelled)?
    }

    /// One outstanding observation per call; coalesce backend changes at 10 Hz.
    /// Timeout is a liveness bound, not a JS status-poll interval. No PCM crosses.
    pub async fn next_realtime_view(
        self: Arc<Self>,
        id: String,
        revision: String,
    ) -> Result<String, VoiceSessionError> {
        crate::runtime()
            .map_err(|_| VoiceSessionError::Cancelled)?
            .spawn(async move { self.wait_view(id, revision).await })
            .await
            .map_err(|_| VoiceSessionError::Cancelled)?
    }
}

impl VoiceSessionCoordinator {
    async fn wait_view(&self, id: String, revision: String) -> Result<String, VoiceSessionError> {
        {
            let mut inner = self.inner.lock();
            if inner.state.phase(&id).is_none() {
                drop(inner);
                return self.snapshot(&id);
            }
            let observed = inner.observations.entry(id.clone()).or_default();
            if observed.waiting {
                return Err(VoiceSessionError::InvalidCommand);
            }
            observed.waiting = true;
            drop(inner);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let result = loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let snapshot = self.snapshot(&id)?;
            let value: Value = decode(&snapshot)?;
            if value["revision"].as_str() != Some(&revision)
                || value["ended"] == true
                || tokio::time::Instant::now() >= deadline
            {
                break Ok(snapshot);
            }
        };
        if let Some(observed) = self.inner.lock().observations.get_mut(&id) {
            observed.waiting = false;
        }
        result
    }
}

// Diagnostics/counters change every audio frame. They must not wake presentation.
fn presentation(mut view: Value) -> Value {
    const FIELDS: &[&str] = &[
        "phase",
        "muted",
        "level",
        "playbackLevel",
        "text",
        "userText",
        "error",
        "inputTokens",
        "outputTokens",
        "estimatedUsd",
        "costIncomplete",
        "messages",
        "backendText",
        "liveSeconds",
        "usageFinalized",
        "resumedContextTruncated",
        "continuity",
    ];
    if let Some(object) = view.as_object_mut() {
        object.retain(|key, _| FIELDS.contains(&key.as_str()));
    }
    view
}

#[cfg(test)]
mod tests;

/// Native audio services check the same admission while JS is suspended.
/// Legacy standalone previews have no app-wide session token.
/// # Safety
/// `token` is a borrowed, NUL-terminated UTF-8 string until this call returns.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_voice_session_current(token: *const std::ffi::c_char) -> bool {
    if token.is_null() {
        return false;
    }
    // SAFETY: Platform adapters lend a valid C string for this synchronous call.
    let Ok(token) = unsafe { std::ffi::CStr::from_ptr(token) }.to_str() else {
        return false;
    };
    token.len() <= MAX_TOKEN_BYTES
        && (!token.starts_with(state::CALL_PREFIX) || {
            let core = voice_session_coordinator();
            let inner = core.inner.lock();
            inner.state.is_current(token)
                && matches!(
                    inner.state.phase(token),
                    Some(Phase::Starting | Phase::Active)
                )
        })
}

/// # Safety
/// `token` follows the same borrowed C-string contract as `whip_voice_session_current`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_voice_session_end(token: *const std::ffi::c_char, interrupted: bool) {
    if token.is_null() {
        return;
    }
    // SAFETY: Platform adapters lend a valid C string for this synchronous call.
    if let Ok(token) = unsafe { std::ffi::CStr::from_ptr(token) }.to_str()
        && token.len() <= MAX_TOKEN_BYTES
        && token.starts_with(state::CALL_PREFIX)
    {
        voice_session_coordinator().end(
            token.into(),
            interrupted.then(|| "The system interrupted the voice audio session.".into()),
        );
    }
}
