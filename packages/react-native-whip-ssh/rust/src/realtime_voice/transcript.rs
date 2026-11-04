//! Call-owned captions. Word timing is estimated over a completed audio item,
//! advanced only by acknowledged device playback, never packet arrival order.
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
    stopped: bool,
}

impl Turn {
    fn advance(&mut self, played: usize) {
        if self.stopped {
            return;
        }
        self.played = self.played.max(played.min(self.samples));
        // Transcript and audio packets are independent streams, not paired
        // word boundaries. A sentence can precede its first 100ms of audio.
        // Interpolating against that partial duration races to the sentence's
        // end and a monotonic cursor cannot recover. Keep streaming text dim
        // until both final markers establish this item's actual denominator.
        if self.audio_done && self.text_done && self.samples > 0 {
            self.message.spoken_utf16 =
                self.message.text.encode_utf16().count() * self.played / self.samples;
        }
        self.message.active = self.samples > 0 && (!self.audio_done || self.samples > self.played);
    }
}

#[derive(Default)]
pub(super) struct Transcript {
    turns: VecDeque<Turn>,
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
            stopped: false,
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
                }
            }
            ServerEvent::InputAudioTranscriptionDelta { item_id, delta, .. } => {
                if let Some(turn) = self
                    .turns
                    .iter_mut()
                    .find(|turn| turn.message.id == format!("user:{item_id}"))
                {
                    super::bounded_text(&mut turn.message.text, delta);
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

    pub fn stop(&mut self) {
        for turn in &mut self.turns {
            if turn.message.role == ASSISTANT {
                turn.stopped = true;
                turn.message.active = false;
            }
        }
    }

    pub fn stop_item(&mut self, item: &str, index: u32) {
        if let Some(turn) = self
            .turns
            .iter_mut()
            .find(|turn| turn.message.id == assistant_id(item, index))
        {
            turn.stopped = true;
            turn.message.active = false;
        }
    }

    pub fn snapshot(&self) -> Vec<Message> {
        self.turns
            .iter()
            .filter(|turn| !turn.message.text.is_empty())
            .map(|turn| turn.message.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests;
