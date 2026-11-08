//! Native audio and device state owned by Whip, shared by both provider modes.
use super::{ClientEvent, Ordering, RealtimeVoiceAdapter, startup};
use voice_call_openai::session::Audio;

impl Audio for RealtimeVoiceAdapter {
    fn is_muted(&self) -> bool {
        self.microphone.lock().muted
    }
    fn current(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
    }
    fn credentials_current(&self) -> bool {
        !crate::voice_credentials::is_updating()
            && crate::voice_credentials::generation() == self.credential_generation
    }
    fn set_muted(&self, muted: bool) -> Result<(), &'static str> {
        self.view.lock().level = 0.0;
        // Live can acknowledge an older command after a newer user/tool mute.
        // Provider acknowledgements may gate capture, never replace intent.
        self.input.set_muted(muted || self.microphone.lock().muted);
        if let Some(echo) = self.echo.lock().as_mut() {
            echo.reset_capture()?;
        }
        Ok(())
    }
    fn interrupt(&self) -> Option<ClientEvent> {
        if self.live {
            self.output.lock().clear();
            None
        } else {
            self.output.lock().interrupt()
        }
    }
    fn render_pcm(&self, item: String, index: u32, pcm: Vec<u8>) -> Result<(), &'static str> {
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        self.output.lock().append(item, index, pcm)
    }
    fn cancel_audio(&self, response: Option<&str>) {
        if let Some(media) = self.media.lock().as_ref() {
            media.cancel_audio(response);
        }
    }
    fn resume_live_audio(&self) {
        if let Some(media) = self.media.lock().as_ref() {
            media.resume_live_audio();
        }
    }
    fn confirm_live_closed(&self) {
        if let Some(media) = self.media.lock().as_ref() {
            media.confirm_live_closed();
        }
    }
    fn uploaded(&self) {
        let mut view = self.view.lock();
        view.uploaded_packets += 1;
        view.startup.first_input.get_or_insert_with(|| {
            self.client_elapsed_ms
                .saturating_add(startup::elapsed(self.started_at))
        });
    }
}
