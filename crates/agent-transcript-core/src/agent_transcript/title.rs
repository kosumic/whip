use super::model::{AgentMessageRole, AgentTranscriptMessage, AgentTranscriptPart};
use super::projection::injected_user_context;

const MAX_TITLE_CHARS: usize = 72;

/// Shared display metadata normalization; never changes an agent's stored name.
pub(super) fn session_title(value: &str) -> Option<String> {
    let mut chars = value
        .split_whitespace()
        .flat_map(|word| word.chars().chain(std::iter::once(' ')));
    let mut title: String = chars.by_ref().take(MAX_TITLE_CHARS).collect();
    let truncated = chars.any(|character| !character.is_whitespace());
    title.truncate(title.trim_end().len());
    if truncated {
        title.push('…');
    }
    (!title.is_empty()).then_some(title)
}

pub(super) fn first_prompt_title(messages: &[AgentTranscriptMessage]) -> Option<String> {
    messages
        .iter()
        .filter(|message| message.role == AgentMessageRole::User)
        .find_map(|message| {
            let text = message
                .parts
                .iter()
                .filter_map(|part| match part {
                    AgentTranscriptPart::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(" ");
            let text = text.trim();
            if injected_user_context(text)
                || text.starts_with("# AGENTS.md instructions for ")
                || matches!(
                    text.split_whitespace().next(),
                    Some("/new" | "/clear" | "/resume")
                )
            {
                return None;
            }
            session_title(text)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_nonempty_single_line_and_unicode_safe() {
        assert_eq!(session_title(" \n\t "), None);
        assert_eq!(
            session_title("  Fix\n  the\tlogin  ").as_deref(),
            Some("Fix the login")
        );
        let title = session_title(&"界".repeat(MAX_TITLE_CHARS + 1)).unwrap();
        assert_eq!(title, format!("{}…", "界".repeat(MAX_TITLE_CHARS)));
        assert_eq!(
            session_title(&"a".repeat(MAX_TITLE_CHARS)),
            Some("a".repeat(MAX_TITLE_CHARS))
        );
    }
}
