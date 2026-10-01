//! Agent launch, paste submission, and integration behavior.

use std::future::Future;

use super::*;
use crate::agent_sessions::{
    AgentChatBinding, AgentChatOpenResult, AgentChatStartResult, AgentChatUnavailableReason,
    AgentSessionError, AgentTranscriptArchive,
};
use crate::agent_transcript::AgentTranscriptState;
use crate::herdr_api::{
    HerdrAgentKind, HerdrControlError, HerdrControlRequest, HerdrControlResult,
    HerdrIntegrationInstallResult, HerdrIntegrationState, HerdrTabLaunch, HerdrTabLaunchResult,
    HerdrTabLaunchStage,
};

const AGENT_SHELL_READINESS_TIMEOUT: Duration = Duration::from_secs(2);
const AGENT_SHELL_READINESS_INTERVAL: Duration = Duration::from_millis(100);

pub(super) fn managed_agent_name(label: &str, kind: HerdrAgentKind, tab_number: f64) -> String {
    let mut normalized = String::new();
    let mut previous_was_dash = false;
    for character in label.to_lowercase().chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_' {
            normalized.push(character);
            previous_was_dash = false;
        } else if character == '-' {
            normalized.push(character);
            previous_was_dash = true;
        } else if !previous_was_dash {
            normalized.push('-');
            previous_was_dash = true;
        }
    }
    let first_letter = normalized
        .char_indices()
        .find_map(|(index, character)| character.is_ascii_lowercase().then_some(index));
    normalized = first_letter.map_or_else(String::new, |index| normalized[index..].to_owned());
    while normalized.ends_with('-') {
        normalized.pop();
    }
    if normalized.is_empty() {
        normalized = format!("{}-{tab_number}", kind.as_str());
    }
    normalized.truncate(normalized.len().min(32));
    normalized
}

pub(super) async fn integration_status_with_request<F, Fut>(
    kind: HerdrAgentKind,
    request: F,
) -> Result<AgentIntegrationStatus, HerdrControlError>
where
    F: FnOnce(HerdrControlRequest) -> Fut,
    Fut: Future<Output = Result<HerdrControlResult, HerdrControlError>>,
{
    match request(HerdrControlRequest::IntegrationList).await? {
        HerdrControlResult::IntegrationList { integrations } => Ok(integrations
            .iter()
            .find(|integration| integration.target == kind.as_str())
            .map_or(
                AgentIntegrationStatus::Unknown,
                |integration| match integration.state {
                    HerdrIntegrationState::NotInstalled => AgentIntegrationStatus::NotInstalled,
                    HerdrIntegrationState::Current => AgentIntegrationStatus::Current,
                    HerdrIntegrationState::Outdated => AgentIntegrationStatus::Outdated,
                },
            )),
        _ => Err(HerdrControlError::UnsupportedResponse(
            "integration.list returned a non-integration result".to_owned(),
        )),
    }
}

pub(super) async fn install_integration_with_request<F, Fut>(
    kind: HerdrAgentKind,
    request: F,
) -> Result<HerdrIntegrationInstallResult, HerdrControlError>
where
    F: FnOnce(HerdrControlRequest) -> Fut,
    Fut: Future<Output = Result<HerdrControlResult, HerdrControlError>>,
{
    match request(HerdrControlRequest::IntegrationInstall { kind }).await? {
        HerdrControlResult::IntegrationInstalled { install } if install.kind == kind => Ok(install),
        HerdrControlResult::IntegrationInstalled { install } => {
            Err(HerdrControlError::UnsupportedResponse(format!(
                "integration.install returned {:?} for requested {:?}",
                install.kind, kind
            )))
        }
        _ => Err(HerdrControlError::UnsupportedResponse(
            "integration.install returned a non-integration result".to_owned(),
        )),
    }
}

