//! The voice provider has no host selection, shell, or approval capability.
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

    pub(crate) fn feedback_snapshot(
        &self,
        revision: Option<u64>,
    ) -> Result<Option<crate::realtime_voice::feedback::Snapshot>, HerdrControlError> {
        self.check_liveness()?;
        if self.check().is_err() {
            return Ok(None);
        }
        let snapshot = self.runtime.inner.agents.project_live_transcript(
            &self.binding.transcript_key,
            revision,
            crate::realtime_voice::feedback::Snapshot::from_view,
        );
        self.check_liveness()?;
        Ok(snapshot)
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
            let baseline = self.feedback_snapshot(None)?;
            self.request(json!({"action":"agent_prompt","target":target,"text":request.prompt}))
                .await?;
            if was_working && followup && request.delivery == Delivery::Now {
                return Ok(
                    json!({"delivery":"steered","completion":"submitted","guidance":"Guidance was sent to the active task. This is not task completion; the original handoff continues."}),
                );
            }
            // A successful write alone is not a started turn. Observe activity
            // before releasing admission for another initial submission.
            if !was_working {
                let deadline = tokio::time::Instant::now() + START_TIMEOUT;
                loop {
                    let status = self.live_status().await?;
                    if matches!(
                        status,
                        HerdrAgentStatus::Working | HerdrAgentStatus::Blocked
                    ) {
                        break;
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return Err(HerdrControlError::RequestTimeout(
                            "Agent input was submitted but activity was not observed".into(),
                        ));
                    }
                    tokio::time::sleep(POLL_INTERVAL).await;
                }
            }
            drop(admission);
            // Only reads are repeated. Never replay input after a transport or
            // completion timeout. This wait does not claim per-turn correlation.
            loop {
                let status = self.live_status().await?;
                if settled(status) || status == HerdrAgentStatus::Blocked {
                    let answer = self.settled_answer(baseline.as_ref()).await?;
                    return Ok(
                        json!({"delivery":if was_working {"steered"} else {"started"},"completion":"lifecycle_settled","status":status,"assistant_output":answer,"guidance":"This is a lifecycle observation, not proof that every request or queued task completed. assistant_output is actual public text observed after submission, not a per-turn completion receipt."}),
                    );
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

    async fn settled_answer(
        &self,
        baseline: Option<&crate::realtime_voice::feedback::Snapshot>,
    ) -> Result<Option<String>, HerdrControlError> {
        let Some(baseline) = baseline else {
            return Ok(None);
        };
        // Native transcript delivery can trail PTY status. Keep the socket/audio
        // actor responsive while allowing that bounded tail to arrive.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let mut answer = None;
        loop {
            self.wait_fresh().await?;
            if let Some(snapshot) = self.feedback_snapshot(None)? {
                answer = snapshot.answer_since(baseline).map(str::to_owned);
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(answer);
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
