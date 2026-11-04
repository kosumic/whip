//! Call-owned captions paced by acknowledged playback, including while the
//! server is still generating. Final duration refines the estimate gradually.
use crate::speech_pacing as pacing;
use std::collections::{HashSet, VecDeque};

use oai_rt_rs::ServerEvent;
use serde::Serialize;

const MAX_MESSAGES: usize = 64;
const MAX_BYTES: usize = 128 * 1024;
const USER: &str = "user";
const ASSISTANT: &str = "assistant";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Message {
    pub id: String,
    pub role: &'static str,
    pub text: String,
    pub spoken_utf16: usize,
    pub active: bool,
}

struct Turn {
    message: Message,
    samples: usize,
    played: usize,
    audio_done: bool,
    text_done: bool,
    text_failed: bool,
    stopped: bool,
    timing: pacing::Text,
    clock: pacing::Clock,
    pace_reported: bool,
}

impl Turn {
    fn stop(&mut self) {
        if self.message.active {
            self.message.spoken_utf16 = self.timing.freeze(self.message.spoken_utf16);
        }
        self.stopped = true;
        self.message.active = false;
    }

    fn advance(&mut self, played: usize) {
        if self.stopped {
            return;
        }
        self.played = self.played.max(played.min(self.samples));
        self.message.spoken_utf16 = self.clock.advance(
            &self.timing,
            self.played,
            self.samples,
            self.audio_done && self.text_done,
        );
        self.message.active = self.samples > 0 && (!self.audio_done || self.samples > self.played);
    }
}

#[derive(Default)]
pub(super) struct Transcript {
    turns: VecDeque<Turn>,
    pace: pacing::Pace,
}

fn assistant_id(item: &str, index: u32) -> String {
    format!("assistant:{item}:{index}")
}

impl Transcript {
    fn turn(&mut self, id: String, role: &'static str) -> Option<&mut Turn> {
        if id.len() > 512 {
            return None;
        }
        if let Some(index) = self.turns.iter().position(|turn| turn.message.id == id) {
            return self.turns.get_mut(index);
        }
        self.trim();
        if self.turns.len() == MAX_MESSAGES {
            self.turns.pop_front();
        }
        self.turns.push_back(Turn {
            message: Message {
                id,
                role,
                text: String::new(),
                spoken_utf16: 0,
                active: false,
            },
            samples: 0,
            played: 0,
            audio_done: false,
            text_done: false,
            text_failed: false,
            stopped: false,
            timing: pacing::Text::default(),
            clock: pacing::Clock::new(self.pace),
            pace_reported: false,
        });
        self.turns.back_mut()
    }

    fn trim(&mut self) {
        let mut bytes: usize = self.turns.iter().map(|turn| turn.message.text.len()).sum();
        while bytes > MAX_BYTES {
            if let Some(turn) = self.turns.pop_front() {
                bytes -= turn.message.text.len();
            } else {
                break;
            }
        }
    }

