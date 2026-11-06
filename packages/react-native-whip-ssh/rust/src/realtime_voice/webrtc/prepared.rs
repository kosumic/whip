pub(in crate::realtime_voice) use voice_call_media::prepared::clear;
pub(in crate::realtime_voice) fn configure(enabled: bool) -> bool {
    if enabled {
        let _ = super::api::client();
    }
    let Ok(runtime) = crate::runtime() else {
        return false;
    };
    let _guard = runtime.enter();
    voice_call_media::prepared::configure(enabled)
}