pub(super) fn has_shell_command_semantics(command: &str) -> bool {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Quote {
        Single,
        Double,
    }

    let mut quote = None;
    for character in command.chars() {
        match quote {
            Some(Quote::Single) => {
                if character == '\'' {
                    quote = None;
                }
            }
            Some(Quote::Double) => match character {
                '"' => quote = None,
                '$' | '`' | '\n' | '\r' => return true,
                _ => {}
            },
            None => match character {
                '\'' => quote = Some(Quote::Single),
                '"' => quote = Some(Quote::Double),
                '\\' | '\n' | '\r' | '$' | '`' | '|' | '&' | ';' | '<' | '>' | '(' | ')' | '['
                | ']' | '{' | '}' | '*' | '?' | '!' | '#' | '~' => return true,
                _ => {}
            },
        }
    }
    false
}

pub(super) fn normalize_tab_launch(
    launch: HerdrTabLaunch,
) -> Result<HerdrTabLaunch, HerdrControlError> {
    let HerdrTabLaunch::Command { command } = launch else {
        return Ok(launch);
    };
    let command = command.trim().to_owned();
    if command.is_empty() {
        return Err(HerdrControlError::InvalidField(
            "command must not be empty".to_owned(),
        ));
    }
    if has_shell_command_semantics(&command) {
        return Ok(HerdrTabLaunch::Command { command });
    }
    let Some(mut args) = shlex::split(&command) else {
        return Ok(HerdrTabLaunch::Command { command });
    };
    let Some(executable) = args.first() else {
        return Ok(HerdrTabLaunch::Command { command });
    };
    let kind = match executable.as_str() {
        "claude" => HerdrAgentKind::Claude,
        "codex" => HerdrAgentKind::Codex,
        "opencode" => HerdrAgentKind::OpenCode,
        _ => return Ok(HerdrTabLaunch::Command { command }),
    };
    args.remove(0);
    Ok(HerdrTabLaunch::Agent { kind, args })
}

pub(super) fn launch_request(
    tab: &crate::herdr_api::HerdrTabInfo,
    root_pane: &crate::herdr_api::HerdrPaneInfo,
    launch: HerdrTabLaunch,
) -> Option<(HerdrTabLaunchStage, HerdrControlRequest)> {
    match launch {
        HerdrTabLaunch::Shell => None,
        HerdrTabLaunch::Agent { kind, args } => Some((
            HerdrTabLaunchStage::AgentStart,
            HerdrControlRequest::AgentStart {
                name: managed_agent_name(&tab.label, kind, tab.number),
                kind,
                pane_id: root_pane.pane_id.clone(),
                args,
            },
        )),
        HerdrTabLaunch::Command { command } => Some((
            HerdrTabLaunchStage::CommandInput,
            HerdrControlRequest::PaneSendInput {
                pane_id: root_pane.pane_id.clone(),
                text: command,
                keys: vec!["enter".to_owned()],
            },
        )),
    }
}

pub(super) async fn create_tab_with_launch_inner(
    inner: Arc<RuntimeInner>,
    workspace_id: String,
    label: String,
    launch: HerdrTabLaunch,
) -> Result<HerdrTabLaunchResult, HerdrControlError> {
    let connection_identity = {
        let state = inner.state.lock();
        (state.generation, state.herdr_recovery_revision)
    };
    create_tab_with_launch_using(workspace_id, label, launch, |request| {
        let inner = inner.clone();
        async move {
            {
                let state = inner.state.lock();
                if (state.generation, state.herdr_recovery_revision) != connection_identity {
                    return Err(HerdrControlError::RequestCancelled(
                        "Herdr connection changed during tab launch".to_owned(),
                    ));
                }
            }
            control_request_inner(inner, request).await
        }
    })
    .await
}

