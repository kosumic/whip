//! Call-owned captions. Timing is an estimate within streamed audio/text chunks,
//! advanced only by acknowledged device playback, never wall time or receipt.
use std::collections::{HashSet, VecDeque};

use oai_rt_rs::ServerEvent;
use serde::Serialize;

const MAX_MESSAGES: usize = 64;
const MAX_BYTES: usize = 128 * 1024;
const MAX_SPANS: usize = 2048;
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

struct Span {
    start: usize,
    end: usize,
    text_start: usize,
    text_end: usize,
}

struct Turn {
    message: Message,
    samples: usize,
    played: usize,
    spans: Vec<Span>,
    done: bool,
    stopped: bool,
}

impl Turn {
    fn anchor(&mut self) {
        let text_end = self.message.text.encode_utf16().count();
        let (start, text_start) = self
            .spans
            .last()
            .map_or((0, 0), |span| (span.end, span.text_end));
        if self.samples > start && text_end > text_start && self.spans.len() < MAX_SPANS {
            self.spans.push(Span {
                start,
                end: self.samples,
                text_start,
                text_end,
            });
        }
        self.advance(self.played);
    }

    fn advance(&mut self, played: usize) {
        if self.stopped {
            return;
        }
        self.played = self.played.max(played.min(self.samples));
        let position = self.spans.iter().fold(0, |position, span| {
            if self.played >= span.end {
                span.text_end
            } else if self.played > span.start {
                span.text_start
                    + (span.text_end - span.text_start) * (self.played - span.start)
                        / (span.end - span.start)
            } else {
                position
            }
        });
        self.message.spoken_utf16 = self.message.spoken_utf16.max(position);
        self.message.active = self.samples > 0 && (!self.done || self.samples > self.played);
        if self.done && self.samples > 0 && self.samples == self.played {
            self.message.spoken_utf16 = self.message.text.encode_utf16().count();
        }
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
            spans: Vec::new(),
            done: false,
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
                    && !turn.done
                {
                    super::bounded_text(&mut turn.message.text, delta);
                    turn.anchor();
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
                    turn.anchor();
                }
            }
            ServerEvent::ResponseOutputAudioDone {
                response_id,
                item_id,
                content_index,
                ..
            } if !ignored.contains(response_id) => {
                if let Some(turn) = self.turn(assistant_id(item_id, *content_index), ASSISTANT) {
                    turn.done = true;
                    turn.anchor();
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
            turn.anchor();
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