    pub fn observe(&mut self, event: &ServerEvent, ignored: &HashSet<String>) {
        match event {
            ServerEvent::InputAudioBufferSpeechStarted { item_id, .. }
            | ServerEvent::InputAudioBufferCommitted { item_id, .. } => {
                self.turn(format!("user:{item_id}"), USER);
            }
            ServerEvent::InputAudioTranscriptionCompleted {
                item_id,
                transcript,
                ..
            } => {
                // Reserve at speech start, so delayed ASR cannot reorder turns or
                // resurrect a message already evicted from this bounded window.
                if let Some(turn) = self
                    .turns
                    .iter_mut()
                    .find(|turn| turn.message.id == format!("user:{item_id}"))
                {
                    turn.message.text = super::limit_text(transcript.clone());
                    turn.text_done = true;
                    turn.text_failed = false;
                }
            }
            ServerEvent::InputAudioTranscriptionDelta { item_id, delta, .. } => {
                if let Some(turn) = self
                    .turns
                    .iter_mut()
                    .find(|turn| turn.message.id == format!("user:{item_id}") && !turn.text_done)
                {
                    super::bounded_text(&mut turn.message.text, delta);
                }
            }
            ServerEvent::InputAudioTranscriptionFailed { item_id, .. } => {
                if let Some(turn) = self
                    .turns
                    .iter_mut()
                    .find(|turn| turn.message.id == format!("user:{item_id}") && !turn.text_done)
                {
                    turn.text_failed = true;
                }
            }
            ServerEvent::ResponseOutputAudioTranscriptDelta {
                response_id,
                item_id,
                content_index,
                delta,
                ..
            } if !ignored.contains(response_id) => {
                if let Some(turn) = self.turn(assistant_id(item_id, *content_index), ASSISTANT)
                    && !turn.stopped
                    && !turn.text_done
                {
                    super::bounded_text(&mut turn.message.text, delta);
                    turn.timing.update(&turn.message.text);
                    turn.advance(turn.played);
                }
            }
            ServerEvent::ResponseOutputAudioTranscriptDone {
                response_id,
                item_id,
                content_index,
                transcript,
                ..
            } if !ignored.contains(response_id) => {
                if let Some(turn) = self.turn(assistant_id(item_id, *content_index), ASSISTANT)
                    && !turn.stopped
                {
                    turn.message.text = super::limit_text(transcript.clone());
                    turn.timing.update(&turn.message.text);
                    turn.text_done = true;
                    turn.advance(turn.played);
                }
            }
            ServerEvent::ResponseOutputAudioDone {
                response_id,
                item_id,
                content_index,
                ..
            } if !ignored.contains(response_id) => {
                if let Some(turn) = self.turn(assistant_id(item_id, *content_index), ASSISTANT) {
                    turn.audio_done = true;
                    turn.advance(turn.played);
                }
            }
            _ => {}
        }
        for turn in &mut self.turns {
            if turn.audio_done && turn.text_done && !turn.stopped && !turn.pace_reported {
                self.pace.observe(turn.timing.units, turn.samples);
                turn.pace_reported = true;
            }
        }
        self.trim();
    }

    pub fn audio(&mut self, item: &str, index: u32, samples: usize) {
        if let Some(turn) = self.turn(assistant_id(item, index), ASSISTANT)
            && !turn.stopped
        {
            turn.samples = samples;
            turn.advance(turn.played);
        }
    }

    pub fn played(&mut self, item: &str, index: u32, played: usize) {
        if let Some(turn) = self
            .turns
            .iter_mut()
            .find(|turn| turn.message.id == assistant_id(item, index))
        {
            turn.advance(played);
        }
    }

    pub fn finish_audio(&mut self, item: &str, index: u32) {
        if let Some(turn) = self
            .turns
            .iter_mut()
            .find(|turn| turn.message.id == assistant_id(item, index))
        {
            turn.audio_done = true;
            turn.advance(turn.played);
            if turn.text_done && !turn.stopped && !turn.pace_reported {
                self.pace.observe(turn.timing.units, turn.samples);
                turn.pace_reported = true;
            }
        }
    }

    pub fn stop(&mut self) {
        for turn in &mut self.turns {
            if turn.message.role == ASSISTANT {
                turn.stop();
            }
        }
    }

    pub fn stop_item(&mut self, item: &str, index: u32) {
        if let Some(turn) = self
            .turns
            .iter_mut()
            .find(|turn| turn.message.id == assistant_id(item, index))
        {
            turn.stop();
        }
    }

    pub fn snapshot(&self) -> Vec<Message> {
        self.turns
            .iter()
            .filter(|turn| !turn.message.text.is_empty())
            .map(|turn| turn.message.clone())
            .collect()
    }

    pub fn delegation_snapshot(&self) -> Vec<super::handoff_context::Caption> {
        let mut captions: Vec<_> = self
            .turns
            .iter()
            .rev()
            .filter(|turn| !turn.message.text.is_empty())
            .take(super::handoff_context::MAX_RECORDS)
            .map(|turn| {
                super::handoff_context::Caption::new(
                    &turn.message.id,
                    turn.message.role,
                    &turn.message.text,
                    turn.text_done,
                    turn.text_failed,
                    turn.stopped && (!turn.audio_done || turn.played < turn.samples),
                    (turn.message.role == ASSISTANT).then_some(turn.message.spoken_utf16),
                )
            })
            .collect();
        captions.reverse();
        captions
    }
}

#[cfg(test)]
mod tests;
