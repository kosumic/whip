use super::VoiceChat;
use crate::audio_ingress::{MAX_SAMPLES, NativeIngress};
use audio_ingress::Packet;
use std::sync::Arc;

impl Drop for VoiceChat {
    fn drop(&mut self) {
        self.state.get_mut().close_capture();
    }
}

impl VoiceChat {
    pub(super) fn open_capture(self: Arc<Self>, input_id: u64) -> Result<u64, &'static str> {
        let runtime = crate::runtime().map_err(|_| "Microphone worker could not start.")?;
        let mut state = self.state.lock();
        if !state.call.accepts_audio(input_id) {
            return Err("The microphone input was replaced.");
        }
        state.close_capture();
        let ingress = NativeIngress::new(16_000, MAX_SAMPLES, 8)?;
        let id = ingress.id();
        state.audio_error = None;
        state.ingress = Some(ingress.clone());
        drop(state);
        let owner = Arc::downgrade(&self);
        // The task retains only a weak owner. Closing/replacing capture wakes it.
        runtime.spawn(async move {
            let mut packet = Packet::new(MAX_SAMPLES);
            let mut samples = Vec::with_capacity(MAX_SAMPLES);
            loop {
                let received = ingress.receive(&mut packet).await;
                let Some(owner) = owner.upgrade() else {
                    break;
                };
                let mut state = owner.state.lock();
                // Lifecycle decisions and the final sample admission share this lock.
                if state.call.view().input_id != input_id
                    || state
                        .ingress
                        .as_ref()
                        .is_none_or(|active| active.id() != id)
                {
                    break;
                }
                if let Err(error) = received {
                    state.audio_error = Some(error.to_owned());
                    state.close_capture();
                    break;
                }
                if !state.call.accepts_audio(input_id) || !ingress.accepts(packet.ticket.generation)
                {
                    continue;
                }
                samples.clear();
                samples.extend(
                    packet
                        .samples
                        .iter()
                        .map(|sample| f32::from(*sample) / 32768.0),
                );
                owner.process_audio(&mut state, &samples);
                drop(state);
            }
        });
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        reason = "Unexpected lifecycle errors must fail these tests immediately"
    )]
    use super::VoiceChat;
    use crate::VoiceChatPhase;
    use crate::audio_ingress::whip_audio_ingress_push_v1;
    use std::time::Duration;

    async fn wait_for_level(owner: &VoiceChat, level: f32) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if (owner.view().level - level).abs() < 0.001 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
    }

    fn capture(handle: u64, sample: i16) -> u8 {
        let bytes: Vec<u8> = std::iter::repeat_n(sample, 256)
            .flat_map(i16::to_le_bytes)
            .collect();
        // SAFETY: These owned bytes live through the synchronous native call.
        unsafe { whip_audio_ingress_push_v1(handle, bytes.as_ptr(), bytes.len(), 16_000, 1, 0, 0) }
    }

    #[tokio::test]
    async fn native_pcm_reaches_local_vad_and_recognizer_restart_fences_old_handles() {
        let owner = VoiceChat::new(String::new());
        owner.use_vad();
        let input = owner.view().input_id;
        let first = owner.clone().open_audio_capture(input).unwrap();
        assert_eq!(capture(first, 8192), 0);
        wait_for_level(&owner, 0.25).await;
        let second = owner.clone().open_audio_capture(input).unwrap();
        owner.close_audio_capture(first); // late teardown must not close the replacement
        assert_eq!(capture(first, 32767), 3);
        assert_eq!(capture(second, 16384), 0);
        wait_for_level(&owner, 0.5).await;
        owner.close();
        assert_eq!(capture(second, 32767), 3);
        assert_eq!(owner.view().phase, VoiceChatPhase::Closed);
    }

    #[tokio::test]
    async fn rapid_mute_and_input_replacement_invalidate_capture_even_before_js_observes_them() {
        let owner = VoiceChat::new(String::new());
        owner.use_vad();
        let first = owner
            .clone()
            .open_audio_capture(owner.view().input_id)
            .unwrap();
        owner.set_muted(true);
        owner.set_muted(false);
        assert_eq!(capture(first, 32767), 3);
        let next = owner
            .clone()
            .open_audio_capture(owner.view().input_id)
            .unwrap();
        assert_eq!(capture(next, 8192), 0);
        wait_for_level(&owner, 0.25).await;
        owner.close();
    }
}
