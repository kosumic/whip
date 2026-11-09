//! Speech selection and ordering for one explicitly selected chat binding.

use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

use crate::{
    AgentMessageRole, AgentQuestion, AgentScalarValue, AgentTranscriptKind, AgentTranscriptMessage,
    AgentTranscriptPart, agent_transcript::is_question_tool,
};
use parking_lot::Mutex;

mod chunking;
pub(crate) use chunking::speech_chunks_with_limit;

#[derive(uniffi::Enum)]
pub enum ChatSpeechPart {
    Text {
        id: String,
        text: String,
    },
    Tool {
        id: String,
        tool: String,
        summary: String,
        questions: Vec<AgentQuestion>,
    },
    Notice {
        id: String,
        questions: Vec<AgentQuestion>,
    },
}

/// The platform adapter forwards prose and question payloads, without tool output.
#[derive(uniffi::Record)]
pub struct ChatSpeechMessage {
    pub id: String,
    pub assistant: bool,
    pub completed: bool,
    pub prose: Vec<ChatSpeechPart>,
}

#[derive(Default)]
struct SpeechState {
    live: bool,
    parts: HashMap<(String, String), SpokenPart>,
    pending: VecDeque<ChatSpeechChunk>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatSpeechChunk {
    pub message_id: String,
    pub part_id: String,
    pub text: String,
    pub start_utf16: usize,
}

#[derive(Default)]
struct SpokenPart {
    spoken: String,
    finished: bool,
}

pub(crate) struct SpeechContent {
    pub(crate) id: String,
    pub(crate) text: String,
    pub(crate) question: bool,
}

pub(crate) fn speech_content(part: ChatSpeechPart) -> Option<SpeechContent> {
    let (id, text, question) = match part {
        ChatSpeechPart::Text { id, text } => (id, text, false),
        ChatSpeechPart::Tool {
            id,
            tool,
            summary,
            questions,
        } if is_question_tool(&tool) => {
            let text = if questions.is_empty() {
                summary
            } else {
                spoken_questions(&questions)
            };
            (id, text, true)
        }
        ChatSpeechPart::Notice { id, questions } => (id, spoken_questions(&questions), true),
        ChatSpeechPart::Tool { .. } => return None,
    };
    if text.trim().is_empty() {
        return None;
    }
    Some(SpeechContent { id, text, question })
}

fn readable(agent: AgentTranscriptKind, completed: bool, content: &SpeechContent) -> bool {
    content.question || completed || agent == AgentTranscriptKind::Codex
}

#[uniffi::export]
pub fn chat_speech_response_available(
    agent: AgentTranscriptKind,
    messages: Vec<ChatSpeechMessage>,
) -> bool {
    messages.into_iter().any(|message| {
        message.assistant
            && message
                .prose
                .into_iter()
                .filter_map(speech_content)
                .any(|part| {
                    readable(agent, message.completed, &part)
                        && !spoken_prose(&part.text).is_empty()
                })
    })
}

#[derive(Default, uniffi::Object)]
pub struct ChatSpeechQueue {
    state: Mutex<SpeechState>,
}

#[uniffi::export]
impl ChatSpeechQueue {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Every initial load/reconnect establishes a baseline before accepting new
    /// completions. An unfinished message at the baseline may finish later.
    pub fn update(&self, agent: AgentTranscriptKind, live: bool, messages: Vec<ChatSpeechMessage>) {
        self.update_stream(agent, live, messages, false, false);
    }

    pub fn next(&self) -> Option<String> {
        self.next_content().map(|chunk| chunk.text)
    }

    pub fn next_with_source(&self) -> Option<String> {
        self.next_content()
            .and_then(|chunk| serde_json::to_string(&chunk).ok())
    }

