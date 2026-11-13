//! The voice provider has no host selection, shell, or approval capability.
mod correlation;
mod delivery;
pub(crate) use delivery::{BACKGROUND_AGENT, Delegation, Delivery, REMAIN_SILENT};

use std::sync::{
    Arc, LazyLock, Weak,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    HostConnectionState, HostRuntime, authoritative_agent_chat_identity, get_host_runtime,
};
use crate::agent_sessions::AgentBindingIdentity;
use crate::herdr_api::{
    HerdrAgentStatus, HerdrControlError, HerdrControlRequest, HerdrControlResult,
};
use crate::host_state::{HostFreshness, HostSyncStatus};
use crate::reverse_control::herdr::Request;

const MAX_RESULT_BYTES: usize = 24 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const START_TIMEOUT: Duration = Duration::from_secs(5);
static PINS: LazyLock<parking_lot::Mutex<Vec<Weak<PinnedAgent>>>> =
    LazyLock::new(parking_lot::Mutex::default);

/// Call-owned native capabilities pin residency; presentation lifetime does not.
pub(crate) fn retains_transcript(host: &str, binding: &AgentBindingIdentity) -> bool {
    PINS.lock().iter().filter_map(Weak::upgrade).any(|pin| {
        pin.runtime.inner.id == host
            && pin.binding.runtime_incarnation == binding.runtime_incarnation
            && pin.binding.terminal_id == binding.terminal_id
            && pin.binding.pane_id == binding.pane_id
            && pin.binding.agent == binding.agent
            && pin.binding.session_id == binding.session_id
            && pin.binding.transcript_key == binding.transcript_key
    })
}

#[cfg(test)]
mod tests;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTarget {
    pub runtime_id: String,
    pub terminal_id: String,
    pub pane_id: String,
    pub binding_token: String,
}

pub(crate) struct PinnedAgent {
    runtime: Arc<HostRuntime>,
    binding: AgentBindingIdentity,
    generation: u64,
    recovery: u64,
    submission: tokio::sync::Mutex<()>,
    uncertain: AtomicBool,
    receipts: parking_lot::Mutex<std::collections::HashMap<String, Receipt>>,
}

#[derive(Default)]
struct Receipt {
    accepted: bool,
    turn_id: Option<String>,
    lost: bool,
    terminal: bool,
    pending: bool,
    epoch: Option<u64>,
    after_revision: Option<u64>,
}

fn changed() -> HerdrControlError {
    HerdrControlError::RequestCancelled("The bound voice agent is no longer available.".into())
}

