pub(super) use voice_openai::response::ResponseCreateQueue;
pub(super) fn is_active_response_error(error: &oai_rt_rs::ServerError) -> bool {
    voice_openai::response::is_active_response_error_for(error, super::EVENT_PREFIX)
}
pub(super) fn provider_error_message(error: &oai_rt_rs::ServerError) -> &'static str {
    voice_openai::response::provider_error_message_for(error, super::EVENT_PREFIX)
}
