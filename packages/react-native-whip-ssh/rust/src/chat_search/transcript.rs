//! Searchable content and list anchors projected directly from the native model.

use std::collections::HashMap;

use crate::agent_transcript::{
    AgentFileDiff, AgentMessageRole, AgentQuestion, AgentScalarValue, AgentTranscriptPart,
    AgentTranscriptState, is_question_tool,
};

use super::ChatSearchDocument;
use crate::chat_rows::{part_row_id, renderable, row_id};

#[derive(Default)]
struct Text(String);

impl Text {
    fn push(&mut self, value: &str) {
        if !value.is_empty() {
            if !self.0.is_empty() {
                self.0.push('\n');
            }
            self.0.push_str(value);
        }
    }

    fn diff(&mut self, file: &AgentFileDiff) {
        self.push(&file.file);
        self.push(file.patch.as_deref().unwrap_or_default());
        self.push(file.before.as_deref().unwrap_or_default());
        self.push(file.after.as_deref().unwrap_or_default());
    }

    fn questions(&mut self, questions: &[AgentQuestion]) {
        for question in questions {
            self.push(question.header.as_deref().unwrap_or_default());
            self.push(&question.question);
            for option in &question.options {
                self.push(&option.label);
                self.push(option.description.as_deref().unwrap_or_default());
            }
        }
    }

    fn scalar(&mut self, value: &AgentScalarValue) {
        match value {
            AgentScalarValue::String { value } => self.push(value),
            AgentScalarValue::Number { value } => self.push(&value.to_string()),
            AgentScalarValue::Boolean { value } => self.push(&value.to_string()),
        }
    }
}

fn part_text(part: &AgentTranscriptPart) -> Option<(&str, String)> {
    if !renderable(part) {
        return None;
    }
    let mut text = Text::default();
    let id = match part {
        AgentTranscriptPart::Text {
            id, text: value, ..
        }
        | AgentTranscriptPart::Reasoning {
            id, text: value, ..
        }
        | AgentTranscriptPart::Plan {
            id, text: value, ..
        } => {
            text.push(value);
            id
        }
        AgentTranscriptPart::Image { .. } => return None,
        AgentTranscriptPart::Notice {
            id,
            text: value,
            questions,
            ..
        } => {
            text.push(value);
            text.questions(questions);
            id
        }
        AgentTranscriptPart::Tool {
            id, tool, state, ..
        } => {
            if is_question_tool(tool) {
                text.questions(&state.questions);
                if text.0.is_empty()
                    && let Some(summary) = state
                        .input
                        .iter()
                        .find(|field| field.key == "question_summary")
                {
                    text.scalar(&summary.value);
                }
            } else {
                text.push(tool);
                text.push(state.title.as_deref().unwrap_or_default());
                for field in &state.input {
                    text.scalar(&field.value);
                }
            }
            text.push(state.output.as_deref().unwrap_or_default());
            text.push(state.error.as_deref().unwrap_or_default());
            if !is_question_tool(tool) {
                for file in &state.files {
                    text.diff(file);
                }
                for path in &state.loaded {
                    text.push(path);
                }
                for diagnostic in &state.diagnostics {
                    text.push(&diagnostic.file);
                    text.push(&diagnostic.message);
                }
            }
            id
        }
    };
    Some((id, text.0))
}

pub(crate) fn documents(state: &AgentTranscriptState) -> Vec<ChatSearchDocument> {
    let messages: HashMap<_, _> = state
        .messages
        .iter()
        .map(|message| (message.id.as_str(), message))
        .collect();
    let mut documents = Vec::new();
    let mut push = |id: String, text: String, parent: Option<String>| {
        if !text.is_empty() {
            let mut reveal: Vec<_> = parent.into_iter().collect();
            reveal.push(id.clone());
            documents.push(ChatSearchDocument { id, text, reveal });
        }
    };
    for turn in &state.turns {
        let ids: Vec<_> = if turn.message_ids.is_empty() {
            turn.user_message_id
                .iter()
                .chain(&turn.assistant_message_ids)
                .collect()
        } else {
            turn.message_ids.iter().collect()
        };
        for message in ids.into_iter().filter_map(|id| messages.get(id.as_str())) {
            if message.role == AgentMessageRole::User {
                let mut text = Text::default();
                for part in &message.parts {
                    match part {
                        AgentTranscriptPart::Text { text: value, .. } => text.push(value),
                        AgentTranscriptPart::Image { source, .. }
                            if !source.starts_with("data:") =>
                        {
                            text.push(source);
                        }
                        _ => (),
                    }
                }
                push(row_id(&[&turn.id, "user", &message.id]), text.0, None);
            } else {
                let mut occurrences = HashMap::<&str, usize>::new();
                for part in &message.parts {
                    if let Some((id, text)) = part_text(part) {
                        let occurrence = occurrences.entry(id).or_default();
                        push(
                            part_row_id(&turn.id, &message.id, id, *occurrence),
                            text,
                            None,
                        );
                        *occurrence += 1;
                    }
                }
            }
        }
        for message in turn
            .assistant_message_ids
            .iter()
            .filter_map(|id| messages.get(id.as_str()))
        {
            if let Some(error) = &message.error {
                push(
                    row_id(&[&turn.id, "error", &message.id]),
                    error.clone(),
                    None,
                );
            }
        }
        for (index, file) in turn.diffs.iter().enumerate() {
            let mut text = Text::default();
            text.diff(file);
            push(
                row_id(&[&turn.id, "diff", &file.file, &index.to_string()]),
                text.0,
                Some(row_id(&[&turn.id, "changes"])),
            );
        }
    }
    documents
}
