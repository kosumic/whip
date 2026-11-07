//! Local agent alert policy. Platform adapters execute effects and acknowledge
//! their IDs; they never own alert lifetimes or decide whether a result is stale.
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::{Arc, LazyLock, Weak},
    time::{Duration, Instant},
};

use parking_lot::Mutex;

use crate::HerdrAgentStatus;

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum LocalAlertDelivery {
    Persistent,
    Brief,
    Regular,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct LocalAlertRuntime {
    pub runtime_id: String,
    pub incarnation: u64,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct LocalAlertRequest {
    pub host_id: String,
    pub pane_id: String,
    pub tab_id: String,
    pub runtime: Option<LocalAlertRuntime>,
    pub status: HerdrAgentStatus,
    pub session_identity: String,
    pub title: String,
    pub body: String,
    pub announcement: Option<String>,
    pub language: String,
    pub delivery: LocalAlertDelivery,
    pub persistent_timeout_ms: u32,
    pub android: bool,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct LocalAlertTransition {
    pub host_id: String,
    pub pane_id: String,
    pub runtime: Option<LocalAlertRuntime>,
    pub status: Option<HerdrAgentStatus>,
    pub request: Option<LocalAlertRequest>,
    pub enabled: bool,
    pub afk_mode: bool,
    pub previous_status: Option<HerdrAgentStatus>,
    pub foreground: bool,
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum LocalAlertScope {
    All,
    Host { host_id: String },
    Tab { host_id: String, tab_id: String },
    Pane { host_id: String, pane_id: String },
}

impl LocalAlertScope {
    fn matches(&self, request: &LocalAlertRequest) -> bool {
        match self {
            Self::All => true,
            Self::Host { host_id } => request.host_id == *host_id,
            Self::Tab { host_id, tab_id } => {
                request.host_id == *host_id && request.tab_id == *tab_id
            }
            Self::Pane { host_id, pane_id } => {
                request.host_id == *host_id && request.pane_id == *pane_id
            }
        }
    }
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum LocalAlertAction {
    Speak {
        token: String,
        text: String,
        language: String,
    },
    StopSpeech {
        token: String,
    },
    Schedule {
        request: LocalAlertRequest,
    },
    DismissNotification {
        notification_id: String,
    },
    ArmPersistent {
        notification_id: String,
        timeout_ms: u32,
    },
    DismissPersistent {
        notification_id: Option<String>,
    },
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct LocalAlertEffect {
    pub id: String,
    pub action: LocalAlertAction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum LocalAlertEffectAdmission {
    Run,
    Skip,
    Duplicate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum LocalAlertSpeechEnd {
    Completed,
    Stopped,
    Shake,
    Replaced,
    Interrupted,
    Busy,
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum LocalAlertOutcome {
    Done,
    Scheduled { notification_id: String },
    SpeechEnded { reason: LocalAlertSpeechEnd },
    Failed { message: String },
    Skipped,
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error)]
pub enum LocalAlertError {
    #[error("Effect completion does not match its action")]
    InvalidCompletion,
}

struct Alert {
    request: LocalAlertRequest,
    notification_id: Option<String>,
    speech_created: Instant,
    speech_ready: bool,
}

struct PendingEffect {
    action: LocalAlertAction,
    alert_id: Option<String>,
    started: bool,
}

#[derive(Clone, PartialEq, Eq)]
struct Persistent {
    alert_id: String,
    notification_id: String,
    timeout_ms: u32,
}

#[derive(Default)]
struct CoordinatorState {
    alerts: BTreeMap<String, Alert>,
    suppressions: HashMap<String, LocalAlertScope>,
    effects: HashMap<String, PendingEffect>,
    runtimes: HashMap<String, Option<LocalAlertRuntime>>,
    announcement: Option<String>,
    waiting: VecDeque<String>,
    desired_persistent: Option<Persistent>,
    applied_persistent: Option<Persistent>,
    persistent_effect: Option<String>,
    reset_persistent: bool,
}

impl CoordinatorState {
    fn effect(
        &mut self,
        action: LocalAlertAction,
        alert_id: Option<String>,
        output: &mut Vec<LocalAlertEffect>,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.effects.insert(
            id.clone(),
            PendingEffect {
                action: action.clone(),
                alert_id,
                started: false,
            },
        );
        output.push(LocalAlertEffect {
            id: id.clone(),
            action,
        });
        id
    }

    fn runtime_current(&self, request: &LocalAlertRequest) -> bool {
        self.source_current(&request.host_id, request.runtime.as_ref())
    }

    fn source_current(&self, host_id: &str, source: Option<&LocalAlertRuntime>) -> bool {
        self.runtimes
            .get(host_id)
            .is_none_or(|runtime| runtime.is_some() && runtime.as_ref() == source)
    }

    fn admit(&mut self, request: LocalAlertRequest) -> Vec<LocalAlertEffect> {
        if !self.runtime_current(&request)
            || self
                .suppressions
                .values()
                .any(|scope| scope.matches(&request))
        {
            return Vec::new();
        }
        let mut output = Vec::new();
        let previous: Vec<_> = self
            .alerts
            .iter()
            .filter(|(_, alert)| {
                alert.request.host_id == request.host_id && alert.request.pane_id == request.pane_id
            })
            .map(|(token, _)| token.clone())
            .collect();
        for token in previous {
            self.cancel_speech(&token, &mut output);
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.effect(
            LocalAlertAction::Schedule {
                request: request.clone(),
            },
            Some(id.clone()),
            &mut output,
        );
        self.alerts.insert(
            id.clone(),
            Alert {
                request: request.clone(),
                notification_id: None,
                speech_created: Instant::now(),
                speech_ready: false,
            },
        );
        if let Some(text) = request.announcement.clone() {
            self.waiting.push_back(id.clone());
            // Retain higher-priority waiting items; discard the oldest in the
            // lowest tier when overloaded. The current utterance is untouched.
            if self.waiting.len() > MAX_WAITING {
                let lowest = self
                    .waiting
                    .iter()
                    .position(|token| {
                        self.alerts
                            .get(token)
                            .is_none_or(|a| a.request.status != HerdrAgentStatus::Blocked)
                    })
                    .unwrap_or(0);
                self.waiting.remove(lowest);
            }
            self.effect(
                LocalAlertAction::Speak {
                    token: id.clone(),
                    text,
                    language: request.language,
                },
                Some(id),
                &mut output,
            );
        }

        output
    }

    fn speech_valid(&self, token: &str, now: Instant) -> bool {
        self.alerts.get(token).is_some_and(|alert| {
            self.runtime_current(&alert.request)
                && matches!(
                    alert.request.status,
                    HerdrAgentStatus::Blocked | HerdrAgentStatus::Done | HerdrAgentStatus::Idle
                )
                && alert.request.announcement.is_some()
                && (self.announcement.as_deref() == Some(token)
                    || self.waiting.iter().any(|id| id == token)
                        && now.duration_since(alert.speech_created) < MAX_WAIT)
                && !self
                    .suppressions
                    .values()
                    .any(|scope| scope.matches(&alert.request))
        })
    }

    fn take_speech(
        &mut self,
        observed_lease: u64,
        now: Instant,
        claim: impl FnOnce(&str, u64) -> u64,
    ) -> Option<NativeAnnouncement> {
        self.waiting = self
            .waiting
            .iter()
            .filter(|token| self.speech_valid(token, now))
            .cloned()
            .collect();
        if self.announcement.is_some() {
            return None;
        }
        let index = self
            .waiting
            .iter()
            .position(|token| {
                self.alerts
                    .get(token)
                    .is_some_and(|a| a.request.status == HerdrAgentStatus::Blocked)
            })
            .or_else(|| (!self.waiting.is_empty()).then_some(0))?;
        let token = self.waiting.get(index)?.clone();
        if !self.alerts.get(&token)?.speech_ready {
            return None;
        }
        let lease = claim(&token, observed_lease);
        if lease == 0 {
            return None;
        }
        self.waiting.remove(index);
        self.announcement = Some(token.clone());
        let alert = self.alerts.get(&token)?;
        Some(NativeAnnouncement {
            token,
            text: alert.request.announcement.clone()?,
            language: alert.request.language.clone(),
            lease,
        })
    }

    fn finish_speech(&mut self, token: &str) {
        if self.announcement.as_deref() == Some(token) {
            self.announcement = None;
        }
        self.waiting.retain(|id| id != token);
    }

    fn cancel_speech(&mut self, token: &str, output: &mut Vec<LocalAlertEffect>) {
        let active = self.announcement.as_deref() == Some(token);
        self.finish_speech(token);
        if let Some(alert) = self.alerts.get_mut(token) {
            alert.request.announcement = None;
        }
        if active {
            self.effect(
                LocalAlertAction::StopSpeech {
                    token: token.into(),
                },
                None,
                output,
            );
        }
    }

    fn dismiss(&mut self, scope: &LocalAlertScope) -> Vec<LocalAlertEffect> {
        let mut output = Vec::new();
        let ids: Vec<_> = self
            .alerts
            .iter()
            .filter(|(_, alert)| scope.matches(&alert.request))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            let Some(alert) = self.alerts.remove(&id) else {
                continue;
            };
            if self.announcement.as_ref() == Some(&id) {
                self.announcement = None;
                self.effect(
                    LocalAlertAction::StopSpeech { token: id.clone() },
                    None,
                    &mut output,
                );
            }
            if let Some(notification_id) = alert.notification_id {
                self.effect(
                    LocalAlertAction::DismissNotification { notification_id },
                    None,
                    &mut output,
                );
            }
            if self
                .desired_persistent
                .as_ref()
                .is_some_and(|p| p.alert_id == id)
            {
                self.desired_persistent = None;
            }
        }
        self.waiting.retain(|id| self.alerts.contains_key(id));
        if matches!(scope, LocalAlertScope::All) {
            // Also clean up platform state surviving a detached JS consumer.
            self.reset_persistent = true;
        }
        self.reconcile_persistent(&mut output);
        output
    }

    fn reconcile_persistent(&mut self, output: &mut Vec<LocalAlertEffect>) {
        if self.persistent_effect.is_some() {
            return;
        }
        if !self.reset_persistent && self.desired_persistent == self.applied_persistent {
            return;
        }
        let action = if let Some(desired) = &self.desired_persistent {
            LocalAlertAction::ArmPersistent {
                notification_id: desired.notification_id.clone(),
                timeout_ms: desired.timeout_ms,
            }
        } else {
            LocalAlertAction::DismissPersistent {
                notification_id: self
                    .applied_persistent
                    .as_ref()
                    .map(|p| p.notification_id.clone()),
            }
        };
        let alert_id = self.desired_persistent.as_ref().map(|p| p.alert_id.clone());
        self.persistent_effect = Some(self.effect(action, alert_id, output));
        self.reset_persistent = false;
    }

    fn begin(&mut self, id: &str) -> LocalAlertEffectAdmission {
        let Some(effect) = self.effects.get(id) else {
            return LocalAlertEffectAdmission::Duplicate;
        };
        if effect.started {
            return LocalAlertEffectAdmission::Duplicate;
        }
        let current = effect.alert_id.as_ref().is_none_or(|id| {
            self.alerts
                .get(id)
                .is_some_and(|alert| self.runtime_current(&alert.request))
        });
        let current = current
            && match &effect.action {
                LocalAlertAction::Speak { token, .. } => self.speech_valid(token, Instant::now()),
                LocalAlertAction::ArmPersistent {
                    notification_id, ..
                } => self
                    .desired_persistent
                    .as_ref()
                    .is_some_and(|p| p.notification_id == *notification_id),
                _ => true,
            };
        if current && let Some(effect) = self.effects.get_mut(id) {
            effect.started = true;
        }
        if current {
            LocalAlertEffectAdmission::Run
        } else {
            LocalAlertEffectAdmission::Skip
        }
    }

    fn complete(
        &mut self,
        id: &str,
        outcome: LocalAlertOutcome,
    ) -> Result<Vec<LocalAlertEffect>, LocalAlertError> {
        let Some(effect) = self.effects.get(id) else {
            return Ok(Vec::new());
        };
        let valid = match (&effect.action, &outcome) {
            (_, LocalAlertOutcome::Failed { .. } | LocalAlertOutcome::Skipped)
            | (LocalAlertAction::Schedule { .. }, LocalAlertOutcome::Scheduled { .. })
            | (LocalAlertAction::Speak { .. }, LocalAlertOutcome::SpeechEnded { .. }) => true,
            (LocalAlertAction::Schedule { .. } | LocalAlertAction::Speak { .. }, _) => false,
            (_, LocalAlertOutcome::Done) => true,
            _ => false,
        };
        if !valid {
            return Err(LocalAlertError::InvalidCompletion);
        }
        let Some(effect) = self.effects.remove(id) else {
            return Ok(Vec::new());
        };
        let mut output = Vec::new();
        match effect.action {
            LocalAlertAction::Speak { token, .. } => {
                let was_current = self.announcement.as_deref() == Some(&token);
                self.finish_speech(&token);
                if was_current
                    && matches!(
                        outcome,
                        LocalAlertOutcome::SpeechEnded {
                            reason: LocalAlertSpeechEnd::Shake
                        }
                    )
                {
                    return Ok(self.dismiss(&LocalAlertScope::All));
                }
            }
            LocalAlertAction::Schedule { .. } => {
                let alert_id = effect.alert_id.unwrap_or_default();
                if let LocalAlertOutcome::Scheduled { notification_id } = outcome {
                    if let Some(alert) = self.alerts.get_mut(&alert_id) {
                        alert.notification_id = Some(notification_id.clone());
                        if alert.request.android
                            && alert.request.delivery == LocalAlertDelivery::Persistent
                        {
                            self.desired_persistent = Some(Persistent {
                                alert_id,
                                notification_id,
                                timeout_ms: alert.request.persistent_timeout_ms,
                            });
                        }
                    } else {
                        self.effect(
                            LocalAlertAction::DismissNotification { notification_id },
                            None,
                            &mut output,
                        );
                    }
                }
            }
            LocalAlertAction::ArmPersistent {
                notification_id,
                timeout_ms,
            } => {
                self.persistent_effect = None;
                if matches!(outcome, LocalAlertOutcome::Done) {
                    self.applied_persistent = effect.alert_id.map(|alert_id| Persistent {
                        alert_id,
                        notification_id,
                        timeout_ms,
                    });
                } else if self
                    .desired_persistent
                    .as_ref()
                    .is_some_and(|p| p.notification_id == notification_id)
                {
                    // Do not spin on an unavailable backend. A later alert can retry.
                    self.desired_persistent = None;
                }
            }
            LocalAlertAction::DismissPersistent { .. } => {
                self.persistent_effect = None;
                self.applied_persistent = None;
            }
            LocalAlertAction::StopSpeech { .. } | LocalAlertAction::DismissNotification { .. } => {}
        }
        self.reconcile_persistent(&mut output);
        Ok(output)
    }
}

/// Synchronous commands establish admission order before any platform promise
/// runs. No native timer certifies JS notification-consumer liveness.
#[derive(Default, uniffi::Object)]
pub struct LocalAlertCoordinator {
    state: Arc<Mutex<CoordinatorState>>,
}

#[uniffi::export]
impl LocalAlertCoordinator {
    #[uniffi::constructor]
    pub fn new() -> Self {
        let coordinator = Self::default();
        *NATIVE_COORDINATOR.lock() = Arc::downgrade(&coordinator.state);
        coordinator
    }

    pub fn alert(&self, request: LocalAlertRequest) -> Vec<LocalAlertEffect> {
        self.state.lock().admit(request)
    }

    pub fn transition(&self, transition: LocalAlertTransition) -> Vec<LocalAlertEffect> {
        let mut state = self.state.lock();
        if !state.source_current(&transition.host_id, transition.runtime.as_ref()) {
            return Vec::new();
        }
        let finished_working = transition.previous_status == Some(HerdrAgentStatus::Working)
            && transition.status == Some(HerdrAgentStatus::Idle);
        if !finished_working
            && !matches!(
                transition.status,
                Some(HerdrAgentStatus::Blocked | HerdrAgentStatus::Done)
            )
        {
            return state.dismiss(&LocalAlertScope::Pane {
                host_id: transition.host_id,
                pane_id: transition.pane_id,
            });
        }
        if !transition.enabled {
            return state.dismiss(&LocalAlertScope::Pane {
                host_id: transition.host_id,
                pane_id: transition.pane_id,
            });
        }
        let Some(mut request) = transition.request else {
            return Vec::new();
        };
        if request.host_id != transition.host_id
            || request.pane_id != transition.pane_id
            || request.runtime != transition.runtime
            || Some(request.status) != transition.status
        {
            return Vec::new();
        }
        if (finished_working && !transition.afk_mode)
            || (!finished_working
                && transition.foreground
                && request.delivery == LocalAlertDelivery::Persistent)
        {
            request.delivery = LocalAlertDelivery::Brief;
        }
        state.admit(request)
    }

    pub fn dismiss(&self, scope: LocalAlertScope) -> Vec<LocalAlertEffect> {
        self.state.lock().dismiss(&scope)
    }

    /// A call owns its suppression token until hangup, independent of UI focus.
    /// Dismiss first so pending platform completions cannot revive old alerts.
    pub fn set_suppression(
        &self,
        token: String,
        scope: Option<LocalAlertScope>,
    ) -> Vec<LocalAlertEffect> {
        let mut state = self.state.lock();
        if let Some(scope) = scope {
            let effects = state.dismiss(&scope);
            state.suppressions.insert(token, scope);
            effects
        } else {
            state.suppressions.remove(&token);
            drop(state);
            Vec::new()
        }
    }

    pub fn set_runtime(
        &self,
        host_id: String,
        runtime: Option<LocalAlertRuntime>,
    ) -> Vec<LocalAlertEffect> {
        let mut state = self.state.lock();
        if state.runtimes.get(&host_id) == Some(&runtime) {
            return Vec::new();
        }
        state.runtimes.insert(host_id.clone(), runtime);
        state.dismiss(&LocalAlertScope::Host { host_id })
    }

    /// Revalidate every snapshot, including identity changes without a status edge.
    pub fn retain_speech(
        &self,
        host_id: String,
        runtime: Option<LocalAlertRuntime>,
        requests: Vec<LocalAlertRequest>,
    ) -> Vec<LocalAlertEffect> {
        let mut state = self.state.lock();
        if !state.source_current(&host_id, runtime.as_ref()) {
            return Vec::new();
        }
        let invalid: Vec<_> = state
            .alerts
            .iter()
            .filter(|(_, alert)| {
                alert.request.host_id == host_id
                    && !requests.iter().any(|request| {
                        request.pane_id == alert.request.pane_id
                            && request.tab_id == alert.request.tab_id
                            && request.runtime == alert.request.runtime
                            && request.session_identity == alert.request.session_identity
                            && request.status == alert.request.status
                            && request.announcement.is_some()
                    })
            })
            .map(|(token, _)| token.clone())
            .collect();
        let mut output = Vec::new();
        for token in invalid {
            state.cancel_speech(&token, &mut output);
        }
        output
    }

    pub fn set_speech_enabled(&self, enabled: bool) -> Vec<LocalAlertEffect> {
        let mut state = self.state.lock();
        let mut output = Vec::new();
        if !enabled {
            let tokens: Vec<_> = state.alerts.keys().cloned().collect();
            for token in tokens {
                state.cancel_speech(&token, &mut output);
            }
        }
        output
    }

    pub fn begin_effect(&self, id: String) -> LocalAlertEffectAdmission {
        self.state.lock().begin(&id)
    }

    pub fn complete_effect(
        &self,
        id: String,
        outcome: LocalAlertOutcome,
    ) -> Result<Vec<LocalAlertEffect>, LocalAlertError> {
        self.state.lock().complete(&id, outcome)
    }
}

#[cfg(test)]
mod tests;

const MAX_WAITING: usize = 4;
const MAX_WAIT: Duration = Duration::from_secs(15);
static NATIVE_COORDINATOR: LazyLock<Mutex<Weak<Mutex<CoordinatorState>>>> =
    LazyLock::new(Mutex::default);

#[derive(serde::Serialize)]
struct NativeAnnouncement {
    token: String,
    text: String,
    language: String,
    lease: u64,
}

// Native owns callbacks and OS resources, while this coordinator owns all
// selection and validity. No JS event or status update is needed at completion.
pub(crate) fn native_speech_command(action: &str, token: &str, observed_lease: u64) -> String {
    let Some(state) = NATIVE_COORDINATOR.lock().upgrade() else {
        return "null".into();
    };
    let mut state = state.lock();
    let result = match action {
        "register" => {
            let valid = state.speech_valid(token, Instant::now());
            if valid && let Some(alert) = state.alerts.get_mut(token) {
                alert.speech_ready = true;
            }
            valid.to_string()
        }
        "valid" => state.speech_valid(token, Instant::now()).to_string(),
        "take" => serde_json::to_string(&state.take_speech(
            observed_lease,
            Instant::now(),
            crate::speech_playback::claim_status_at_boundary,
        ))
        .unwrap_or_else(|_| "null".into()),
        "finish" => {
            state.finish_speech(token);
            "null".into()
        }
        // Global native Stop, dictation and audio interruption discard waiting
        // speech immediately, including while JS is suspended.
        "clear" => {
            state.waiting.clear();
            "null".into()
        }
        _ => "null".into(),
    };
    drop(state);
    result
}
