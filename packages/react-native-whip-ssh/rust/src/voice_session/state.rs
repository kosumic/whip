//! App-wide call arbitration. Only acknowledged platform effects release ownership.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
static EPOCH: std::sync::LazyLock<uuid::Uuid> = std::sync::LazyLock::new(uuid::Uuid::new_v4);

pub(super) const CALL_PREFIX: &str = "voice:";
pub(super) const LOCKED: &str = "Unlock Whip to start a call.";
const UNAVAILABLE: &str = "This conversation mode is not available yet.";
const PREPARE_FAILED: &str = "The voice call could not be prepared.";
const START_FAILED: &str = "The voice call could not start.";
const CLOSE_FAILED: &str = "The voice call could not be closed. Retry Hang Up.";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(super) enum Mode {
    TurnBased,
    Realtime,
    Live,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Source {
    pub runtime_id: String,
    pub incarnation: String,
    pub terminal_id: String,
    pub pane_id: String,
    pub agent: String,
    pub target_key: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub(super) enum Scope {
    Global,
    Agent {
        host_id: String,
        tab_id: String,
        pane_id: String,
        agent: String,
        source: Option<Source>,
    },
    Terminal {
        host_id: String,
        runtime_id: String,
        incarnation: u64,
        connection_generation: u64,
        terminal_id: String,
        pane_id: Option<String>,
    },
}
impl Scope {
    fn host(&self) -> Option<&str> {
        match self {
            Self::Global => None,
            Self::Agent { host_id, .. } | Self::Terminal { host_id, .. } => Some(host_id),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Request {
    pub scope: Scope,
    pub mode: Mode,
    pub resume_call_id: Option<String>,
    pub available: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Phase {
    Queued,
    Preparing,
    Starting,
    Active,
    Closing,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Ack {
    Prepared,
    PrepareFailed,
    Started,
    StartFailed,
    Closed,
    CloseFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Action {
    Prepare,
    Start,
    Close,
    End,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Effect {
    pub id: String,
    pub action: Action,
    pub error: Option<String>,
}

#[derive(Debug)]
struct Call {
    request: Request,
    phase: Phase,
    /// Preparation may resolve after cancellation. Its adapter must still drain.
    preparing: bool,
    close_sent: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Admission {
    pub id: String,
    pub attached: bool,
    pub error: Option<&'static str>,
}

#[derive(Default)]
pub(super) struct State {
    pub current: Option<String>,
    locked: bool,
    sequence: u64,
    calls: BTreeMap<String, Call>,
    effects: VecDeque<Effect>,
}

impl State {
    pub fn attachment(&self, request: &Request) -> Option<String> {
        self.current
            .as_ref()
            .filter(|id| {
                let call = &self.calls[*id];
                call.request.scope == request.scope
                    && request
                        .resume_call_id
                        .as_ref()
                        .is_none_or(|resume| call.request.resume_call_id.as_ref() == Some(resume))
            })
            .cloned()
    }
    pub fn admission_error(&self, request: &Request) -> Option<&'static str> {
        if self.locked {
            Some(LOCKED)
        } else if !request.available
            || matches!(
                (&request.scope, &request.mode),
                (Scope::Terminal { .. }, Mode::TurnBased | Mode::Live)
                    | (Scope::Global, Mode::TurnBased)
            )
        {
            Some(UNAVAILABLE)
        } else {
            None
        }
    }
    pub fn reject(&mut self, error: &'static str) -> Admission {
        Admission {
            id: self.next_id(),
            attached: false,
            error: Some(error),
        }
    }
    fn next_id(&mut self) -> String {
        self.sequence += 1;
        format!("{CALL_PREFIX}{}:{}", *EPOCH, self.sequence)
    }
    pub fn request(&mut self, request: Request) -> Admission {
        if let Some(id) = self.attachment(&request) {
            return Admission {
                id,
                attached: true,
                error: None,
            };
        }
        let id = self.next_id();
        let error = self.admission_error(&request);
        if error.is_none() {
            let retry: Vec<_> = self
                .calls
                .iter()
                .filter(|(_, call)| {
                    call.phase == Phase::Closing && !call.preparing && !call.close_sent
                })
                .map(|(id, _)| id.clone())
                .collect();
            for id in retry {
                self.close(&id);
            }
            if let Some(previous) = self.current.clone() {
                self.end(&previous, None);
            }
            self.calls.insert(
                id.clone(),
                Call {
                    request,
                    phase: Phase::Queued,
                    preparing: false,
                    close_sent: false,
                    error: None,
                },
            );
            self.current = Some(id.clone());
        }
        Admission {
            id,
            attached: false,
            error,
        }
    }

    pub fn same_target(left: Scope, right: Scope) -> bool {
        left == right
    }
    pub fn is_current(&self, id: &str) -> bool {
        self.current.as_deref() == Some(id)
    }
    pub fn phase(&self, id: &str) -> Option<Phase> {
        self.calls.get(id).map(|call| call.phase)
    }
    pub fn mode(&self, id: &str) -> Option<&Mode> {
        self.calls.get(id).map(|call| &call.request.mode)
    }
    pub fn scope(&self, id: &str) -> Option<&Scope> {
        self.calls.get(id).map(|call| &call.request.scope)
    }
    pub fn set_locked(&mut self, locked: bool) {
        self.locked = locked;
    }
    pub fn retain_hosts(&mut self, hosts: &[String]) {
        if let Some(id) = self.current.clone()
            && self.calls[&id]
                .request
                .scope
                .host()
                .is_some_and(|host| !hosts.iter().any(|candidate| candidate == host))
        {
            self.end(&id, None);
        }
    }

    pub fn end(&mut self, id: &str, error: Option<String>) {
        if self.is_current(id) {
            self.current = None;
        }
        let Some(call) = self.calls.get_mut(id) else {
            return;
        };
        if error.is_some() {
            call.error = error;
        }
        if call.phase == Phase::Queued {
            self.finish(id);
            return;
        }
        call.phase = Phase::Closing;
        self.close(id);
    }

    fn close(&mut self, id: &str) {
        let Some(call) = self.calls.get_mut(id) else {
            return;
        };
        if !call.preparing && !call.close_sent {
            call.close_sent = true;
            self.effects.push_back(Effect {
                id: id.into(),
                action: Action::Close,
                error: call.error.clone(),
            });
        }
    }
    fn finish(&mut self, id: &str) {
        if let Some(call) = self.calls.remove(id) {
            self.effects.push_back(Effect {
                id: id.into(),
                action: Action::End,
                error: call.error,
            });
        }
    }
    pub fn acknowledge(&mut self, id: &str, ack: Ack) {
        let current = self.is_current(id);
        let Some(call) = self.calls.get_mut(id) else {
            return;
        };
        match ack {
            Ack::Prepared | Ack::PrepareFailed if call.preparing => {
                call.preparing = false;
                if matches!(ack, Ack::PrepareFailed) {
                    if call.error.is_none() && current {
                        call.error = Some(PREPARE_FAILED.into());
                    }
                    if current {
                        self.current = None;
                    }
                    self.finish(id);
                } else if call.phase == Phase::Closing {
                    self.close(id);
                } else {
                    call.phase = Phase::Starting;
                    self.effects.push_back(Effect {
                        id: id.into(),
                        action: Action::Start,
                        error: None,
                    });
                }
            }
            Ack::Started if call.phase == Phase::Starting => {
                call.phase = Phase::Active;
            }
            Ack::StartFailed if call.phase == Phase::Starting => {
                self.end(id, Some(START_FAILED.into()));
            }
            Ack::Closed if call.phase == Phase::Closing && call.close_sent => {
                self.finish(id);
            }
            Ack::CloseFailed if call.phase == Phase::Closing && call.close_sent => {
                call.close_sent = false;
                call.error = Some(CLOSE_FAILED.into());
                self.effects.push_back(Effect {
                    id: id.into(),
                    action: Action::Error,
                    error: call.error.clone(),
                });
                if let Some(pending) = self.current.clone()
                    && pending != id
                {
                    self.end(&pending, Some(CLOSE_FAILED.into()));
                }
            }
            _ => {}
        }
    }

    /// Called by the effect consumer, so simultaneous admissions coalesce before I/O.
    pub fn take_effects(&mut self) -> Vec<Effect> {
        if let Some(id) = self.current.clone()
            && self.calls.len() == 1
            && self.calls[&id].phase == Phase::Queued
        {
            let Some(call) = self.calls.get_mut(&id) else {
                return Vec::new();
            };
            call.phase = Phase::Preparing;
            call.preparing = true;
            self.effects.push_back(Effect {
                id,
                action: Action::Prepare,
                error: None,
            });
        }
        self.effects.drain(..).collect()
    }
}

#[cfg(test)]
mod tests;
