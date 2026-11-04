// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
//! Port of Codex's RealtimeResponseCreateQueue at f2b94ef8b52196f127d162c6db71e390b9bb265c.
//! The public API reports request failures asynchronously; client event IDs
//! correlate those failures instead of the Codex writer's acknowledgement future.

#[derive(Default)]
pub(super) struct ResponseCreateQueue {
    active: Option<String>,
    active_unknown: bool,
    pending_create: bool,
    requested: bool,
    speaking: bool,
    awaiting_vad: bool,
}
impl ResponseCreateQueue {
    pub(super) fn request_create(&mut self) {
        self.pending_create = true;
    }
    pub(super) fn can_create(&self) -> bool {
        self.pending_create && self.can_respond()
    }
    pub(super) fn can_respond(&self) -> bool {
        !self.is_active() && !self.speaking && !self.awaiting_vad
    }
    pub(super) fn mark_requested(&mut self) {
        self.pending_create = false;
        self.requested = true;
    }
    pub(super) fn mark_started(&mut self, id: String) {
        self.active = Some(id);
        self.active_unknown = false;
        self.requested = false;
        if !self.speaking {
            self.awaiting_vad = false;
        }
    }
    pub(super) fn mark_finished(&mut self, id: &str) {
        if self.active.as_deref() == Some(id) || self.active_unknown {
            self.active = None;
            self.active_unknown = false;
            self.requested = false;
        }
    }
    pub(super) fn defer_active_response(&mut self) {
        self.active_unknown = self.active.is_none();
        self.requested = false;
        self.pending_create = true;
    }
    pub(super) fn active(&self) -> Option<&String> {
        self.active.as_ref()
    }
    pub(super) fn is_active(&self) -> bool {
        self.active.is_some() || self.active_unknown || self.requested
    }
    pub(super) fn speech_started(&mut self) {
        self.speaking = true;
        self.awaiting_vad = true;
    }
    pub(super) fn speech_stopped(&mut self) {
        self.speaking = false;
    }
    pub(super) fn clear_input(&mut self) {
        self.speaking = false;
        self.awaiting_vad = false;
    }
}

pub(super) fn is_active_response_error(error: &oai_rt_rs::ServerError) -> bool {
    error.error_type == oai_rt_rs::ApiErrorType::InvalidRequestError
        && error.code.as_deref() == Some("conversation_already_has_active_response")
        && error
            .event_id
            .as_deref()
            .is_some_and(|id| id.starts_with("whip:response.create:"))
}

pub(super) fn provider_error_message(error: &oai_rt_rs::ServerError) -> &'static str {
    match error.error_type {
        oai_rt_rs::ApiErrorType::RateLimitError => "OpenAI Realtime quota or rate limit reached.",
        oai_rt_rs::ApiErrorType::AuthenticationError => "OpenAI rejected the saved API credential.",
        oai_rt_rs::ApiErrorType::InvalidRequestError => match error
            .event_id
            .as_deref()
            .and_then(|id| id.strip_prefix("whip:"))
            .and_then(|id| id.split(':').next())
        {
            Some("session.update") => "OpenAI rejected the model, voice, or server VAD settings.",
            Some("conversation.item.truncate") => {
                "OpenAI rejected the interrupted audio position. Please call again."
            }
            Some("response.create") => {
                "OpenAI rejected the next voice response. Please call again."
            }
            Some("input_audio_buffer.append") => {
                "OpenAI rejected the microphone audio format. Please call again."
            }
            _ => "OpenAI rejected a conversation request. Please call again.",
        },
        _ => "OpenAI Realtime returned an error. Please call again.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notices_wait_for_response_completion_and_user_speech() {
        let mut queue = ResponseCreateQueue::default();
        queue.mark_started("tool-request".into());
        assert!(!queue.can_respond());
        queue.mark_finished("tool-request");
        assert!(queue.can_respond());
        assert!(!queue.can_create());
        queue.mark_requested();
        assert!(!queue.can_respond());
        queue.mark_started("acknowledgement".into());
        queue.speech_started();
        queue.mark_finished("acknowledgement");
        assert!(!queue.can_respond());
        queue.speech_stopped();
        assert!(!queue.can_respond());
        queue.mark_started("user-followup".into());
        queue.mark_finished("user-followup");
        assert!(queue.can_respond());
        queue.request_create();
        assert!(queue.can_create());
    }
    #[test]
    fn interrupted_response_stays_active_until_server_completion() {
        let mut queue = ResponseCreateQueue::default();
        queue.mark_started("old".into());
        queue.speech_started();
        queue.request_create();
        assert!(!queue.can_create());
        queue.mark_finished("old");
        queue.speech_stopped();
        assert!(!queue.can_create()); // VAD's automatic response is still in flight.
        queue.mark_started("vad".into());
        assert!(!queue.can_create());
        queue.mark_finished("vad");
        assert!(queue.can_create());
        queue.mark_requested();
        assert!(!queue.can_create());
    }
    #[test]
    fn delayed_cancellation_cannot_finish_a_newer_response() {
        let mut queue = ResponseCreateQueue::default();
        queue.mark_started("old".into());
        queue.mark_started("new".into());
        queue.request_create();
        queue.mark_finished("old");
        assert!(!queue.can_create());
        queue.mark_finished("new");
        assert!(queue.can_create());
    }
    #[test]
    fn active_response_race_defers_exactly_one_continuation() {
        let mut queue = ResponseCreateQueue::default();
        queue.request_create();
        queue.mark_requested();
        queue.defer_active_response();
        assert!(!queue.can_create());
        queue.mark_finished("server-active");
        assert!(queue.can_create());
        queue.mark_requested();
        queue.mark_started("continuation".into());
        queue.mark_finished("continuation");
        assert!(!queue.can_create());
    }
    #[test]
    fn provider_errors_use_correlated_request_kind_without_leaking_payloads()
    -> Result<(), serde_json::Error> {
        let mut error: oai_rt_rs::ServerError = serde_json::from_value(
            serde_json::json!({"type":"invalid_request_error","code":"conversation_already_has_active_response","message":"private prompt sk-secret","event_id":"whip:response.create:123"}),
        )?;
        assert!(is_active_response_error(&error));
        error.event_id = Some("whip:conversation.item.truncate:124".into());
        assert!(!is_active_response_error(&error));
        assert_eq!(
            provider_error_message(&error),
            "OpenAI rejected the interrupted audio position. Please call again."
        );
        error.event_id = Some("private sk-secret".into());
        assert!(!is_active_response_error(&error));
        assert!(!provider_error_message(&error).contains("sk-secret"));
        Ok(())
    }
}