pub(super) async fn create_tab_with_launch_using<F, Fut>(
    workspace_id: String,
    label: String,
    launch: HerdrTabLaunch,
    mut send: F,
) -> Result<HerdrTabLaunchResult, HerdrControlError>
where
    F: FnMut(HerdrControlRequest) -> Fut,
    Fut: Future<Output = Result<HerdrControlResult, HerdrControlError>>,
{
    let launch = normalize_tab_launch(launch)?;
    let label = label.trim();
    let created = send(HerdrControlRequest::TabCreate {
        workspace_id,
        label: (!label.is_empty()).then(|| label.to_owned()),
    })
    .await?;
    let HerdrControlResult::TabCreated { tab, root_pane } = created else {
        return Err(HerdrControlError::UnsupportedResponse(
            "tab.create returned a non-tab result".to_owned(),
        ));
    };
    let Some((stage, request)) = launch_request(&tab, &root_pane, launch) else {
        return Ok(HerdrTabLaunchResult::Created { tab, root_pane });
    };
    let result = launch_in_created_tab(request, &mut send).await;
    match result {
        Ok(_) => Ok(HerdrTabLaunchResult::Created { tab, root_pane }),
        Err(error) => Ok(HerdrTabLaunchResult::LaunchFailed {
            tab,
            root_pane,
            stage,
            failure: error.into(),
        }),
    }
}

pub(super) async fn launch_in_created_tab<F, Fut>(
    request: HerdrControlRequest,
    send: &mut F,
) -> Result<HerdrControlResult, HerdrControlError>
where
    F: FnMut(HerdrControlRequest) -> Fut,
    Fut: Future<Output = Result<HerdrControlResult, HerdrControlError>>,
{
    let mut retry_deadline = None;
    loop {
        let error = match send(request.clone()).await {
            Ok(result) => return Ok(result),
            Err(error) => error,
        };
        // A newly created shell can still be initializing. This rejection is
        // issued before Herdr writes any agent input, so retrying is safe.
        // Never replay ambiguous failures or ordinary command submissions.
        if !matches!(request, HerdrControlRequest::AgentStart { .. })
            || !matches!(&error, HerdrControlError::ProtocolError(code, _) if code == "agent_pane_busy")
        {
            return Err(error);
        }
        let deadline = *retry_deadline
            .get_or_insert_with(|| tokio::time::Instant::now() + AGENT_SHELL_READINESS_TIMEOUT);
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(error);
        }
        tokio::time::sleep(AGENT_SHELL_READINESS_INTERVAL.min(remaining)).await;
        if tokio::time::Instant::now() >= deadline {
            return Err(error);
        }
    }
}

pub(super) fn pane_submission_requests(
    pane_id: String,
    parts: Vec<String>,
) -> Vec<(HerdrControlRequest, bool)> {
    let parts = parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return vec![(
            HerdrControlRequest::PaneSendKeys {
                pane_id,
                keys: vec!["enter".to_owned()],
            },
            false,
        )];
    }

    let part_count = parts.len();
    let mut requests = Vec::with_capacity(part_count.saturating_mul(2).saturating_sub(1));
    for (index, text) in parts.into_iter().enumerate() {
        if index > 0 {
            requests.push((
                HerdrControlRequest::PaneSendText {
                    pane_id: pane_id.clone(),
                    text: " ".to_owned(),
                },
                false,
            ));
        }
        requests.push((
            HerdrControlRequest::PaneSendInput {
                pane_id: pane_id.clone(),
                text,
                keys: if index + 1 == part_count {
                    vec!["enter".to_owned()]
                } else {
                    Vec::new()
                },
            },
            true,
        ));
    }
    requests
}

