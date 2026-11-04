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
    seen: super::super::wire::Seen,
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
    pub fn finish(&mut self, epoch: u64, now: Instant) -> bool {
        if self.epoch != epoch || self.finish_at.is_none_or(|deadline| deadline > now) {
            return false;
        }
        self.enabled = false;
        self.ended = true;
        self.finish_at = None;
        true
    }
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
        match self.seen.accept_value(event) {
            Ok(true) => {}
            Ok(false) => return,
            Err(_) => {
                self.failed = true;
                return;
            }
        }
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
    fn server_stop_finishes_on_its_deadline_despite_idle_rtp_and_cannot_end_a_new_epoch()
    -> Result<(), &'static str> {
        let mut identity = Identity::default();
        identity.observe(&json!({"type":"response.content_part.added","response_id":"reply","item_id":"item","content_index":0,"part":{"type":"audio"}}));
        identity.observe(&json!({"type":"output_audio_buffer.started","response_id":"reply"}));
        identity.observe(&json!({"type":"output_audio_buffer.stopped","response_id":"reply"}));
        let epoch = identity.epoch;
        let deadline = identity.finish_at.ok_or("missing drain deadline")?;
        assert!(!identity.finish(epoch, deadline - Duration::from_nanos(1)));
        assert!(identity.enabled);
        assert!(identity.finish(epoch, deadline));
        assert!(identity.ended);
        assert!(!identity.enabled);
        assert!(!identity.finish(epoch, deadline + Duration::from_secs(1)));
        identity.observe(&json!({"type":"output_audio_buffer.started","response_id":"reply"}));
        assert!(!identity.finish(epoch, deadline + Duration::from_secs(2)));
        assert!(identity.enabled);
        assert!(!identity.ended);
        Ok(())
    }
    #[test]
    fn mirrored_sideband_events_do_not_restart_the_audible_epoch() {
        let mut identity = Identity::default();
        let part = json!({"event_id":"part_1","type":"response.content_part.added","response_id":"reply","item_id":"item","content_index":0,"part":{"type":"audio"}});
        let started = json!({"event_id":"start_1","type":"output_audio_buffer.started","response_id":"reply"});
        identity.observe(&part);
        identity.observe(&started);
        let epoch = identity.epoch;
        identity.observe(&part);
        identity.observe(&started);
        assert_eq!(identity.epoch, epoch);
        assert!(identity.enabled);
    }
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
