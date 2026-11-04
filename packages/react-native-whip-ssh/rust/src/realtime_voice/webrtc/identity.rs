//! Audio identities follow the ordered event channel, independently of sideband startup.
use serde_json::Value;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

#[derive(Clone, PartialEq)]
pub(super) struct Tag {
    pub response: String,
    pub item: String,
    pub index: u32,
}
#[derive(Default)]
pub(super) struct Identity {
    tags: VecDeque<Tag>,
    cancelled: VecDeque<String>,
    pub current: Option<Tag>,
    pub epoch: u64,
    pub enabled: bool,
    pub ended: bool,
    pub failed: bool,
    pub finish_at: Option<Instant>,
}
impl Identity {
    pub fn cancel_response(&mut self, response: Option<&str>) {
        let response = response
            .map(str::to_owned)
            .or_else(|| self.current.as_ref().map(|tag| tag.response.clone()));
        if let Some(response) = response {
            self.cancelled.push_back(response);
            if self.cancelled.len() > 8 {
                self.cancelled.pop_front();
            }
        }
        self.cancel();
    }
    fn cancel(&mut self) {
        self.enabled = false;
        self.epoch += 1;
        self.finish_at = None;
    }
    pub fn observe(&mut self, event: &Value) {
        let response = event["response_id"].as_str().unwrap_or_default();
        match event["type"].as_str().unwrap_or_default() {
            "response.content_part.added" | "response.output_audio_transcript.delta" => {
                if event["type"] == "response.content_part.added"
                    && event["part"]["type"] != "audio"
                    && event["part"]["type"] != "output_audio"
                {
                    return;
                }
                let item = event["item_id"].as_str().unwrap_or_default();
                if item.is_empty() || item.len() > 512 || response.len() > 512 {
                    return;
                }
                let index = event["content_index"]
                    .as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .unwrap_or(0);
                if !self
                    .tags
                    .iter()
                    .any(|tag| tag.item == item && tag.index == index)
                {
                    self.tags.push_back(Tag {
                        response: response.into(),
                        item: item.into(),
                        index,
                    });
                    if self.tags.len() > 8 {
                        self.tags.pop_front();
                    }
                }
            }
            "output_audio_buffer.started" => {
                if self.cancelled.iter().any(|old| old == response) {
                    return;
                }
                self.current = self
                    .tags
                    .iter()
                    .rev()
                    .find(|tag| tag.response == response)
                    .cloned();
                self.epoch += 1;
                self.enabled = self.current.is_some();
                self.ended = false;
                self.finish_at = None;
            }
            "output_audio_buffer.stopped"
                if self
                    .current
                    .as_ref()
                    .is_some_and(|tag| tag.response == response) =>
            {
                self.finish_at = Some(Instant::now() + Duration::from_millis(160));
            }
            "output_audio_buffer.cleared"
                if self
                    .current
                    .as_ref()
                    .is_some_and(|tag| tag.response == response) =>
            {
                self.cancel_response(Some(response));
            }
            "input_audio_buffer.speech_started" => self.cancel_response(None),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn cancelled_response_cannot_resume_or_clear_a_newer_audible_epoch() {
        let mut identity = Identity::default();
        for response in ["old", "new"] {
            identity.observe(&json!({"type":"response.content_part.added","response_id":response,"item_id":response,"content_index":0,"part":{"type":"audio"}}));
            identity.observe(&json!({"type":"output_audio_buffer.started","response_id":response}));
            assert!(identity.enabled);
            if response == "old" {
                identity.cancel_response(Some("old"));
                assert!(!identity.enabled);
            }
        }
        let epoch = identity.epoch;
        identity.observe(&json!({"type":"output_audio_buffer.cleared","response_id":"old"}));
        identity.observe(&json!({"type":"output_audio_buffer.started","response_id":"old"}));
        assert_eq!(identity.epoch, epoch);
        assert!(identity.enabled);
        assert_eq!(
            identity.current.as_ref().map(|tag| tag.response.as_str()),
            Some("new")
        );
    }
}
