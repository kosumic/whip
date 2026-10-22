//! Per-viewport, text-free presentation over canonical transcript deltas.
//! No provider records or transcript contents are retained here.

#[cfg(test)]
mod benchmark;
mod owner;
#[cfg(test)]
mod tests;

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use crate::agent_transcript::{
    AgentMessageRole, AgentToolStatus, AgentTranscriptDelta, AgentTranscriptMessage,
    AgentTranscriptPart, AgentTranscriptState, AgentTranscriptTurn, AgentTranscriptUpdate,
    AgentTranscriptView, AgentTurnStatus,
};
pub use owner::AgentChatRows;

const JOURNAL_LIMIT: usize = 128;

fn row_index(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

pub(crate) fn row_id(parts: &[&str]) -> String {
    // JSON string arrays are unambiguous even for quotes, Unicode and delimiters.
    serde_json::to_string(parts).unwrap_or_default()
}

pub(crate) fn part_row_id(turn: &str, message: &str, part: &str, occurrence: usize) -> String {
    if occurrence == 0 {
        row_id(&[turn, "part", message, part])
    } else {
        row_id(&[turn, "part", message, part, &occurrence.to_string()])
    }
}

pub(crate) fn renderable(part: &AgentTranscriptPart) -> bool {
    match part {
        AgentTranscriptPart::Text { text, .. } | AgentTranscriptPart::Reasoning { text, .. } => {
            // Preserve ECMAScript trim semantics: BOM is whitespace, while
            // Unicode NEL is not. Rust's Unicode White_Space differs on both.
            text.chars().any(|character| {
                !matches!(character,
                '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
                '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
                '\u{205f}' | '\u{3000}' | '\u{feff}')
            })
        }
        AgentTranscriptPart::Tool {
            id, tool, state, ..
        } => {
            !(id.starts_with("raw-tool:") && matches!(tool.as_str(), "exec" | "wait"))
                && (tool != "todowrite" || state.status == AgentToolStatus::Error)
        }
        AgentTranscriptPart::Plan { .. } | AgentTranscriptPart::Notice { .. } => true,
        AgentTranscriptPart::Image { .. } => false,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum AgentChatRowSpacing {
    None,
    Turn,
    Part,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum AgentChatPartKind {
    Text,
    Reasoning,
    Tool,
    Plan,
    Notice,
}

impl AgentChatPartKind {
    fn of(part: &AgentTranscriptPart) -> Option<Self> {
        match part {
            AgentTranscriptPart::Text { .. } => Some(Self::Text),
            AgentTranscriptPart::Reasoning { .. } => Some(Self::Reasoning),
            AgentTranscriptPart::Tool { .. } => Some(Self::Tool),
            AgentTranscriptPart::Plan { .. } => Some(Self::Plan),
            AgentTranscriptPart::Notice { .. } => Some(Self::Notice),
            AgentTranscriptPart::Image { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum AgentChatRowContent {
    User {
        message_id: String,
    },
    Part {
        message_id: String,
        part_id: String,
        part_index: u32,
        kind: AgentChatPartKind,
        first: bool,
        streaming: bool,
    },
    Error {
        message_id: String,
    },
    Changes,
    Diff {
        index: u32,
    },
    Meta,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct AgentChatRow {
    pub id: String,
    pub turn_id: String,
    pub spacing: AgentChatRowSpacing,
    pub content: AgentChatRowContent,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum AgentChatRowPatch {
    Reset {
        rows: Vec<AgentChatRow>,
    },
    /// A zero delete count inserts; empty rows remove; both replace.
    Splice {
        index: u32,
        delete_count: u32,
        rows: Vec<AgentChatRow>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct AgentChatRowUpdate {
    pub base_revision: u64,
    pub revision: u64,
    pub transcript_revision: u64,
    pub patches: Vec<AgentChatRowPatch>,
}

#[derive(Debug)]
struct PartRef {
    id: String,
    index: u32,
    kind: AgentChatPartKind,
}

#[derive(Debug)]
struct MessageRef {
    role: AgentMessageRole,
    completed: bool,
    error: bool,
    parts: Vec<PartRef>,
}

impl From<&AgentTranscriptMessage> for MessageRef {
    fn from(message: &AgentTranscriptMessage) -> Self {
        // User rows reference the entire message, independently of normalized
        // image/text parts. Only assistant rows need individual part metadata.
        let parts = if message.role == AgentMessageRole::User {
            Vec::new()
        } else {
            message
                .parts
                .iter()
                .enumerate()
                .filter_map(|(index, part)| {
                    if !renderable(part) {
                        return None;
                    }
                    let kind = AgentChatPartKind::of(part)?;
                    Some(PartRef {
                        id: part.id().to_owned(),
                        index: row_index(index),
                        kind,
                    })
                })
                .collect()
        };
        Self {
            role: message.role,
            completed: message.completed_at_ms.is_some(),
            error: message
                .error
                .as_ref()
                .is_some_and(|error| !error.is_empty()),
            parts,
        }
    }
}

impl MessageRef {
    fn matches(&self, message: &AgentTranscriptMessage) -> bool {
        if self.role != message.role
            || self.completed != message.completed_at_ms.is_some()
            || self.error
                != message
                    .error
                    .as_ref()
                    .is_some_and(|error| !error.is_empty())
        {
            return false;
        }
        if message.role == AgentMessageRole::User {
            return true;
        }
        let mut parts = self.parts.iter();
        for (index, part) in message
            .parts
            .iter()
            .enumerate()
            .filter(|(_, part)| renderable(part))
        {
            let Some(previous) = parts.next() else {
                return false;
            };
            if previous.id != part.id() || previous.index as usize != index {
                return false;
            }
            if Some(previous.kind) != AgentChatPartKind::of(part) {
                return false;
            }
        }
        parts.next().is_none()
    }
}

#[derive(Debug)]
struct TurnRef {
    id: String,
    messages: Vec<String>,
    assistants: Vec<String>,
    working: bool,
    files: Vec<String>,
    start: usize,
    rows: Vec<AgentChatRow>,
}

impl From<&AgentTranscriptTurn> for TurnRef {
    fn from(turn: &AgentTranscriptTurn) -> Self {
        Self {
            id: turn.id.clone(),
            messages: if turn.message_ids.is_empty() {
                turn.user_message_id
                    .iter()
                    .chain(&turn.assistant_message_ids)
                    .cloned()
                    .collect()
            } else {
                turn.message_ids.clone()
            },
            assistants: turn.assistant_message_ids.clone(),
            working: turn.status == AgentTurnStatus::Working,
            files: turn.diffs.iter().map(|file| file.file.clone()).collect(),
            start: 0,
            rows: Vec::new(),
        }
    }
}

impl TurnRef {
    fn matches(&self, turn: &AgentTranscriptTurn) -> bool {
        let messages_match = if turn.message_ids.is_empty() {
            self.messages.iter().eq(turn
                .user_message_id
                .iter()
                .chain(&turn.assistant_message_ids))
        } else {
            self.messages == turn.message_ids
        };
        self.id == turn.id
            && messages_match
            && self.assistants == turn.assistant_message_ids
            && self.working == (turn.status == AgentTurnStatus::Working)
            && self
                .files
                .iter()
                .map(String::as_str)
                .eq(turn.diffs.iter().map(|file| file.file.as_str()))
    }
}

#[derive(Debug, Default)]
pub(crate) struct RowProjection {
    transcript_revision: u64,
    revision: u64,
    initialized: bool,
    pub(crate) needs_reset: bool,
    pub(crate) disposed: bool,
    working: bool,
    expanded: HashSet<String>,
    messages: HashMap<String, MessageRef>,
    message_order: Vec<String>,
    message_turns: HashMap<String, usize>,
    changes_turns: HashMap<String, usize>,
    turns: Vec<TurnRef>,
    journal: VecDeque<AgentChatRowUpdate>,
    #[cfg(test)]
    projected_turns: usize,
}

impl RowProjection {
    pub(crate) fn restore(&mut self, state: &AgentTranscriptState) {
        self.restore_view(state.into());
    }

    pub(crate) fn restore_view(&mut self, view: AgentTranscriptView<'_>) {
        self.messages = view
            .messages
            .iter()
            .map(|message| (message.id.clone(), message.into()))
            .collect();
        self.message_order = view
            .messages
            .iter()
            .map(|message| message.id.clone())
            .collect();
        self.turns = view.turns.iter().map(TurnRef::from).collect();
        self.message_turns.clear();
        self.changes_turns.clear();
        for index in 0..self.turns.len() {
            self.index_turn(index);
        }
        let mut start = 0;
        for index in 0..self.turns.len() {
            let rows = self.project(index);
            self.turns[index].start = start;
            start += rows.len();
            self.turns[index].rows = rows;
        }
        self.transcript_revision = view.revision;
        self.initialized = true;
        self.needs_reset = false;
        self.journal.clear();
        self.record(vec![AgentChatRowPatch::Reset {
            rows: self.snapshot(),
        }]);
    }

    fn snapshot(&self) -> Vec<AgentChatRow> {
        self.turns
            .iter()
            .flat_map(|turn| turn.rows.iter().cloned())
            .collect()
    }

    // Legacy Codex sends authoritative resets even when only its tail changed.
    // Reconcile their references so that those snapshots never force routine
    // full row delivery. Ordinary deltas do not run this compatibility scan.
    fn reconcile_reset(&mut self, state: &AgentTranscriptState, revision: u64) {
        let compatible = self
            .message_order
            .iter()
            .zip(&state.messages)
            .all(|(id, message)| id == &message.id)
            && self
                .turns
                .iter()
                .zip(&state.turns)
                .all(|(before, after)| before.id == after.id);
        if !compatible {
            self.restore(state);
            self.transcript_revision = revision;
            return;
        }
        let old_last = self.turns.len().checked_sub(1);
        let mut dirty = BTreeSet::new();
        for message in &state.messages {
            if !self
                .messages
                .get(&message.id)
                .is_some_and(|previous| previous.matches(message))
            {
                self.messages.insert(message.id.clone(), message.into());
                if let Some(index) = self.message_turns.get(&message.id) {
                    dirty.insert(*index);
                }
            }
        }
        for id in self
            .message_order
            .drain(state.messages.len().min(self.message_order.len())..)
        {
            self.messages.remove(&id);
            if let Some(index) = self.message_turns.get(&id) {
                dirty.insert(*index);
            }
        }
        self.message_order.extend(
            state.messages[self.message_order.len()..]
                .iter()
                .map(|message| message.id.clone()),
        );
        let mut patches = Vec::new();
        if let Some(first) = self.turns.get(state.turns.len()) {
            let end = self
                .turns
                .last()
                .map_or(0, |last| last.start + last.rows.len());
            patches.push(AgentChatRowPatch::Splice {
                index: row_index(first.start),
                delete_count: row_index(end - first.start),
                rows: Vec::new(),
            });
        }
        for turn in self.turns.drain(state.turns.len().min(self.turns.len())..) {
            self.changes_turns.remove(&row_id(&[&turn.id, "changes"]));
            for id in turn.messages.iter().chain(&turn.assistants) {
                self.message_turns.remove(id);
            }
        }
        for (index, turn) in state.turns.iter().enumerate() {
            if self
                .turns
                .get(index)
                .is_some_and(|previous| previous.matches(turn))
            {
                continue;
            }
            let mut next = TurnRef::from(turn);
            if index == self.turns.len() {
                next.start = self
                    .turns
                    .last()
                    .map_or(0, |last| last.start + last.rows.len());
                self.turns.push(next);
            } else {
                let previous = &mut self.turns[index];
                for id in previous.messages.iter().chain(&previous.assistants) {
                    self.message_turns.remove(id);
                }
                next.start = previous.start;
                next.rows = std::mem::take(&mut previous.rows);
                *previous = next;
            }
            self.index_turn(index);
            dirty.insert(index);
        }
        if old_last != self.turns.len().checked_sub(1) {
            dirty.extend(old_last);
            dirty.extend(self.turns.len().checked_sub(1));
        }
        self.refresh(dirty, &mut patches);
        self.transcript_revision = revision;
        self.record(patches);
    }

    fn index_turn(&mut self, index: usize) {
        let turn = &self.turns[index];
        for id in turn.messages.iter().chain(&turn.assistants) {
            self.message_turns.insert(id.clone(), index);
        }
        self.changes_turns
            .insert(row_id(&[&turn.id, "changes"]), index);
    }

    fn project(&mut self, index: usize) -> Vec<AgentChatRow> {
        #[cfg(test)]
        {
            self.projected_turns += 1;
        }
        let turn = &self.turns[index];
        let mut rows = Vec::new();
        let mut push = |id, content| {
            let spacing = if rows.is_empty() {
                if index == 0 {
                    AgentChatRowSpacing::None
                } else {
                    AgentChatRowSpacing::Turn
                }
            } else if matches!(
                content,
                AgentChatRowContent::Meta | AgentChatRowContent::Changes
            ) {
                AgentChatRowSpacing::None
            } else {
                AgentChatRowSpacing::Part
            };
            rows.push(AgentChatRow {
                id,
                turn_id: turn.id.clone(),
                spacing,
                content,
            });
        };
        for id in &turn.messages {
            let Some(message) = self.messages.get(id) else {
                continue;
            };
            if message.role == AgentMessageRole::User {
                push(
                    row_id(&[&turn.id, "user", id]),
                    AgentChatRowContent::User {
                        message_id: id.clone(),
                    },
                );
            } else {
                let mut occurrences = HashMap::<&str, usize>::new();
                for (part_index, part) in message.parts.iter().enumerate() {
                    let occurrence = occurrences.entry(&part.id).or_default();
                    push(
                        part_row_id(&turn.id, id, &part.id, *occurrence),
                        AgentChatRowContent::Part {
                            message_id: id.clone(),
                            part_id: part.id.clone(),
                            part_index: part.index,
                            kind: part.kind,
                            first: part_index == 0,
                            streaming: false,
                        },
                    );
                    *occurrence += 1;
                }
            }
        }
        for id in &turn.assistants {
            if self.messages.get(id).is_some_and(|message| message.error) {
                push(
                    row_id(&[&turn.id, "error", id]),
                    AgentChatRowContent::Error {
                        message_id: id.clone(),
                    },
                );
            }
        }
        if !turn.files.is_empty() {
            let id = row_id(&[&turn.id, "changes"]);
            let expanded = self.expanded.contains(&id);
            push(id, AgentChatRowContent::Changes);
            if expanded {
                for (index, file) in turn.files.iter().enumerate() {
                    push(
                        row_id(&[&turn.id, "diff", file, &index.to_string()]),
                        AgentChatRowContent::Diff {
                            index: row_index(index),
                        },
                    );
                }
            }
        }
        push(row_id(&[&turn.id, "meta"]), AgentChatRowContent::Meta);
        if index + 1 == self.turns.len()
            && (self.working || turn.working)
            && !turn
                .messages
                .iter()
                .rev()
                .find_map(|id| self.messages.get(id))
                .is_some_and(|message| message.role == AgentMessageRole::User)
            && let Some(row) = rows
                .iter_mut()
                .rev()
                .find(|row| matches!(row.content, AgentChatRowContent::Part { .. }))
            && let AgentChatRowContent::Part {
                message_id,
                kind,
                streaming,
                ..
            } = &mut row.content
            && matches!(kind, AgentChatPartKind::Text | AgentChatPartKind::Reasoning)
            && self
                .messages
                .get(message_id)
                .is_some_and(|message| !message.completed)
        {
            *streaming = true;
        }
        rows
    }

    pub(crate) fn accept(&mut self, update: &AgentTranscriptUpdate) {
        if self.disposed
            || !self.initialized
            || self.needs_reset
            || update.revision <= self.transcript_revision
        {
            return;
        }
        if let Some(state) = update.deltas.iter().find_map(|delta| match delta {
            AgentTranscriptDelta::Reset { state } => Some(state),
            _ => None,
        }) {
            self.reconcile_reset(state, update.revision);
            if let Some(last) = self.journal.back_mut() {
                last.transcript_revision = update.revision;
            }
            return;
        }
        if update.revision != self.transcript_revision + 1 {
            self.needs_reset = true;
            return;
        }
        let old_last = self.turns.len().checked_sub(1);
        let mut dirty = BTreeSet::new();
        let mut patches = Vec::new();
        for delta in &update.deltas {
            match delta {
                AgentTranscriptDelta::MessageUpserted { index, message } => {
                    let index = *index as usize;
                    if index > self.message_order.len()
                        || self
                            .message_order
                            .get(index)
                            .is_some_and(|id| id != &message.id)
                    {
                        self.needs_reset = true;
                        return;
                    }
                    if index == self.message_order.len() {
                        self.message_order.push(message.id.clone());
                    }
                    if !self
                        .messages
                        .get(&message.id)
                        .is_some_and(|previous| previous.matches(message))
                    {
                        self.messages.insert(message.id.clone(), message.into());
                        if let Some(index) = self.message_turns.get(&message.id) {
                            dirty.insert(*index);
                        }
                    }
                }
                AgentTranscriptDelta::MessageRemoved { index, message_id } => {
                    if self.message_order.get(*index as usize) != Some(message_id) {
                        self.needs_reset = true;
                        return;
                    }
                    self.message_order.remove(*index as usize);
                    self.messages.remove(message_id);
                    if let Some(index) = self.message_turns.remove(message_id) {
                        dirty.insert(index);
                    }
                }
                AgentTranscriptDelta::MessagesTruncated { length } => {
                    if *length as usize > self.message_order.len() {
                        self.needs_reset = true;
                        return;
                    }
                    for id in self.message_order.drain(*length as usize..) {
                        self.messages.remove(&id);
                        if let Some(index) = self.message_turns.get(&id) {
                            dirty.insert(*index);
                        }
                    }
                }
                AgentTranscriptDelta::TurnUpserted { index, turn } => {
                    let index = *index as usize;
                    if index > self.turns.len() {
                        self.needs_reset = true;
                        return;
                    }
                    if self
                        .turns
                        .get(index)
                        .is_some_and(|previous| previous.matches(turn))
                    {
                        continue;
                    }
                    let mut next = TurnRef::from(turn);
                    if index == self.turns.len() {
                        next.start = self
                            .turns
                            .last()
                            .map_or(0, |last| last.start + last.rows.len());
                        self.turns.push(next);
                    } else {
                        let old = &mut self.turns[index];
                        for id in old.messages.iter().chain(&old.assistants) {
                            self.message_turns.remove(id);
                        }
                        self.changes_turns.remove(&row_id(&[&old.id, "changes"]));
                        next.start = old.start;
                        next.rows = std::mem::take(&mut old.rows);
                        *old = next;
                    }
                    self.index_turn(index);
                    dirty.insert(index);
                }
                AgentTranscriptDelta::TurnsTruncated { length } => {
                    let length = *length as usize;
                    if length > self.turns.len() {
                        self.needs_reset = true;
                        return;
                    }
                    if let Some(first) = self.turns.get(length) {
                        let end = self
                            .turns
                            .last()
                            .map_or(0, |last| last.start + last.rows.len());
                        patches.push(AgentChatRowPatch::Splice {
                            index: row_index(first.start),
                            delete_count: row_index(end - first.start),
                            rows: Vec::new(),
                        });
                    }
                    for turn in self.turns.drain(length..) {
                        self.changes_turns.remove(&row_id(&[&turn.id, "changes"]));
                        for id in turn.messages.iter().chain(&turn.assistants) {
                            self.message_turns.remove(id);
                        }
                    }
                }
                _ => {}
            }
        }
        if old_last != self.turns.len().checked_sub(1) {
            dirty.extend(old_last);
            dirty.extend(self.turns.len().checked_sub(1));
        }
        self.refresh(dirty, &mut patches);
        self.transcript_revision = update.revision;
        self.record(patches);
    }

    fn refresh(&mut self, dirty: BTreeSet<usize>, patches: &mut Vec<AgentChatRowPatch>) {
        for index in dirty {
            if index >= self.turns.len() {
                continue;
            }
            let rows = self.project(index);
            let turn = &mut self.turns[index];
            let before = &turn.rows;
            let prefix = before.iter().zip(&rows).take_while(|(a, b)| a == b).count();
            let suffix = before[prefix..]
                .iter()
                .rev()
                .zip(rows[prefix..].iter().rev())
                .take_while(|(a, b)| a == b)
                .count();
            let old_length = before.len();
            let new_length = rows.len();
            if old_length - prefix - suffix != 0 || new_length - prefix - suffix != 0 {
                patches.push(AgentChatRowPatch::Splice {
                    index: row_index(turn.start + prefix),
                    delete_count: row_index(old_length - prefix - suffix),
                    rows: rows[prefix..new_length - suffix].to_vec(),
                });
                turn.rows = rows;
                for next in &mut self.turns[index + 1..] {
                    next.start = next.start + new_length - old_length;
                }
            }
        }
    }

    fn record(&mut self, patches: Vec<AgentChatRowPatch>) {
        // Text/status-only revisions need no journal entry or row revision.
        // A long stream cannot overflow the journal with empty row changes.
        if patches.is_empty() {
            return;
        }
        let base_revision = self.revision;
        self.revision += 1;
        self.journal.push_back(AgentChatRowUpdate {
            base_revision,
            revision: self.revision,
            transcript_revision: self.transcript_revision,
            patches,
        });
        while self.journal.len() > JOURNAL_LIMIT {
            self.journal.pop_front();
        }
    }

    pub(crate) fn poll(
        &mut self,
        after: u64,
        working: bool,
        expanded: Vec<String>,
    ) -> AgentChatRowUpdate {
        // Acknowledged entries have a single consumer and need no second copy.
        while self
            .journal
            .front()
            .is_some_and(|entry| entry.revision <= after)
        {
            self.journal.pop_front();
        }
        let expanded: HashSet<_> = expanded.into_iter().collect();
        let mut dirty: BTreeSet<_> = self
            .expanded
            .symmetric_difference(&expanded)
            .filter_map(|id| self.changes_turns.get(id).copied())
            .collect();
        if self.working != working {
            dirty.extend(self.turns.len().checked_sub(1));
        }
        self.working = working;
        self.expanded = expanded;
        let mut patches = Vec::new();
        self.refresh(dirty, &mut patches);
        if !patches.is_empty() {
            self.record(patches);
        }
        if after == self.revision {
            return AgentChatRowUpdate {
                base_revision: after,
                revision: after,
                transcript_revision: self.transcript_revision,
                patches: Vec::new(),
            };
        }
        if after > self.revision
            || self
                .journal
                .front()
                .is_none_or(|entry| after < entry.base_revision)
        {
            let rows = self.snapshot();
            self.journal.clear();
            return AgentChatRowUpdate {
                base_revision: after,
                revision: self.revision,
                transcript_revision: self.transcript_revision,
                patches: vec![AgentChatRowPatch::Reset { rows }],
            };
        }
        let update = AgentChatRowUpdate {
            base_revision: after,
            revision: self.revision,
            transcript_revision: self.transcript_revision,
            patches: self
                .journal
                .iter()
                .filter(|entry| entry.revision > after)
                .flat_map(|entry| entry.patches.iter().cloned())
                .collect(),
        };
        // This owner has one poll consumer. Delivered entries can be freed:
        // a failed delivery/retry gets an authoritative reset rather than
        // retaining a second full initial/expanded row array indefinitely.
        self.journal.clear();
        update
    }
}
