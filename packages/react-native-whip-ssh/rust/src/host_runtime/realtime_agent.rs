//! The voice provider has no host selection, shell, or approval capability.
use std::sync::Arc;

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

const MAX_PROMPT_BYTES: usize = 8 * 1024;
const MAX_RESULT_BYTES: usize = 24 * 1024;
pub(crate) const AGENT_PROMPT: &str = "agent_prompt";
pub(crate) const AGENT_STATUS: &str = "agent_status";
pub(crate) const AGENT_READ: &str = "agent_read";

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
                let agent_result = matches!(call.method.as_str(), "agent.get" | "agent.prompt");
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

    pub(crate) async fn execute(&self, name: &str, arguments: &str) -> Value {
        if self.check_liveness().is_ok() && self.check().is_err() {
            return json!({"error":"agent_syncing","guidance":"Wait for the connected host to refresh before using agent tools."});
        }
        match self.execute_inner(name, arguments).await {
            Ok(value) if value.to_string().len() <= MAX_RESULT_BYTES => value,
            Ok(_) => {
                json!({"error":"result_too_large","guidance":"Use agent_read with fewer lines."})
            }
            Err(HerdrControlError::ProtocolError(code, _)) => {
                // Never return provider/host error bodies, terminal text embedded
                // in errors, or unrestricted protocol error strings to logs/UI.
                let code = match code.as_str() {
                    "agent_blocked" | "agent_not_ready" => "approval_required",
                    "agent_pane_busy" => "agent_busy",
                    "unsupported_feature" => "unsupported_host",
                    _ => "outcome_unknown",
                };
                json!({"error":code,"guidance":"Inspect the bound agent in Whip. Never repeat a prompt after an uncertain outcome."})
            }
            Err(_) => {
                json!({"error":"outcome_unknown","guidance":"Inspect the agent in Whip before submitting again."})
            }
        }
    }

    async fn execute_inner(&self, name: &str, arguments: &str) -> Result<Value, HerdrControlError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Prompt {
            text: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Read {
            lines: Option<u32>,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Empty {}
        let invalid = || HerdrControlError::InvalidField("Invalid voice tool arguments".into());
        self.check()?;
        // A fresh remote snapshot verifies the original pane occupant immediately
        // before a tool; foreground focus is deliberately irrelevant.
        let pane = self.refresh().await?;
        let target = self.binding.pane_id.as_str();
        match name {
            AGENT_STATUS => {
                serde_json::from_str::<Empty>(arguments).map_err(|_| invalid())?;
                self.request(json!({"action":"agent_get","target":target}))
                    .await
            }
            AGENT_READ => {
                let args = serde_json::from_str::<Read>(arguments).map_err(|_| invalid())?;
                let lines = args.lines.unwrap_or(60);
                if !(1..=120).contains(&lines) {
                    return Err(invalid());
                }
                let value = self
                    .request(json!({"action":"agent_read","target":target,"lines":lines}))
                    .await?;
                self.refresh().await?;
                Ok(value)
            }
            AGENT_PROMPT => {
                let args = serde_json::from_str::<Prompt>(arguments).map_err(|_| invalid())?;
                if args.text.trim().is_empty()
                    || args.text.len() > MAX_PROMPT_BYTES
                    || args
                        .text
                        .chars()
                        .any(|c| c.is_control() && c != '\n' && c != '\t')
                {
                    return Err(invalid());
                }
                if pane.agent_status == HerdrAgentStatus::Blocked {
                    return Ok(
                        json!({"error":"approval_required","guidance":"Use the existing approval controls in Whip."}),
                    );
                }
                if !matches!(
                    pane.agent_status,
                    HerdrAgentStatus::Idle | HerdrAgentStatus::Done
                ) {
                    return Ok(json!({"error":"agent_busy"}));
                }
                // Atomic Herdr lifecycle wait: no shell, key injection, retries,
                // automatic approval, or waits against a different agent.
                self.request(json!({"action":AGENT_PROMPT,"target":target,"text":args.text,"wait":{"timeout_ms":120_000}})).await
            }
            _ => Err(invalid()),
        }
    }
}
