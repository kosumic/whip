//! Bounded call transcripts and speech text, separate from accounting and audio.
use crate::app_database::{
    AppStorageEntry, VoiceUsageIdentity, VoiceUsageMode, read_app_data, write_app_data,
};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, sync::LazyLock, time::Duration};
mod resume;
pub(crate) use resume::{Continuation, Restored, restore};

pub(crate) const KEY: &str = "whip.voice.transcripts";
pub(crate) const LEGACY_LIVE_KEY: &str = "whip.voice.live.transcripts";
pub(crate) const LOCAL_MODEL: &str = "local";
const LEGACY_LIVE_MODEL: &str = "gpt-live-1";
const MAX_CALLS: usize = 20;
const MAX_SPEECH_REQUESTS: usize = 100;
const MAX_MESSAGES: usize = 64;
const MAX_TEXT: usize = 16 * 1024;
const MAX_BYTES: usize = 128 * 1024;
const SAVE_TIMEOUT: Duration = Duration::from_secs(2);
const SAVE_ERROR: &str = "Voice chats could not be saved.";
const USER: &str = "user";
const ASSISTANT: &str = "assistant";
const MAX_EVENT_DETAIL: usize = 4096;
// Serialize read/append/write across call teardown and replacements.
pub(crate) static WRITES: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Caption {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<Event>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Event {
    pub kind: String,
    pub name: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}
impl Event {
    pub fn bytes(&self) -> usize {
        self.name.len()
            + self.status.len()
            + self.input.as_ref().map_or(0, String::len)
            + self.output.as_ref().map_or(0, String::len)
    }
    pub fn bounded(mut self) -> Self {
        self.name.truncate(boundary(&self.name, 128));
        self.status.truncate(boundary(&self.status, 64));
        for text in [&mut self.input, &mut self.output].into_iter().flatten() {
            if text.len() > MAX_EVENT_DETAIL {
                text.truncate(boundary(text, MAX_EVENT_DETAIL));
                text.push('…');
            }
        }
        self
    }
    pub fn new(kind: &str, name: &str, status: &str) -> Self {
        Self {
            kind: kind.into(),
            name: name.into(),
            status: status.into(),
            input: None,
            output: None,
        }
    }
    pub fn result(&mut self, value: &serde_json::Value) {
        self.status = if value["error"] == "outcome_unknown" {
            "unknown"
        } else if value.get("error").is_some_and(|value| !value.is_null())
            || value["result"]["exit_code"]
                .as_i64()
                .is_some_and(|code| code != 0)
        {
            "failed"
        } else {
            match value["completion"].as_str() {
                Some("submitted") => "submitted",
                Some("running") => "running",
                Some("unknown") => "unknown",
                Some("queued" | "not_started") => "queued",
                Some("completed" | "succeeded" | "finished") => "completed",
                _ if self.kind == "delegation" => "unknown",
                _ => "completed",
            }
        }
        .into();
        let output = value.to_string();
        self.output = Some(output[..boundary(&output, MAX_EVENT_DETAIL)].into());
    }
}

#[derive(Default)]
pub(crate) struct Conversation {
    messages: VecDeque<Caption>,
}
impl Conversation {
    pub fn user(&mut self, text: &str) {
        self.append(USER, text);
    }
    pub fn assistant(&mut self, text: &str) {
        self.append(ASSISTANT, text);
    }
    fn append(&mut self, role: &str, text: &str) {
        if text.trim().is_empty() {
            return;
        }
        if role == ASSISTANT
            && let Some(last) = self.messages.back_mut()
            && last.role == ASSISTANT
            && last.event.is_none()
        {
            if last.text.len() < MAX_TEXT
                && !last.text.ends_with(char::is_whitespace)
                && !text.starts_with(char::is_whitespace)
            {
                last.text.push(' ');
            }
            let end = boundary(text, MAX_TEXT.saturating_sub(last.text.len()));
            last.text.push_str(&text[..end]);
        } else {
            self.messages.push_back(Caption {
                id: uuid::Uuid::new_v4().to_string(),
                role: role.into(),
                text: text[..boundary(text, MAX_TEXT)].into(),
                start_ms: None,
                end_ms: None,
                event: None,
            });
        }
        self.trim();
    }
    pub fn into_captions(self) -> Vec<Caption> {
        self.messages.into()
    }
    pub fn event(&mut self, id: &str, event: Event) {
        let mut event = event.bounded();
        let text = format!("{} · {}", event.name, event.status);
        if let Some(message) = self.messages.iter_mut().find(|message| message.id == id) {
            if event.status == "requested"
                && message
                    .event
                    .as_ref()
                    .is_some_and(|old| old.status != "requested")
            {
                return;
            }
            if let Some(old) = &message.event
                && event.input.is_none()
            {
                event.input.clone_from(&old.input);
            }
            message.text = text;
            message.event = Some(event);
        } else {
            self.messages.push_back(Caption {
                id: id.into(),
                role: ASSISTANT.into(),
                text,
                start_ms: None,
                end_ms: None,
                event: Some(event),
            });
        }
        self.trim();
    }
    pub fn events_json(&self) -> String {
        serde_json::to_string(
            &self
                .messages
                .iter()
                .filter(|message| message.event.is_some())
                .collect::<Vec<_>>(),
        )
        .unwrap_or_else(|_| "[]".into())
    }
    fn trim(&mut self) {
        while self.messages.len() > MAX_MESSAGES
            || self
                .messages
                .iter()
                .map(|message| message.text.len() + message.event.as_ref().map_or(0, Event::bytes))
                .sum::<usize>()
                > MAX_BYTES
        {
            self.messages.pop_front();
        }
    }
}
fn boundary(text: &str, limit: usize) -> usize {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedCall {
    id: String,
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    voice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage: Option<VoiceUsageIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    continuation: Option<Continuation>,
    fragments: Vec<Caption>,
    ended_at_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCall {
    id: String,
    fragments: Vec<Caption>,
    ended_at_ms: u64,
}

fn append(
    existing: Option<&str>,
    legacy: Option<&str>,
    call: SavedCall,
) -> Result<String, &'static str> {
    let mut calls = load_calls(existing, legacy)?;
    calls.retain(|previous| previous.id != call.id);
    calls.push_back(call);
    calls.make_contiguous().sort_by_key(|call| call.ended_at_ms);
    let mut speech = 0;
    let mut conversations = 0;
    // Speech requests must not evict saved conversations.
    let mut calls: Vec<_> = calls
        .into_iter()
        .rev()
        .filter(|call| {
            let (count, limit) = if call.usage.as_ref().is_some_and(|usage| {
                matches!(usage.mode, VoiceUsageMode::Tts | VoiceUsageMode::Stt)
            }) {
                (&mut speech, MAX_SPEECH_REQUESTS)
            } else {
                (&mut conversations, MAX_CALLS)
            };
            *count += 1;
            *count <= limit
        })
        .collect();
    calls.reverse();
    serde_json::to_string(&calls).map_err(|_| SAVE_ERROR)
}

fn load_calls(
    existing: Option<&str>,
    legacy: Option<&str>,
) -> Result<VecDeque<SavedCall>, &'static str> {
    Ok(if let Some(existing) = existing {
        serde_json::from_str(existing).map_err(|_| SAVE_ERROR)?
    } else {
        let old: Vec<LegacyCall> = legacy
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| SAVE_ERROR)?
            .unwrap_or_default();
        old.into_iter()
            .map(|call| SavedCall {
                id: call.id,
                model: LEGACY_LIVE_MODEL.into(),
                voice: None,
                usage: None,
                continuation: None,
                fragments: call.fragments,
                ended_at_ms: call.ended_at_ms,
            })
            .collect()
    })
}

