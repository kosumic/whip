use super::super::{ComposerDictation, DictationPhase};
use mobile_speech::{Admission, Arbiter, LeaseId, Preemption};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

const CONTEXT_MS: u64 = 1_500;
const OPERATION_MS: u64 = 10_000;
const CLOUD_FINISH_MS: u64 = 120_000;
const RESTART_MS: u64 = 250;
const MAX_RESTART_MS: u64 = 2_000;
const IDLE_CHECKS: u8 = 3;
const CONTINUOUS_API: u32 = 33;
const MICROPHONE_CLASS: u8 = 0;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub owner: String,
    pub draft: String,
    pub android: bool,
    pub api: u32,
    pub provider: Provider,
    pub local_only: bool,
    pub managed_call: bool,
    pub during_playback: bool,
    pub native_ingress: bool,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Default,
    Local,
    Openai,
}
impl Config {
    fn cloud(&self) -> bool {
        self.provider == Provider::Openai && !self.local_only
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Reserve {
        owner: String,
    },
    ReleaseReservation {
        owner: String,
    },
    Begin {
        config: Config,
    },
    Stop {
        owner: String,
    },
    Cancel {
        owner: String,
    },
    Background,
    Execute {
        id: String,
        generation: String,
        epoch: String,
    },
    Ack {
        id: String,
        generation: String,
        epoch: String,
        outcome: Outcome,
    },
    Event {
        generation: String,
        epoch: String,
        event: Event,
    },
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Outcome {
    Loaded {
        available: bool,
        local_supported: bool,
        ingress_supported: bool,
    },
    Context {
        recent: Vec<String>,
    },
    Permission {
        granted: bool,
    },
    Done,
    CloudStarted {
        granted: bool,
    },
    Transcript {
        text: String,
    },
    Idle {
        inactive: bool,
    },
    CaptureFailed,
    Failed {
        error: String,
        message: Option<String>,
    },
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Start,
    Result {
        text: String,
        is_final: bool,
    },
    NoMatch,
    Error {
        error: String,
        message: Option<String>,
    },
    End,
    CloudEnd {
        failed: bool,
    },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: String,
    pub generation: String,
    pub epoch: String,
    #[serde(flatten)]
    pub action: Action,
}
#[derive(Clone, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Load,
    ReadContext,
    RequestPermission {
        existing: bool,
    },
    SuspendPlayback,
    StartRecognition {
        continuous: bool,
        on_device: bool,
        monitoring: bool,
        context: Vec<String>,
    },
    StartCloud,
    FinishCloud {
        recent: Vec<String>,
    },
    CancelCloud,
    CloseCapture,
    Stop,
    Abort,
    CheckIdle,
    PublishDraftAppend {
        text: String,
    },
    ReportError {
        error: String,
        message: Option<String>,
    },
    Release,
}
impl Action {
    fn needs_ack(&self) -> bool {
        !matches!(
            self,
            Self::CloseCapture
                | Self::PublishDraftAppend { .. }
                | Self::ReportError { .. }
                | Self::Release
        )
    }
    fn accepts(&self, outcome: &Outcome) -> bool {
        matches!(outcome, Outcome::Failed { .. })
            || matches!(
                (self, outcome),
                (Self::Load, Outcome::Loaded { .. })
                    | (Self::ReadContext, Outcome::Context { .. })
                    | (Self::RequestPermission { .. }, Outcome::Permission { .. })
                    | (Self::StartCloud, Outcome::CloudStarted { .. })
                    | (Self::StartRecognition { .. }, Outcome::CaptureFailed)
                    | (Self::FinishCloud { .. }, Outcome::Transcript { .. })
                    | (Self::CheckIdle, Outcome::Idle { .. })
                    | (
                        Self::SuspendPlayback
                            | Self::StartRecognition { .. }
                            | Self::Stop
                            | Self::Abort
                            | Self::CancelCloud,
                        Outcome::Done
                    )
            )
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    owner: Option<String>,
    generation: Option<String>,
    epoch: String,
    phase: &'static str,
    interim_text: String,
    active: bool,
    accepts_audio: bool,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Loading,
    Permission,
    Context,
    Playback,
    Starting,
    Listening,
    Stopping,
    Closing,
    Checking,
    Quiet,
    Gap,
    Quarantined,
    CloudStarting,
    CloudListening,
    CloudFinishing,
    CloudClosing,
}
#[derive(Clone, Copy)]
enum Deadline {
    Operation,
    Quiet,
    Restart,
}
struct Session {
    config: Config,
    generation: String,
    epoch: u64,
    lease: LeaseId,
    reserved: bool,
    core: ComposerDictation,
    stage: Stage,
    continuous: bool,
    context_ready: bool,
    recent: Vec<String>,
    context_deadline: Option<u64>,
    operation_deadline: Option<(u64, Deadline)>,
    restart_delay: u64,
    restart: bool,
    cancelled: bool,
    received_final: bool,
    idle_checks: u8,
    idle_confirmed: bool,
    error_reported: bool,
}
impl Session {
    fn scoped(&self, generation: &str, epoch: &str) -> bool {
        self.generation == generation && self.epoch.to_string() == epoch
    }
    fn managed(&self) -> bool {
        self.reserved && self.config.local_only && self.config.managed_call
    }
}
#[derive(Default)]
pub struct State {
    arbiter: Arbiter,
    reservation: Option<(String, LeaseId)>,
    session: Option<Session>,
    sequence: u64,
    effects: VecDeque<Effect>,
    pending: HashMap<String, Effect>,
    continuous_failed: bool,
}
impl State {
    pub fn view(&self) -> View {
        let session = self.session.as_ref();
        let core = session.map(|s| s.core.view());
        let phase = match core.as_ref().map(|v| v.phase).unwrap_or_default() {
            DictationPhase::Idle => {
                if session.is_some() {
                    "finishing"
                } else {
                    "idle"
                }
            }
            DictationPhase::Preparing => "preparing",
            DictationPhase::Listening => "listening",
            DictationPhase::Finishing => "finishing",
        };
        View {
            owner: session.map(|s| s.config.owner.clone()),
            generation: session.map(|s| s.generation.clone()),
            epoch: session.map_or_else(|| "0".into(), |s| s.epoch.to_string()),
            phase,
            interim_text: core.map_or_else(String::new, |v| v.interim_text),
            active: session.is_some_and(|s| {
                !matches!(s.stage, Stage::Loading | Stage::Permission | Stage::Context)
            }) || self.reservation.is_some(),
            accepts_audio: session.is_some_and(|s| s.stage == Stage::Listening && !s.cancelled),
        }
    }
    pub fn take_effects(&mut self) -> Vec<Effect> {
        self.effects.drain(..).collect()
    }
    pub fn deadline(&self) -> Option<u64> {
        let s = self.session.as_ref()?;
        [s.context_deadline, s.operation_deadline.map(|(at, _)| at)]
            .into_iter()
            .flatten()
            .min()
    }
    fn emit(&mut self, action: Action) {
        let Some(s) = &self.session else {
            return;
        };
        self.sequence += 1;
        let effect = Effect {
            id: self.sequence.to_string(),
            generation: s.generation.clone(),
            epoch: s.epoch.to_string(),
            action,
        };
        if effect.action.needs_ack() {
            self.pending.insert(effect.id.clone(), effect.clone());
        }
        self.effects.push_back(effect);
    }
    pub fn apply(&mut self, command: Command, now: u64) -> bool {
        // Process elapsed native deadlines before admitting queued JS work.
        self.advance(now);
        match command {
            Command::Reserve { owner } => {
                if self.session.is_some() || self.reservation.is_some() {
                    return false;
                }
                let Some(lease) = self.claim(&owner) else {
                    return false;
                };
                self.reservation = Some((owner, lease));
            }
            Command::ReleaseReservation { owner } => {
                let Some((reserved_owner, lease)) = &self.reservation else {
                    return false;
                };
                if *reserved_owner != owner {
                    return false;
                }
                let lease = *lease;
                self.reservation = None;
                if let Some(s) = &mut self.session {
                    s.reserved = false;
                } else {
                    self.arbiter.stop(lease);
                }
            }
            Command::Begin { config } => return self.begin(config, now),
            Command::Stop { owner } => {
                if !self.owns(&owner) {
                    return false;
                }
                self.stop(now);
            }
            Command::Cancel { owner } => {
                if !self.owns(&owner) {
                    return false;
                }
                self.cancel(now);
            }
            Command::Background => {
                if self
                    .session
                    .as_ref()
                    .is_some_and(|s| !s.config.managed_call)
                {
                    self.cancel(now);
                }
            }
            Command::Execute {
                id,
                generation,
                epoch,
            } => {
                return self
                    .pending
                    .get(&id)
                    .is_some_and(|e| e.generation == generation && e.epoch == epoch)
                    && self.current(&generation, &epoch);
            }
            Command::Ack {
                id,
                generation,
                epoch,
                outcome,
            } => {
                let Some(effect) = self.pending.get(&id) else {
                    return false;
                };
                if effect.generation != generation
                    || effect.epoch != epoch
                    || !effect.action.accepts(&outcome)
                    || !self.current(&generation, &epoch)
                {
                    return false;
                }
                let Some(effect) = self.pending.remove(&id) else {
                    return false;
                };
                self.ack(effect.action, outcome, now);
            }
            Command::Event {
                generation,
                epoch,
                event,
            } => {
                if !self.current(&generation, &epoch) {
                    return false;
                }
                self.event(event, now);
            }
        }
        true
    }
    fn claim(&mut self, owner: &str) -> Option<LeaseId> {
        self.arbiter.claim(
            MICROPHONE_CLASS,
            owner,
            "dictation",
            Admission {
                preemption: Preemption::Never,
                retain_on_complete: true,
            },
        )
    }
    fn owns(&self, owner: &str) -> bool {
        self.session
            .as_ref()
            .is_some_and(|s| s.config.owner == owner)
    }
    fn current(&self, generation: &str, epoch: &str) -> bool {
        self.session
            .as_ref()
            .is_some_and(|s| s.scoped(generation, epoch))
    }
    fn begin(&mut self, config: Config, now: u64) -> bool {
        if self
            .session
            .as_ref()
            .is_some_and(|s| s.stage == Stage::Quarantined && !s.config.cloud())
        {
            // A fresh user action can recheck a previously wedged recognizer.
            // It never authorizes a replacement before that check completes.
            self.check_idle(now);
            return false;
        }
        if self.session.is_some()
            || self
                .reservation
                .as_ref()
                .is_some_and(|(owner, _)| *owner != config.owner)
        {
            return false;
        }
        let reserved = self.reservation.is_some();
        let lease = if let Some((_, lease)) = self.reservation {
            lease
        } else {
            let Some(lease) = self.claim(&config.owner) else {
                return false;
            };
            lease
        };
        self.sequence += 1;
        let continuous = config.local_only
            || !config.android
            || (config.api >= CONTINUOUS_API && !self.continuous_failed);
        let core = ComposerDictation::default();
        core.begin();
        self.session = Some(Session {
            config,
            generation: self.sequence.to_string(),
            epoch: 0,
            lease,
            reserved,
            core,
            stage: Stage::Loading,
            continuous,
            context_ready: false,
            recent: Vec::new(),
            context_deadline: Some(now + CONTEXT_MS),
            operation_deadline: Some((now + OPERATION_MS, Deadline::Operation)),
            restart_delay: RESTART_MS,
            restart: false,
            cancelled: false,
            received_final: false,
            idle_checks: 0,
            idle_confirmed: false,
            error_reported: false,
        });
        self.emit(Action::Load);
        self.emit(Action::ReadContext);
        true
    }
    fn error(&mut self, error: &str, message: Option<String>) {
        let Some(s) = &mut self.session else {
            return;
        };
        if s.error_reported {
            return;
        }
        s.error_reported = true;
        self.emit(Action::ReportError {
            error: error.into(),
            message,
        });
    }
    fn append(&mut self, text: Option<String>) {
        if let Some(text) = text {
            self.emit(Action::PublishDraftAppend { text });
        }
    }
    fn release(&mut self) {
        let Some(s) = &self.session else {
            return;
        };
        let text = s.core.end();
        if !s.cancelled {
            self.append(text);
        }
        self.emit(Action::CloseCapture);
        self.emit(Action::Release);
        if let Some(s) = self.session.take()
            && !s.reserved
        {
            self.arbiter.stop(s.lease);
        }
        self.pending.clear();
    }
    fn ready(&mut self, now: u64) {
        let Some(s) = &mut self.session else {
            return;
        };
        if s.stage != Stage::Context || !s.context_ready {
            return;
        }
        s.stage = Stage::Playback;
        s.operation_deadline = Some((now + OPERATION_MS, Deadline::Operation));
        if s.managed() && s.config.during_playback {
            self.start_engine(now);
        } else {
            self.emit(Action::SuspendPlayback);
        }
    }
    fn start_engine(&mut self, now: u64) {
        let Some(s) = &mut self.session else {
            return;
        };
        self.pending.clear();
        s.epoch += 1;
        s.core.result(String::new(), false);
        s.operation_deadline = Some((now + OPERATION_MS, Deadline::Operation));
        s.idle_checks = 0;
        s.idle_confirmed = false;
        if s.config.cloud() {
            s.stage = Stage::CloudStarting;
            // Capture.start includes the system permission dialog. Like local
            // permission requests, it must remain pending until a reply/cancel.
            s.operation_deadline = None;
            self.emit(Action::StartCloud);
        } else {
            s.stage = Stage::Starting;
            let action = Action::StartRecognition {
                continuous: s.continuous,
                on_device: s.config.local_only || s.config.provider == Provider::Local,
                monitoring: s.managed() && s.config.during_playback,
                context: super::super::super::composer_dictation_context(
                    s.config.draft.clone(),
                    s.recent.clone(),
                ),
            };
            self.emit(action);
        }
    }
    fn disable_continuous(&mut self) {
        if let Some(s) = &mut self.session
            && !s.config.local_only
            && s.continuous
        {
            s.continuous = false;
            self.continuous_failed = true;
        }
    }
    fn fallback(&mut self, now: u64) -> bool {
        let Some(s) = &self.session else {
            return false;
        };
        if !s.config.android || s.config.local_only || !s.continuous || s.stage == Stage::Stopping {
            return false;
        }
        self.disable_continuous();
        self.close(true, now);
        true
    }
    fn close(&mut self, restart: bool, now: u64) {
        let Some(s) = &mut self.session else {
            return;
        };
        s.stage = Stage::Closing;
        s.restart = restart;
        s.context_deadline = None;
        s.operation_deadline = Some((now + OPERATION_MS, Deadline::Operation));
        self.pending.clear();
        self.emit(Action::CloseCapture);
        self.emit(Action::Abort);
    }
    fn cancel(&mut self, now: u64) {
        let Some(s) = &mut self.session else {
            return;
        };
        if s.stage == Stage::Quarantined && !s.config.cloud() {
            s.cancelled = true;
            s.restart = false;
            s.core.end();
            s.idle_checks = 0;
            self.check_idle(now);
            return;
        }
        if s.cancelled {
            return;
        }
        s.cancelled = true;
        s.core.end();
        s.restart = false;
        match s.stage {
            Stage::Loading | Stage::Permission | Stage::Context | Stage::Playback | Stage::Gap => {
                self.release();
            }
            Stage::CloudStarting | Stage::CloudListening | Stage::CloudFinishing => {
                s.stage = Stage::CloudClosing;
                s.context_deadline = None;
                s.operation_deadline = Some((now + OPERATION_MS, Deadline::Operation));
                self.pending.clear();
                self.emit(Action::CancelCloud);
            }
            Stage::Checking | Stage::Quiet | Stage::Quarantined => {}
            _ => self.close(false, now),
        }
    }
    fn stop(&mut self, now: u64) {
        let Some(s) = &mut self.session else {
            return;
        };
        if s.core.view().phase != DictationPhase::Listening || s.cancelled {
            return;
        }
        s.core.finish();
        s.restart = false;
        self.emit(Action::CloseCapture);
        let Some(s) = &mut self.session else {
            return;
        };
        match s.stage {
            Stage::Gap => self.release(),
            Stage::Checking | Stage::Quiet | Stage::Closing => {}
            Stage::CloudListening => {
                s.stage = Stage::CloudFinishing;
                s.operation_deadline = Some((now + CLOUD_FINISH_MS, Deadline::Operation));
                let recent = s.recent.clone();
                self.emit(Action::FinishCloud { recent });
            }
            _ => {
                s.stage = Stage::Stopping;
                s.operation_deadline = Some((now + OPERATION_MS, Deadline::Operation));
                self.emit(Action::Stop);
            }
        }
    }
    fn check_idle(&mut self, now: u64) {
        let Some(s) = &mut self.session else {
            return;
        };
        if s.stage == Stage::Quarantined {
            s.idle_checks = 0;
            s.idle_confirmed = false;
        }
        s.stage = Stage::Checking;
        s.operation_deadline = Some((now + OPERATION_MS, Deadline::Operation));
        self.pending.clear();
        self.emit(Action::CloseCapture);
        self.emit(Action::CheckIdle);
    }
    fn ack(&mut self, action: Action, outcome: Outcome, now: u64) {
        if let Outcome::Failed { error, message } = outcome {
            match action {
                Action::Load => {
                    self.error("unavailable", message);
                    self.cancel(now);
                }
                Action::StartRecognition { .. } => {
                    if !self.fallback(now) {
                        self.error(&error, message);
                        self.cancel(now);
                    }
                }
                Action::Stop => {
                    self.fail(now);
                }
                Action::Abort => self.check_idle(now),
                Action::CheckIdle => self.idle(false, now),
                Action::ReadContext => self.context(now),
                _ => {
                    self.error(&error, message);
                    self.cancel(now);
                }
            }
            return;
        }
        let Some(s) = &mut self.session else {
            return;
        };
        match (action, outcome) {
            (Action::StartRecognition { .. }, Outcome::CaptureFailed) => {
                self.error("failed", None);
                // No recognizer operation occurred, so no terminal event can arrive.
                self.release();
            }
            (
                Action::Load,
                Outcome::Loaded {
                    available,
                    local_supported,
                    ingress_supported,
                },
            ) => {
                if !s.config.cloud()
                    && (!available
                        || (s.config.local_only && !local_supported)
                        || (s.config.native_ingress && !ingress_supported))
                {
                    let local = s.config.local_only || s.config.native_ingress;
                    self.error("unavailable", local.then(|| "This build or device does not support on-device voice chat. Install an updated Whip build and an offline speech language.".into()));
                    self.release();
                    return;
                }
                if s.config.cloud() {
                    s.stage = Stage::Context;
                    self.ready(now);
                } else {
                    s.stage = Stage::Permission;
                    s.operation_deadline = None; // A permission dialog may remain open indefinitely.
                    let existing = s.managed();
                    self.emit(Action::RequestPermission { existing });
                }
            }
            (Action::ReadContext, Outcome::Context { recent }) => {
                s.recent = recent;
                self.context(now);
            }
            (Action::RequestPermission { .. }, Outcome::Permission { granted }) => {
                if !granted {
                    self.error("permission", None);
                    self.release();
                } else {
                    s.stage = Stage::Context;
                    self.ready(now);
                }
            }
            (Action::SuspendPlayback, Outcome::Done) => self.start_engine(now),
            (Action::StartCloud, Outcome::CloudStarted { granted }) => {
                if !granted {
                    self.error("permission", None);
                    self.cancel(now);
                } else {
                    s.stage = Stage::CloudListening;
                    s.operation_deadline = None;
                    s.core.listening();
                }
            }
            (Action::FinishCloud { .. }, Outcome::Transcript { text }) => {
                let final_text = s.core.result(text, true);
                if final_text.is_none() {
                    self.error("noSpeech", None);
                }
                self.append(final_text);
                self.release();
            }
            (Action::CancelCloud, Outcome::Done) => self.release(),
            (Action::CheckIdle, Outcome::Idle { inactive }) => self.idle(inactive, now),
            _ => {}
        }
    }
    fn context(&mut self, now: u64) {
        if let Some(s) = &mut self.session {
            s.context_ready = true;
            s.context_deadline = None;
        }
        self.ready(now);
    }
    fn idle(&mut self, inactive: bool, now: u64) {
        let Some(s) = &mut self.session else {
            return;
        };
        if inactive && s.idle_confirmed {
            s.operation_deadline = None;
            if s.restart && !s.cancelled {
                s.stage = Stage::Gap;
                // Quiet time already yielded to Expo; backoff includes that time.
                s.operation_deadline = Some((
                    now + s.restart_delay.saturating_sub(RESTART_MS),
                    Deadline::Restart,
                ));
                s.restart_delay = (s.restart_delay * 2).min(MAX_RESTART_MS);
            } else {
                self.release();
            }
            return;
        }
        s.idle_confirmed = inactive;
        if !inactive {
            s.idle_checks += 1;
        }
        if !inactive && s.idle_checks >= IDLE_CHECKS {
            s.stage = Stage::Quarantined;
            s.operation_deadline = None;
            s.restart = false;
            let text = s.core.end();
            s.cancelled = true;
            self.append(text);
            self.error("interrupted", None);
        } else {
            s.stage = Stage::Quiet;
            s.operation_deadline = Some((now + RESTART_MS, Deadline::Quiet));
        }
    }
    fn event(&mut self, event: Event, now: u64) {
        let Some(s) = &mut self.session else {
            return;
        };
        match event {
            Event::Start if s.stage == Stage::Starting && !s.cancelled => {
                s.stage = Stage::Listening;
                s.operation_deadline = None;
                s.core.listening();
            }
            Event::Result { text, is_final }
                if matches!(s.stage, Stage::Listening | Stage::Stopping) && !s.cancelled =>
            {
                if !text.trim().is_empty() {
                    s.restart_delay = RESTART_MS;
                } else if is_final && self.fallback(now) {
                    return;
                }
                let Some(s) = &mut self.session else {
                    return;
                };
                let final_text = s.core.result(text, is_final);
                s.received_final |= final_text.is_some();
                self.append(final_text);
            }
            Event::NoMatch
                if matches!(s.stage, Stage::Starting | Stage::Listening) && !s.cancelled =>
            {
                self.fallback(now);
            }
            Event::Error { error, message }
                if matches!(
                    s.stage,
                    Stage::Starting | Stage::Listening | Stage::Stopping
                ) && !s.cancelled =>
            {
                let empty = matches!(error.as_str(), "no-speech" | "speech-timeout");
                if s.config.android
                    && s.stage != Stage::Stopping
                    && (empty
                        || (!s.config.local_only
                            && s.continuous
                            && matches!(error.as_str(), "client" | "audio-capture")))
                {
                    self.disable_continuous();
                    self.close(true, now);
                    return;
                }
                let stopped = s.stage == Stage::Stopping;
                let stopped_client =
                    stopped && s.config.android && s.config.local_only && error == "client";
                let message = s.config.local_only.then_some(message).flatten();
                if !stopped_client && (!stopped || !empty) {
                    self.error(error_reason(&error), message);
                }
                if !stopped {
                    self.cancel(now);
                }
                // A stop still admits final results until end, even after error.
            }
            Event::End
                if !s.config.cloud()
                    && matches!(
                        s.stage,
                        Stage::Starting
                            | Stage::Listening
                            | Stage::Stopping
                            | Stage::Closing
                            | Stage::Quarantined
                    ) =>
            {
                if matches!(s.stage, Stage::Starting | Stage::Listening) && !s.cancelled {
                    if s.config.android {
                        s.restart = true;
                        self.disable_continuous();
                    } else if !s.received_final {
                        self.error("noSpeech", None);
                    }
                }
                self.check_idle(now);
            }
            Event::CloudEnd { failed } if s.stage == Stage::CloudListening => {
                if failed {
                    self.error("interrupted", None);
                    self.cancel(now);
                } else {
                    let owner = s.config.owner.clone();
                    self.apply(Command::Stop { owner }, now);
                }
            }
            _ => {}
        }
    }
    fn fail(&mut self, now: u64) {
        if let Some(s) = &self.session {
            let text = s.core.end();
            if !s.cancelled {
                self.append(text);
            }
        }
        self.error("failed", None);
        self.cancel(now);
    }
    pub fn advance(&mut self, now: u64) {
        let Some(s) = &mut self.session else {
            return;
        };
        if s.context_deadline.is_some_and(|at| at <= now) {
            self.pending
                .retain(|_, e| !matches!(e.action, Action::ReadContext));
            self.context(now);
        }
        let Some(s) = &mut self.session else {
            return;
        };
        let Some((at, kind)) = s.operation_deadline else {
            return;
        };
        if at > now {
            return;
        }
        s.operation_deadline = None;
        match kind {
            Deadline::Quiet => self.check_idle(now),
            Deadline::Restart => self.start_engine(now),
            Deadline::Operation => match s.stage {
                Stage::Starting => {
                    if !self.fallback(now) {
                        self.fail(now);
                    }
                }
                Stage::Closing => self.check_idle(now),
                Stage::Checking => {
                    self.pending
                        .retain(|_, e| !matches!(e.action, Action::CheckIdle));
                    self.idle(false, now);
                }
                Stage::CloudClosing => {
                    s.stage = Stage::Quarantined;
                    self.error("interrupted", None);
                }
                _ => self.fail(now),
            },
        }
    }
}
fn error_reason(error: &str) -> &str {
    match error {
        "not-allowed" => "permission",
        "service-not-allowed" | "language-not-supported" => "unavailable",
        "no-speech" | "speech-timeout" => "noSpeech",
        "network" => "network",
        "interrupted" => "interrupted",
        _ => "failed",
    }
}

#[cfg(test)]
mod tests;
