pub(in crate::realtime_voice) fn rejected(
    error: &oai_rt_rs::live::ProviderError,
    global: bool,
) -> &'static str {
    voice_openai::live::errors::rejected_for(error, global, "whip-live")
}