pub(crate) fn remove(
    existing: Option<&str>,
    legacy: Option<&str>,
    id: &str,
) -> Result<String, &'static str> {
    let mut calls = load_calls(existing, legacy)?;
    calls.retain(|call| call.id != id);
    serde_json::to_string(&calls).map_err(|_| SAVE_ERROR)
}

pub(crate) async fn persist(
    identity: Option<&VoiceUsageIdentity>,
    model: &str,
    voice: Option<&str>,
    fragments: Vec<Caption>,
) -> Result<(), &'static str> {
    persist_call(identity, model, voice, fragments, None).await
}

pub(crate) async fn persist_call(
    identity: Option<&VoiceUsageIdentity>,
    model: &str,
    voice: Option<&str>,
    mut fragments: Vec<Caption>,
    mut continuation: Option<Continuation>,
) -> Result<(), &'static str> {
    if fragments.is_empty() {
        return Ok(());
    }
    if fragments
        .iter()
        .any(|fragment| !matches!(fragment.role.as_str(), USER | ASSISTANT))
    {
        return Err(SAVE_ERROR);
    }
    for fragment in &mut fragments {
        if fragment.text.len() >= MAX_TEXT
            && let Some(continuation) = &mut continuation
        {
            continuation.truncated = true;
        }
        fragment.text.truncate(boundary(&fragment.text, MAX_TEXT));
        fragment.event = fragment.event.take().map(Event::bounded);
    }
    let mut bytes = 0;
    let original_count = fragments.len();
    fragments.reverse();
    fragments.retain(|fragment| {
        bytes += fragment.text.len() + fragment.event.as_ref().map_or(0, Event::bytes);
        bytes <= MAX_BYTES
    });
    fragments.truncate(MAX_MESSAGES);
    fragments.reverse();
    if (fragments.len() < original_count || original_count >= MAX_MESSAGES)
        && let Some(continuation) = &mut continuation
    {
        continuation.truncated = true;
    }
    // Snapshot the end time before waiting for another call's database write.
    let ended_at_ms = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX);
    tokio::time::timeout(SAVE_TIMEOUT, async {
        let _write = WRITES.lock().await;
        if let Some(identity) = identity
            && crate::app_database::voice_activity_deleted(identity.session_id.clone())
                .await
                .map_err(|_| SAVE_ERROR)?
        {
            return Ok(());
        }
        let entries = read_app_data(vec![KEY.into(), LEGACY_LIVE_KEY.into()])
            .await
            .map_err(|_| SAVE_ERROR)?;
        let existing = entries
            .iter()
            .find(|entry| entry.key == KEY)
            .and_then(|entry| entry.value.as_deref());
        let legacy = entries
            .iter()
            .find(|entry| entry.key == LEGACY_LIVE_KEY)
            .and_then(|entry| entry.value.as_deref());
        let value = append(
            existing,
            legacy,
            SavedCall {
                id: identity.map_or_else(
                    || uuid::Uuid::new_v4().to_string(),
                    |call| call.session_id.clone(),
                ),
                model: model.into(),
                voice: voice.map(str::to_owned),
                usage: identity.cloned(),
                continuation,
                fragments,
                ended_at_ms,
            },
        )?;
        write_app_data(vec![AppStorageEntry {
            key: KEY.into(),
            value: Some(value),
        }])
        .await
        .map_err(|_| SAVE_ERROR)
    })
    .await
    .map_err(|_| SAVE_ERROR)?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(index: usize, model: &str) -> SavedCall {
        let mut conversation = Conversation::default();
        conversation.user(&format!("call {index}"));
        SavedCall {
            id: index.to_string(),
            model: model.into(),
            voice: None,
            usage: None,
            continuation: None,
            fragments: conversation.into_captions(),
            ended_at_ms: index as u64,
        }
    }
    #[test]
    fn cloud_models_share_the_last_twenty_chats() -> Result<(), Box<dyn std::error::Error>> {
        let mut saved = None;
        for index in 0..=MAX_CALLS {
            saved = Some(append(
                saved.as_deref(),
                None,
                call(
                    index,
                    if index % 2 == 0 {
                        "gpt-live-1"
                    } else {
                        "gpt-realtime-1.5"
                    },
                ),
            )?);
        }
        let calls: Vec<SavedCall> = serde_json::from_str(saved.as_deref().ok_or("no history")?)?;
        assert_eq!(calls.len(), MAX_CALLS);
        assert_eq!(calls[0].id, "1");
        assert_eq!(calls[MAX_CALLS - 1].model, "gpt-live-1");
        assert!(append(Some("invalid history"), None, call(21, LOCAL_MODEL)).is_err());
        Ok(())
    }
    #[test]
    fn legacy_live_chats_keep_text_and_timing_and_are_imported_only_once()
    -> Result<(), Box<dyn std::error::Error>> {
        let legacy = r#"[{"id":"old","endedAtMs":0,"fragments":[{"id":"caption","role":"user","text":"hello","startMs":0,"endMs":50}]}]"#;
        let saved = append(None, Some(legacy), call(1, "gpt-realtime-1.5"))?;
        let saved = append(Some(&saved), Some(legacy), call(2, "gpt-realtime-1.5"))?;
        let calls: Vec<SavedCall> = serde_json::from_str(&saved)?;
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].model, LEGACY_LIVE_MODEL);
        assert_eq!(calls[0].fragments[0].end_ms, Some(50.0));
        assert_eq!(calls[0].fragments[0].text, "hello");
        assert_eq!(
            serde_json::from_str::<Vec<SavedCall>>(&append(
                Some("[]"),
                Some(legacy),
                call(3, "gpt-live-1")
            )?)?
            .len(),
            1
        );
        Ok(())
    }
    #[test]
    fn local_calls_are_retained_alongside_cloud_transcripts()
    -> Result<(), Box<dyn std::error::Error>> {
        let saved = append(None, None, call(1, "gpt-live-1"))?;
        let saved = append(Some(&saved), None, call(2, LOCAL_MODEL))?;
        let calls: Vec<SavedCall> = serde_json::from_str(&saved)?;
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].model, "gpt-live-1");
        assert_eq!(calls[1].model, LOCAL_MODEL);
        Ok(())
    }

    #[test]
    fn deletion_preserves_unrelated_and_legacy_captions() -> Result<(), Box<dyn std::error::Error>>
    {
        let legacy = r#"[{"id":"old","endedAtMs":0,"fragments":[{"id":"caption","role":"user","text":"hello"}]}]"#;
        let removed = remove(None, Some(legacy), "old")?;
        assert_eq!(removed, "[]");
        assert_eq!(remove(Some(&removed), Some(legacy), "old")?, "[]");
        let saved = append(None, None, call(1, "gpt-live-1"))?;
        let saved = append(Some(&saved), None, call(2, LOCAL_MODEL))?;
        let removed = remove(Some(&saved), None, "1")?;
        let calls: Vec<SavedCall> = serde_json::from_str(&removed)?;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "2");
        Ok(())
    }

    #[test]
    fn speech_text_retention_does_not_evict_conversations() -> Result<(), Box<dyn std::error::Error>>
    {
        use crate::app_database::{VoiceUsageProvider, VoiceUsageScope};
        let mut saved = append(None, None, call(0, "gpt-live-1"))?;
        for index in 1..=MAX_SPEECH_REQUESTS + 1 {
            let mut speech = call(index, LOCAL_MODEL);
            speech.usage = Some(VoiceUsageIdentity {
                session_id: speech.id.clone(),
                provider: VoiceUsageProvider::Local,
                mode: VoiceUsageMode::Stt,
                model: None,
                voice: None,
                scope: VoiceUsageScope::Speech,
                started_at_ms: index as u64,
            });
            saved = append(Some(&saved), None, speech)?;
        }
        let calls: Vec<SavedCall> = serde_json::from_str(&saved)?;
        assert_eq!(calls.len(), MAX_SPEECH_REQUESTS + 1);
        assert_eq!(calls[0].id, "0");
        assert_eq!(calls[1].id, "2");
        Ok(())
    }

    #[test]
    fn local_captions_join_spoken_chunks_and_bound_unicode_text() {
        let mut chat = Conversation::default();
        chat.user("Hello");
        chat.assistant("Hi ");
        chat.assistant("there.");
        assert_eq!(chat.messages.len(), 2);
        assert_eq!(chat.messages[1].text, "Hi there.");
        for _ in 0..100 {
            chat.user(&"語".repeat(MAX_TEXT));
            chat.assistant("A reply");
        }
        assert!(chat.messages.len() <= MAX_MESSAGES);
        assert!(
            chat.messages
                .iter()
                .map(|message| message.text.len())
                .sum::<usize>()
                <= MAX_BYTES
        );
        assert!(
            chat.messages
                .iter()
                .all(|message| message.text.len() <= MAX_TEXT)
        );
    }
}
