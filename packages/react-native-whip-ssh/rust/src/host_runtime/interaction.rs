//! Inline controls for the live CLI dialog. Transcript records are history,
//! so they never authorize terminal input.

use sha2::{Digest, Sha256};

use super::*;
use crate::agent_sessions::AgentChatBinding;
use crate::herdr_api::{
    HerdrAgentStatus, HerdrControlError, HerdrControlRequest, HerdrControlResult,
};

const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_ANSWER_BYTES: usize = 16 * 1024;
const MAX_MENU_CHOICES: u32 = 20;

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct AgentInteractionChoice {
    pub label: String,
    /// Zero-based row in the current numbered menu, not a keystroke.
    pub index: u32,
    pub selected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct AgentInteractionPrompt {
    pub token: String,
    pub text: String,
    pub choices: Vec<AgentInteractionChoice>,
}

struct LivePrompt {
    prompt: AgentInteractionPrompt,
    pane_id: String,
    generation: (u64, u64),
}

fn cancelled(message: &str) -> HerdrControlError {
    HerdrControlError::RequestCancelled(message.to_owned())
}

fn menu_choices(text: &str) -> Vec<AgentInteractionChoice> {
    let choices = text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let selected = line.starts_with(['›', '❯', '>']);
            let line = line.trim_start_matches(['›', '❯', '>']).trim_start();
            let (number, label) = line.split_once(". ")?;
            let number = number.parse::<u32>().ok()?;
            (number > 0 && number <= MAX_MENU_CHOICES && !label.trim().is_empty()).then(|| {
                AgentInteractionChoice {
                    index: number - 1,
                    label: label.trim().to_owned(),
                    selected,
                }
            })
        })
        .collect::<Vec<_>>();
    // Prose numbered lists are not selectable menus. Require a single cursor
    // and consecutive rows so positional arrows cannot target another option.
    if choices.iter().filter(|choice| choice.selected).count() != 1
        || choices
            .iter()
            .enumerate()
            .any(|(index, choice)| choice.index as usize != index)
    {
        return Vec::new();
    }
    choices
}

fn project_prompt(
    text: String,
    binding_token: &str,
    generation: (u64, u64),
    revision: f64,
) -> Option<AgentInteractionPrompt> {
    let text = text.trim().to_owned();
    if text.is_empty() || text.len() > MAX_PROMPT_BYTES {
        return None;
    }
    let mut hash = Sha256::new();
    hash.update(binding_token.as_bytes());
    hash.update(generation.0.to_le_bytes());
    hash.update(generation.1.to_le_bytes());
    hash.update(revision.to_bits().to_le_bytes());
    hash.update(text.as_bytes());
    Some(AgentInteractionPrompt {
        token: crate::lower_hex(&hash.finalize()),
        choices: menu_choices(&text),
        text,
    })
}

/// Local binding plus fresh server identity are both required: a terminal id
/// may outlive the agent, its session, and a transport reconnect.
fn pane_matches_binding(pane: &HerdrPaneInfo, binding: &AgentChatBinding) -> bool {
    pane.agent_status == HerdrAgentStatus::Blocked
        && pane.terminal_id == binding.terminal_id
        && pane.pane_id == binding.pane_id
        && authoritative_agent_chat_identity(pane).is_some_and(|identity| {
            identity.session_id == binding.session_id && identity.agent == binding.agent
        })
}

pub(super) fn interaction_target(
    inner: &RuntimeInner,
    terminal_id: &str,
    binding_token: &str,
) -> Result<(String, (u64, u64)), HerdrControlError> {
    let binding = inner
        .agents
        .terminal_binding(terminal_id)
        .filter(|binding| binding.binding_token == binding_token)
        .ok_or_else(|| cancelled("This chat session has changed."))?;
    let state = inner.state.lock();
    let host = state.host_state.projection();
    let pane = host.snapshot.as_ref().and_then(|snapshot| {
        snapshot
            .panes
            .iter()
            .find(|pane| pane.terminal_id == terminal_id)
    });
    if state.connection != HostConnectionState::Connected
        || host.sync_status != HostSyncStatus::Synced
        || host.freshness != HostFreshness::Fresh
        || !pane.is_some_and(|pane| pane_matches_binding(pane, &binding))
    {
        return Err(cancelled("The agent is no longer waiting for input."));
    }
    Ok((
        binding.pane_id,
        (state.generation, state.herdr_recovery_revision),
    ))
}

