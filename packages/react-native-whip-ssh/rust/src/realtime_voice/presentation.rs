//! Wake presentation readers after a writer changes the visible part of state.
//! Device counters and queue operations share these locks but have no revision.
use super::{Output, View};
use parking_lot::{Mutex, MutexGuard};
use serde::Serialize;
use std::{
    ops::{Deref, DerefMut},
    sync::Arc,
};
use tokio::sync::watch;
use voice_call_openai::continuity::{Diagnostics, Policy};

#[derive(Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Fields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resumed_context_truncated: Option<bool>,
    pub phase: &'static str,
    #[serde(skip)]
    pub turn_working: bool,
    pub muted: bool,
    pub level: f32,
    pub playback_level: f32,
    pub error: Option<&'static str>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated_usd: Option<f64>,
    pub cost_incomplete: bool,
    pub live_seconds: Option<f64>,
    pub usage_finalized: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TextFields {
    #[serde(skip)]
    revision: u64,
    text: String,
    user_text: String,
    backend_text: Option<String>,
}

impl TextFields {
    pub fn assistant(&self) -> &str {
        &self.text
    }

    pub fn clear_assistant(&mut self) {
        self.revision += u64::from(!self.text.is_empty());
        self.text.clear();
    }

    pub fn append(&mut self, delta: &str) {
        let length = self.text.len();
        super::bounded_text(&mut self.text, delta);
        self.revision += u64::from(length != self.text.len());
    }

    pub fn set_user(&mut self, text: String) {
        self.revision += u64::from(self.user_text != text);
        self.user_text = text;
    }

    pub fn set_backend(&mut self, text: Option<String>) {
        self.revision += u64::from(self.backend_text != text);
        self.backend_text = text;
    }
}

pub(super) trait Visible {
    type Key: PartialEq;
    fn key(&self) -> Self::Key;
}

impl Visible for View {
    type Key = (Fields, u64);
    fn key(&self) -> Self::Key {
        (self.fields, self.text.revision)
    }
}

impl Fields {
    pub(super) fn working(&self) -> bool {
        self.turn_working && !matches!(self.phase, "error" | "closed")
    }
}

impl Visible for Output {
    // Clearing output also fences replacement transcripts with a fresh epoch.
    type Key = (u64, u64);
    fn key(&self) -> Self::Key {
        (
            self.epoch,
            self.live_transcript
                .as_ref()
                .map_or(self.transcript.revision, |live| live.revision),
        )
    }
}

impl Visible for Policy {
    type Key = Diagnostics;
    fn key(&self) -> Self::Key {
        self.diagnostics.clone()
    }
}

pub(super) struct Observed<T> {
    state: Mutex<T>,
    changes: watch::Sender<u64>,
}

impl<T: Visible> Observed<T> {
    pub fn new(value: T, changes: &watch::Sender<u64>) -> Self {
        Self {
            state: Mutex::new(value),
            changes: changes.clone(),
        }
    }

    pub fn lock(&self) -> Guard<'_, T> {
        Guard {
            state: self.state.lock(),
            before: None,
            changes: &self.changes,
        }
    }
}

pub(super) struct Guard<'a, T: Visible> {
    state: MutexGuard<'a, T>,
    before: Option<T::Key>,
    changes: &'a watch::Sender<u64>,
}

impl<T: Visible> Deref for Guard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.state
    }
}
impl<T: Visible> DerefMut for Guard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        self.before.get_or_insert_with(|| self.state.key());
        &mut self.state
    }
}
impl<T: Visible> Drop for Guard<'_, T> {
    fn drop(&mut self) {
        if self
            .before
            .as_ref()
            .is_some_and(|before| *before != self.state.key())
        {
            self.changes.send_modify(|revision| *revision += 1);
        }
    }
}

use super::{RealtimeVoiceAdapter, live, transcript};
use serde_json::{
    Value,
    value::{RawValue, to_raw_value},
};

pub(super) enum Captions {
    Realtime(Vec<transcript::Message>),
    Live(live::captions::MessageSnapshot),
}
impl Output {
    pub(super) fn captions(&self) -> Captions {
        self.live_transcript.as_ref().map_or_else(
            || Captions::Realtime(self.transcript.snapshot()),
            |live| Captions::Live(live.message_snapshot()),
        )
    }
}
impl Captions {
    pub(super) fn messages(self, working: bool) -> Value {
        let mut value = match self {
            Self::Realtime(messages) => serde_json::json!(messages),
            Self::Live(snapshot) => snapshot.messages(),
        };
        if let Some(messages) = value.as_array_mut() {
            transcript::group_call_tools(messages, working);
        }
        value
    }
}

pub(super) struct Messages {
    key: (u64, u64),
    working: bool,
    pub raw: Box<RawValue>,
    pub text_utf16: usize,
    pub spoken_utf16: u64,
}

#[derive(Default)]
pub(super) struct Cache {
    captions: Option<Arc<Messages>>,
    view: Option<(u64, Arc<RawValue>)>,
}

impl Cache {
    pub fn messages(
        &mut self,
        call: &RealtimeVoiceAdapter,
        working: bool,
    ) -> serde_json::Result<Arc<Messages>> {
        let output = call.output.lock();
        let key = output.key();
        match self.captions {
            Some(ref cached) if cached.key == key && cached.working == working => {
                Ok(cached.clone())
            }
            _ => {
                let captions = output.captions();
                drop(output);
                let live = matches!(captions, Captions::Live(_));
                let value = captions.messages(working);
                let (text_utf16, spoken_utf16) = if live {
                    live::captions::latest_lengths(&value)
                } else {
                    (0, 0)
                };
                let messages = Arc::new(Messages {
                    key,
                    working,
                    raw: to_raw_value(&value)?,
                    text_utf16,
                    spoken_utf16,
                });
                self.captions = Some(messages.clone());
                Ok(messages)
            }
        }
    }
}

#[derive(Serialize)]
struct Presentation<'a> {
    #[serde(flatten)]
    fields: Fields,
    #[serde(flatten)]
    text: TextFields,
    messages: &'a RawValue,
    continuity: Diagnostics,
}

impl RealtimeVoiceAdapter {
    pub(crate) fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub(super) fn fields(&self) -> (Fields, TextFields) {
        let view = self.view.lock();
        let mut fields = view.fields;
        let text = view.text.clone();
        drop(view);
        if self.is_suspended() {
            fields.phase = "suspended";
            fields.level = 0.0;
            fields.playback_level = 0.0;
        }
        (fields, text)
    }

    pub(super) fn is_suspended(&self) -> bool {
        use std::sync::atomic::Ordering::Acquire;
        self.suspended.load(Acquire) && !self.closed.load(Acquire)
    }

    pub(crate) fn presentation(&self) -> serde_json::Result<(u64, Arc<RawValue>)> {
        let mut cache = self.presentation.lock();
        // Read before taking the snapshots. A concurrent write stays pending.
        let revision = *self.changes.borrow();
        if let Some((old, view)) = &cache.view
            && *old == revision
        {
            return Ok((revision, view.clone()));
        }
        let (fields, text) = self.fields();
        let working = fields.working();
        let messages = cache.messages(self, working)?;
        let continuity = self.continuity.lock().diagnostics.clone();
        let view: Arc<RawValue> = to_raw_value(&Presentation {
            fields,
            text,
            messages: &messages.raw,
            continuity,
        })?
        .into();
        cache.view = Some((revision, view.clone()));
        drop(cache);
        Ok((revision, view))
    }
}
