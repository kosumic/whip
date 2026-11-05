//! Live fragments have timeline intervals, not provider turns or playback marks.
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};

const MAX_FRAGMENTS: usize = 512;
const MAX_BYTES: usize = 64 * 1024;
const MAX_REQUEST: usize = 8 * 1024;
const HISTORY_KEY: &str = "whip.voice.live.transcripts";
const MAX_SAVED_CALLS: usize = 20;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Fragment {
    pub id: String,
    pub role: String,
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
}

#[derive(Default)]
pub(in crate::realtime_voice) struct Transcript {
    fragments: Vec<Fragment>,
    bytes: usize,
    admitted: HashSet<String>,
    discarded_through: f64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedCall {
    id: String,
    fragments: Vec<Fragment>,
    ended_at_ms: u64,
}

impl Transcript {
    pub(super) fn append(&mut self, fragment: Fragment) -> Result<(), &'static str> {
        if !fragment.start_ms.is_finite()
            || !fragment.end_ms.is_finite()
            || fragment.start_ms < 0.0
            || fragment.end_ms < fragment.start_ms
            || fragment.text.len() > super::super::MAX_TEXT
        {
            return Err("GPT-Live returned invalid caption timing or text.");
        }
        if self.fragments.iter().any(|old| old.id == fragment.id) {
            return Ok(());
        }
        self.bytes += fragment.text.len();
        self.fragments.push(fragment);
        self.fragments
            .sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
        while self.bytes > MAX_BYTES || self.fragments.len() > MAX_FRAGMENTS {
            let removed = self.fragments.remove(0);
            self.bytes -= removed.text.len();
            self.admitted.remove(&removed.id);
            self.discarded_through = self.discarded_through.max(removed.end_ms);
        }
        Ok(())
    }

    pub(super) fn request(&self, after: f64, offset: f64) -> Result<String, &'static str> {
        if !offset.is_finite() || offset < after || after < self.discarded_through {
            return Err("Voice context is incomplete. Please use the agent chat.");
        }
        let selected: Vec<_> = self
            .fragments
            .iter()
            .filter(|fragment| {
                fragment.role == "user"
                    && fragment.start_ms >= after
                    && !self.admitted.contains(&fragment.id)
                    && fragment.start_ms <= offset
            })
            .collect();
        if selected.is_empty()
            || selected
                .iter()
                .all(|fragment| fragment.text.trim().is_empty())
        {
            return Err("The spoken request is not available yet. Please use the agent chat.");
        }
        let mut prompt = String::from(
            "New spoken request from this agent-bound voice call (transcription can contain mistakes):\n",
        );
        for fragment in selected {
            prompt.push_str(&fragment.text);
        }
        prompt.push_str("\n\nUse the existing agent conversation/workspace. Keep approvals in Whip. The call may end while you work. Return a concise public answer; do not include private reasoning or secrets.");
        if prompt.len() > MAX_REQUEST {
            return Err("The spoken request is too long. Please use the agent chat.");
        }
        Ok(prompt)
    }

    pub(super) fn admit(&mut self, offset: f64) {
        for fragment in &self.fragments {
            if fragment.role == "user" && fragment.start_ms <= offset {
                self.admitted.insert(fragment.id.clone());
            }
        }
    }

    pub(in crate::realtime_voice) fn messages(&self) -> serde_json::Value {
        // Each speaker grows independently; original fragments retain timing.
        let mut bubbles: Vec<Fragment> = Vec::new();
        for fragment in &self.fragments {
            let previous = bubbles
                .iter()
                .rposition(|bubble| bubble.role == fragment.role);
            if let Some(index) = previous
                && fragment.start_ms <= bubbles[index].end_ms + 1200.0
                && bubbles[index].text.len() + fragment.text.len() <= super::super::MAX_TEXT
            {
                bubbles[index].text.push_str(&fragment.text);
                bubbles[index].end_ms = bubbles[index].end_ms.max(fragment.end_ms);
            } else {
                bubbles.push(fragment.clone());
            }
        }
        serde_json::Value::Array(
            bubbles
                .iter()
                .map(|fragment| {
                    serde_json::json!({
                        "id":fragment.id,"role":fragment.role,"text":fragment.text,
                        "startMs":fragment.start_ms,"endMs":fragment.end_ms,
                        "spokenUtf16":0,"active":false,
                    })
                })
                .collect(),
        )
    }

    pub(super) fn snapshot(&self) -> Vec<Fragment> {
        self.fragments.clone()
    }
}

pub(super) async fn persist(id: String, fragments: Vec<Fragment>) -> Result<(), &'static str> {
    use crate::app_database::{AppStorageEntry, read_app_data, write_app_data};
    if fragments.is_empty() {
        return Ok(());
    }
    let entries = read_app_data(vec![HISTORY_KEY.into()])
        .await
        .map_err(|_| "Voice captions could not be saved.")?;
    let mut calls: VecDeque<SavedCall> = entries
        .into_iter()
        .next()
        .and_then(|entry| entry.value)
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(|_| "Saved voice captions are unavailable.")?
        .unwrap_or_default();
    calls.retain(|call| call.id != id);
    let ended_at_ms = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX);
    calls.push_back(SavedCall {
        id,
        fragments,
        ended_at_ms,
    });
    while calls.len() > MAX_SAVED_CALLS {
        calls.pop_front();
    }
    let value = serde_json::to_string(&calls).map_err(|_| "Voice captions could not be saved.")?;
    write_app_data(vec![AppStorageEntry {
        key: HISTORY_KEY.into(),
        value: Some(value),
    }])
    .await
    .map_err(|_| "Voice captions could not be saved.")
}
