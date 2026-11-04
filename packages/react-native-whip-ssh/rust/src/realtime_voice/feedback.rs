// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
//! Adapted from Codex's realtime_conversation.rs handoff stream at
//! f2b94ef8b52196f127d162c6db71e390b9bb265c. Whip reads its pinned native
//! transcript instead of Codex's backend output channel. Only public answer
//! text crosses this boundary; reasoning and tool payloads are excluded.

use std::time::{Duration, Instant};

use crate::agent_transcript::{AgentMessageRole, AgentTranscriptPart, AgentTranscriptView};

const MAX_MESSAGES: usize = 64;
const MAX_MESSAGE_BYTES: usize = 8192;
const MAX_BATCH_BYTES: usize = 16 * 1024;
const MAX_HANDOFF_BYTES: usize = 64 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_secs(15);
pub(super) const BACKEND_PREFIX: &str = "[BACKEND] ";
pub(super) const FINISHED_GUIDANCE: &str = "Use actual assistant_output and [BACKEND] assistant text as the result. If neither contains the answer, say the result is not available in this voice call and direct the user to the agent chat. A lifecycle observation alone is not an answer or proof that all deferred work completed. Do not resubmit the request.";

pub(crate) struct Snapshot {
    revision: u64,
    messages: Vec<AgentMessage>,
}
struct AgentMessage {
    id: String,
    text: String,
}

impl Snapshot {
    /// Bounded public assistant text, never terminal output or private parts.
    pub(crate) fn answer_since(&self, previous: &Self) -> Option<&str> {
        if previous
            .messages
            .last()
            .is_some_and(|anchor| !self.messages.iter().any(|message| message.id == anchor.id))
        {
            return None;
        }
        self.messages
            .iter()
            .rev()
            .find(|message| {
                !message.text.is_empty()
                    && previous
                        .messages
                        .iter()
                        .find(|old| old.id == message.id)
                        .is_none_or(|old| old.text != message.text)
            })
            .map(|message| message.text.as_str())
    }

    pub(crate) fn from_view(view: AgentTranscriptView<'_>) -> Self {
        let messages = view
            .messages
            .iter()
            .rev()
            .take(MAX_MESSAGES)
            .rev()
            .filter_map(|message| {
                // Omit pathological IDs rather than allocating unbounded cursor keys.
                if message.id.len() > 256 {
                    return None;
                }
                let mut text = String::new();
                if message.role == AgentMessageRole::Assistant {
                    for part in &message.parts {
                        if let AgentTranscriptPart::Text { text: part, .. } = part {
                            if !text.is_empty() && text.len() < MAX_MESSAGE_BYTES {
                                text.push('\n');
                            }
                            text.push_str(take_bytes(
                                part,
                                MAX_MESSAGE_BYTES.saturating_sub(text.len()),
                            ));
                            if text.len() >= MAX_MESSAGE_BYTES {
                                break;
                            }
                        }
                    }
                }
                Some(AgentMessage {
                    id: message.id.clone(),
                    text,
                })
            })
            .collect();
        Self {
            revision: view.revision,
            messages,
        }
    }
}

fn take_bytes(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Notice {
    Acknowledgement,
    Progress,
}
impl Notice {
    pub(super) fn instructions(self) -> &'static str {
        match self {
            Self::Acknowledgement => {
                "Briefly acknowledge the user's request in one short spoken sentence in their language, such as 'I'll check the latest price.' The agent call is pending. Describe your intent, without claiming it has completed or inventing a result. Then keep listening. If the user requested silence, remain silent."
            }
            Self::Progress => {
                "Give at most one short spoken sentence about the new [BACKEND] progress, in the user's language. Use only facts in those messages. The agent call is still pending: do not claim completion, invent progress, repeat an earlier update, or ask the user to wait. If there is no useful new progress or the user requested silence, remain silent."
            }
        }
    }
}

pub(super) struct Handoff {
    pub(super) call_id: String,
    response_id: String,
    snapshot: Option<Snapshot>,
    remaining_bytes: usize,
    acknowledgement: bool,
    progress: bool,
    last_notice: Instant,
}
impl Handoff {
    pub(super) fn new(
        call_id: String,
        response_id: String,
        snapshot: Option<Snapshot>,
        already_spoke: bool,
        now: Instant,
    ) -> Self {
        Self {
            call_id,
            response_id,
            snapshot,
            remaining_bytes: MAX_HANDOFF_BYTES,
            acknowledgement: !already_spoke,
            progress: false,
            last_notice: now,
        }
    }
    pub(super) fn revision(&self) -> Option<u64> {
        self.snapshot.as_ref().map(|snapshot| snapshot.revision)
    }

    pub(super) fn silence(&mut self) {
        self.acknowledgement = false;
        self.progress = false;
    }

    pub(super) fn observe(&mut self, next: Snapshot) -> Vec<String> {
        let mut updates = Vec::new();
        let mut budget = MAX_BATCH_BYTES.min(self.remaining_bytes);
        if let Some(previous) = &self.snapshot {
            // An absent anchor means history was reset/replaced. Rebaseline;
            // never replay a transcript window as new work after a reload.
            let anchor = previous.messages.last().and_then(|last| {
                next.messages
                    .iter()
                    .position(|message| message.id == last.id)
            });
            if let Some(anchor) = anchor {
                for (index, message) in next.messages.iter().enumerate() {
                    let previous = previous.messages.iter().find(|old| old.id == message.id);
                    let text = match previous {
                        Some(old) if old.text == message.text => continue,
                        Some(old) => message
                            .text
                            .strip_prefix(&old.text)
                            .unwrap_or(&message.text),
                        None if index > anchor => &message.text,
                        None => continue,
                    };
                    let text = take_bytes(text, budget).trim();
                    if !text.is_empty() {
                        updates.push(text.to_owned());
                        budget -= text.len();
                        self.remaining_bytes -= text.len();
                    }
                    if budget == 0 {
                        break;
                    }
                }
            } else if previous.messages.is_empty() {
                // A live empty transcript is a valid baseline for a new chat.
                for message in &next.messages {
                    let text = take_bytes(&message.text, budget).trim();
                    if !text.is_empty() {
                        updates.push(text.to_owned());
                        budget -= text.len();
                        self.remaining_bytes -= text.len();
                    }
                    if budget == 0 {
                        break;
                    }
                }
            }
        }
        self.snapshot = Some(next);
        self.progress |= !updates.is_empty();
        updates
    }
    pub(super) fn audio(&mut self, response_id: &str, now: Instant) {
        if self.response_id == response_id {
            self.acknowledgement = false;
            self.last_notice = now;
        }
    }
    pub(super) fn notice(&mut self, now: Instant) -> Option<Notice> {
        let notice = if self.acknowledgement {
            self.acknowledgement = false;
            Notice::Acknowledgement
        } else if self.progress && now.duration_since(self.last_notice) >= PROGRESS_INTERVAL {
            Notice::Progress
        } else {
            return None;
        };
        self.progress = false;
        self.last_notice = now;
        Some(notice)
    }
}

#[cfg(test)]
mod tests;
