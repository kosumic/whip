//! Local agent alert policy. Platform adapters execute effects and acknowledge
//! their IDs; they never own alert lifetimes or decide whether a result is stale.
use std::collections::{BTreeMap, HashMap};

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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Announcement,
    Scheduling,
    Active,
}

struct Alert {
    request: LocalAlertRequest,
    phase: Phase,
    notification_id: Option<String>,
}

struct PendingEffect {
    action: LocalAlertAction,
    alert_id: Option<String>,
    resume_announcement: Option<String>,
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
    effects: HashMap<String, PendingEffect>,
    runtimes: HashMap<String, Option<LocalAlertRuntime>>,
    announcement: Option<String>,
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
        resume_announcement: Option<String>,
        output: &mut Vec<LocalAlertEffect>,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.effects.insert(
            id.clone(),
            PendingEffect {
                action: action.clone(),
                alert_id,
                resume_announcement,
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

    fn speak(&mut self, id: &str, output: &mut Vec<LocalAlertEffect>) {
        let Some(alert) = self.alerts.get(id) else {
            return;
        };
        if self.announcement.as_deref() != Some(id) || alert.phase != Phase::Announcement {
            return;
        }
        let Some(text) = alert.request.announcement.clone() else {
            return;
        };
        self.effect(
            LocalAlertAction::Speak {
                token: id.into(),
                text,
                language: alert.request.language.clone(),
            },
            Some(id.into()),
            None,
            output,
        );
    }

    fn schedule(&mut self, id: &str, output: &mut Vec<LocalAlertEffect>) {
        let Some(alert) = self.alerts.get_mut(id) else {
            return;
        };
        if alert.phase != Phase::Announcement {
            return;
        }
        alert.phase = Phase::Scheduling;
        let request = alert.request.clone();
        self.effect(
            LocalAlertAction::Schedule { request },
            Some(id.into()),
            None,
            output,
        );
    }

    fn admit(&mut self, request: LocalAlertRequest) -> Vec<LocalAlertEffect> {
        let mut output = Vec::new();
        if !self.runtime_current(&request) {
            return output;
        }
        let speak = request.announcement.is_some();
        let id = uuid::Uuid::new_v4().to_string();
        self.alerts.insert(
            id.clone(),
            Alert {
                request,
                phase: Phase::Announcement,
                notification_id: None,
            },
        );
        if speak {
            if let Some(previous) = self.announcement.replace(id.clone()) {
                // Token-scoped stop cannot interrupt chat speech or a newer
                // announcement. Admit the replacement only after the stop ack.
                self.effect(
                    LocalAlertAction::StopSpeech { token: previous },
                    None,
                    Some(id),
                    &mut output,
                );
            } else {
                self.speak(&id, &mut output);
            }
        } else {
            self.schedule(&id, &mut output);
        }
        output
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
                    None,
                    &mut output,
                );
            }
            if let Some(notification_id) = alert.notification_id {
                self.effect(
                    LocalAlertAction::DismissNotification { notification_id },
                    None,
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
        self.persistent_effect = Some(self.effect(action, alert_id, None, output));
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
                LocalAlertAction::Speak { token, .. } => self.announcement.as_ref() == Some(token),
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
                let shake = matches!(
                    outcome,
                    LocalAlertOutcome::SpeechEnded {
                        reason: LocalAlertSpeechEnd::Shake
                    }
                );
                if self.announcement.as_ref() == Some(&token) {
                    self.announcement = None;
                    if shake {
                        return Ok(self.dismiss(&LocalAlertScope::All));
                    }
                }
                if shake {
                    self.alerts.remove(&token);
                } else {
                    self.schedule(&token, &mut output);
                }
            }
            LocalAlertAction::StopSpeech { .. } => {
                if let Some(next) = effect.resume_announcement {
                    if self.announcement.as_ref() == Some(&next) {
                        self.speak(&next, &mut output);
                    } else {
                        self.schedule(&next, &mut output);
                    }
                }
            }
            LocalAlertAction::Schedule { .. } => {
                let alert_id = effect.alert_id.unwrap_or_default();
                if let LocalAlertOutcome::Scheduled { notification_id } = outcome {
                    if let Some(alert) = self.alerts.get_mut(&alert_id) {
                        alert.phase = Phase::Active;
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
                            None,
                            &mut output,
                        );
                    }
                } else {
                    self.alerts.remove(&alert_id);
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
            LocalAlertAction::DismissNotification { .. } => {}
        }
        self.reconcile_persistent(&mut output);
        Ok(output)
    }
}

/// Synchronous commands establish admission order before any platform promise
/// runs. No native timer certifies JS notification-consumer liveness.
#[derive(Default, uniffi::Object)]
pub struct LocalAlertCoordinator {
    state: Mutex<CoordinatorState>,
}

#[uniffi::export]
impl LocalAlertCoordinator {
    #[uniffi::constructor]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn alert(&self, request: LocalAlertRequest) -> Vec<LocalAlertEffect> {
        self.state.lock().admit(request)
    }

    pub fn transition(&self, transition: LocalAlertTransition) -> Vec<LocalAlertEffect> {
        let mut state = self.state.lock();
        if !state.source_current(&transition.host_id, transition.runtime.as_ref()) {
            return Vec::new();
        }
        if !matches!(
            transition.status,
            Some(HerdrAgentStatus::Blocked | HerdrAgentStatus::Done)
        ) {
            return state.dismiss(&LocalAlertScope::Pane {
                host_id: transition.host_id,
                pane_id: transition.pane_id,
            });
        }
        if !transition.enabled {
            return Vec::new();
        }
        let Some(mut request) = transition.request else {
            return Vec::new();
        };
        if request.host_id != transition.host_id
            || request.pane_id != transition.pane_id
            || request.runtime != transition.runtime
        {
            return Vec::new();
        }
        if transition.foreground && request.delivery == LocalAlertDelivery::Persistent {
            request.delivery = LocalAlertDelivery::Brief;
        }
        state.admit(request)
    }

    pub fn dismiss(&self, scope: LocalAlertScope) -> Vec<LocalAlertEffect> {
        self.state.lock().dismiss(&scope)
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