async fn read_prompt(
    inner: Arc<RuntimeInner>,
    terminal_id: &str,
    binding_token: &str,
) -> Result<Option<LivePrompt>, HerdrControlError> {
    // Refresh status before reading; a cached blocked hint is insufficient.
    let Ok((pane_id, generation)) = interaction_target(&inner, terminal_id, binding_token) else {
        return Ok(None);
    };
    let binding = inner
        .agents
        .terminal_binding(terminal_id)
        .ok_or_else(|| cancelled("This chat session has changed."))?;
    let snapshot =
        control_request_inner(inner.clone(), HerdrControlRequest::SessionSnapshot).await?;
    let HerdrControlResult::SessionSnapshot { snapshot } = snapshot else {
        return Err(cancelled("The live agent state could not be read."));
    };
    if !snapshot
        .panes
        .iter()
        .any(|pane| pane_matches_binding(pane, &binding))
    {
        return Ok(None);
    }
    let result = control_request_inner(
        inner.clone(),
        HerdrControlRequest::PaneReadVisible {
            pane_id: pane_id.clone(),
        },
    )
    .await?;
    if interaction_target(&inner, terminal_id, binding_token)? != (pane_id.clone(), generation) {
        return Err(cancelled("The connection changed. Refresh the question."));
    }
    match result {
        HerdrControlResult::PaneRead { read }
            if read.pane_id == pane_id
                && !read.truncated
                && read.source == crate::herdr_api::HerdrPaneReadSource::Visible
                && read.format == crate::herdr_api::HerdrPaneReadFormat::Text =>
        {
            Ok(
                project_prompt(read.text, binding_token, generation, read.revision).map(|prompt| {
                    LivePrompt {
                        prompt,
                        pane_id,
                        generation,
                    }
                }),
            )
        }
        _ => Err(cancelled("The live agent prompt could not be read.")),
    }
}

fn response_keys(
    prompt: &AgentInteractionPrompt,
    action: &str,
    answer: &str,
) -> Result<Vec<String>, HerdrControlError> {
    if answer.len() > MAX_ANSWER_BYTES || answer.chars().any(char::is_control) {
        return Err(HerdrControlError::InvalidField(
            "Answers must be a single line of plain text.".to_owned(),
        ));
    }
    if let Some(index) = action
        .strip_prefix("choice:")
        .and_then(|index| index.parse::<u32>().ok())
    {
        let selected = prompt
            .choices
            .iter()
            .find(|choice| choice.selected)
            .ok_or_else(|| cancelled("The menu selection has changed."))?;
        if !prompt.choices.iter().any(|choice| choice.index == index) {
            return Err(cancelled("That choice is no longer available."));
        }
        let key = if index < selected.index { "up" } else { "down" };
        return Ok(vec![
            key.to_owned();
            index.abs_diff(selected.index) as usize
        ]);
    }
    match action {
        "up" | "down" | "left" | "right" | "tab" | "space" | "enter" | "esc"
            if answer.is_empty() =>
        {
            Ok(vec![action.to_owned()])
        }
        "answer" if !answer.trim().is_empty() => Ok(vec!["enter".to_owned()]),
        _ => Err(HerdrControlError::InvalidField(
            "Unsupported question response.".to_owned(),
        )),
    }
}

fn reserve_response(
    last: &mut String,
    expected: &str,
    current: &AgentInteractionPrompt,
    submitting: bool,
) -> Result<(), HerdrControlError> {
    if expected != current.token || last == expected {
        return Err(cancelled(
            "The prompt changed or was already answered. Review the refreshed prompt.",
        ));
    }
    if submitting {
        expected.clone_into(last);
    }
    Ok(())
}

