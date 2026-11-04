//! Codex routes backend items through an active handoff ID. Herdr has no such
//! receipt: carry a native nonce through the submitted user message and require
//! provider turn membership before attributing completion or public output.
//! Reference: openai/codex ede589336e9ecc64cb05045c2961fb1277858f1d,
//! codex-rs/core/src/realtime_conversation.rs (RealtimeHandoffStreamState).
use std::collections::HashMap;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::agent_transcript::{
    AgentMessageRole, AgentTranscriptMessage, AgentTranscriptPart, AgentTranscriptTurn,
    AgentTranscriptView, AgentTurnOutcome, AgentTurnStatus,
};

const MAX_MESSAGES: usize = 128;
const MAX_ID_BYTES: usize = 512;
const MAX_OUTPUT_BYTES: usize = 8192;

fn fingerprint(message: &AgentTranscriptMessage) -> [u8; 32] {
    let mut hash = Sha256::new();
    for part in &message.parts {
        if let AgentTranscriptPart::Text { text, .. } = part {
            hash.update(text.len().to_le_bytes());
            hash.update(text.as_bytes());
        }
    }
    hash.finalize().into()
}

fn includes(turn: &AgentTranscriptTurn, id: &str) -> bool {
    turn.user_message_id.as_deref() == Some(id) || turn.message_ids.iter().any(|key| key == id)
}

#[derive(Clone)]
pub(super) struct Scope {
    turn_id: String,
    user_id: String,
    marker: String,
    fingerprint: [u8; 32],
    baseline: HashMap<String, [u8; 32]>,
}

impl Scope {
    pub(super) fn matches(&self, view: AgentTranscriptView<'_>) -> bool {
        view.provider_turns
            && view
                .turns
                .iter()
                .any(|turn| turn.id == self.turn_id && includes(turn, &self.user_id))
            && view.messages.iter().any(|message| {
                message.id == self.user_id
                    && marked(message, &self.marker)
                    && fingerprint(message) == self.fingerprint
            })
    }

    pub(super) fn permits(
        &self,
        turn: &AgentTranscriptTurn,
        message: &AgentTranscriptMessage,
    ) -> bool {
        message.role == AgentMessageRole::Assistant
            && (turn.assistant_message_ids.contains(&message.id)
                || turn.message_ids.contains(&message.id))
            && self
                .baseline
                .get(&message.id)
                .is_none_or(|old| *old != fingerprint(message))
    }

    pub(super) fn turn<'a>(
        &self,
        view: AgentTranscriptView<'a>,
    ) -> Option<&'a AgentTranscriptTurn> {
        self.matches(view)
            .then(|| view.turns.iter().find(|turn| turn.id == self.turn_id))
            .flatten()
    }
}

fn marked(message: &AgentTranscriptMessage, marker: &str) -> bool {
    message.role == AgentMessageRole::User
        && message
            .parts
            .iter()
            .find_map(|part| match part {
                AgentTranscriptPart::Text { text, .. } => Some(text),
                _ => None,
            })
            .is_some_and(|text| text.starts_with(marker))
}

pub(super) struct Tracker {
    marker: String,
    revision: Option<u64>,
    anchor: Option<String>,
    turn_anchor: Option<String>,
    active_turn: Option<String>,
    baseline: HashMap<String, [u8; 32]>,
    pub(super) scope: Option<Scope>,
    lost: bool,
}

pub(super) struct Observation {
    pub(super) accepted: bool,
    pub(super) provider: bool,
    pub(super) turn_id: Option<String>,
    pub(super) outcome: Option<AgentTurnOutcome>,
    pub(super) assistant_output: Option<String>,
    pub(super) lost: bool,
}

impl Observation {
    pub(super) fn result(&self, delivery: &str, status: impl serde::Serialize) -> Value {
        let completion = match self.outcome {
            Some(AgentTurnOutcome::Completed) => "completed",
            Some(AgentTurnOutcome::Interrupted) => "interrupted",
            Some(AgentTurnOutcome::Failed) => "failed",
            None => "unknown",
        };
        json!({"delivery":delivery,"completion":completion,"accepted":self.accepted,
            "correlation":if self.lost {"unavailable"} else if self.provider {"provider_turn"} else if self.accepted {"inferred"} else {"unavailable"},
            "turn_id":self.turn_id,"agent_status":status,"assistant_output":self.assistant_output,
            "guidance":"Only an explicit terminal outcome of the associated provider turn establishes turn completion. Unknown or inferred observations are not completion. Never replay the submitted request; inspect the agent chat if the answer is unavailable."})
    }
}