pub(super) async fn submit_pastes_inner(
    inner: Arc<RuntimeInner>,
    pane_id: String,
    parts: Vec<String>,
) -> Result<(), HostRuntimeError> {
    let mut submitted_parts = 0_u32;
    for (request, completes_part) in pane_submission_requests(pane_id, parts) {
        control_request_inner(inner.clone(), request)
            .await
            .map_err(|error| HostRuntimeError::PaneSubmissionFailure {
                submitted_parts,
                message: error.to_string(),
            })?;
        if completes_part {
            submitted_parts = submitted_parts.saturating_add(1);
        }
    }
    Ok(())
}
#[uniffi::export]
impl HostRuntime {
    pub fn open_agent_chat(
        &self,
        terminal_id: String,
    ) -> Result<AgentChatOpenResult, AgentSessionError> {
        let identity = {
            let host = self.inner.state.lock().host_state.projection();
            if host.sync_status != HostSyncStatus::Synced || host.freshness != HostFreshness::Fresh
            {
                return Ok(AgentChatOpenResult::NoChat {
                    terminal_id,
                    reason: AgentChatUnavailableReason::HostStateUnavailable,
                });
            }
            let Some(pane) = host.snapshot.as_ref().and_then(|snapshot| {
                snapshot
                    .panes
                    .iter()
                    .find(|pane| pane.terminal_id == terminal_id)
            }) else {
                return Ok(AgentChatOpenResult::NoChat {
                    terminal_id,
                    reason: AgentChatUnavailableReason::TerminalNotFound,
                });
            };
            let Some(identity) = authoritative_agent_chat_identity(pane) else {
                return Ok(AgentChatOpenResult::NoChat {
                    terminal_id,
                    reason: AgentChatUnavailableReason::UnsupportedPane,
                });
            };
            identity
        };
        let binding = self.inner.agents.bind_authoritative(identity)?;
        Ok(AgentChatOpenResult::Bound { binding })
    }

    pub fn start_agent_chat(
        &self,
        binding_token: String,
        cache_blob: Option<Vec<u8>>,
    ) -> Result<AgentChatStartResult, AgentSessionError> {
        self.inner.agents.start_bound(&binding_token, cache_blob)
    }

    /// Return the current Rust-owned binding without creating or reopening it.
    /// Presentation reconciliation must use this projection rather than the
    /// explicit `open_agent_chat` operation.
    pub fn current_agent_chat(&self, terminal_id: String) -> Option<AgentChatBinding> {
        self.inner.agents.terminal_binding(&terminal_id)
    }

    pub fn agent_transcript(&self, key: String) -> Result<AgentTranscriptState, AgentSessionError> {
        self.inner.agents.state(&key).ok_or_else(|| {
            AgentSessionError::SessionClosed(format!("agent transcript session {key} is closed"))
        })
    }

    pub fn detach_agent_chat(
        &self,
        terminal_id: String,
    ) -> Result<Option<AgentTranscriptArchive>, AgentSessionError> {
        self.inner.agents.detach_terminal(&terminal_id)
    }

    pub fn confirm_agent_transcript_cache(&self, confirmation_token: String) -> bool {
        self.inner.agents.confirm_cache(&confirmation_token)
    }

    /// Recheck after the bridge queue: detached/replaced operations cannot
    /// update a new view or persist an obsolete checkpoint for the same key.
    pub fn accepts_agent_transcript_event(&self, key: String, operation_epoch: u64) -> bool {
        self.inner.agents.accepts_event(&key, operation_epoch)
    }

    pub async fn create_tab_with_launch(
        &self,
        workspace_id: String,
        label: String,
        launch: HerdrTabLaunch,
    ) -> Result<HerdrTabLaunchResult, HerdrControlError> {
        let inner = self.inner.clone();
        let remembered_launch = launch.clone();
        let outcome = crate::runtime()
            .map_err(HerdrControlError::TransportDisconnected)?
            .spawn(create_tab_with_launch_inner(
                inner,
                workspace_id,
                label,
                launch,
            ))
            .await
            .map_err(|error| {
                HerdrControlError::RequestCancelled(format!("host tab launch task failed: {error}"))
            })??;
        if let HerdrTabLaunchResult::Created { root_pane, .. } = &outcome {
            self.inner.agent_preferences.lock().remember(
                &root_pane.terminal_id,
                &remembered_launch,
                false,
            );
        }
        Ok(outcome)
    }