#[uniffi::export]
impl HostRuntime {
    pub async fn agent_interaction_prompt(
        &self,
        terminal_id: String,
        binding_token: String,
    ) -> Result<Option<AgentInteractionPrompt>, HerdrControlError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HerdrControlError::TransportDisconnected)?
            .spawn(async move {
                read_prompt(inner, &terminal_id, &binding_token)
                    .await
                    .map(|live| live.map(|live| live.prompt))
            })
            .await
            .map_err(|error| cancelled(&error.to_string()))?
    }

    pub async fn respond_agent_interaction(
        &self,
        terminal_id: String,
        binding_token: String,
        prompt_token: String,
        action: String,
        answer: String,
    ) -> Result<(), HerdrControlError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HerdrControlError::TransportDisconnected)?
            .spawn(async move {
                let mut last = inner.interaction_response.lock().await;
                last.retain(|terminal_id, _| inner.agents.terminal_binding(terminal_id).is_some());
                let live = read_prompt(inner.clone(), &terminal_id, &binding_token)
                    .await?
                    .ok_or_else(|| cancelled("The agent is no longer waiting for input."))?;
                let keys = response_keys(&live.prompt, &action, &answer)?;
                if keys.is_empty() {
                    return Ok(());
                }
                if interaction_target(&inner, &terminal_id, &binding_token)?
                    != (live.pane_id.clone(), live.generation)
                {
                    return Err(cancelled("The connection changed. Refresh the question."));
                }
                reserve_response(
                    last.entry(terminal_id).or_default(),
                    &prompt_token,
                    &live.prompt,
                    matches!(action.as_str(), "answer" | "enter" | "esc"),
                )?;
                // Reserve before dispatch. A lost acknowledgement must never
                // cause an automatic duplicate approval or text submission.
                let request = if action == "answer" {
                    HerdrControlRequest::PaneSendInput {
                        pane_id: live.pane_id,
                        text: answer,
                        keys,
                    }
                } else {
                    HerdrControlRequest::PaneSendKeys {
                        pane_id: live.pane_id,
                        keys,
                    }
                };
                let result = control_request_inner(inner.clone(), request).await;
                drop(last);
                result?;
                Ok(())
            })
            .await
            .map_err(|error| cancelled(&error.to_string()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(text: &str) -> AgentInteractionPrompt {
        project_prompt(text.to_owned(), "binding", (1, 0), 4.0).unwrap()
    }

    #[test]
    fn approval_menu_uses_actual_labels_and_moves_without_approving() {
        let prompt = prompt(
            "Would you like to run this command?\n› 1. Yes, proceed\n  2. Yes, and don't ask again\n  3. No, tell the agent what to do differently\nPress enter to confirm or esc to cancel",
        );
        assert_eq!(prompt.choices.len(), 3);
        assert_eq!(prompt.choices[1].label, "Yes, and don't ask again");
        assert_eq!(
            response_keys(&prompt, "choice:2", "").unwrap(),
            ["down", "down"]
        );
        assert_eq!(response_keys(&prompt, "enter", "").unwrap(), ["enter"]);
        assert!(response_keys(&prompt, "choice:3", "").is_err());
    }

    #[test]
    fn prose_and_ambiguous_menus_do_not_become_actionable_choices() {
        for text in [
            "1. Run a command\n2. Read a file",
            "› 1. First\n› 2. Second",
            "› 1. First\n3. Third",
        ] {
            assert!(prompt(text).choices.is_empty());
        }
        let prompt = prompt("❯ 1. SQLite\n  2. Postgres");
        assert_eq!(response_keys(&prompt, "choice:1", "").unwrap(), ["down"]);
    }

    #[test]
    fn answers_reject_terminal_sequences_and_unknown_actions() {
        let prompt = prompt("Which name?");
        assert_eq!(response_keys(&prompt, "answer", "Whip").unwrap(), ["enter"]);
        for answer in ["", "  ", "hello\nrm -rf", "\u{1b}[A", "hi\tthere"] {
            assert!(response_keys(&prompt, "answer", answer).is_err());
        }
        assert!(response_keys(&prompt, "approve", "").is_err());
        assert!(response_keys(&prompt, "enter", "unintended text").is_err());
    }

    #[test]
    fn stale_reconnected_and_duplicate_responses_cannot_be_reserved() {
        let prompt = prompt("Approve?");
        let mut last = String::new();
        let changed = project_prompt("Approve?".into(), "binding", (2, 0), 4.0).unwrap();
        assert!(reserve_response(&mut last, &prompt.token, &changed, true).is_err());
        let changed = project_prompt("Approve?".into(), "binding", (1, 0), 5.0).unwrap();
        assert!(reserve_response(&mut last, &prompt.token, &changed, true).is_err());
        reserve_response(&mut last, &prompt.token, &prompt, false).unwrap();
        reserve_response(&mut last, &prompt.token, &prompt, false).unwrap();
        reserve_response(&mut last, &prompt.token, &prompt, true).unwrap();
        assert!(reserve_response(&mut last, &prompt.token, &prompt, true).is_err());
    }
}