impl Tracker {
    pub(super) fn new(view: Option<AgentTranscriptView<'_>>, working: bool) -> Self {
        let marker = format!(
            "[Whip voice handoff {}; tracking metadata]\n",
            uuid::Uuid::new_v4()
        );
        let mut tracker = Self {
            marker,
            revision: view.map(|view| view.revision),
            anchor: None,
            turn_anchor: None,
            active_turn: None,
            baseline: HashMap::new(),
            scope: None,
            lost: view.is_none(),
        };
        if let Some(view) = view {
            tracker.anchor = view.messages.last().map(|message| message.id.clone());
            tracker.turn_anchor = view.turns.last().map(|turn| turn.id.clone());
            tracker.baseline = view
                .messages
                .iter()
                .rev()
                .take(MAX_MESSAGES)
                .filter(|message| message.id.len() <= MAX_ID_BYTES)
                .map(|message| (message.id.clone(), fingerprint(message)))
                .collect();
            if working {
                let mut turns = view
                    .turns
                    .iter()
                    .filter(|turn| turn.status == AgentTurnStatus::Working);
                tracker.active_turn = turns
                    .next()
                    .filter(|_| view.provider_turns)
                    .filter(|turn| turn.id.len() <= MAX_ID_BYTES)
                    .map(|turn| turn.id.clone());
                if turns.next().is_some() {
                    tracker.active_turn = None;
                }
                // A steering write cannot identify a new running turn after the fact.
                tracker.lost |= tracker.active_turn.is_none();
            }
        }
        tracker
    }

    pub(super) fn text(&self, request: &str) -> String {
        format!("{}{request}", self.marker)
    }

    pub(super) fn observe(&mut self, view: AgentTranscriptView<'_>) -> Observation {
        let mut result = Observation {
            accepted: false,
            provider: false,
            turn_id: None,
            outcome: None,
            assistant_output: None,
            lost: self.lost,
        };
        self.lost |= self
            .revision
            .is_some_and(|revision| view.revision < revision)
            || self
                .anchor
                .as_ref()
                .is_some_and(|id| !view.messages.iter().any(|message| &message.id == id));
        self.revision = Some(view.revision);
        if self.lost {
            result.lost = true;
            return result;
        }
        let mut messages = view
            .messages
            .iter()
            .rev()
            .take(MAX_MESSAGES)
            .filter(|message| marked(message, &self.marker));
        let Some(user) = messages.next() else {
            self.lost |= self.scope.is_some();
            result.lost = self.lost;
            return result;
        };
        let mut turns = view.turns.iter().filter(|turn| includes(turn, &user.id));
        let turn = turns.next();
        if messages.next().is_some() || turns.next().is_some() || user.id.len() > MAX_ID_BYTES {
            self.lost = true;
            result.lost = true;
            return result;
        }
        result.accepted = true;
        let Some(turn) = turn.filter(|turn| !turn.id.is_empty() && turn.id.len() <= MAX_ID_BYTES)
        else {
            return result;
        };
        result.turn_id = Some(turn.id.clone());
        if !view.provider_turns {
            self.lost |= self.scope.is_some();
            result.lost = self.lost;
            return result;
        }
        if self.active_turn.is_none()
            && let Some(anchor) = &self.turn_anchor
            && !view
                .turns
                .iter()
                .position(|old| &old.id == anchor)
                .zip(
                    view.turns
                        .iter()
                        .position(|candidate| candidate.id == turn.id),
                )
                .is_some_and(|(before, after)| after > before)
        {
            self.lost = true;
        }
        self.lost |= self.active_turn.as_ref().is_some_and(|id| id != &turn.id)
            || self
                .scope
                .as_ref()
                .is_some_and(|scope| !scope.matches(view));
        if self.lost {
            result.lost = true;
            result.turn_id = None;
            return result;
        }
        let scope = self.scope.get_or_insert_with(|| Scope {
            turn_id: turn.id.clone(),
            user_id: user.id.clone(),
            marker: self.marker.clone(),
            fingerprint: fingerprint(user),
            baseline: self.baseline.clone(),
        });
        result.provider = true;
        result.outcome = turn
            .details
            .as_ref()
            .and_then(|details| details.outcome)
            .filter(|outcome| {
                matches!(
                    (outcome, turn.status),
                    (AgentTurnOutcome::Completed, AgentTurnStatus::Idle)
                        | (AgentTurnOutcome::Interrupted, AgentTurnStatus::Interrupted)
                        | (AgentTurnOutcome::Failed, AgentTurnStatus::Error)
                )
            });
        let mut output = String::new();
        if let Some(message) = view
            .messages
            .iter()
            .rev()
            .take(MAX_MESSAGES)
            .find(|message| scope.permits(turn, message)
                && message.parts.iter().any(|part| matches!(part, AgentTranscriptPart::Text { text, .. } if !text.is_empty())))
        {
            for part in &message.parts {
                if let AgentTranscriptPart::Text { text, .. } = part {
                    if !output.is_empty() && output.len() < MAX_OUTPUT_BYTES {
                        output.push('\n');
                    }
                    let mut end = text
                        .len()
                        .min(MAX_OUTPUT_BYTES.saturating_sub(output.len()));
                    while !text.is_char_boundary(end) {
                        end -= 1;
                    }
                    output.push_str(&text[..end]);
                }
            }
        }
        result.assistant_output = (!output.is_empty()).then_some(output);
        result
    }
}
