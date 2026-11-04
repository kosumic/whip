//! The voice provider has no host selection, shell, or approval capability.
mod correlation;
mod delivery;
pub(crate) use delivery::{BACKGROUND_AGENT, Delegation, Delivery, REMAIN_SILENT};

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    HostConnectionState, HostRuntime, authoritative_agent_chat_identity, get_host_runtime,
};
use crate::agent_sessions::BoundAgentChat;
use crate::herdr_api::{
    HerdrAgentStatus, HerdrControlError, HerdrControlRequest, HerdrControlResult,
};
use crate::host_state::{HostFreshness, HostSyncStatus};
use crate::reverse_control::herdr::Request;

const MAX_RESULT_BYTES: usize = 24 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const START_TIMEOUT: Duration = Duration::from_secs(5);

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
    binding: BoundAgentChat,
    generation: u64,
    recovery: u64,
    submission: tokio::sync::Mutex<()>,
    uncertain: AtomicBool,
    feedback_scope: parking_lot::Mutex<Option<correlation::Scope>>,
}

fn changed() -> HerdrControlError {
    HerdrControlError::RequestCancelled("The bound voice agent is no longer available.".into())
}

impl PinnedAgent {
    pub(crate) fn pin(target: AgentTarget) -> Result<Arc<Self>, HerdrControlError> {
        let runtime = get_host_runtime(target.runtime_id).ok_or_else(changed)?;
        let binding = runtime
            .inner
            .agents
            .terminal_binding(&target.terminal_id)
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
            feedback_scope: parking_lot::Mutex::new(None),
        });
        pinned.check()?;
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
        let context = self.runtime.inner.agents.project_live_transcript(
            &self.binding.transcript_key,
            None,
            crate::realtime_voice::context::from_view,
        );
        self.check_liveness()?;
        Ok(context)
    }

    pub(crate) fn feedback_snapshot(
        &self,
        _revision: Option<u64>,
    ) -> Result<Option<crate::realtime_voice::feedback::Snapshot>, HerdrControlError> {
        self.check_liveness()?;
        if self.check().is_err() {
            return Ok(None);
        }
        let scope = self.feedback_scope.lock().clone();
        let snapshot = self.runtime.inner.agents.project_live_transcript(
            &self.binding.transcript_key,
            None,
            |view| {
                let scope = scope
                    .as_ref()
                    .and_then(|scope| scope.turn(view).map(|turn| (scope, turn)));
                crate::realtime_voice::feedback::Snapshot::from_filtered_view(view, |message| {
                    scope.is_some_and(|(scope, turn)| scope.permits(turn, message))
                })
            },
        );
        self.check_liveness()?;
        Ok(snapshot)
    }

    fn observe_request(
        &self,
        tracker: &mut correlation::Tracker,
    ) -> Result<Option<correlation::Observation>, HerdrControlError> {
        self.check()?;
        let observation = self.runtime.inner.agents.project_live_transcript(
            &self.binding.transcript_key,
            None,
            |view| tracker.observe(view),
        );
        self.check()?;
        if observation
            .as_ref()
            .is_some_and(|observation| observation.lost)
        {
            *self.feedback_scope.lock() = None;
        } else if let Some(scope) = &tracker.scope {
            *self.feedback_scope.lock() = Some(scope.clone());
        }
        Ok(observation)
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
            .terminal_binding(self.binding.terminal_id.as_str())
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

    async fn refresh(&self) -> Result<crate::herdr_api::HerdrPaneInfo, HerdrControlError> {
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
    }

    async fn request(&self, value: Value) -> Result<Value, HerdrControlError> {
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
    }

    pub(crate) fn mark_uncertain(&self) {
        self.uncertain.store(true, Ordering::Release);
    }

    pub(crate) fn clear_feedback(&self) {
        *self.feedback_scope.lock() = None;
    }

    pub(crate) async fn delegate(&self, request: Delegation, followup: bool) -> Value {
        if request.delivery == Delivery::Now
            && self.check_liveness().is_ok()
            && self.check().is_err()
        {
            return json!({"error":"agent_syncing","guidance":"Wait for the connected host to refresh before using agent tools."});
        }
        match self.delegate_inner(request, followup).await {
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
        }
    }

    async fn delegate_inner(
        &self,
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
            let mut tracker = self
                .runtime
                .inner
                .agents
                .project_live_transcript(&self.binding.transcript_key, None, |view| {
                    correlation::Tracker::new(Some(view), was_working)
                })
                .unwrap_or_else(|| correlation::Tracker::new(None, was_working));
            if !was_working {
                *self.feedback_scope.lock() = None;
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
                    let observation = self.observe_request(&mut tracker)?;
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
                let observation = self.observe_request(&mut tracker)?;
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
                let observation = self.observe_request(&mut tracker)?;
                let status = self.live_status().await?;
                if observation
                    .as_ref()
                    .is_some_and(|value| value.outcome.is_some() || value.lost)
                    || settled(status)
                    || status == HerdrAgentStatus::Blocked
                {
                    return self.request_result(&mut tracker, delivery, status).await;
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
        tracker: &mut correlation::Tracker,
        delivery: &str,
        status: HerdrAgentStatus,
    ) -> Result<Value, HerdrControlError> {
        // Provider items can trail terminal/status events. Read a bounded tail
        // from the same identity; never select a different turn or stale answer.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            self.wait_fresh().await?;
            let observation = self.observe_request(tracker)?;
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
