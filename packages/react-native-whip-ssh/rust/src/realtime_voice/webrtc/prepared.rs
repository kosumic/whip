pub(in crate::realtime_voice) fn clear() {
    voice_call_openai::prepared::clear();
    voice_call_media::prepared::clear();
}

pub(in crate::realtime_voice) fn configure(enabled: bool) -> bool {
    if !enabled {
        clear();
        return true;
    }
    let Ok(runtime) = crate::runtime() else {
        return false;
    };
    let _guard = runtime.enter();
    let media = voice_call_media::prepared::configure(true);
    let http = voice_call_openai::prepared::configure(true);
    media && http
}
