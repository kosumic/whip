//! Persisted agent launch preferences and serialized pane lifecycle operations.
use super::*;
use crate::herdr_api::{
    HerdrAgentKind, HerdrAgentStatus, HerdrControlError, HerdrControlRequest, HerdrControlResult,
    HerdrSessionSnapshot, HerdrTabLaunch, HerdrTabLaunchResult,
};
use serde::{Deserialize, Serialize};

const EXIT_COMMAND: &str = "/exit";
const POLL_INTERVAL: Duration = Duration::from_millis(150);
const STOP_TIMEOUT_MS: u64 = 15_000;
const STOP_TIMEOUT: Duration = Duration::from_millis(STOP_TIMEOUT_MS);

#[derive(Debug, PartialEq, Eq)]
enum ResumeVerification {
    Pending,
    ReportIdentity,
    Verified,
}

#[derive(Clone, Copy)]
enum CopyFocus {
    Foreground,
    Background,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct AgentControlView {
    pub terminal_id: String,
    pub kind: HerdrAgentKind,
    pub session_id: Option<String>,
    pub reverse_control: bool,
    pub connected: bool,
    pub reverse_control_state: crate::reverse_control::ReverseControlState,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentPreference {
    terminal_id: String,
    kind: HerdrAgentKind,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    reverse_control: bool,
    // Projection-inferred defaults must not shadow preferences restored later.
    #[serde(skip)]
    explicit: bool,
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct AgentPreferences {
    #[serde(default)]
    agents: Vec<AgentPreference>,
}

fn invalid(message: impl Into<String>) -> HerdrControlError {
    HerdrControlError::InvalidField(message.into())
}

fn kind_for(pane: &HerdrPaneInfo) -> Result<HerdrAgentKind, HerdrControlError> {
    match pane.agent.as_deref() {
        Some("codex") => Ok(HerdrAgentKind::Codex),
        Some("opencode") => Ok(HerdrAgentKind::OpenCode),
        Some("claude") => Ok(HerdrAgentKind::Claude),
        _ => Err(invalid("This pane has no supported agent")),
    }
}

impl AgentPreferences {
    fn for_pane(&mut self, pane: &HerdrPaneInfo) -> Result<AgentPreference, HerdrControlError> {
        let kind = kind_for(pane)?;
        let session_id =
            authoritative_agent_chat_identity(pane).map(|identity| identity.session_id);
        let index = self
            .agents
            .iter()
            .position(|agent| agent.terminal_id == pane.terminal_id);
        if let Some(index) = index {
            let agent = &mut self.agents[index];
            if agent.kind == kind
                && (agent.session_id.is_none()
                    || session_id.is_none()
                    || agent.session_id == session_id)
            {
                if session_id.is_some() {
                    agent.session_id = session_id;
                }
                return Ok(agent.clone());
            }
            self.agents.remove(index);
        }
        let agent = AgentPreference {
            terminal_id: pane.terminal_id.clone(),
            kind,
            session_id,
            args: Vec::new(),
            reverse_control: false,
            explicit: false,
        };
        self.agents.push(agent.clone());
        Ok(agent)
    }

    pub(super) fn remember(
        &mut self,
        terminal_id: &str,
        launch: &HerdrTabLaunch,
        reverse_control: bool,
    ) {
        let Ok(HerdrTabLaunch::Agent { kind, args }) = agents::normalize_tab_launch(launch.clone())
        else {
            return;
        };
        self.agents.retain(|agent| agent.terminal_id != terminal_id);
        self.agents.push(AgentPreference {
            terminal_id: terminal_id.to_owned(),
            kind,
            args: fresh_args(kind, &args),
            reverse_control,
            session_id: None,
            explicit: true,
        });
    }
}

/// Copy launch options without resuming, forking, or replaying a saved turn.
fn fresh_args(kind: HerdrAgentKind, args: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    let mut index = 0;
    if kind == HerdrAgentKind::Codex
        && args
            .first()
            .is_some_and(|arg| matches!(arg.as_str(), "resume" | "fork"))
    {
        index = 1;
        if args.get(index).is_some_and(|arg| !arg.starts_with('-')) {
            index += 1;
        }
    }
    while let Some(arg) = args.get(index) {
        let takes_id = match kind {
            HerdrAgentKind::Claude => matches!(arg.as_str(), "--resume" | "-r" | "--session-id"),
            HerdrAgentKind::OpenCode => matches!(arg.as_str(), "--session" | "-s"),
            HerdrAgentKind::Codex => false,
        };
        if takes_id {
            index += 1;
            if args.get(index).is_some_and(|value| !value.starts_with('-')) {
                index += 1;
            }
            continue;
        }
        if matches!(
            arg.as_str(),
            "--continue" | "--fork" | "--fork-session" | "--last" | "--all"
        ) || (kind != HerdrAgentKind::Codex && arg == "-c")
            || arg.starts_with("--session=")
            || arg.starts_with("--resume=")
            || arg.starts_with("--session-id=")
        {
            index += 1;
            continue;
        }
        result.push(arg.clone());
        index += 1;
    }
    result
}

fn resume_launch(preference: &AgentPreference) -> Result<HerdrTabLaunch, HerdrControlError> {
    let id = preference
        .session_id
        .as_ref()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            invalid("The agent's conversation ID is unavailable. Open Chat View before restarting.")
        })?;
    let mut args = preference.args.clone();
    match preference.kind {
        HerdrAgentKind::Codex => args.extend(["resume".to_owned(), id.clone()]),
        HerdrAgentKind::Claude => args.extend(["--resume".to_owned(), id.clone()]),
        HerdrAgentKind::OpenCode => args.extend(["--session".to_owned(), id.clone()]),
    }
    Ok(HerdrTabLaunch::Agent {
        kind: preference.kind,
        args,
    })
}

fn check_generation(inner: &RuntimeInner, generation: u64) -> Result<(), HerdrControlError> {
    if inner.state.lock().generation != generation {
        return Err(invalid("SSH changed during the agent operation"));
    }
    Ok(())
}

async fn request_in_generation(
    inner: &Arc<RuntimeInner>,
    generation: u64,
    request: HerdrControlRequest,
) -> Result<HerdrControlResult, HerdrControlError> {
    check_generation(inner, generation)?;
    let result = control_request_inner(inner.clone(), request).await?;
    check_generation(inner, generation)?;
    // Agent session metadata can be supplied by Herdr's agent rows rather
    // than its pane rows. Always validate against the normalized projection.
    match result {
        HerdrControlResult::SessionSnapshot { mut snapshot } => {
            crate::host_state::normalize_snapshot(&mut snapshot);
            inner.reverse_control.reconcile(&snapshot.panes);
            Ok(HerdrControlResult::SessionSnapshot { snapshot })
        }
        result => Ok(result),
    }
}

async fn snapshot(
    inner: &Arc<RuntimeInner>,
    generation: u64,
) -> Result<HerdrSessionSnapshot, HerdrControlError> {
    match request_in_generation(inner, generation, HerdrControlRequest::SessionSnapshot).await? {
        HerdrControlResult::SessionSnapshot { snapshot } => Ok(snapshot),
        _ => Err(invalid("Could not refresh the agent pane")),
    }
}

fn selected_pane(
    snapshot: &HerdrSessionSnapshot,
    terminal_id: &str,
) -> Result<HerdrPaneInfo, HerdrControlError> {
    snapshot
        .panes
        .iter()
        .find(|pane| pane.terminal_id == terminal_id)
        .cloned()
        .ok_or_else(|| invalid("The agent pane no longer exists"))
}

async fn prepare_launch(
    inner: &Arc<RuntimeInner>,
    generation: u64,
    pane: &HerdrPaneInfo,
    launch: HerdrTabLaunch,
    enabled: bool,
    conversation: Option<&str>,
) -> Result<HerdrTabLaunch, HerdrControlError> {
    check_generation(inner, generation)?;
    if !enabled {
        return Ok(launch);
    }
    let ssh = current_ssh(inner)
        .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?;
    let launch = crate::reverse_control::agent_launch(launch)
        .map_err(invalid)?
        .for_host(&ssh)
        .await
        .map_err(invalid)?;
    check_generation(inner, generation)?;
    let info = crate::reverse_control::new_session(&inner.id, pane).map_err(invalid)?;
    let result = match conversation {
        Some(conversation) => {
            inner
                .reverse_control
                .prepare_resume(ssh, info, launch, conversation.to_owned())
                .await
        }
        None => inner.reverse_control.prepare(ssh, info, launch).await,
    }
    .map_err(HerdrControlError::TransportDisconnected)?;
    check_generation(inner, generation)?;
    Ok(result)
}

async fn start_in_pane(
    inner: &Arc<RuntimeInner>,
    generation: u64,
    pane: &HerdrPaneInfo,
    tab: &crate::herdr_api::HerdrTabInfo,
    launch: HerdrTabLaunch,
    agent_name: Option<&str>,
) -> Result<(), HerdrControlError> {
    start_in_pane_using(&inner.id, pane, tab, launch, agent_name, |request| {
        request_in_generation(inner, generation, request)
    })
    .await
}

async fn start_in_pane_using<F, Fut>(
    host_id: &str,
    pane: &HerdrPaneInfo,
    tab: &crate::herdr_api::HerdrTabInfo,
    launch: HerdrTabLaunch,
    agent_name: Option<&str>,
    send: F,
) -> Result<(), HerdrControlError>
where
    F: Fn(HerdrControlRequest) -> Fut,
    Fut: std::future::Future<Output = Result<HerdrControlResult, HerdrControlError>>,
{
    let (_, mut request) = agents::launch_request(tab, pane, launch)
        .ok_or_else(|| invalid("Agent launch is missing"))?;
    if let HerdrControlRequest::AgentStart { name, kind, .. } = &mut request {
        // Preserve the original agent's handle on restart. New agents receive
        // a distinct name that remains stable across shell-readiness retries.
        *name = match agent_name {
            Some(name) => name.to_owned(),
            None => {
                let nonce = crate::reverse_control::new_session(host_id, pane).map_err(invalid)?;
                format!("{}-{}", kind.as_str(), &nonce.session_id[..12])
            }
        };
    }
    let send = &send;
    agents::launch_when_shell_ready(request, STOP_TIMEOUT, &mut |request| async move {
        let HerdrControlResult::SessionSnapshot { snapshot } =
            send(HerdrControlRequest::SessionSnapshot).await?
        else {
            return Err(invalid("Could not refresh the agent pane"));
        };
        let current = selected_pane(&snapshot, &pane.terminal_id)?;
        check_launch_pane(&current, pane)?;
        send(request).await
    })
    .await?;
    Ok(())
}

fn check_launch_pane(
    current: &HerdrPaneInfo,
    original: &HerdrPaneInfo,
) -> Result<(), HerdrControlError> {
    if current.agent.is_some()
        || current.pane_id != original.pane_id
        || current.terminal_id != original.terminal_id
        || current.workspace_id != original.workspace_id
        || current.tab_id != original.tab_id
    {
        return Err(invalid("The pane changed before the agent could launch"));
    }
    Ok(())
}

async fn change_directory(
    inner: &Arc<RuntimeInner>,
    generation: u64,
    pane: &HerdrPaneInfo,
    cwd: &str,
) -> Result<(), HerdrControlError> {
    let current = selected_pane(&snapshot(inner, generation).await?, &pane.terminal_id)?;
    if current.agent.is_some() {
        return Err(invalid("The pane is no longer a shell"));
    }
    if current.cwd.as_deref() == Some(cwd) || current.foreground_cwd.as_deref() == Some(cwd) {
        return Ok(());
    }
    request_in_generation(
        inner,
        generation,
        HerdrControlRequest::PaneSendInput {
            pane_id: pane.pane_id.clone(),
            text: format!(
                "cd -- {}",
                shlex::try_quote(cwd).map_err(|error| invalid(error.to_string()))?
            ),
            keys: vec!["enter".to_owned()],
        },
    )
    .await?;
    let deadline = tokio::time::Instant::now() + STOP_TIMEOUT;
    loop {
        let current = selected_pane(&snapshot(inner, generation).await?, &pane.terminal_id)?;
        if current.agent.is_some() {
            return Err(invalid(
                "The pane changed while entering the working directory",
            ));
        }
        if current.cwd.as_deref() == Some(cwd) || current.foreground_cwd.as_deref() == Some(cwd) {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(invalid("Could not enter the agent's working directory"));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn stop_agent_using<F, Fut>(
    pane: &HerdrPaneInfo,
    preference: &AgentPreference,
    mut send: F,
) -> Result<(), HerdrControlError>
where
    F: FnMut(HerdrControlRequest) -> Fut,
    Fut: std::future::Future<Output = Result<HerdrControlResult, HerdrControlError>>,
{
    let mut interrupted = false;
    let deadline = tokio::time::Instant::now() + STOP_TIMEOUT;
    loop {
        let HerdrControlResult::SessionSnapshot { snapshot } =
            send(HerdrControlRequest::SessionSnapshot).await?
        else {
            return Err(invalid("Could not refresh the agent pane"));
        };
        let current = selected_pane(&snapshot, &pane.terminal_id)?;
        if current.pane_id != pane.pane_id {
            return Err(invalid("The agent pane changed during restart"));
        }
        if current.agent.is_none() {
            return Ok(());
        }
        if current.agent != pane.agent
            || authoritative_agent_chat_identity(&current).map(|identity| identity.session_id)
                != preference.session_id
        {
            return Err(invalid("The agent conversation changed during restart"));
        }
        if !matches!(
            current.agent_status,
            HerdrAgentStatus::Working | HerdrAgentStatus::Blocked
        ) {
            break;
        }
        if !interrupted {
            send(HerdrControlRequest::PaneSendKeys {
                pane_id: pane.pane_id.clone(),
                keys: vec!["escape".to_owned()],
            })
            .await?;
            interrupted = true;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(invalid(
                "The agent is still busy. Stop its current task in Terminal, then retry.",
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    send(HerdrControlRequest::PaneSendKeys {
        pane_id: pane.pane_id.clone(),
        keys: vec!["ctrl+u".to_owned()],
    })
    .await?;
    send(HerdrControlRequest::AgentPrompt {
        target: pane.pane_id.clone(),
        text: EXIT_COMMAND.to_owned(),
    })
    .await?;
    let deadline = tokio::time::Instant::now() + STOP_TIMEOUT;
    loop {
        let HerdrControlResult::SessionSnapshot { snapshot } =
            send(HerdrControlRequest::SessionSnapshot).await?
        else {
            return Err(invalid("Could not refresh the agent pane"));
        };
        let current = selected_pane(&snapshot, &pane.terminal_id)?;
        if current.pane_id != pane.pane_id {
            return Err(invalid("The agent pane changed during restart"));
        }
        if current.agent.is_none() {
            return Ok(());
        }
        if current.agent != pane.agent
            || authoritative_agent_chat_identity(&current).map(|identity| identity.session_id)
                != preference.session_id
        {
            return Err(invalid("The agent conversation changed during restart"));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(invalid(
                "The agent did not exit. Finish exiting in Terminal, then resume the conversation.",
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn verify_resume(
    inner: &Arc<RuntimeInner>,
    generation: u64,
    pane: &HerdrPaneInfo,
    preference: &AgentPreference,
    report_missing_identity: bool,
) -> Result<(), HerdrControlError> {
    let deadline = tokio::time::Instant::now() + crate::reverse_control::STARTUP_TIMEOUT;
    loop {
        let current = selected_pane(&snapshot(inner, generation).await?, &pane.terminal_id)?;
        let connected = inner.reverse_control.connected_terminal(&pane.terminal_id);
        let verification =
            resume_verification(&current, preference, connected, report_missing_identity);
        if verification.is_err() {
            inner.reverse_control.close_terminal(&pane.terminal_id);
        }
        match verification? {
            ResumeVerification::Pending => {}
            ResumeVerification::ReportIdentity => {
                // OpenCode's MCP configuration needs an environment wrapper,
                // which agent.start cannot accept. Publish its captured ID
                // after observing the CLI and its bound MCP handshake.
                report_resume_identity(inner, generation, pane, preference).await?;
            }
            ResumeVerification::Verified => return Ok(()),
        }
        if tokio::time::Instant::now() >= deadline {
            let message = if preference.reverse_control && !connected {
                "The agent restarted, but Whip MCP has not connected yet. Check the agent's startup messages in Terminal."
            } else {
                "The agent restarted, but Herdr has not reported its conversation yet. Check it in Terminal."
            };
            return Err(invalid(message));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn report_resume_identity(
    inner: &Arc<RuntimeInner>,
    generation: u64,
    pane: &HerdrPaneInfo,
    preference: &AgentPreference,
) -> Result<(), HerdrControlError> {
    let session = preference
        .session_id
        .as_deref()
        .ok_or_else(|| invalid("The resumed conversation ID is unavailable"))?;
    let sequence = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| invalid(error.to_string()))?
        .as_nanos();
    let sequence = u64::try_from(sequence).map_err(|error| invalid(error.to_string()))?;
    check_generation(inner, generation)?;
    let result = crate::herdr_api::request_json_on_runtime(
        inner.herdr.clone(),
        "pane.report_agent_session",
        serde_json::json!({
            "pane_id": pane.pane_id,
            "source": format!("herdr:{}", preference.kind.as_str()),
            "agent": preference.kind.as_str(),
            "agent_session_id": session,
            "session_start_source": "resume",
            "seq": sequence,
        }),
        STOP_TIMEOUT_MS,
    )
    .await?;
    check_generation(inner, generation)?;
    if result["type"] != "ok" {
        return Err(invalid(
            "Could not report the resumed conversation identity",
        ));
    }
    Ok(())
}

fn resume_verification(
    pane: &HerdrPaneInfo,
    preference: &AgentPreference,
    connected: bool,
    report_missing_identity: bool,
) -> Result<ResumeVerification, HerdrControlError> {
    let identity = authoritative_agent_chat_identity(pane);
    if identity
        .as_ref()
        .is_some_and(|identity| Some(&identity.session_id) != preference.session_id.as_ref())
    {
        return Err(invalid(
            "The agent resumed a different conversation. Check it in Terminal.",
        ));
    }
    if pane.agent.as_deref() != Some(preference.kind.as_str())
        || preference.reverse_control && !connected
    {
        return Ok(ResumeVerification::Pending);
    }
    Ok(if identity.is_some() {
        ResumeVerification::Verified
    } else if report_missing_identity {
        ResumeVerification::ReportIdentity
    } else {
        ResumeVerification::Pending
    })
}

#[uniffi::export]
impl HostRuntime {
    pub fn agent_control_views(&self) -> Vec<AgentControlView> {
        let preferences = self.reconciled_agent_preferences();
        preferences
            .agents
            .iter()
            .map(|agent| {
                let reverse_control_state = self
                    .inner
                    .reverse_control
                    .terminal_state(&agent.terminal_id, agent.reverse_control);
                AgentControlView {
                    terminal_id: agent.terminal_id.clone(),
                    kind: agent.kind,
                    session_id: agent.session_id.clone(),
                    reverse_control: agent.reverse_control,
                    connected: reverse_control_state
                        == crate::reverse_control::ReverseControlState::Connected,
                    reverse_control_state,
                }
            })
            .collect()
    }

    pub fn agent_preferences_json(&self) -> String {
        let preferences = self.reconciled_agent_preferences();
        serde_json::to_string(&*preferences).unwrap_or_else(|_| "{\"agents\":[]}".to_owned())
    }

    pub fn restore_agent_preferences(&self, value: String) -> Result<(), HerdrControlError> {
        let restored: AgentPreferences = serde_json::from_str(&value)
            .map_err(|_| invalid("Saved agent preferences are invalid"))?;
        if restored.agents.len() > 4096
            || restored
                .agents
                .iter()
                .any(|agent| agent.terminal_id.is_empty())
        {
            return Err(invalid("Saved agent preferences are invalid"));
        }
        self.inner.agent_preferences.lock().restore(restored);
        Ok(())
    }

    pub async fn set_agent_reverse_control(
        &self,
        terminal_id: String,
        enabled: bool,
    ) -> Result<(), HerdrControlError> {
        let runtime = Self {
            inner: self.inner.clone(),
        };
        run_control_task(async move {
            runtime
                .set_agent_reverse_control_inner(terminal_id, enabled)
                .await
        })
        .await
    }

    pub async fn restart_agent(&self, terminal_id: String) -> Result<(), HerdrControlError> {
        let runtime = Self {
            inner: self.inner.clone(),
        };
        run_control_task(async move { runtime.restart_agent_inner(terminal_id).await }).await
    }

    pub async fn copy_agent(
        &self,
        terminal_id: String,
        label: Option<String>,
    ) -> Result<HerdrTabLaunchResult, HerdrControlError> {
        let runtime = Self {
            inner: self.inner.clone(),
        };
        run_control_task(async move {
            runtime
                .copy_agent_inner(terminal_id, label, CopyFocus::Foreground)
                .await
        })
        .await
    }
}

impl AgentPreferences {
    fn restore(&mut self, restored: Self) {
        for mut agent in restored.agents {
            if self
                .agents
                .iter()
                .any(|current| current.terminal_id == agent.terminal_id && current.explicit)
            {
                continue;
            }
            self.agents
                .retain(|current| current.terminal_id != agent.terminal_id);
            agent.explicit = true;
            self.agents.push(agent);
        }
    }
}

impl HostRuntime {
    fn reconciled_agent_preferences(&self) -> parking_lot::MutexGuard<'_, AgentPreferences> {
        let host = self.inner.state.lock().host_state.projection();
        let synchronized =
            host.freshness == HostFreshness::Fresh && host.sync_status == HostSyncStatus::Synced;
        let panes = host
            .snapshot
            .map(|snapshot| snapshot.panes)
            .unwrap_or_default();
        let mut preferences = self.inner.agent_preferences.lock();
        if synchronized {
            preferences.agents.retain(|agent| {
                panes
                    .iter()
                    .any(|pane| pane.terminal_id == agent.terminal_id)
            });
        }
        for pane in &panes {
            let _ = preferences.for_pane(pane);
            if self
                .inner
                .reverse_control
                .recovering_terminal(&pane.terminal_id)
                && let Some(agent) = preferences
                    .agents
                    .iter_mut()
                    .find(|agent| agent.terminal_id == pane.terminal_id)
            {
                agent.reverse_control = true;
            }
        }
        preferences
    }
}

async fn run_control_task<T: Send + 'static>(
    future: impl std::future::Future<Output = Result<T, HerdrControlError>> + Send + 'static,
) -> Result<T, HerdrControlError> {
    crate::runtime()
        .map_err(HerdrControlError::TransportDisconnected)?
        .spawn(future)
        .await
        .map_err(|error| HerdrControlError::RequestCancelled(error.to_string()))?
}

impl HostRuntime {
    async fn set_agent_reverse_control_inner(
        &self,
        terminal_id: String,
        enabled: bool,
    ) -> Result<(), HerdrControlError> {
        let _operation = self.inner.agent_control_operation.lock().await;
        let generation = self.inner.state.lock().generation;
        let pane = selected_pane(&snapshot(&self.inner, generation).await?, &terminal_id)?;
        let mut preferences = self.inner.agent_preferences.lock();
        preferences.for_pane(&pane)?;
        if let Some(agent) = preferences
            .agents
            .iter_mut()
            .find(|agent| agent.terminal_id == terminal_id)
        {
            agent.reverse_control = enabled;
            agent.explicit = true;
        }
        drop(preferences);
        if !enabled {
            self.inner.reverse_control.close_terminal(&terminal_id);
        }
        Ok(())
    }

    pub(crate) async fn restart_from_reverse_agent(
        &self,
        terminal_id: String,
    ) -> Result<(), HerdrControlError> {
        self.restart_agent_inner(terminal_id).await
    }

    pub(crate) async fn copy_from_reverse_agent(
        &self,
        terminal_id: String,
        label: Option<String>,
    ) -> Result<HerdrTabLaunchResult, HerdrControlError> {
        self.copy_agent_inner(terminal_id, label, CopyFocus::Background)
            .await
    }

    async fn restart_agent_inner(&self, terminal_id: String) -> Result<(), HerdrControlError> {
        let _operation = self.inner.agent_control_operation.lock().await;
        let generation = self.inner.state.lock().generation;
        let initial = snapshot(&self.inner, generation).await?;
        let pane = selected_pane(&initial, &terminal_id)?;
        let preference = self.inner.agent_preferences.lock().for_pane(&pane)?;
        let launch = resume_launch(&preference)?;
        let tab = initial
            .tabs
            .iter()
            .find(|tab| tab.tab_id == pane.tab_id)
            .ok_or_else(|| invalid("The agent tab no longer exists"))?;
        let agent_name = initial
            .agents
            .iter()
            .find(|agent| agent.terminal_id == pane.terminal_id)
            .and_then(|agent| agent.name.as_deref());
        // Validate the host's agent version before interrupting any work.
        if preference.reverse_control {
            let ssh = current_ssh(&self.inner)
                .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?;
            crate::reverse_control::agent_launch(launch.clone())
                .map_err(invalid)?
                .for_host(&ssh)
                .await
                .map_err(invalid)?;
        }
        let mut started = false;
        let result: Result<(), HerdrControlError> = async {
            stop_agent_using(&pane, &preference, |request| {
                request_in_generation(&self.inner, generation, request)
            })
            .await?;
            // Retire the old launch explicitly: event projections may still
            // show it even though the lifecycle snapshot confirmed its exit.
            self.inner.reverse_control.close_terminal(&terminal_id);
            if let Some(cwd) = pane.foreground_cwd.as_deref().or(pane.cwd.as_deref()) {
                change_directory(&self.inner, generation, &pane, cwd).await?;
            }
            // Hold the new authorization through transient shell observations
            // until the resumed CLI and its MCP connection verify.
            let _restart = preference
                .reverse_control
                .then(|| self.inner.reverse_control.begin_restart(&terminal_id));
            let launch = if preference.reverse_control {
                prepare_launch(
                    &self.inner,
                    generation,
                    &pane,
                    resume_launch(&preference)?,
                    true,
                    preference.session_id.as_deref(),
                )
                .await?
            } else {
                launch
            };
            let report_missing_identity = matches!(launch, HerdrTabLaunch::Command { .. });
            start_in_pane(&self.inner, generation, &pane, tab, launch, agent_name).await?;
            started = true;
            verify_resume(
                &self.inner,
                generation,
                &pane,
                &preference,
                report_missing_identity,
            )
            .await
        }
        .await;
        // A verification timeout must not disconnect an already running CLI.
        // Failed launches are revoked here; exits, replacements and missing
        // MCP initialization are revoked by Reverse Control reconciliation.
        if result.is_err() && !started {
            self.inner.reverse_control.close_terminal(&terminal_id);
        }
        result
    }

    async fn copy_agent_inner(
        &self,
        terminal_id: String,
        label: Option<String>,
        focus: CopyFocus,
    ) -> Result<HerdrTabLaunchResult, HerdrControlError> {
        let _operation = self.inner.agent_control_operation.lock().await;
        let generation = self.inner.state.lock().generation;
        let initial = snapshot(&self.inner, generation).await?;
        let pane = selected_pane(&initial, &terminal_id)?;
        let preference = self.inner.agent_preferences.lock().for_pane(&pane)?;
        let cwd = pane
            .foreground_cwd
            .as_ref()
            .or(pane.cwd.as_ref())
            .filter(|cwd| !cwd.is_empty())
            .ok_or_else(|| invalid("The agent's working directory is unavailable"))?;
        let request = HerdrControlRequest::TabCreate {
            workspace_id: pane.workspace_id.clone(),
            label: label.and_then(|label| {
                let label = label.trim();
                (!label.is_empty()).then(|| label.to_owned())
            }),
        };
        let created = match focus {
            CopyFocus::Foreground => {
                request_in_generation(&self.inner, generation, request).await?
            }
            CopyFocus::Background => {
                check_generation(&self.inner, generation)?;
                let mut value =
                    serde_json::to_value(&request).map_err(|error| invalid(error.to_string()))?;
                value["cwd"] = serde_json::json!(cwd);
                let background = crate::reverse_control::herdr::Request::parse(value)?;
                let result = self.request_from_reverse_agent(background).await?;
                check_generation(&self.inner, generation)?;
                let bytes = serde_json::to_vec(&serde_json::json!({"result":result}))
                    .map_err(|error| invalid(error.to_string()))?;
                crate::herdr_api::parse_response(&request, &bytes)?
            }
        };
        let HerdrControlResult::TabCreated { tab, root_pane } = created else {
            return Err(invalid("Could not create the copied agent tab"));
        };
        let launch = HerdrTabLaunch::Agent {
            kind: preference.kind,
            args: fresh_args(preference.kind, &preference.args),
        };
        let result: Result<(), HerdrControlError> = async {
            change_directory(&self.inner, generation, &root_pane, cwd).await?;
            let configured = prepare_launch(
                &self.inner,
                generation,
                &root_pane,
                launch.clone(),
                preference.reverse_control,
                None,
            )
            .await?;
            start_in_pane(&self.inner, generation, &root_pane, &tab, configured, None).await?;
            self.inner.agent_preferences.lock().remember(
                &root_pane.terminal_id,
                &launch,
                preference.reverse_control,
            );
            Ok(())
        }
        .await;
        match result {
            Ok(()) => Ok(HerdrTabLaunchResult::Created { tab, root_pane }),
            Err(error) => {
                self.inner
                    .reverse_control
                    .close_terminal(&root_pane.terminal_id);
                Ok(HerdrTabLaunchResult::LaunchFailed {
                    tab,
                    root_pane,
                    stage: crate::herdr_api::HerdrTabLaunchStage::AgentStart,
                    failure: error.into(),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::agent_chat_snapshot;
    use super::*;
    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn managed_restart_waits_for_herdr_identity_and_the_bound_handshake()
    -> Result<(), Box<dyn std::error::Error>> {
        let initial = agent_chat_snapshot(Some(("codex", "original")), Some("codex"));
        let mut preference = AgentPreferences::default().for_pane(&initial.panes[0])?;
        preference.reverse_control = true;
        let booting = agent_chat_snapshot(None, Some("codex"));
        assert_eq!(
            resume_verification(&booting.panes[0], &preference, false, false)?,
            ResumeVerification::Pending
        );
        assert_eq!(
            resume_verification(&booting.panes[0], &preference, true, false)?,
            ResumeVerification::Pending
        );
        assert_eq!(
            resume_verification(&initial.panes[0], &preference, true, false)?,
            ResumeVerification::Verified
        );

        let shell = agent_chat_snapshot(None, None);
        assert_eq!(
            resume_verification(&shell.panes[0], &preference, true, false)?,
            ResumeVerification::Pending
        );
        let replacement = agent_chat_snapshot(Some(("codex", "replacement")), Some("codex"));
        assert!(resume_verification(&replacement.panes[0], &preference, true, false).is_err());

        assert_eq!(
            resume_verification(&initial.panes[0], &preference, false, false)?,
            ResumeVerification::Pending
        );

        preference.reverse_control = false;
        assert_eq!(
            resume_verification(&booting.panes[0], &preference, false, false)?,
            ResumeVerification::Pending
        );
        assert_eq!(
            resume_verification(&initial.panes[0], &preference, false, false)?,
            ResumeVerification::Verified
        );
        Ok(())
    }

    #[test]
    fn environment_resume_reports_missing_identity_only_after_the_bound_handshake()
    -> Result<(), Box<dyn std::error::Error>> {
        let initial = agent_chat_snapshot(Some(("opencode", "original")), Some("opencode"));
        let mut preference = AgentPreferences::default().for_pane(&initial.panes[0])?;
        preference.reverse_control = true;
        let booting = agent_chat_snapshot(None, Some("opencode"));
        assert_eq!(
            resume_verification(&booting.panes[0], &preference, false, true)?,
            ResumeVerification::Pending
        );
        assert_eq!(
            resume_verification(&booting.panes[0], &preference, true, true)?,
            ResumeVerification::ReportIdentity
        );
        assert_eq!(
            resume_verification(&initial.panes[0], &preference, true, true)?,
            ResumeVerification::Verified
        );
        let replacement = agent_chat_snapshot(Some(("opencode", "replacement")), Some("opencode"));
        assert!(resume_verification(&replacement.panes[0], &preference, true, true).is_err());
        Ok(())
    }

    #[test]
    fn restart_uses_agent_start_with_the_saved_conversation_and_retries_busy_rejections()
    -> Result<(), Box<dyn std::error::Error>> {
        for kind in [
            HerdrAgentKind::Codex,
            HerdrAgentKind::Claude,
            HerdrAgentKind::OpenCode,
        ] {
            let session = "original";
            let model = "model with 'quotes'; $(command)";
            let snapshot = agent_chat_snapshot(Some((kind.as_str(), session)), Some(kind.as_str()));
            let pane = &snapshot.panes[0];
            let mut preference = AgentPreferences::default().for_pane(pane)?;
            preference.args = strings(&["--model", model]);
            let launch = resume_launch(&preference)?;
            let selector = match kind {
                HerdrAgentKind::Codex => "resume",
                HerdrAgentKind::Claude => "--resume",
                HerdrAgentKind::OpenCode => "--session",
            };
            let expected = strings(&["--model", model, selector, session]);
            let mut shell = agent_chat_snapshot(None, None);
            shell.agents.clear();
            let requests = std::cell::RefCell::new(Vec::new());
            let attempts = std::cell::Cell::new(0);
            crate::runtime()?.block_on(start_in_pane_using(
                "restart-test",
                pane,
                &snapshot.tabs[0],
                launch,
                Some("original-agent"),
                |request| {
                    let response = match &request {
                        HerdrControlRequest::SessionSnapshot => {
                            Ok(HerdrControlResult::SessionSnapshot {
                                snapshot: shell.clone(),
                            })
                        }
                        HerdrControlRequest::AgentStart { .. } => {
                            attempts.set(attempts.get() + 1);
                            if attempts.get() < 3 {
                                Err(HerdrControlError::ProtocolError(
                                    "agent_pane_busy".to_owned(),
                                    "the old agent is being released".to_owned(),
                                ))
                            } else {
                                Ok(HerdrControlResult::Ok)
                            }
                        }
                        _ => Err(invalid("Unexpected request during managed restart")),
                    };
                    requests.borrow_mut().push(request);
                    std::future::ready(response)
                },
            ))?;
            let requests = requests.into_inner();
            assert_eq!(requests.len(), 6);
            assert!(
                requests
                    .iter()
                    .step_by(2)
                    .all(|request| matches!(request, HerdrControlRequest::SessionSnapshot))
            );
            let HerdrControlRequest::AgentStart {
                name,
                pane_id,
                kind: started_kind,
                args,
                ..
            } = &requests[1]
            else {
                return Err("Restart must use agent.start".into());
            };
            assert_eq!(pane_id, &pane.pane_id);
            assert_eq!(name, "original-agent");
            assert_eq!(*started_kind, kind);
            assert_eq!(args, &expected);
            assert_eq!(requests[1], requests[3]);
            assert_eq!(requests[3], requests[5]);
        }
        Ok(())
    }

    #[test]
    fn restart_rechecks_shell_and_pane_identity_before_each_launch_attempt()
    -> Result<(), Box<dyn std::error::Error>> {
        let initial = agent_chat_snapshot(Some(("codex", "original")), Some("codex"));
        let original = &initial.panes[0];
        let mut shell = original.clone();
        shell.agent = None;
        check_launch_pane(&shell, original)?;
        assert!(check_launch_pane(original, original).is_err());
        for field in ["pane", "terminal", "workspace", "tab", "agent"] {
            let mut replacement = shell.clone();
            match field {
                "pane" => replacement.pane_id.push_str("-replacement"),
                "terminal" => replacement.terminal_id.push_str("-replacement"),
                "workspace" => replacement.workspace_id.push_str("-replacement"),
                "tab" => replacement.tab_id.push_str("-replacement"),
                _ => replacement.agent = Some("codex".to_owned()),
            }
            let snapshots = std::cell::RefCell::new(std::collections::VecDeque::from([
                shell.clone(),
                replacement,
            ]));
            let attempts = std::cell::Cell::new(0);
            let preference = AgentPreferences::default().for_pane(original)?;
            let result = crate::runtime()?.block_on(start_in_pane_using(
                "restart-replacement-test",
                original,
                &initial.tabs[0],
                resume_launch(&preference)?,
                Some("original-agent"),
                |request| {
                    std::future::ready(match request {
                        HerdrControlRequest::SessionSnapshot => snapshots
                            .borrow_mut()
                            .pop_front()
                            .map(|pane| {
                                let mut snapshot = initial.clone();
                                snapshot.panes = vec![pane];
                                HerdrControlResult::SessionSnapshot { snapshot }
                            })
                            .ok_or_else(|| invalid("Unexpected snapshot request")),
                        HerdrControlRequest::AgentStart { .. } => {
                            attempts.set(attempts.get() + 1);
                            Err(HerdrControlError::ProtocolError(
                                "agent_pane_busy".to_owned(),
                                "busy".to_owned(),
                            ))
                        }
                        _ => Err(invalid("Unexpected request during restart")),
                    })
                },
            ));
            assert!(result.is_err());
            assert_eq!(attempts.get(), 1);
            assert!(snapshots.borrow().is_empty());
        }
        Ok(())
    }

    #[test]
    fn copies_remove_conversation_selectors_and_preserve_configuration() {
        assert_eq!(
            fresh_args(
                HerdrAgentKind::Codex,
                &strings(&["resume", "old", "-c", "model=\"test\""])
            ),
            strings(&["-c", "model=\"test\""])
        );
        assert_eq!(
            fresh_args(
                HerdrAgentKind::OpenCode,
                &strings(&[
                    "--session",
                    "ses_old",
                    "--fork",
                    "--model",
                    "provider/model"
                ])
            ),
            strings(&["--model", "provider/model"])
        );
        assert_eq!(
            fresh_args(
                HerdrAgentKind::Claude,
                &strings(&["--resume=old", "--fork-session", "--model", "sonnet"])
            ),
            strings(&["--model", "sonnet"])
        );
    }

    #[test]
    fn preferences_round_trip_without_transport_credentials() -> Result<(), serde_json::Error> {
        let mut preferences = AgentPreferences::default();
        preferences.remember(
            "terminal",
            &HerdrTabLaunch::Agent {
                kind: HerdrAgentKind::Codex,
                args: strings(&["--model", "test"]),
            },
            true,
        );
        let serialized = serde_json::to_string(&preferences)?;
        let restored: AgentPreferences = serde_json::from_str(&serialized)?;
        assert!(restored.agents[0].reverse_control);
        assert_eq!(restored.agents[0].args, strings(&["--model", "test"]));
        assert!(resume_launch(&restored.agents[0]).is_err());
        Ok(())
    }

    #[test]
    fn restoring_preferences_preserves_a_launch_or_explicitly_disabled_control()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut preferences = AgentPreferences::default();
        let snapshot = agent_chat_snapshot(Some(("codex", "original")), Some("codex"));
        let pane = &snapshot.panes[0];
        preferences.remember(
            &pane.terminal_id,
            &HerdrTabLaunch::Agent {
                kind: HerdrAgentKind::Codex,
                args: strings(&["--model", "current"]),
            },
            false,
        );
        preferences.restore(serde_json::from_value(serde_json::json!({"agents": [{
            "terminalId": pane.terminal_id, "kind": "codex", "reverseControl": true,
            "args": ["--model", "old"]
        }]}))?);
        let current = preferences.for_pane(pane)?;
        assert!(!current.reverse_control);
        assert_eq!(current.args, strings(&["--model", "current"]));
        Ok(())
    }

    #[test]
    fn persisted_preference_follows_the_conversation_and_copy_is_independent()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut preferences = AgentPreferences::default();
        let mut snapshot = agent_chat_snapshot(Some(("codex", "original")), Some("codex"));
        let original = snapshot.panes[0].clone();
        preferences.remember(
            &original.terminal_id,
            &HerdrTabLaunch::Agent {
                kind: HerdrAgentKind::Codex,
                args: Vec::new(),
            },
            true,
        );
        let preference = preferences.for_pane(&original)?;
        let launch = resume_launch(&preference)?;
        assert!(
            matches!(launch, HerdrTabLaunch::Agent {args, ..} if args == strings(&["resume", "original"]))
        );
        let mut restored: AgentPreferences =
            serde_json::from_str(&serde_json::to_string(&preferences)?)?;
        assert!(restored.for_pane(&original)?.reverse_control);
        restored.remember(
            "copy-terminal",
            &HerdrTabLaunch::Agent {
                kind: HerdrAgentKind::Codex,
                args: preference.args,
            },
            preference.reverse_control,
        );
        restored.agents[0].reverse_control = false;
        assert!(restored.agents[1].reverse_control);
        snapshot.panes[0]
            .agent_session
            .as_mut()
            .ok_or("missing session")?
            .value = "replacement".to_owned();
        assert!(!preferences.for_pane(&snapshot.panes[0])?.reverse_control);
        Ok(())
    }

    #[test]
    fn restart_exits_only_the_expected_conversation_and_waits_for_shell()
    -> Result<(), Box<dyn std::error::Error>> {
        let initial = agent_chat_snapshot(Some(("codex", "original")), Some("codex"));
        let pane = initial.panes[0].clone();
        let preference = AgentPreferences::default().for_pane(&pane)?;
        let mut shell = initial.clone();
        shell.panes[0].agent = None;
        shell.panes[0].agent_session = None;
        let mut requests = Vec::new();
        let mut snapshots = std::collections::VecDeque::from([initial, shell]);
        crate::runtime()?.block_on(stop_agent_using(&pane, &preference, |request| {
            let result = if matches!(request, HerdrControlRequest::SessionSnapshot) {
                snapshots
                    .pop_front()
                    .ok_or_else(|| invalid("Unexpected snapshot request"))
            } else {
                Ok(agent_chat_snapshot(None, None))
            };
            requests.push(request);
            std::future::ready(
                result.map(|snapshot| HerdrControlResult::SessionSnapshot { snapshot }),
            )
        }))?;
        assert!(
            matches!(requests.as_slice(), [HerdrControlRequest::SessionSnapshot, HerdrControlRequest::PaneSendKeys {keys, ..}, HerdrControlRequest::AgentPrompt {target, text}, HerdrControlRequest::SessionSnapshot] if keys == &strings(&["ctrl+u"]) && target == &pane.pane_id && text == EXIT_COMMAND)
        );
        Ok(())
    }

    #[test]
    fn restart_refuses_to_exit_a_replacement_conversation() -> Result<(), Box<dyn std::error::Error>>
    {
        let mut initial = agent_chat_snapshot(Some(("codex", "original")), Some("codex"));
        initial.panes[0].agent_status = HerdrAgentStatus::Working;
        let pane = initial.panes[0].clone();
        let preference = AgentPreferences::default().for_pane(&pane)?;
        let changed = agent_chat_snapshot(Some(("codex", "replacement")), Some("codex"));
        let mut writes = 0;
        let result = crate::runtime()?.block_on(stop_agent_using(&pane, &preference, |request| {
            if !matches!(request, HerdrControlRequest::SessionSnapshot) {
                writes += 1;
            }
            std::future::ready(Ok(HerdrControlResult::SessionSnapshot {
                snapshot: changed.clone(),
            }))
        }));
        assert!(result.is_err());
        assert_eq!(writes, 0);
        Ok(())
    }
}