    pub async fn submit_pastes(
        &self,
        pane_id: String,
        parts: Vec<String>,
    ) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(submit_pastes_inner(inner, pane_id, parts))
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "pane submission task failed: {error}"
                ))
            })?
    }

    pub async fn agent_integration_status(
        &self,
        kind: HerdrAgentKind,
    ) -> Result<AgentIntegrationStatus, HerdrControlError> {
        integration_status_with_request(kind, |request| self.control_request(request)).await
    }

    pub async fn install_agent_integration(
        &self,
        kind: HerdrAgentKind,
    ) -> Result<HerdrIntegrationInstallResult, HerdrControlError> {
        install_integration_with_request(kind, |request| self.control_request(request)).await
    }
}

#[uniffi::export]
impl HostRuntime {
    /// The normal launch path stays untouched. Authorization is enforced in Rust.
    pub async fn create_tab_with_reverse_control(
        &self,
        workspace_id: String,
        label: String,
        launch: HerdrTabLaunch,
    ) -> Result<HerdrTabLaunchResult, HerdrControlError> {
        let remembered_launch = launch.clone();
        let launch = crate::reverse_control::agent_launch(normalize_tab_launch(launch)?)
            .map_err(HerdrControlError::InvalidField)?;
        let inner = self.inner.clone();
        let outcome = crate::runtime()
            .map_err(HerdrControlError::TransportDisconnected)?
            .spawn(async move {
                let generation = inner.state.lock().generation;
                let created = control_request_inner(
                    inner.clone(),
                    HerdrControlRequest::TabCreate {
                        workspace_id,
                        label: (!label.trim().is_empty()).then(|| label.trim().to_owned()),
                    },
                )
                .await?;
                let HerdrControlResult::TabCreated { tab, root_pane } = created else {
                    return Err(HerdrControlError::UnsupportedResponse(
                        "tab.create returned a non-tab result".to_owned(),
                    ));
                };
                let info = crate::reverse_control::new_session(&inner.id, &root_pane)
                    .map_err(HerdrControlError::InvalidField)?;
                let session_id = info.session_id.clone();
                let mut stage = HerdrTabLaunchStage::AgentStart;
                let result = async {
                    let ssh = current_ssh(&inner).map_err(|error| {
                        HerdrControlError::TransportDisconnected(error.to_string())
                    })?;
                    let launch = launch
                        .for_host(&ssh)
                        .await
                        .map_err(HerdrControlError::InvalidField)?;
                    let launch = inner
                        .reverse_control
                        .prepare(ssh, info, launch)
                        .await
                        .map_err(HerdrControlError::TransportDisconnected)?;
                    if inner.state.lock().generation != generation {
                        inner.reverse_control.shutdown();
                        return Err(HerdrControlError::RequestCancelled(
                            "SSH changed during browser launch".to_owned(),
                        ));
                    }
                    let (launch_stage, request) = launch_request(&tab, &root_pane, launch)
                        .ok_or_else(|| {
                            HerdrControlError::InvalidField(
                                "Browser agent launch missing".to_owned(),
                            )
                        })?;
                    stage = launch_stage;
                    launch_in_created_tab(request, &mut |request| {
                        control_request_inner(inner.clone(), request)
                    })
                    .await
                }
                .await;
                match result {
                    Ok(_) => Ok(HerdrTabLaunchResult::Created { tab, root_pane }),
                    Err(error) => {
                        inner.reverse_control.close_session(&session_id);
                        Ok(HerdrTabLaunchResult::LaunchFailed {
                            tab,
                            root_pane,
                            stage,
                            failure: error.into(),
                        })
                    }
                }
            })
            .await
            .map_err(|error| HerdrControlError::RequestCancelled(error.to_string()))??;
        if let HerdrTabLaunchResult::Created { root_pane, .. } = &outcome {
            self.inner.agent_preferences.lock().remember(
                &root_pane.terminal_id,
                &remembered_launch,
                true,
            );
        }
        Ok(outcome)
    }
}
