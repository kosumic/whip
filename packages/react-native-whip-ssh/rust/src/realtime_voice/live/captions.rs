//! Live fragments have timeline intervals, not provider turns or playback marks.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
mod source_clock;
#[cfg(test)]
mod tests;

const MAX_FRAGMENTS: usize = 512;
const MAX_BYTES: usize = 64 * 1024;
const MAX_REQUEST: usize = 8 * 1024;
const USER: &str = "user";
const ASSISTANT: &str = "assistant";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Fragment {
    pub id: String,
    pub role: String,
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<crate::voice_history::Event>,
}

impl From<Fragment> for crate::voice_history::Caption {
    fn from(fragment: Fragment) -> Self {
        Self {
            id: fragment.id,
            role: fragment.role,
            text: fragment.text,
            start_ms: Some(fragment.start_ms),
            end_ms: Some(fragment.end_ms),
            event: fragment.event,
        }
    }
}

#[derive(Default)]
pub(in crate::realtime_voice) struct Transcript {
    fragments: Vec<Fragment>,
    bytes: usize,
    admitted: HashSet<String>,
    discarded_through: f64,
    playback_samples: usize,
    received_samples: usize,
    playback_origin: Option<usize>,
    caption_origin: Option<f64>,
    source_clock: Option<source_clock::SourceClock>,
    source_origin: Option<usize>,
    heard: Vec<(f64, f64)>,
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
        if fragment.role == ASSISTANT && fragment.event.is_none() && self.caption_origin.is_none() {
            self.caption_origin = Some(fragment.start_ms);
            self.heard.push((fragment.start_ms, fragment.start_ms));
            if self.heard.len() > MAX_FRAGMENTS {
                self.heard.remove(0);
            }
            self.advance();
        }
        self.bytes += fragment.text.len()
            + fragment
                .event
                .as_ref()
                .map_or(0, crate::voice_history::Event::bytes);
        self.fragments.push(fragment);
        self.fragments
            .sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
        while self.bytes > MAX_BYTES || self.fragments.len() > MAX_FRAGMENTS {
            let removed = self.fragments.remove(0);
            self.bytes -= removed.text.len()
                + removed
                    .event
                    .as_ref()
                    .map_or(0, crate::voice_history::Event::bytes);
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
                fragment.role == USER
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
            if fragment.role == USER && fragment.start_ms <= offset {
                self.admitted.insert(fragment.id.clone());
            }
        }
    }

    pub(in crate::realtime_voice) fn messages(&self) -> serde_json::Value {
        // Each speaker grows independently; original fragments retain timing.
        let mut bubbles: Vec<(Fragment, usize, bool)> = Vec::new();
        for fragment in &self.fragments {
            let (spoken, active) = self.progress(fragment);
            let previous = bubbles
                .iter()
                .rposition(|(bubble, _, _)| bubble.role == fragment.role && bubble.event.is_none());
            if let Some(index) = previous
                && fragment.event.is_none()
                && bubbles[index + 1..]
                    .iter()
                    .all(|(bubble, _, _)| bubble.event.is_none())
                && fragment.start_ms <= bubbles[index].0.end_ms + 1200.0
                && bubbles[index].0.text.len() + fragment.text.len() <= super::super::MAX_TEXT
            {
                let (bubble, heard, playing) = &mut bubbles[index];
                if *heard == bubble.text.encode_utf16().count() {
                    *heard += spoken;
                }
                *playing |= active;
                bubble.text.push_str(&fragment.text);
                bubble.end_ms = bubble.end_ms.max(fragment.end_ms);
            } else {
                bubbles.push((fragment.clone(), spoken, active));
            }
        }
        serde_json::Value::Array(
            bubbles
                .iter()
                .map(|(fragment, spoken, active)| {
                    serde_json::json!({
                        "id":fragment.id,"role":fragment.role,"text":fragment.text,
                        "startMs":fragment.start_ms,"endMs":fragment.end_ms,
                        "spokenUtf16":spoken,"active":active,
                        "event":fragment.event,
                    })
                })
                .collect(),
        )
    }

    /// Locate provider speech before it enters the device queue. Caption text
    /// may arrive before or after its audio; arrival time is not a playback mark.
    pub(in crate::realtime_voice) fn audio(&mut self, start: usize, pcm: &[u8]) {
        self.received_samples = start.saturating_add(pcm.len() / 2);
        if self.playback_origin.is_none()
            && let Some(offset) = pcm.as_chunks::<2>().0.iter().position(|sample| {
                i16::from_le_bytes(*sample).unsigned_abs() >= super::super::AUDIBLE_SAMPLE
            })
        {
            let origin = start.saturating_add(offset);
            self.playback_origin = Some(origin);
            self.source_origin = self
                .source_clock
                .as_ref()
                .and_then(|clock| clock.sample(origin));
            self.advance();
        }
    }

    pub(in crate::realtime_voice) fn source_audio(
        &mut self,
        start: usize,
        count: usize,
        rtp_timestamp: Option<u32>,
    ) -> Result<(), &'static str> {
        if rtp_timestamp.is_some() {
            self.source_clock.get_or_insert_default();
        }
        if let Some(clock) = &mut self.source_clock {
            clock.record(start, count, rtp_timestamp)?;
        }
        Ok(())
    }

    /// Fragment timestamps are approximate. Pair the first caption timestamp
    /// with the first provider speech sample and advance only with device audio.
    /// Late captions catch up immediately; interrupted ranges remain frozen.
    pub(in crate::realtime_voice) fn played(&mut self, samples: usize) {
        self.playback_samples = self.playback_samples.max(samples);
        self.advance();
    }

    fn advance(&mut self) {
        if let Some(origin) = self.playback_origin
            && self.caption_origin.is_some()
            && let Some((start, end)) = self.heard.last_mut()
        {
            let elapsed = self
                .source_clock
                .as_mut()
                .and_then(|clock| clock.played(self.playback_samples))
                .zip(self.source_origin)
                .map_or_else(
                    || self.playback_samples.saturating_sub(origin),
                    |(source, origin)| source.saturating_sub(origin),
                );
            let samples = u32::try_from(elapsed).unwrap_or(u32::MAX);
            let rate = u32::try_from(super::super::RATE).unwrap_or(u32::MAX);
            *end = *start + f64::from(samples) * 1000.0 / f64::from(rate);
        }
    }

    pub(in crate::realtime_voice) fn stop(&mut self) {
        self.playback_origin = None;
        self.caption_origin = None;
        self.playback_samples = 0;
        self.received_samples = 0;
        self.source_clock = None;
        self.source_origin = None;
    }

    /// Fixed timing/count fields only; never export transcript text or IDs.
    pub(in crate::realtime_voice) fn timing(
        &self,
        messages: &serde_json::Value,
    ) -> serde_json::Value {
        let latest = messages.as_array().and_then(|messages| {
            messages
                .iter()
                .rev()
                .find(|message| message["role"] == ASSISTANT && message["event"].is_null())
        });
        let fragment = self
            .fragments
            .iter()
            .rev()
            .find(|fragment| fragment.role == ASSISTANT && fragment.event.is_none());
        serde_json::json!({
            "decodedMs": self.received_samples.saturating_mul(1000) / super::super::RATE,
            "heardPcmMs": self.playback_samples.saturating_mul(1000) / super::super::RATE,
            "sourceMs": self.heard.last().map(|(_, end)| end),
            "fragmentStartMs": fragment.map(|fragment| fragment.start_ms),
            "fragmentEndMs": fragment.map(|fragment| fragment.end_ms),
            "textUtf16": latest.and_then(|message| message["text"].as_str()).map_or(0, |text| text.encode_utf16().count()),
            "spokenUtf16": latest.and_then(|message| message["spokenUtf16"].as_u64()).unwrap_or(0),
            "sourceClock": self.source_clock.is_some(),
        })
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "A clamped nonnegative fraction intentionally rounds down the bounded UTF-16 length"
    )]
    fn progress(&self, fragment: &Fragment) -> (usize, bool) {
        if fragment.role != ASSISTANT || fragment.event.is_some() {
            return (0, false);
        }
        let Some((_, through)) = self
            .heard
            .iter()
            .find(|(start, end)| *start <= fragment.start_ms && *end > fragment.start_ms)
        else {
            return (0, false);
        };
        let fraction = if fragment.end_ms <= fragment.start_ms {
            1.0
        } else {
            ((through - fragment.start_ms) / (fragment.end_ms - fragment.start_ms)).clamp(0.0, 1.0)
        };
        let length = u32::try_from(fragment.text.encode_utf16().count()).unwrap_or(u32::MAX);
        let spoken = (f64::from(length) * fraction) as usize;
        let active = self.playback_origin.is_some()
            && self.heard.last().is_some_and(|range| {
                range.0 <= fragment.start_ms
                    && range.1 > fragment.start_ms
                    && range.1 < fragment.end_ms
            });
        (spoken, active)
    }

    pub(super) fn snapshot(&self) -> Vec<Fragment> {
        self.fragments.clone()
    }
    pub(in crate::realtime_voice) fn saved_captions(&self) -> Vec<crate::voice_history::Caption> {
        self.snapshot().into_iter().map(Into::into).collect()
    }
    pub(in crate::realtime_voice) fn event(
        &mut self,
        id: &str,
        event: crate::voice_history::Event,
    ) {
        let event = event.bounded();
        let id = format!("event:{id}");
        let text = format!("{} · {}", event.name, event.status);
        if let Some(fragment) = self.fragments.iter_mut().find(|fragment| fragment.id == id) {
            if event.status == "requested"
                && fragment
                    .event
                    .as_ref()
                    .is_some_and(|old| old.status != "requested")
            {
                return;
            }
            self.bytes = self.bytes.saturating_sub(
                fragment.text.len()
                    + fragment
                        .event
                        .as_ref()
                        .map_or(0, crate::voice_history::Event::bytes),
            ) + text.len()
                + event.bytes();
            fragment.text = text;
            fragment.event = Some(event);
        } else {
            let at = self
                .fragments
                .last()
                .map_or(0.0, |fragment| fragment.end_ms);
            let _ = self.append(Fragment {
                id,
                role: ASSISTANT.into(),
                text,
                start_ms: at,
                end_ms: at,
                event: Some(event),
            });
        }
    }
    pub(super) fn event_result(&mut self, id: &str, value: &serde_json::Value) {
        if let Some(event) = self
            .fragments
            .iter()
            .find(|fragment| fragment.id == format!("event:{id}"))
            .and_then(|fragment| fragment.event.clone())
        {
            let mut event = event;
            event.result(value);
            self.event(id, event);
        }
    }
}
