//! Outbound composer ownership. The renderer supplies encoding and an input
//! barrier; only a native permit can commit the resulting terminal writes.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::Notify;

const MAX_ATTEMPTS: u32 = 5;
const RETRY_BASE_MS: u64 = 1_000;

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TerminalSubmissionAttachment {
    pub id: i64,
    pub remote_path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TerminalSubmissionStatus {
    Queued,
    Preparing,
    Writing,
    Retrying,
    Failed,
    Ambiguous,
    Accepted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TerminalSubmissionFailure {
    Unavailable,
    TargetChanged,
    WriteInterrupted,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct TerminalSubmissionMessage {
    pub id: String,
    pub text: String,
    pub attachments: Vec<TerminalSubmissionAttachment>,
    pub paste_events: Vec<String>,
    pub history_entry: String,
    pub status: TerminalSubmissionStatus,
    pub attempts: u32,
    pub failure: Option<TerminalSubmissionFailure>,
    pub accepted_parts: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TerminalSubmissionTarget {
    pub key: String,
    pub runtime_id: String,
    pub runtime_incarnation: u64,
    pub terminal_id: String,
    pub pane_id: String,
    pub ssh: bool,
    pub online: bool,
}

impl TerminalSubmissionTarget {
    fn same_destination(&self, other: &Self) -> bool {
        self.runtime_id == other.runtime_id
            && self.runtime_incarnation == other.runtime_incarnation
            && self.terminal_id == other.terminal_id
            && self.pane_id == other.pane_id
            && self.ssh == other.ssh
    }
}

#[derive(Clone, Copy, Debug, thiserror::Error, uniffi::Error)]
pub enum TerminalSubmissionPlatformError {
    #[error("Terminal renderer is unavailable")]
    Unavailable,
}

#[derive(Clone, Copy, Debug, thiserror::Error, uniffi::Error)]
pub enum TerminalSubmissionPermitError {
    #[error("Terminal submission is no longer current")]
    Obsolete,
    #[error("Terminal is unavailable; no input was sent")]
    Unavailable,
    #[error("Terminal input may have been partially sent; inspect it before resubmitting")]
    Ambiguous,
}

#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait TerminalSubmissionPlatform: Send + Sync {
    /// Reserve the existing keyboard-input queue, encode with xterm when needed,
    /// then call permit.dispatch inside that reservation. Returning is not an ACK.
    async fn submit(
        &self,
        permit: Arc<TerminalSubmissionPermit>,
        target_key: String,
        parts: Vec<String>,
        first_attempt: bool,
    ) -> Result<(), TerminalSubmissionPlatformError>;
    fn changed(&self, target_key: String);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WriteOutcome {
    Unsent,
    Accepted,
    Ambiguous(u32),
}

#[async_trait::async_trait]
pub(crate) trait SubmissionTransport: Send + Sync {
    fn valid(&self) -> bool;
    async fn send(&self, parts: Vec<String>, permit: &TerminalSubmissionPermit) -> WriteOutcome;
}

type TransportFactory =
    dyn Fn(&TerminalSubmissionTarget) -> Option<Arc<dyn SubmissionTransport>> + Send + Sync;

#[derive(Clone)]
pub(crate) struct VoiceSubmissionBinding {
    pub agent: crate::AgentTranscriptKind,
    pub session_id: String,
    pub admission: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

#[derive(Default)]
struct Target {
    binding: Option<TerminalSubmissionTarget>,
    epoch: u64,
    queue: VecDeque<TerminalSubmissionMessage>,
    completed: Vec<TerminalSubmissionMessage>,
    active: Option<Weak<TerminalSubmissionPermit>>,
    runner: Option<u64>,
    voice_bindings: HashMap<String, VoiceSubmissionBinding>,
}

#[derive(Default)]
struct State {
    targets: HashMap<String, Target>,
    platform: Option<Arc<dyn TerminalSubmissionPlatform>>,
    platform_epoch: u64,
    next_runner: u64,
    observers: HashMap<String, Weak<Mutex<TerminalSubmissionStatus>>>,
    recent: VecDeque<(String, String, String, TerminalSubmissionStatus)>,
}

#[derive(uniffi::Object)]
pub struct TerminalSubmissionQueue {
    state: Mutex<State>,
    transport: Arc<TransportFactory>,
}

#[derive(uniffi::Object)]
pub struct TerminalSubmissionPermit {
    queue: Weak<TerminalSubmissionQueue>,
    key: String,
    id: String,
    epoch: u64,
    platform_epoch: u64,
    transport: Arc<dyn SubmissionTransport>,
    destination: TerminalSubmissionTarget,
    voice_binding: Option<VoiceSubmissionBinding>,
    cancelled: Notify,
    dispatched: AtomicBool,
    finished: AtomicBool,
    outcome: Mutex<Option<WriteOutcome>>,
}

impl TerminalSubmissionPermit {
    pub(crate) fn active(&self) -> bool {
        if self.finished.load(Ordering::Acquire) {
            return false;
        }
        let Some(queue) = self.queue.upgrade() else {
            return false;
        };
        let state = queue.state.lock();
        let current = state.platform_epoch == self.platform_epoch
            && state.targets.get(&self.key).is_some_and(|target| {
                target.epoch == self.epoch
                    && target
                        .binding
                        .as_ref()
                        .is_some_and(|binding| binding.online)
                    && target
                        .queue
                        .front()
                        .is_some_and(|message| message.id == self.id)
            });
        drop(state);
        current
            && self.voice_binding.as_ref().is_none_or(|binding| {
                binding.admission.as_ref().is_none_or(|valid| valid())
                    && crate::host_runtime::voice_submission_current(&self.destination, binding)
            })
    }
}

#[uniffi::export]
impl TerminalSubmissionPermit {
    pub fn check_active(&self) -> Result<(), TerminalSubmissionPermitError> {
        if !self.active() {
            return Err(TerminalSubmissionPermitError::Obsolete);
        }
        if !self.transport.valid() {
            return Err(TerminalSubmissionPermitError::Unavailable);
        }
        Ok(())
    }

    pub async fn dispatch(
        self: Arc<Self>,
        parts: Vec<String>,
    ) -> Result<(), TerminalSubmissionPermitError> {
        crate::runtime()
            .map_err(|_| TerminalSubmissionPermitError::Unavailable)?
            .spawn(async move {
                self.check_active()?;
                if self.dispatched.swap(true, Ordering::AcqRel) {
                    return Err(TerminalSubmissionPermitError::Obsolete);
                }
                let queue = self
                    .queue
                    .upgrade()
                    .ok_or(TerminalSubmissionPermitError::Obsolete)?;
                {
                    let mut state = queue.state.lock();
                    let target = state
                        .targets
                        .get_mut(&self.key)
                        .ok_or(TerminalSubmissionPermitError::Obsolete)?;
                    let message = target
                        .queue
                        .front_mut()
                        .filter(|message| message.id == self.id)
                        .ok_or(TerminalSubmissionPermitError::Obsolete)?;
                    message.status = TerminalSubmissionStatus::Writing;
                    drop(state);
                }
                queue.changed(&self.key);
                let outcome = self.transport.send(parts, &self).await;
                *self.outcome.lock() = Some(outcome);
                match outcome {
                    WriteOutcome::Accepted => Ok(()),
                    WriteOutcome::Unsent => Err(TerminalSubmissionPermitError::Unavailable),
                    WriteOutcome::Ambiguous(_) => Err(TerminalSubmissionPermitError::Ambiguous),
                }
            })
            .await
            .map_err(|_| TerminalSubmissionPermitError::Ambiguous)?
    }
}

impl Default for TerminalSubmissionQueue {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            transport: Arc::new(crate::host_runtime::submission_transport),
        }
    }
}

impl TerminalSubmissionQueue {
    pub(crate) fn enqueue_voice(
        self: Arc<Self>,
        key: String,
        text: String,
        expected: &TerminalSubmissionTarget,
        binding: VoiceSubmissionBinding,
    ) -> Option<TerminalSubmissionMessage> {
        self.enqueue_checked(key, text, Vec::new(), Some(expected), Some(binding))
    }

    fn enqueue_checked(
        &self,
        key: String,
        text: String,
        attachments: Vec<TerminalSubmissionAttachment>,
        expected: Option<&TerminalSubmissionTarget>,
        voice_binding: Option<VoiceSubmissionBinding>,
    ) -> Option<TerminalSubmissionMessage> {
        let paste_events: Vec<_> = std::iter::once(text.trim_end().to_owned())
            .chain(
                attachments
                    .iter()
                    .map(|attachment| attachment.remote_path.clone()),
            )
            .filter(|part| !part.is_empty())
            .collect();
        if paste_events.is_empty() {
            return None;
        }
        let message = TerminalSubmissionMessage {
            id: uuid::Uuid::new_v4().to_string(),
            text,
            attachments,
            history_entry: paste_events.join(" "),
            paste_events,
            status: TerminalSubmissionStatus::Queued,
            attempts: 0,
            failure: None,
            accepted_parts: 0,
        };
        let mut state = self.state.lock();
        let target = state.targets.entry(key).or_default();
        if expected.is_some_and(|expected| {
            target
                .binding
                .as_ref()
                .is_none_or(|binding| !binding.same_destination(expected))
        }) {
            return None;
        }
        if let Some(binding) = voice_binding {
            target.voice_bindings.insert(message.id.clone(), binding);
        }
        target.queue.push_back(message.clone());
        drop(state);
        // The caller atomically transfers UI attachment resources before start().
        Some(message)
    }
}

impl TerminalSubmissionQueue {
    /// Revoke a call's unsent work, including a platform preparation that never
    /// resolves. Writes already admitted retain their ambiguous/accepted outcome.
    pub(crate) fn cancel_voice(&self, key: &str, id: &str) {
        let mut state = self.state.lock();
        let Some(target) = state.targets.get_mut(key) else {
            return;
        };
        let Some(index) = target.queue.iter().position(|message| message.id == id) else {
            return;
        };
        target.voice_bindings.remove(id);
        let admitted = index == 0
            && target
                .active
                .as_ref()
                .and_then(Weak::upgrade)
                .is_some_and(|permit| {
                    permit.finished.store(true, Ordering::Release);
                    permit.cancelled.notify_one();
                    permit.dispatched.load(Ordering::Acquire)
                });
        if admitted {
            target.queue[index].status = TerminalSubmissionStatus::Ambiguous;
            target.queue[index].failure = Some(TerminalSubmissionFailure::WriteInterrupted);
        } else {
            target.queue.remove(index);
        }
        drop(state);
        self.changed(key);
    }
}

#[uniffi::export]
impl TerminalSubmissionQueue {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn attach(self: Arc<Self>, platform: Arc<dyn TerminalSubmissionPlatform>) {
        {
            let mut state = self.state.lock();
            state.platform_epoch = state.platform_epoch.wrapping_add(1);
            for target in state.targets.values() {
                invalidate(target);
            }
            state.platform = Some(platform);
        }
        self.kick();
    }

    pub fn detach(&self) {
        let mut state = self.state.lock();
        state.platform_epoch = state.platform_epoch.wrapping_add(1);
        state.platform = None;
        for target in state.targets.values() {
            invalidate(target);
        }
    }

    pub fn update_targets(self: Arc<Self>, bindings: Vec<TerminalSubmissionTarget>) {
        {
            let mut state = self.state.lock();
            for (key, target) in &mut state.targets {
                if !bindings.iter().any(|binding| &binding.key == key)
                    && let Some(binding) = &mut target.binding
                    && binding.online
                {
                    binding.online = false;
                    target.epoch = target.epoch.wrapping_add(1);
                    invalidate(target);
                }
            }
            for binding in bindings {
                let target = state.targets.entry(binding.key.clone()).or_default();
                if target
                    .binding
                    .as_ref()
                    .is_some_and(|old| !old.same_destination(&binding))
                {
                    target.epoch = target.epoch.wrapping_add(1);
                    invalidate(target);
                    for message in &mut target.queue {
                        if !matches!(
                            message.status,
                            TerminalSubmissionStatus::Preparing | TerminalSubmissionStatus::Writing
                        ) {
                            message.status = TerminalSubmissionStatus::Failed;
                            message.failure = Some(TerminalSubmissionFailure::TargetChanged);
                        }
                    }
                } else if !binding.online && target.binding.as_ref().is_some_and(|old| old.online) {
                    target.epoch = target.epoch.wrapping_add(1);
                    invalidate(target);
                }
                target.binding = Some(binding);
            }
            drop(state);
        }
        self.kick();
    }

    pub fn enqueue(
        self: Arc<Self>,
        key: String,
        text: String,
        attachments: Vec<TerminalSubmissionAttachment>,
    ) -> Option<TerminalSubmissionMessage> {
        self.enqueue_checked(key, text, attachments, None, None)
    }

    pub fn start(self: Arc<Self>) {
        self.kick();
    }

    pub fn view(&self, key: String) -> Vec<TerminalSubmissionMessage> {
        self.state
            .lock()
            .targets
            .get(&key)
            .map_or_else(Vec::new, |target| target.queue.iter().cloned().collect())
    }

    pub fn take_completed(&self, key: String) -> Vec<TerminalSubmissionMessage> {
        self.state
            .lock()
            .targets
            .get_mut(&key)
            .map_or_else(Vec::new, |target| std::mem::take(&mut target.completed))
    }

    pub fn unqueue(self: Arc<Self>, key: String, id: String) -> Option<TerminalSubmissionMessage> {
        let message = {
            let mut state = self.state.lock();
            let target = state.targets.get_mut(&key)?;
            let index = target.queue.iter().position(|message| message.id == id)?;
            if matches!(
                target.queue[index].status,
                TerminalSubmissionStatus::Preparing | TerminalSubmissionStatus::Writing
            ) {
                return None;
            }
            if index == 0 {
                invalidate(target);
            }
            target.voice_bindings.remove(&id);
            let message = target.queue.remove(index);
            drop(state);
            message
        };
        self.kick();
        message
    }

    pub fn remove(&self, key: String) {
        if let Some(target) = self.state.lock().targets.remove(&key) {
            invalidate(&target);
        }
    }
}

fn invalidate(target: &Target) {
    if let Some(permit) = target.active.as_ref().and_then(Weak::upgrade) {
        permit.cancelled.notify_one();
    }
}

impl TerminalSubmissionQueue {
    /// Call-owned receipt survives UI consumption of accepted messages.
    pub(crate) fn observe(
        &self,
        key: &str,
        id: &str,
    ) -> Option<Arc<Mutex<TerminalSubmissionStatus>>> {
        let mut state = self.state.lock();
        let status = state
            .targets
            .get(key)
            .and_then(|target| {
                target
                    .queue
                    .iter()
                    .chain(&target.completed)
                    .find(|m| m.id == id)
            })
            .map(|m| m.status)
            .or_else(|| {
                state
                    .recent
                    .iter()
                    .find(|(k, i, _, _)| k == key && i == id)
                    .map(|(_, _, _, s)| *s)
            })?;
        let receipt = Arc::new(Mutex::new(status));
        state
            .observers
            .retain(|_, observer| observer.strong_count() > 0);
        state.observers.insert(id.into(), Arc::downgrade(&receipt));
        drop(state);
        Some(receipt)
    }

    pub(crate) fn observe_text(
        &self,
        key: &str,
        text: &str,
    ) -> Option<Arc<Mutex<TerminalSubmissionStatus>>> {
        let id = {
            let state = self.state.lock();
            state
                .targets
                .get(key)
                .and_then(|t| {
                    t.queue
                        .iter()
                        .chain(&t.completed)
                        .rev()
                        .find(|m| m.text.trim() == text.trim())
                })
                .map(|m| m.id.clone())
                .or_else(|| {
                    state
                        .recent
                        .iter()
                        .rev()
                        .find(|(k, _, t, _)| k == key && t.trim() == text.trim())
                        .map(|(_, id, _, _)| id.clone())
                })?
        };
        self.observe(key, &id)
    }

    fn changed(&self, key: &str) {
        let platform = {
            let mut state = self.state.lock();
            if let Some(target) = state.targets.get(key) {
                let statuses: Vec<_> = target
                    .queue
                    .iter()
                    .chain(&target.completed)
                    .map(|m| (m.id.clone(), m.text.clone(), m.status))
                    .collect();
                for (id, text, status) in statuses {
                    if let Some(observer) = state.observers.get(&id).and_then(Weak::upgrade) {
                        *observer.lock() = status;
                    }
                    if status == TerminalSubmissionStatus::Accepted
                        && !state.recent.iter().any(|(_, i, _, _)| i == &id)
                    {
                        state.recent.push_back((key.into(), id, text, status));
                        if state.recent.len() > 64 {
                            state.recent.pop_front();
                        }
                    }
                }
            }
            state.platform.clone()
        };
        if let Some(platform) = platform {
            platform.changed(key.to_owned());
        }
    }

    fn kick(self: Arc<Self>) {
        let keys = {
            let mut state = self.state.lock();
            if state.platform.is_none() {
                return;
            }
            let mut next_runner = state.next_runner;
            let keys = state
                .targets
                .iter_mut()
                .filter_map(|(key, target)| {
                    let eligible = target.queue.front().is_some_and(|message| {
                        matches!(
                            message.status,
                            TerminalSubmissionStatus::Queued | TerminalSubmissionStatus::Retrying
                        )
                    });
                    if target.runner.is_some()
                        || !eligible
                        || !target
                            .binding
                            .as_ref()
                            .is_some_and(|binding| binding.online)
                    {
                        return None;
                    }
                    next_runner = next_runner.wrapping_add(1);
                    target.runner = Some(next_runner);
                    Some((key.clone(), next_runner))
                })
                .collect::<Vec<_>>();
            state.next_runner = next_runner;
            keys
        };
        if let Ok(runtime) = crate::runtime() {
            for (key, runner) in keys {
                let queue = self.clone();
                runtime.spawn(async move {
                    queue.drive(key, runner).await;
                });
            }
        }
    }

    async fn drive(self: Arc<Self>, key: String, runner: u64) {
        let mut advanced = false;
        loop {
            let attempt = {
                let mut state = self.state.lock();
                let platform = state.platform.clone();
                let platform_epoch = state.platform_epoch;
                let attempt = state
                    .targets
                    .get_mut(&key)
                    .filter(|target| target.runner == Some(runner))
                    .and_then(|target| {
                        let platform = platform?;
                        let binding = target.binding.as_ref().filter(|binding| binding.online)?;
                        let message = target.queue.front_mut()?;
                        if !matches!(
                            message.status,
                            TerminalSubmissionStatus::Queued | TerminalSubmissionStatus::Retrying
                        ) {
                            return None;
                        }
                        let transport = (self.transport)(binding)?;
                        let permit = Arc::new(TerminalSubmissionPermit {
                            queue: Arc::downgrade(&self),
                            key: key.clone(),
                            id: message.id.clone(),
                            epoch: target.epoch,
                            platform_epoch,
                            transport,
                            destination: binding.clone(),
                            voice_binding: target.voice_bindings.get(&message.id).cloned(),
                            cancelled: Notify::new(),
                            dispatched: AtomicBool::new(false),
                            finished: AtomicBool::new(false),
                            outcome: Mutex::new(None),
                        });
                        message.status = TerminalSubmissionStatus::Preparing;
                        message.failure = None;
                        target.active = Some(Arc::downgrade(&permit));
                        Some((
                            platform,
                            permit,
                            message.paste_events.clone(),
                            message.attempts == 0,
                        ))
                    });
                if attempt.is_none()
                    && let Some(target) = state
                        .targets
                        .get_mut(&key)
                        .filter(|target| target.runner == Some(runner))
                {
                    target.runner = None;
                    target.active = None;
                }
                drop(state);
                attempt
            };
            let Some((platform, permit, parts, first_attempt)) = attempt else {
                break;
            };
            self.changed(&key);
            tokio::select! {
                _ = platform.submit(permit.clone(), key.clone(), parts, first_attempt) => {},
                () = permit.cancelled.notified() => {},
            }
            permit.finished.store(true, Ordering::Release);
            let outcome = permit.outcome.lock().unwrap_or_else(|| {
                if permit.dispatched.load(Ordering::Acquire) {
                    WriteOutcome::Ambiguous(0)
                } else {
                    WriteOutcome::Unsent
                }
            });
            let delay = {
                let mut state = self.state.lock();
                let platform_current = state.platform_epoch == permit.platform_epoch;
                let Some(target) = state
                    .targets
                    .get_mut(&key)
                    .filter(|target| target.runner == Some(runner))
                else {
                    return;
                };
                let Some(message) = target
                    .queue
                    .front_mut()
                    .filter(|message| message.id == permit.id)
                else {
                    advanced = true;
                    break;
                };
                let delay = match outcome {
                    WriteOutcome::Accepted => {
                        if let Some(mut message) = target.queue.pop_front() {
                            target.voice_bindings.remove(&message.id);
                            message.status = TerminalSubmissionStatus::Accepted;
                            message.accepted_parts =
                                u32::try_from(message.paste_events.len()).unwrap_or(u32::MAX);
                            target.completed.push(message);
                        }
                        None
                    }
                    WriteOutcome::Ambiguous(parts) => {
                        message.status = TerminalSubmissionStatus::Ambiguous;
                        message.failure = Some(TerminalSubmissionFailure::WriteInterrupted);
                        message.accepted_parts = parts;
                        Some(Duration::ZERO)
                    }
                    WriteOutcome::Unsent => {
                        message.attempts = message.attempts.saturating_add(1);
                        let replaced = target
                            .binding
                            .as_ref()
                            .is_some_and(|binding| !binding.same_destination(&permit.destination));
                        message.status = if replaced || message.attempts >= MAX_ATTEMPTS {
                            TerminalSubmissionStatus::Failed
                        } else {
                            TerminalSubmissionStatus::Retrying
                        };
                        message.failure = Some(if replaced {
                            TerminalSubmissionFailure::TargetChanged
                        } else {
                            TerminalSubmissionFailure::Unavailable
                        });
                        let delay =
                            if !platform_current || replaced || message.attempts >= MAX_ATTEMPTS {
                                0
                            } else {
                                RETRY_BASE_MS * 2_u64.pow(message.attempts - 1)
                            };
                        Some(Duration::from_millis(delay))
                    }
                };
                drop(state);
                delay
            };
            self.changed(&key);
            if let Some(delay) = delay
                && !delay.is_zero()
            {
                tokio::select! { () = tokio::time::sleep(delay) => {}, () = permit.cancelled.notified() => {} }
            }
        }
        if let Some(target) = self
            .state
            .lock()
            .targets
            .get_mut(&key)
            .filter(|target| target.runner == Some(runner))
        {
            target.runner = None;
        }
        if advanced {
            self.clone().kick();
        }
    }
}

#[cfg(test)]
mod tests;