    /// Read assistant prose and questions in the selected response, in order.
    /// Questions are speakable while the agent is still waiting for an answer.
    pub fn read_response(
        &self,
        agent: AgentTranscriptKind,
        messages: Vec<ChatSpeechMessage>,
    ) -> bool {
        let mut state = self.state.lock();
        state.pending.clear();
        for message in messages {
            if !message.assistant {
                continue;
            }
            for part in message.prose.into_iter().filter_map(speech_content) {
                if !readable(agent, message.completed, &part) {
                    continue;
                }
                let prose = spoken_prose(&part.text);
                let mut offset = 0;
                state
                    .pending
                    .extend(speech_chunks(&prose).into_iter().map(|text| {
                        let start = offset + prose[offset..].find(&text).unwrap_or(0);
                        offset = start + text.len();
                        ChatSpeechChunk {
                            message_id: message.id.clone(),
                            part_id: part.id.clone(),
                            start_utf16: prose[..start].encode_utf16().count(),
                            text,
                        }
                    }));
            }
        }
        !state.pending.is_empty()
    }
}

impl ChatSpeechQueue {
    pub(crate) fn retain_messages(&self, messages: &VecDeque<String>) {
        self.state
            .lock()
            .parts
            .retain(|(message, _), _| messages.contains(message));
    }
    pub(crate) fn within_budget(&self, parts: usize, bytes: usize) -> bool {
        let state = self.state.lock();
        state.parts.len() <= parts
            && state
                .parts
                .values()
                .map(|part| part.spoken.len())
                .sum::<usize>()
                <= bytes
    }
    pub(crate) fn next_content(&self) -> Option<ChatSpeechChunk> {
        self.state.lock().pending.pop_front()
    }
    pub(crate) fn update_silent(
        &self,
        agent: AgentTranscriptKind,
        messages: Vec<ChatSpeechMessage>,
    ) {
        self.update_stream(agent, true, messages, false, true);
    }
    pub(crate) fn reset_voice(&self) {
        *self.state.lock() = SpeechState {
            live: true,
            ..SpeechState::default()
        };
    }
    pub(crate) fn has_pending(&self) -> bool {
        !self.state.lock().pending.is_empty()
    }
    pub(crate) fn update_voice(
        &self,
        agent: AgentTranscriptKind,
        mut messages: Vec<ChatSpeechMessage>,
        completed: bool,
    ) {
        for message in &mut messages {
            message.completed |= completed;
        }
        self.update_stream(agent, true, messages, true, false);
    }
    fn update_stream(
        &self,
        agent: AgentTranscriptKind,
        live: bool,
        messages: Vec<ChatSpeechMessage>,
        voice: bool,
        silent: bool,
    ) {
        let mut state = self.state.lock();
        if !live {
            state.live = false;
            state.pending.clear();
            return;
        }
        for message in messages {
            if !message.assistant {
                continue;
            }
            let parts: Vec<_> = message
                .prose
                .into_iter()
                .filter_map(speech_content)
                .collect();
            let part_count = parts.len();
            for (index, part) in parts.into_iter().enumerate() {
                let live = state.live && !silent;
                // Baseline complete prose is history. Codex publishes finalized
                // response items inside a growing turn; keep their existing
                // immediate playback without freezing a part on its first update.
                let finalized = message.completed
                    || part.question
                    || index + 1 < part_count
                    || (!voice && readable(agent, message.completed, &part));
                let part_id = part.id.clone();
                let progress = state
                    .parts
                    .entry((message.id.clone(), part.id))
                    .or_default();
                if progress.finished {
                    continue;
                }
                let prose = spoken_prose(&part.text);
                if !live {
                    let end = if finalized || silent {
                        prose.len()
                    } else {
                        stable_prose_end(&prose, part.text.ends_with(char::is_whitespace))
                    };
                    prose[..end].clone_into(&mut progress.spoken);
                    progress.finished = message.completed;
                    continue;
                }
                // A provider rewriting already spoken prose must not replay it
                // or reorder it into a later part. New parts remain speakable.
                if !prose.starts_with(&progress.spoken) {
                    progress.finished = true;
                    continue;
                }
                let end = if finalized {
                    prose.len()
                } else {
                    stable_prose_end(&prose, part.text.ends_with(char::is_whitespace))
                };
                if end <= progress.spoken.len() {
                    progress.finished = message.completed;
                    continue;
                }
                let tail_start = progress.spoken.len();
                let tail = prose[tail_start..end].trim().to_owned();
                prose[..end].clone_into(&mut progress.spoken);
                progress.finished = message.completed;
                let mut offset = tail_start;
                state
                    .pending
                    .extend(speech_chunks(&tail).into_iter().map(|text| {
                        let start = offset + prose[offset..].find(&text).unwrap_or(0);
                        offset = start + text.len();
                        ChatSpeechChunk {
                            message_id: message.id.clone(),
                            part_id: part_id.clone(),
                            start_utf16: prose[..start].encode_utf16().count(),
                            text,
                        }
                    }));
            }
        }
        state.live = true;
    }
}

fn spoken_questions(questions: &[AgentQuestion]) -> String {
    let mut sections = Vec::new();
    for question in questions {
        if let Some(header) = &question.header {
            push_sentence(&mut sections, header);
        }
        push_sentence(&mut sections, &question.question);
        if question.multiple {
            push_sentence(&mut sections, "Choose one or more.");
        }
        let options = question
            .options
            .iter()
            .filter_map(|option| {
                let label = option.label.trim();
                if label.is_empty() {
                    return None;
                }
                Some(match option.description.as_deref().map(str::trim) {
                    Some(description) if !description.is_empty() => {
                        format!("{label}: {description}")
                    }
                    _ => label.to_owned(),
                })
            })
            .collect::<Vec<_>>()
            .join(" or ");
        push_sentence(&mut sections, &options);
    }
    sections.join(" ")
}

fn push_sentence(sections: &mut Vec<String>, text: &str) {
    let text = text.trim();
    if !text.is_empty() {
        sections.push(if text.ends_with(['.', '?', '!', '。', '？', '！']) {
            text.to_owned()
        } else {
            format!("{text}.")
        });
    }
}

/// Commit punctuation only once following whitespace is visible. The mutable
/// tail stays in the transcript until more text arrives or the turn completes.
fn stable_prose_end(prose: &str, trailing_whitespace: bool) -> usize {
    let mut end = 0;
    for (index, character) in prose.char_indices() {
        if !matches!(
            character,
            '.' | '?' | '!' | ';' | ':' | '。' | '？' | '！' | '；'
        ) {
            continue;
        }
        let next = index + character.len_utf8();
        if prose[next..].starts_with(char::is_whitespace)
            || (matches!(character, '。' | '？' | '！' | '；') && next < prose.len())
            || (next == prose.len() && trailing_whitespace)
        {
            end = next;
        }
    }
    end
}

// Keep each utterance below Android's 4,000 UTF-16-unit limit, including emoji.
const MAX_CHUNK_UNITS: usize = 3_000;

fn speech_chunks(text: &str) -> Vec<String> {
    speech_chunks_with_limit(text, MAX_CHUNK_UNITS)
}

/// Lightweight speech formatting: omit fenced/indented code and links' URLs,
/// preserving their human-readable labels and inline code words.
pub(crate) fn spoken_prose(markdown: &str) -> String {
    format_prose(markdown, false).0
}

pub(crate) fn mapped_prose(markdown: &str) -> (String, Vec<std::ops::Range<usize>>) {
    format_prose(markdown, true)
}

fn format_prose(markdown: &str, mapping: bool) -> (String, Vec<std::ops::Range<usize>>) {
    let mut prose = String::new();
    let mut spans = Vec::new();
    let mut whitespace = None;
    let mut emit = |character: char, span: std::ops::Range<usize>| {
        if character.is_whitespace() {
            whitespace = Some(span);
            return;
        }
        if let Some(space) = whitespace.take().filter(|_| !prose.is_empty()) {
            prose.push(' ');
            if mapping {
                spans.push(space);
            }
        }
        prose.push(character);
        if mapping {
            spans.extend(std::iter::repeat_n(span, character.len_utf16()));
        }
    };
    let mut fence: Option<(char, usize)> = None;
    let mut line_start = 0;
    for line in markdown.split_inclusive('\n') {
        let source_start = line_start;
        line_start += line.len();
        let trimmed = line.trim_start();
        let marker = trimmed.chars().next().unwrap_or(' ');
        let count = trimmed.chars().take_while(|&c| c == marker).count();
        if let Some((opening, length)) = fence {
            if marker == opening && count >= length {
                fence = None;
            }
            continue;
        }
        if matches!(marker, '`' | '~') && count >= 3 {
            fence = Some((marker, count));
            continue;
        }
        if line.starts_with("    ") || line.starts_with('\t') {
            continue;
        }
        let trimmed = trimmed.trim_start_matches(['#', '>', '-', '+', '*', ' ']);
        let source_start = source_start + line.len() - trimmed.len();
        let mut chars = trimmed.char_indices().peekable();
        while let Some((index, character)) = chars.next() {
            match character {
                ']' if chars.peek().is_some_and(|(_, c)| *c == '(') => {
                    chars.next();
                    let mut depth = 1;
                    for (_, c) in chars.by_ref() {
                        match c {
                            '(' => depth += 1,
                            ')' => depth -= 1,
                            _ => {}
                        }
                        if depth == 0 {
                            break;
                        }
                    }
                }
                '!' if chars.peek().is_some_and(|(_, c)| *c == '[') => {}
                '[' | ']' | '*' | '_' | '`' | '~' => {}
                _ => emit(
                    character,
                    source_start + index..source_start + index + character.len_utf8(),
                ),
            }
        }
        emit(' ', line_start..line_start);
    }
    (prose, spans)
}

pub(crate) fn transcript_message(message: &AgentTranscriptMessage) -> ChatSpeechMessage {
    project_transcript_message(message, None)
}

const TRANSCRIPT_BYTES: usize = 8192;
const TRANSCRIPT_PARTS: usize = 64;
const TRANSCRIPT_ID_BYTES: usize = 256;
const TRANSCRIPT_QUESTIONS: usize = 16;

pub(crate) fn bounded_transcript_message(message: &AgentTranscriptMessage) -> ChatSpeechMessage {
    project_transcript_message(message, Some(TRANSCRIPT_BYTES))
}

pub(crate) fn transcript_projection_limited(message: &AgentTranscriptMessage) -> bool {
    transcript_speech_parts(message, true)
        .take(TRANSCRIPT_PARTS + 1)
        .count()
        > TRANSCRIPT_PARTS
        || transcript_speech_parts(message, true)
            .filter_map(|part| match part {
                AgentTranscriptPart::Text { text, .. } => Some(text.len()),
                _ => None,
            })
            .sum::<usize>()
            > TRANSCRIPT_BYTES
}

fn transcript_speech_parts(
    message: &AgentTranscriptMessage,
    bounded: bool,
) -> impl DoubleEndedIterator<Item = &AgentTranscriptPart> {
    message.parts.iter().filter(move |part| {
        (!bounded || part.id().len() <= TRANSCRIPT_ID_BYTES)
            && match part {
                AgentTranscriptPart::Text { .. } => true,
                AgentTranscriptPart::Tool { call_id, tool, .. } => {
                    crate::agent_transcript::is_question_tool(tool)
                        && (!bounded
                            || tool.len() <= TRANSCRIPT_ID_BYTES
                                && call_id.len() <= TRANSCRIPT_ID_BYTES)
                }
                AgentTranscriptPart::Notice { questions, .. } => !questions.is_empty(),
                _ => false,
            }
    })
}

pub(crate) fn text_prefix(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn project_transcript_message(
    message: &AgentTranscriptMessage,
    limit: Option<usize>,
) -> ChatSpeechMessage {
    let mut remaining = limit.unwrap_or(usize::MAX);
    let mut copy = |value: &str| {
        let value = text_prefix(value, remaining);
        remaining -= value.len();
        value.to_owned()
    };
    let questions = |questions: &[AgentQuestion], copy: &mut dyn FnMut(&str) -> String| {
        questions
            .iter()
            .take(if limit.is_some() {
                TRANSCRIPT_QUESTIONS
            } else {
                usize::MAX
            })
            .map(|question| AgentQuestion {
                header: question.header.as_ref().map(|header| copy(header)),
                question: copy(&question.question),
                multiple: question.multiple,
                options: question
                    .options
                    .iter()
                    .take(if limit.is_some() {
                        TRANSCRIPT_QUESTIONS
                    } else {
                        usize::MAX
                    })
                    .map(|option| crate::AgentQuestionOption {
                        label: copy(&option.label),
                        description: option
                            .description
                            .as_ref()
                            .map(|description| copy(description)),
                    })
                    .collect(),
            })
            .collect()
    };
    // Allocate a bounded reader's budget from the newest parts, then restore
    // prose order. A long old progress item must not hide a new final answer.
    let mut source = transcript_speech_parts(message, limit.is_some());
    let parts = std::iter::from_fn(|| {
        if limit.is_some() {
            source.next_back()
        } else {
            source.next()
        }
    });
    let mut prose: Vec<_> = parts
        .filter_map(|part| match part {
            AgentTranscriptPart::Text { id, text, .. } => Some(ChatSpeechPart::Text {
                id: id.clone(),
                text: copy(text),
            }),
            AgentTranscriptPart::Tool {
                id,
                call_id,
                tool,
                state,
                ..
            } => {
                let summary = state
                    .input
                    .iter()
                    .find(|field| state.questions.is_empty() && field.key == "question_summary")
                    .and_then(|field| match &field.value {
                        AgentScalarValue::String { value } => Some(copy(value)),
                        _ => None,
                    })
                    .unwrap_or_default();
                Some(ChatSpeechPart::Tool {
                    // Raw activity and the persisted item share a call ID.
                    id: if call_id.is_empty() { id } else { call_id }.clone(),
                    tool: tool.clone(),
                    summary,
                    questions: questions(&state.questions, &mut copy),
                })
            }
            AgentTranscriptPart::Notice {
                id,
                questions: asks,
                ..
            } => Some(ChatSpeechPart::Notice {
                id: id.clone(),
                questions: questions(asks, &mut copy),
            }),
            _ => None,
        })
        .take(if limit.is_some() {
            TRANSCRIPT_PARTS
        } else {
            usize::MAX
        })
        .collect();
    if limit.is_some() {
        prose.reverse();
    }
    ChatSpeechMessage {
        id: if limit.is_some() {
            text_prefix(&message.id, TRANSCRIPT_ID_BYTES).into()
        } else {
            message.id.clone()
        },
        assistant: message.role == AgentMessageRole::Assistant,
        completed: message.completed_at_ms.is_some(),
        prose,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AgentQuestionOption;

    const AGENTS: [AgentTranscriptKind; 4] = [
        AgentTranscriptKind::Claude,
        AgentTranscriptKind::Codex,
        AgentTranscriptKind::OpenCode,
        AgentTranscriptKind::Pi,
    ];

    fn question() -> AgentQuestion {
        AgentQuestion {
            header: None,
            question: "Which approach?".into(),
            multiple: false,
            options: ["First", "Second", "Third"]
                .into_iter()
                .map(|label| AgentQuestionOption {
                    label: label.into(),
                    description: None,
                })
                .collect(),
        }
    }

    fn question_message(tool: Option<&str>, questions: Vec<AgentQuestion>) -> ChatSpeechMessage {
        ChatSpeechMessage {
            id: "question".into(),
            assistant: true,
            completed: false,
            prose: vec![match tool {
                Some(tool) => ChatSpeechPart::Tool {
                    id: "ask".into(),
                    tool: tool.into(),
                    summary: "Fallback summary".into(),
                    questions,
                },
                None => ChatSpeechPart::Notice {
                    id: "ask".into(),
                    questions,
                },
            }],
        }
    }

    #[test]
    fn pending_questions_speak_options_with_or_once_for_every_agent() {
        for agent in AGENTS {
            for tool in [
                Some("AskUserQuestion"),
                Some("question"),
                Some("functions.request_user_input"),
                Some("functions · request_user_input_async"),
                None,
            ] {
                let queue = ChatSpeechQueue::new();
                assert!(chat_speech_response_available(
                    agent,
                    vec![question_message(tool, vec![question()])]
                ));
                queue.update(agent, true, vec![]);
                for completed in [false, false, true] {
                    let mut message = question_message(tool, vec![question()]);
                    message.completed = completed;
                    queue.update(agent, true, vec![message]);
                }
                assert_eq!(
                    queue.next().as_deref(),
                    Some("Which approach? First or Second or Third.")
                );
                assert_eq!(queue.next(), None);
            }
        }
    }

    #[test]
    fn question_history_and_reconnect_catchup_are_silent() {
        for agent in AGENTS {
            let queue = ChatSpeechQueue::new();
            queue.update(
                agent,
                true,
                vec![question_message(Some("question"), vec![question()])],
            );
            queue.update(
                agent,
                true,
                vec![question_message(Some("question"), vec![question()])],
            );
            assert_eq!(queue.next(), None);
            queue.update(agent, false, vec![]);
            let mut missed = question_message(None, vec![question()]);
            missed.id = "missed".into();
            queue.update(agent, true, vec![missed]);
            assert_eq!(queue.next(), None);
            let mut live = question_message(None, vec![question()]);
            live.id = "live".into();
            queue.update(agent, true, vec![live]);
            assert_eq!(
                queue.next().as_deref(),
                Some("Which approach? First or Second or Third.")
            );
        }
    }

    #[test]
    fn newly_available_question_flushes_preceding_prose_before_reading_options() {
        for agent in AGENTS {
            let queue = ChatSpeechQueue::new();
            queue.update(agent, true, vec![]);
            let waiting = || ChatSpeechMessage {
                prose: vec![ChatSpeechPart::Tool {
                    id: "ask".into(),
                    tool: "AskUserQuestion".into(),
                    summary: String::new(),
                    questions: Vec::new(),
                }],
                ..question_message(None, Vec::new())
            };
            queue.update(agent, true, vec![waiting()]);
            assert_eq!(queue.next(), None);
            let with_intro = |mut ask: ChatSpeechMessage| {
                ask.prose.insert(
                    0,
                    ChatSpeechPart::Text {
                        id: "intro".into(),
                        text: "Pick an approach".into(),
                    },
                );
                ask
            };
            queue.update(agent, true, vec![with_intro(waiting())]);
            if agent != AgentTranscriptKind::Codex {
                assert_eq!(queue.next(), None);
            }
            queue.update(
                agent,
                true,
                vec![with_intro(question_message(
                    Some("AskUserQuestion"),
                    vec![question()],
                ))],
            );
            assert_eq!(queue.next().as_deref(), Some("Pick an approach"));
            assert_eq!(
                queue.next().as_deref(),
                Some("Which approach? First or Second or Third.")
            );
            assert_eq!(queue.next(), None);
        }
    }

    #[test]
    fn manual_reading_accepts_pending_questions_and_preserves_response_order() {
        for agent in AGENTS {
            let messages = || {
                let mut ask = question_message(Some("AskUserQuestion"), vec![question()]);
                ask.prose.push(ChatSpeechPart::Notice {
                    id: "next-question".into(),
                    questions: vec![AgentQuestion {
                        question: "Anything else?".into(),
                        options: Vec::new(),
                        ..question()
                    }],
                });
                vec![
                    message("intro", true, "Before the question."),
                    ask,
                    message("outro", true, "After the question."),
                ]
            };
            let queue = ChatSpeechQueue::new();
            assert!(chat_speech_response_available(agent, messages()));
            for _ in 0..2 {
                assert!(queue.read_response(agent, messages()));
                assert_eq!(queue.next().as_deref(), Some("Before the question."));
                assert_eq!(
                    queue.next().as_deref(),
                    Some("Which approach? First or Second or Third.")
                );
                assert_eq!(queue.next().as_deref(), Some("Anything else?"));
                assert_eq!(queue.next().as_deref(), Some("After the question."));
                assert_eq!(queue.next(), None);
            }
        }
    }

    #[test]
    fn questions_include_headers_descriptions_and_multiple_selection() {
        let mut question = question();
        question.header = Some("Approach".into());
        question.multiple = true;
        question.options[0].description = Some("Quickest".into());
        question.options[1].description = Some("   ".into());
        question.options[2].label = "   ".into();
        assert_eq!(
            spoken_questions(&[question]),
            "Approach. Which approach? Choose one or more. First: Quickest or Second."
        );
    }

    #[test]
    fn summary_fallback_is_read_but_non_question_tools_and_empty_notices_are_silent() {
        for agent in AGENTS {
            let queue = ChatSpeechQueue::new();
            assert!(
                queue.read_response(agent, vec![question_message(Some("question"), Vec::new())])
            );
            assert_eq!(queue.next().as_deref(), Some("Fallback summary"));
            let ignored = || {
                let mut user_question = question_message(Some("question"), vec![question()]);
                user_question.assistant = false;
                vec![
                    question_message(Some("shell"), vec![question()]),
                    question_message(None, Vec::new()),
                    user_question,
                ]
            };
            assert!(!chat_speech_response_available(agent, ignored()));
            assert!(!queue.read_response(agent, ignored()));
            queue.update(agent, true, vec![]);
            queue.update(agent, true, ignored());
            assert_eq!(queue.next(), None);
        }
    }

    fn message(id: &str, completed: bool, text: &str) -> ChatSpeechMessage {
        ChatSpeechMessage {
            id: id.into(),
            assistant: true,
            completed,
            prose: vec![ChatSpeechPart::Text {
                id: id.into(),
                text: text.into(),
            }],
        }
    }

    #[test]
    fn growing_prose_speaks_stable_sentences_once_and_flushes_the_final_tail() {
        for agent in [AgentTranscriptKind::Claude, AgentTranscriptKind::OpenCode] {
            let queue = ChatSpeechQueue::new();
            queue.update(agent, true, vec![]);
            queue.update(
                agent,
                true,
                vec![message("reply", false, "First sentence. Sec")],
            );
            assert_eq!(queue.next().as_deref(), Some("First sentence."));
            assert_eq!(queue.next(), None);
            queue.update(
                agent,
                true,
                vec![message("reply", false, "First sentence. Second sentence.")],
            );
            assert_eq!(queue.next(), None);
            queue.update(
                agent,
                true,
                vec![message("reply", true, "First sentence. Second sentence.")],
            );
            assert_eq!(queue.next().as_deref(), Some("Second sentence."));
            queue.update(
                agent,
                true,
                vec![message("reply", true, "First sentence. Second sentence.")],
            );
            assert_eq!(queue.next(), None);
        }
    }

    #[test]
    fn a_later_part_flushes_the_previous_tail_in_prose_order() {
        let queue = ChatSpeechQueue::new();
        queue.update(AgentTranscriptKind::Claude, true, vec![]);
        queue.update(
            AgentTranscriptKind::Claude,
            true,
            vec![message("reply", false, "First. Remaining tail")],
        );
        assert_eq!(queue.next().as_deref(), Some("First."));
        let mut reply = message("reply", false, "First. Remaining tail");
        reply.prose.push(ChatSpeechPart::Text {
            id: "second".into(),
            text: "Next sentence. More".into(),
        });
        queue.update(AgentTranscriptKind::Claude, true, vec![reply]);
        assert_eq!(queue.next().as_deref(), Some("Remaining tail"));
        assert_eq!(queue.next().as_deref(), Some("Next sentence."));
        assert_eq!(queue.next(), None);
    }

    #[test]
    fn partial_code_and_rewritten_spoken_text_are_not_replayed() {
        let queue = ChatSpeechQueue::new();
        queue.update(AgentTranscriptKind::Claude, true, vec![]);
        queue.update(
            AgentTranscriptKind::Claude,
            true,
            vec![message("reply", false, "Safe. ```rust\nsecret();")],
        );
        assert_eq!(queue.next().as_deref(), Some("Safe."));
        queue.update(
            AgentTranscriptKind::Claude,
            true,
            vec![message("reply", true, "Rewritten. New text.")],
        );
        assert_eq!(queue.next(), None);
    }

    #[test]
    fn speaks_new_completions_once_without_replaying_history() {
        for agent in [AgentTranscriptKind::Claude, AgentTranscriptKind::OpenCode] {
            let queue = ChatSpeechQueue::new();
            queue.update(
                agent,
                true,
                vec![
                    message("old", true, "History"),
                    message("stream", false, "Hel"),
                ],
            );
            assert_eq!(queue.next(), None);
            queue.update(
                agent,
                true,
                vec![
                    message("old", true, "History"),
                    message("stream", false, "Hello"),
                ],
            );
            assert_eq!(queue.next(), None);
            queue.update(
                agent,
                true,
                vec![
                    message("stream", true, "Hello"),
                    message("next", true, "World"),
                ],
            );
            assert_eq!(queue.next().as_deref(), Some("Hello"));
            assert_eq!(queue.next().as_deref(), Some("World"));
            queue.update(agent, true, vec![message("stream", true, "Hello again")]);
            assert_eq!(queue.next(), None);
        }
    }

    #[test]
    fn reconnect_discards_queue_and_baselines_catchup() {
        for agent in [AgentTranscriptKind::Claude, AgentTranscriptKind::OpenCode] {
            let queue = ChatSpeechQueue::new();
            queue.update(agent, false, vec![message("cache", true, "Cached")]);
            queue.update(agent, true, vec![message("history", true, "History")]);
            queue.update(agent, true, vec![message("new", true, "Queued")]);
            queue.update(agent, false, vec![]);
            assert_eq!(queue.next(), None);
            queue.update(
                agent,
                true,
                vec![message("catchup", true, "Missed while disconnected")],
            );
            assert_eq!(queue.next(), None);
            queue.update(agent, true, vec![message("live", true, "Live again")]);
            assert_eq!(queue.next().as_deref(), Some("Live again"));
        }
    }

    #[test]
    fn ignores_user_and_non_prose_messages() {
        let queue = ChatSpeechQueue::new();
        queue.update(AgentTranscriptKind::OpenCode, true, vec![]);
        let mut user = message("user", true, "Do this");
        user.assistant = false;
        queue.update(
            AgentTranscriptKind::OpenCode,
            true,
            vec![user, message("tool", true, "")],
        );
        assert_eq!(queue.next(), None);
    }

    #[test]
    fn manual_reading_reads_all_selected_prose_in_order_and_can_replay_it() {
        for agent in [
            AgentTranscriptKind::Claude,
            AgentTranscriptKind::Codex,
            AgentTranscriptKind::OpenCode,
        ] {
            let queue = ChatSpeechQueue::new();
            let messages = || {
                let mut user = message("user", true, "User prompt");
                user.assistant = false;
                vec![
                    message("progress", true, "First part of the response"),
                    message("reply", true, "**Final** [reply](https://example.com)"),
                    message("tool-only", true, ""),
                    message("code-only", true, "```sh\nsecret\n```"),
                    user,
                ]
            };
            for _ in 0..2 {
                assert!(queue.read_response(agent, messages()));
                assert_eq!(queue.next().as_deref(), Some("First part of the response"));
                assert_eq!(queue.next().as_deref(), Some("Final reply"));
                assert_eq!(queue.next(), None);
            }
        }
    }

    #[test]
    fn manual_chunks_keep_original_part_identity_and_unicode_offsets() {
        let queue = ChatSpeechQueue::new();
        let text = format!("{} Hello 你好 👋 world", "Hello ".repeat(1_200));
        let prose = spoken_prose(&text);
        assert!(queue.read_response(
            AgentTranscriptKind::Codex,
            vec![message("selected", true, &text)]
        ));
        let mut chunks = 0;
        while let Some(json) = queue.next_with_source() {
            let chunk: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
            assert_eq!(chunk["messageId"], "selected");
            assert_eq!(chunk["partId"], "selected");
            let start = usize::try_from(chunk["startUtf16"].as_u64().unwrap_or_default())
                .expect("speech offset fits usize");
            let text = chunk["text"].as_str().unwrap_or_default();
            let original = String::from_utf16(
                &prose
                    .encode_utf16()
                    .skip(start)
                    .take(text.encode_utf16().count())
                    .collect::<Vec<_>>(),
            );
            assert_eq!(original.ok().as_deref(), Some(text));
            chunks += 1;
        }
        assert!(chunks > 1);
    }

    #[test]
    fn manual_reading_waits_for_completion_except_finalized_codex_parts() {
        for agent in [AgentTranscriptKind::Claude, AgentTranscriptKind::OpenCode] {
            let queue = ChatSpeechQueue::new();
            assert!(!chat_speech_response_available(
                agent,
                vec![message("stream", false, "Partial")]
            ));
            assert!(!queue.read_response(agent, vec![message("stream", false, "Partial")]));
            assert_eq!(queue.next(), None);
        }
        let queue = ChatSpeechQueue::new();
        assert!(queue.read_response(
            AgentTranscriptKind::Codex,
            vec![message("turn", false, "Finalized response item")]
        ));
        assert_eq!(queue.next().as_deref(), Some("Finalized response item"));
    }

    #[test]
    fn codex_reads_new_parts_in_the_same_turn_once() {
        let queue = ChatSpeechQueue::new();
        queue.update(
            AgentTranscriptKind::Codex,
            true,
            vec![message("turn", false, "Old progress")],
        );
        let mut turn = message("turn", false, "Old progress");
        turn.prose.push(ChatSpeechPart::Text {
            id: "final".into(),
            text: "Finished".into(),
        });
        queue.update(AgentTranscriptKind::Codex, true, vec![turn]);
        assert_eq!(queue.next().as_deref(), Some("Finished"));
        assert_eq!(queue.next(), None);
    }

    #[test]
    fn strips_markdown_and_code_but_keeps_link_labels() {
        assert_eq!(
            spoken_prose(
                "## Done\n**Read** [the guide](https://example.com/a(b)) and `retry`.\n```rust\nsecret();\n```\n    code();\n- Finished."
            ),
            "Done Read the guide and retry. Finished."
        );
    }

    #[test]
    fn chunks_long_unicode_replies_without_losing_text() {
        let text = "🦀".repeat(4_001);
        let chunks = speech_chunks(&text);
        assert!(
            chunks
                .iter()
                .all(|chunk| chunk.encode_utf16().count() <= MAX_CHUNK_UNITS)
        );
        assert_eq!(chunks.concat(), text);
    }
}