impl PinnedAgent {
    pub(crate) fn binding_identity(&self) -> AgentBindingIdentity {
        self.binding.clone()
    }
    /// Resolve a destination selected by the call, independently of React views.
    pub(crate) fn pin_voice_source(
        source: &crate::voice_session::Source,
    ) -> Result<Arc<Self>, HerdrControlError> {
        let runtime = get_host_runtime(source.runtime_id.clone()).ok_or_else(changed)?;
        if source.incarnation.parse::<u64>().ok() != Some(runtime.runtime_incarnation()) {
            return Err(changed());
        }
        let pinned = Self::select(source.runtime_id.clone(), &source.pane_id)?;
        let agent = match pinned.binding.agent {
            crate::AgentTranscriptKind::Claude => "claude",
            crate::AgentTranscriptKind::Codex => "codex",
            crate::AgentTranscriptKind::OpenCode => "opencode",
            crate::AgentTranscriptKind::Pi => "pi",
        };
        if pinned.binding.terminal_id.as_str() != source.terminal_id || agent != source.agent {
            return Err(changed());
        }
        Ok(pinned)
    }
    /// Explicit history lookup never creates a binding or opens a transport.
    pub(crate) fn select_existing(
        runtime_id: String,
        pane_id: &str,
    ) -> Result<Arc<Self>, HerdrControlError> {
        let runtime = get_host_runtime(runtime_id.clone()).ok_or_else(changed)?;
        let terminal = runtime
            .host_state()
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.panes.iter().find(|pane| pane.pane_id == pane_id))
            .map(|pane| pane.terminal_id.clone())
            .ok_or_else(changed)?;
        let binding = runtime
            .inner
            .agents
            .terminal_binding_metadata(&terminal)
            .ok_or_else(changed)?;
        Self::pin(AgentTarget {
            runtime_id,
            terminal_id: terminal,
            pane_id: pane_id.into(),
            binding_token: binding.binding_token,
        })
    }
    /// Explicit global-call selection, pinned before the user confirms a prompt.
    pub(crate) fn select(
        runtime_id: String,
        pane_id: &str,
    ) -> Result<Arc<Self>, HerdrControlError> {
        if let Ok(agent) = Self::select_existing(runtime_id.clone(), pane_id) {
            return Ok(agent);
        }
        let runtime = get_host_runtime(runtime_id.clone()).ok_or_else(changed)?;
        let terminal_id = runtime
            .host_state()
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.panes.iter().find(|pane| pane.pane_id == pane_id))
            .map(|pane| pane.terminal_id.clone())
            .ok_or_else(changed)?;
        let crate::agent_sessions::AgentChatOpenResult::Bound { binding } = runtime
            .open_agent_chat(terminal_id.clone())
            .map_err(|_| changed())?
        else {
            return Err(changed());
        };
        Self::pin(AgentTarget {
            runtime_id,
            terminal_id,
            pane_id: pane_id.into(),
            binding_token: binding.binding_token,
        })
    }

    /// Start native transcript observation without opening or depending on chat UI.
    pub(crate) async fn prepare_selected(&self) -> Result<(), HerdrControlError> {
        self.check()?;
        if !self
            .runtime
            .inner
            .agents
            .binding_needs_start(&self.binding.binding_token)
        {
            return self.check();
        }
        let result = self
            .runtime
            .start_agent_chat(self.binding.binding_token.clone())
            .await
            .map_err(|_| changed())?;
        self.check()?;
        if matches!(
            result,
            crate::agent_sessions::AgentChatStartResult::Started { .. }
        ) {
            Ok(())
        } else {
            Err(changed())
        }
    }

    pub(crate) fn pin(target: AgentTarget) -> Result<Arc<Self>, HerdrControlError> {
        let runtime = get_host_runtime(target.runtime_id).ok_or_else(changed)?;
        let binding = runtime
            .inner
            .agents
            .terminal_binding_metadata(&target.terminal_id)
            .filter(|binding| {
                binding.binding_token == target.binding_token
                    && binding.pane_id.as_str() == target.pane_id
            })
            .ok_or_else(changed)?;
        let (generation, recovery) = {
            let state = runtime.inner.state.lock();
            (state.generation, state.herdr_recovery_revision)
        };
        let pinned = Arc::new(Self {
            runtime,
            binding,
            generation,
            recovery,
            submission: tokio::sync::Mutex::new(()),
            uncertain: AtomicBool::new(false),
            receipts: parking_lot::Mutex::default(),
        });
        pinned.check()?;
        let mut pins = PINS.lock();
        pins.retain(|pin| pin.strong_count() > 0);
        pins.push(Arc::downgrade(&pinned));
        drop(pins);
        Ok(pinned)
    }

    pub(crate) fn check(&self) -> Result<(), HerdrControlError> {
        self.check_state(true)
    }

    /// A snapshot refresh is not a disconnect. Tools still require fresh state.
    pub(crate) fn check_liveness(&self) -> Result<(), HerdrControlError> {
        self.check_state(false)
    }

    pub(crate) fn startup_context(&self) -> Result<Option<String>, HerdrControlError> {
        self.check()?;
        let context = self.runtime.inner.agents.project_voice_transcript(
            &self.binding.transcript_key,
            crate::realtime_voice::context::from_window,
        );
        self.check_liveness()?;
        Ok(context)
    }

    pub(crate) fn source_id(&self) -> crate::realtime_voice::observer::SourceId {
        crate::realtime_voice::observer::SourceId {
            host_id: self.runtime.inner.id.clone(),
            runtime_incarnation: self.binding.runtime_incarnation,
            transcript_key: self.binding.transcript_key.as_str().into(),
            terminal_id: self.binding.terminal_id.as_str().into(),
            pane_id: self.binding.pane_id.as_str().into(),
            binding_token: self.binding.binding_token.clone(),
            binding_generation: self.binding.binding_generation,
        }
    }

    pub(crate) fn read_context(&self, limit: usize) -> Result<Value, HerdrControlError> {
        self.check_liveness()?;
        let context = self
            .runtime
            .inner
            .agents
            .project_voice_transcript(&self.binding.transcript_key, |view| {
                crate::realtime_voice::context::read_window(view, self.binding.agent, limit)
            });
        self.check_liveness()?;
        let status = self
            .runtime
            .host_state()
            .snapshot
            .as_ref()
            .and_then(|snapshot| {
                snapshot
                    .panes
                    .iter()
                    .find(|pane| pane.pane_id == self.binding.pane_id.as_str())
            })
            .map(|pane| pane.agent_status);
        let fresh = self.check().is_ok() && context.is_some();
        self.check_liveness()?;
        Ok(
            json!({"source":self.source_id(), "fresh":fresh, "stale":!fresh,
                "available":context.is_some(), "history":context,"status":status,
                "source_freshness":if fresh { "live" } else { "unavailable_or_stale" },
            "guidance":"Historical questions are not evidence of a currently pending request. Tool and approval details are not available here."}),
        )
    }

    fn observe_request(
        &self,
        delegation_id: &str,
        tracker: &mut correlation::Tracker,
    ) -> Result<Option<correlation::Observation>, HerdrControlError> {
        self.check()?;
        let observation = self.runtime.inner.agents.project_live_transcript(
            &self.binding.transcript_key,
            None,
            |view| tracker.observe(view),
        );
        self.check()?;
        let observation = observation.map(|(epoch, mut value)| {
            let expected = self
                .receipts
                .lock()
                .get(delegation_id)
                .and_then(|receipt| receipt.epoch);
            if expected.is_some_and(|expected| expected != epoch) {
                tracker.source_changed();
                value.lost = true;
                value.accepted = false;
                value.provider = false;
                value.outcome = None;
                value.assistant_output = None;
                value.turn_id = None;
            }
            self.receipts.lock().insert(
                delegation_id.into(),
                Receipt {
                    accepted: value.accepted && value.provider,
                    turn_id: value.turn_id.clone(),
                    lost: value.lost,
                    terminal: value.outcome.is_some(),
                    pending: true,
                    epoch: Some(epoch),
                    after_revision: tracker.admission_revision(),
                },
            );
            value
        });
        Ok(observation)
    }

    pub(crate) fn progress_matches(
        &self,
        delegation: &str,
        turn: &str,
        epoch: u64,
        revision: u64,
    ) -> bool {
        self.receipts.lock().get(delegation).is_some_and(|receipt| {
            receipt.accepted
                && !receipt.lost
                && !receipt.terminal
                && receipt.epoch == Some(epoch)
                && receipt
                    .after_revision
                    .is_some_and(|before| revision > before)
                && receipt.turn_id.as_deref() == Some(turn)
        })
    }

    pub(crate) fn context_delivery(
        &self,
        source: &crate::realtime_voice::observer::SourceId,
        turn: Option<&str>,
        epoch: u64,
        revision: u64,
    ) -> crate::realtime_voice::observer::DeliveryDecision {
        use crate::realtime_voice::observer::DeliveryDecision;
        if *source != self.source_id() {
            return DeliveryDecision::Ignore;
        }
        let receipts = self.receipts.lock();
        if turn.is_some_and(|turn| {
            receipts.values().any(|receipt| {
                receipt.accepted
                    && !receipt.lost
                    && receipt.epoch == Some(epoch)
                    && receipt
                        .after_revision
                        .is_some_and(|before| revision > before)
                    && receipt.turn_id.as_deref() == Some(turn)
            })
        }) {
            return DeliveryDecision::Allow;
        }
        if receipts.values().any(|receipt| {
            receipt.pending && receipt.epoch.is_none_or(|expected| expected == epoch)
        }) {
            DeliveryDecision::Wait
        } else {
            DeliveryDecision::Ignore
        }
    }

    fn check_state(&self, require_fresh: bool) -> Result<(), HerdrControlError> {
        if !super::runtimes()
            .read()
            .get(&self.runtime.inner.id)
            .is_some_and(|registered| Arc::ptr_eq(registered, &self.runtime.inner))
        {
            return Err(changed());
        }
        let binding = self
            .runtime
            .inner
            .agents
            .terminal_binding_metadata(self.binding.terminal_id.as_str())
            .ok_or_else(changed)?;
        if binding.binding_token != self.binding.binding_token
            || binding.binding_generation != self.binding.binding_generation
            || binding.runtime_incarnation != self.binding.runtime_incarnation
            || binding.session_id != self.binding.session_id
        {
            return Err(changed());
        }
        let state = self.runtime.inner.state.lock();
        let host = state.host_state.projection();
        let fresh =
            host.sync_status == HostSyncStatus::Synced && host.freshness == HostFreshness::Fresh;
        let refreshing = host.freshness == HostFreshness::Stale
            && (host.sync_status == HostSyncStatus::Syncing
                || (host.sync_status == HostSyncStatus::Synced && host.needs_resync));
        if state.connection != HostConnectionState::Connected
            || state.generation != self.generation
            || state.herdr_recovery_revision != self.recovery
            || !(fresh || !require_fresh && refreshing)
        {
            return Err(changed());
        }
        drop(state);
        let pane = host
            .snapshot
            .as_ref()
            .and_then(|snapshot| {
                snapshot
                    .panes
                    .iter()
                    .find(|pane| pane.pane_id == self.binding.pane_id.as_str())
            })
            .ok_or_else(changed)?;
        self.check_pane(pane)
    }

    fn check_pane(&self, pane: &crate::herdr_api::HerdrPaneInfo) -> Result<(), HerdrControlError> {
        if pane.terminal_id != self.binding.terminal_id.as_str()
            || pane.pane_id != self.binding.pane_id.as_str()
            || !authoritative_agent_chat_identity(pane).is_some_and(|identity| {
                identity.session_id == self.binding.session_id
                    && identity.agent == self.binding.agent
            })
        {
            return Err(changed());
        }
        Ok(())
    }

    fn check_agent_result(&self, value: &Value) -> Result<(), HerdrControlError> {
        use crate::agent_transcript::AgentTranscriptKind;
        let kind = match self.binding.agent {
            AgentTranscriptKind::Claude => "claude",
            AgentTranscriptKind::Codex => "codex",
            AgentTranscriptKind::OpenCode => "opencode",
            AgentTranscriptKind::Pi => "pi",
        };
        let agent = &value["agent"];
        if agent["pane_id"].as_str() != Some(self.binding.pane_id.as_str())
            || agent["terminal_id"].as_str() != Some(self.binding.terminal_id.as_str())
            || agent["agent_session"]["value"].as_str() != Some(self.binding.session_id.as_str())
            || agent["agent_session"]["agent"].as_str() != Some(kind)
        {
            return Err(changed());
        }
        Ok(())
    }

    fn refresh(
        &self,
    ) -> futures::future::BoxFuture<'_, Result<crate::herdr_api::HerdrPaneInfo, HerdrControlError>>
    {
        Box::pin(async move {
            self.check()?;
            let snapshot = self
                .runtime
                .control_from_reverse_agent(HerdrControlRequest::SessionSnapshot)
                .await?;
            self.check()?;
            let HerdrControlResult::SessionSnapshot { snapshot } = snapshot else {
                return Err(changed());
            };
            let pane = snapshot
                .panes
                .into_iter()
                .find(|pane| pane.pane_id == self.binding.pane_id.as_str())
                .ok_or_else(changed)?;
            self.check_pane(&pane)?;
            Ok(pane)
        })
    }

    fn request(
        &self,
        value: Value,
    ) -> futures::future::BoxFuture<'_, Result<Value, HerdrControlError>> {
        Box::pin(async move {
            self.check()?;
            let request = Request::parse(value)?;
            let protocol = self
                .runtime
                .inner
                .state
                .lock()
                .protocol
                .ok_or_else(changed)?;
            // Reuse Herdr's validated lifecycle requests and verified connection,
            // checking this call's immutable identity before AND after each step.
            request
                .run(protocol, |call| async move {
                    self.check()?;
                    let agent_result = matches!(
                        call.method.as_str(),
                        "agent.get" | "agent.prompt" | "agent.wait"
                    );
                    let value = crate::herdr_api::request_json_on_runtime(
                        self.runtime.inner.herdr.clone(),
                        &call.method,
                        call.params,
                        call.timeout_ms,
                    )
                    .await?;
                    self.check()?;
                    if agent_result {
                        self.check_agent_result(&value)?;
                    }
                    Ok(value)
                })
                .await
        })
    }

    pub(crate) fn mark_uncertain(&self) {
        self.uncertain.store(true, Ordering::Release);
    }

    pub(crate) async fn delegate(&self, request: Delegation, followup: bool) -> Value {
        self.delegate_for(&uuid::Uuid::new_v4().to_string(), request, followup)
            .await
    }

    pub(crate) async fn delegate_for(
        &self,
        id: &str,
        request: Delegation,
        followup: bool,
    ) -> Value {
        {
            let mut receipts = self.receipts.lock();
            if id.is_empty() || id.len() > 128 || receipts.len() >= 128 || receipts.contains_key(id)
            {
                return json!({"error":"delegation_identity_unavailable","guidance":"No request was submitted. Never replay an existing delegation identity."});
            }
            receipts.insert(id.into(), Receipt::default());
        }
        if request.delivery == Delivery::Now
            && self.check_liveness().is_ok()
            && self.check().is_err()
        {
            return json!({"error":"agent_syncing","guidance":"Wait for the connected host to refresh before using agent tools."});
        }
        if let Some(receipt) = self.receipts.lock().get_mut(id) {
            receipt.pending = true;
        }
        let result = match self.delegate_inner(id, request, followup).await {
            Ok(value) if value.to_string().len() <= MAX_RESULT_BYTES => value,
            Ok(_) => json!({"error":"result_too_large"}),
            Err(HerdrControlError::ProtocolError(code, _)) => {
                let code = match code.as_str() {
                    "agent_blocked" | "agent_not_ready" => "approval_required",
                    "agent_pane_busy" => "agent_busy",
                    "unsupported_feature" => "unsupported_host",
                    _ => "outcome_unknown",
                };
                if code == "outcome_unknown" {
                    self.mark_uncertain();
                }
                json!({"error":code,"guidance":"Inspect the bound agent in Whip. Never repeat a prompt after an uncertain outcome."})
            }
            Err(_) => {
                self.mark_uncertain();
                json!({"error":"outcome_unknown","guidance":"Inspect the agent in Whip before submitting again."})
            }
        };
        if let Some(receipt) = self.receipts.lock().get_mut(id) {
            receipt.pending = false;
        }
        result
    }

    async fn delegate_inner(
        &self,
        id: &str,
        request: Delegation,
        followup: bool,
    ) -> Result<Value, HerdrControlError> {
        // Serialize admission, not the whole task: a pending lifecycle wait must
        // not prevent a later user instruction from steering active work.
        loop {
            self.wait_fresh().await?;
            if self.uncertain.load(Ordering::Acquire) {
                return Ok(
                    json!({"error":"outcome_unknown","guidance":"Unsent deferred work was cancelled. Inspect the agent before calling again."}),
                );
            }
            let admission = self.submission.lock().await;
            self.wait_fresh().await?;
            if self.uncertain.load(Ordering::Acquire) {
                return Ok(json!({"error":"outcome_unknown"}));
            }
            let pane = match self.refresh().await {
                Err(_) if self.check_liveness().is_ok() && self.check().is_err() => {
                    drop(admission);
                    continue;
                }
                other => other?,
            };
            if request.delivery == Delivery::Later && !settled(pane.agent_status) {
                drop(admission);
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
            // agent.get also verifies lifecycle protocol support and the remote
            // session identity before any write, including on older hosts.
            let status = self.live_status().await?;
            if request.delivery == Delivery::Later && !settled(status) {
                drop(admission);
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
            if let Err(code) = plan(status, self.binding.agent, request.delivery) {
                return Ok(
                    json!({"error":code,"guidance":"Inspect the bound agent in Whip. Approval controls remain in Whip."}),
                );
            }
            let target = self.binding.pane_id.as_str();
            let was_working = status == HerdrAgentStatus::Working;
            let (epoch, mut tracker) = self
                .runtime
                .inner
                .agents
                .project_live_transcript(&self.binding.transcript_key, None, |view| {
                    correlation::Tracker::new(Some(view), was_working)
                })
                .map(|(epoch, tracker)| (Some(epoch), tracker))
                .unwrap_or_else(|| (None, correlation::Tracker::new(None, was_working)));
            if let Some(receipt) = self.receipts.lock().get_mut(id) {
                receipt.epoch = epoch;
                receipt.after_revision = tracker.admission_revision();
            }
            let text = if let Some(context) = &request.context {
                match context.request(&request.prompt) {
                    Ok(text) => text,
                    Err(_) => {
                        return Ok(
                            json!({"error":"voice_context_unavailable","guidance":"No request was submitted. Inspect the voice conversation before trying again."}),
                        );
                    }
                }
            } else {
                request.prompt.clone()
            };
            let text = tracker.text(&text);
            self.request(json!({"action":"agent_prompt","target":target,"text":text}))
                .await?;
            if let Some(context) = &request.context {
                context.acknowledge();
            }
            if was_working && followup && request.delivery == Delivery::Now {
                let deadline = tokio::time::Instant::now() + START_TIMEOUT;
                loop {
                    self.wait_fresh().await?;
                    let observation = self.observe_request(id, &mut tracker)?;
                    if observation
                        .as_ref()
                        .is_some_and(|value| value.accepted || value.lost)
                        || tokio::time::Instant::now() >= deadline
                    {
                        return Ok(json!({"delivery":"steered","completion":"submitted",
                            "accepted":observation.as_ref().is_some_and(|value| value.accepted && !value.lost),
                            "turn_id":observation.as_ref().filter(|value| value.provider && !value.lost).and_then(|value| value.turn_id.as_ref()),
                            "guidance":"Guidance was submitted to the active task. Acceptance is reported separately. This is not task completion; the original handoff continues."}));
                    }
                    tokio::time::sleep(POLL_INTERVAL).await;
                }
            }
            let delivery = if was_working { "steered" } else { "started" };
            let deadline = tokio::time::Instant::now() + START_TIMEOUT;
            loop {
                self.wait_fresh().await?;
                let observation = self.observe_request(id, &mut tracker)?;
                let status = self.live_status().await?;
                // Transcript acceptance or terminal outcome also handles work that
                // starts and finishes entirely between lifecycle polls.
                if observation
                    .as_ref()
                    .is_some_and(|value| value.accepted || value.lost)
                    || was_working
                    || matches!(
                        status,
                        HerdrAgentStatus::Working | HerdrAgentStatus::Blocked
                    )
                {
                    break;
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(HerdrControlError::RequestTimeout(
                        "Agent input was submitted but acceptance was not observed".into(),
                    ));
                }
                tokio::time::sleep(POLL_INTERVAL).await;
            }
            drop(admission);
            // Only reads repeat. An idle pane or another turn completing cannot
            // complete this request. Unavailable correlation never replays input.
            loop {
                self.wait_fresh().await?;
                let observation = self.observe_request(id, &mut tracker)?;
                let status = self.live_status().await?;
                if observation
                    .as_ref()
                    .is_some_and(|value| value.outcome.is_some() || value.lost)
                    || settled(status)
                    || status == HerdrAgentStatus::Blocked
                {
                    return self
                        .request_result(id, &mut tracker, delivery, status)
                        .await;
                }
                tokio::time::sleep(POLL_INTERVAL).await;
            }
        }
    }

    async fn live_status(&self) -> Result<HerdrAgentStatus, HerdrControlError> {
        loop {
            self.wait_fresh().await?;
            let value = match self
                .request(json!({"action":"agent_get","target":self.binding.pane_id.as_str()}))
                .await
            {
                Err(_) if self.check_liveness().is_ok() && self.check().is_err() => continue,
                other => other?,
            };
            return serde_json::from_value(value["agent"]["agent_status"].clone())
                .map_err(|_| changed());
        }
    }

    async fn wait_fresh(&self) -> Result<(), HerdrControlError> {
        loop {
            self.check_liveness()?;
            if self.check().is_ok() {
                return Ok(());
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    async fn request_result(
        &self,
        id: &str,
        tracker: &mut correlation::Tracker,
        delivery: &str,
        status: HerdrAgentStatus,
    ) -> Result<Value, HerdrControlError> {
        // Provider items can trail terminal/status events. Read a bounded tail
        // from the same identity; never select a different turn or stale answer.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            self.wait_fresh().await?;
            let observation = self.observe_request(id, tracker)?;
            if tokio::time::Instant::now() >= deadline
                || observation.as_ref().is_some_and(|value| value.lost)
            {
                let Some(observation) = observation else {
                    return Ok(
                        json!({"error":"outcome_unknown","completion":"unknown","correlation":"unavailable"}),
                    );
                };
                let mut result = observation.result(delivery, status);
                if observation.lost || !observation.accepted {
                    result["error"] = json!("outcome_unknown");
                } else if observation.outcome.is_none() && status == HerdrAgentStatus::Blocked {
                    result["observation"] = json!("agent_blocked");
                }
                return Ok(result);
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }
}

fn settled(status: HerdrAgentStatus) -> bool {
    matches!(status, HerdrAgentStatus::Idle | HerdrAgentStatus::Done)
}

static PREPARING: std::sync::LazyLock<parking_lot::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(parking_lot::Mutex::default);

pub(crate) fn prepare_global_sources() {
    let ids: Vec<_> = super::runtimes().read().keys().cloned().collect();
    for id in ids {
        prepare_global_host(&id);
    }
}

pub(crate) fn prepare_global_host(id: &str) {
    if !crate::realtime_voice::observer::global_active() {
        return;
    }
    let Some(runtime) = get_host_runtime(id.into()) else {
        return;
    };
    let (connection, host, _) = runtime.tool_state();
    if connection != HostConnectionState::Connected
        || host.sync_status != HostSyncStatus::Synced
        || host.freshness != HostFreshness::Fresh
    {
        return;
    }
    let Some(snapshot) = host.snapshot else {
        return;
    };
    let panes: Vec<_> = snapshot
        .panes
        .iter()
        .filter(|pane| authoritative_agent_chat_identity(pane).is_some())
        .take(64)
        .map(|pane| pane.pane_id.clone())
        .collect();
    if panes.is_empty() || !PREPARING.lock().insert(id.into()) {
        return;
    }
    let Ok(executor) = crate::runtime() else {
        PREPARING.lock().remove(id);
        return;
    };
    let id = id.to_owned();
    executor.spawn(async move {
        let mut tasks = tokio::task::JoinSet::new();
        for pane in panes {
            if !crate::realtime_voice::observer::global_active() {
                break;
            }
            let Ok(agent) = PinnedAgent::select(id.clone(), &pane) else {
                continue;
            };
            tasks.spawn(async move {
                let _ = agent.prepare_selected().await;
            });
            if tasks.len() >= 4 {
                let _ = tasks.join_next().await;
            }
        }
        while tasks.join_next().await.is_some() {}
        PREPARING.lock().remove(&id);
    });
}

fn plan(
    status: HerdrAgentStatus,
    kind: crate::agent_transcript::AgentTranscriptKind,
    delivery: Delivery,
) -> Result<(), &'static str> {
    match status {
        HerdrAgentStatus::Idle | HerdrAgentStatus::Done => Ok(()),
        HerdrAgentStatus::Working
            if delivery == Delivery::Now
                && kind == crate::agent_transcript::AgentTranscriptKind::Codex =>
        {
            Ok(())
        }
        HerdrAgentStatus::Blocked => Err("approval_required"),
        _ => Err("agent_busy"),
    }
}
