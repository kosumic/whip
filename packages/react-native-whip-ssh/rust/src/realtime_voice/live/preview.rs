//! Whip's bounded playback-only sample over the shared provider driver.
use super::{update_usage, usage};
use crate::realtime_voice::{
    Config, PREVIEW_AUDIO_LIMIT, PREVIEW_TIMEOUT, RealtimeVoiceAdapter, bounded_text,
};
use oai_rt_rs::live::{self as api, Command, Nullable, ServerEvent};
use parking_lot::Mutex;
use std::{
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};
use voice_call_media::Capture;
use voice_call_openai::session::{Audio, Delegate, Event, Flow, Session};
const QUIET: Duration = Duration::from_secs(2);
const AUDIBLE: u16 = 64;
const REQUEST: &str = "Speak the preview sample in your startup developer message now, exactly once, in its original language, then remain silent. Do not delegate work.";
#[derive(Default)]
struct Sample {
    last_sound: Option<Instant>,
}
impl Sample {
    fn observe(&mut self, pcm: &[u8], now: Instant) {
        if pcm
            .as_chunks::<2>()
            .0
            .iter()
            .any(|sample| i16::from_le_bytes([sample[0], sample[1]]).unsigned_abs() >= AUDIBLE)
        {
            self.last_sound = Some(now);
        }
    }
    fn quiet(&self, now: Instant) -> bool {
        self.last_sound
            .is_some_and(|last| now.duration_since(last) >= QUIET)
    }
}

struct PreviewAudio<'a> {
    owner: &'a RealtimeVoiceAdapter,
    sample: Mutex<Sample>,
}
impl Capture for PreviewAudio<'_> {
    fn packet_samples(&self) -> usize {
        self.owner.packet_samples()
    }
    fn generation(&self) -> u64 {
        self.owner.generation()
    }
    fn accepts(&self, generation: u64) -> bool {
        self.owner.accepts(generation)
    }
    fn capture_enabled(&self) -> bool {
        false
    }
    fn recover(&self) -> bool {
        self.owner.recover()
    }
    fn reset_capture(&self) -> Result<(), &'static str> {
        self.owner.reset_capture()
    }
    async fn next_capture(&self, packet: &mut audio_ingress::Packet) -> Result<bool, &'static str> {
        self.owner.next_capture(packet).await
    }
    fn process_capture(&self, packet: &mut audio_ingress::Packet) -> Result<(), &'static str> {
        self.owner.process_capture(packet)
    }
}
impl Audio for PreviewAudio<'_> {
    fn is_muted(&self) -> bool {
        true
    }
    fn current(&self) -> bool {
        Audio::current(self.owner)
    }
    fn set_muted(&self, muted: bool) -> Result<(), &'static str> {
        self.owner.set_muted(muted)
    }
    fn interrupt(&self) -> Option<voice_call_openai::ClientEvent> {
        Audio::interrupt(self.owner)
    }
    fn render_pcm(&self, _item: String, _index: u32, pcm: Vec<u8>) -> Result<(), &'static str> {
        if !pcm.len().is_multiple_of(2) {
            return Err("GPT-Live returned invalid preview audio.");
        }
        let quiet = {
            let mut sample = self.sample.lock();
            sample.observe(&pcm, Instant::now());
            sample.quiet(Instant::now())
        };
        if !quiet {
            let mut output = self.owner.output.lock();
            if output.generated + pcm.len() / 2 > PREVIEW_AUDIO_LIMIT {
                return Err("Voice preview exceeded its audio limit.");
            }
            output.append("live-preview".into(), 0, pcm)?;
        }
        Ok(())
    }
    fn cancel_audio(&self, response: Option<&str>) {
        Audio::cancel_audio(self.owner, response);
    }
    fn resume_live_audio(&self) {
        Audio::resume_live_audio(self.owner);
    }
    fn confirm_live_closed(&self) {
        Audio::confirm_live_closed(self.owner);
    }
    fn uploaded(&self) {
        Audio::uploaded(self.owner);
    }
}
struct Preview<'a> {
    owner: &'a Arc<RealtimeVoiceAdapter>,
    audio: &'a PreviewAudio<'a>,
    usage: &'a mut usage::Usage,
    commands: mpsc::Receiver<super::super::Command>,
    cancelled: watch::Receiver<bool>,
    started: Instant,
}
impl Delegate for Preview<'_> {
    type Work = ();
    async fn next_work(&mut self) -> Option<()> {
        tokio::select! {biased; _=self.cancelled.changed()=>None,_=self.commands.recv()=>None,}
    }
    fn work(
        &mut self,
        _: &mut Session<'_>,
        _: (),
    ) -> impl std::future::Future<Output = Result<Flow, &'static str>> + Send {
        std::future::ready(Ok(Flow::Stop))
    }
    async fn event(
        &mut self,
        session: &mut Session<'_>,
        event: Event,
    ) -> Result<Flow, &'static str> {
        let Event::Live(frame) = event else {
            return Err("Invalid preview protocol.");
        };
        self.owner.view.lock().server_events += 1;
        match frame.event {
            ServerEvent::Started { .. } => {
                self.owner.view.lock().media_ready = true;
                self.owner.view.lock().phase = "muted";
                self.owner.ready.store(true, Ordering::Release);
                session.mute(self.audio, true).await?;
                session
                    .send_live(Command::CommentaryAppend {
                        content: REQUEST.into(),
                        delegation_id: Nullable(None),
                    })
                    .await?;
            }
            ServerEvent::UsageUpdated {
                usage: reported, ..
            } => {
                self.usage.observe(reported.seconds, false)?;
                update_usage(self.owner, self.usage);
            }
            ServerEvent::OutputTranscriptDelta { delta, .. } => {
                bounded_text(&mut self.owner.view.lock().text, &delta);
            }
            ServerEvent::Closed {
                usage: reported,
                reason,
                ..
            } => {
                self.usage
                    .observe(reported.seconds, reason != api::CloseReason::ConnectionLost)?;
                return Err("GPT-Live closed before the voice preview finished.");
            }
            ServerEvent::DelegationCreated { .. } => {
                return Err("Voice previews cannot delegate work.");
            }
            _ => {}
        }
        Ok(Flow::Continue)
    }
    fn tick(
        &mut self,
        session: &mut Session<'_>,
    ) -> impl std::future::Future<Output = Result<Flow, &'static str>> + Send {
        std::future::ready(self.tick_state(session))
    }
}
impl Preview<'_> {
    fn tick_state(&mut self, session: &Session<'_>) -> Result<Flow, &'static str> {
        if !self.owner.speech.is_current() {
            return Err("Voice preview was replaced by another speech session.");
        }
        if self.started.elapsed() > PREVIEW_TIMEOUT {
            return Err("Voice preview timed out. Please try again.");
        }
        if !session.ready() {
            return Ok(Flow::Continue);
        }
        let drained = {
            let output = self.owner.output.lock();
            output.generated == output.played
        };
        if self.audio.sample.lock().quiet(Instant::now()) && drained {
            return Ok(Flow::Stop);
        }
        self.owner.view.lock().phase = if drained { "muted" } else { "speaking" };
        Ok(Flow::Continue)
    }
}
pub(super) async fn drive(
    owner: &Arc<RealtimeVoiceAdapter>,
    _config: &Config,
    session: &mut Session<'_>,
    usage: &mut usage::Usage,
    commands: mpsc::Receiver<super::super::Command>,
) -> Result<(), &'static str> {
    let audio = PreviewAudio {
        owner,
        sample: Mutex::new(Sample::default()),
    };
    let mut app = Preview {
        owner,
        audio: &audio,
        usage,
        commands,
        cancelled: owner.cancel.subscribe(),
        started: Instant::now(),
    };
    session.drive(&audio, &mut app).await
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_does_not_complete_an_empty_preview_and_speech_resets_quiet() {
        let start = Instant::now();
        let mut sample = Sample::default();
        sample.observe(&[0; 100], start);
        assert!(!sample.quiet(start + QUIET));
        sample.observe(&1000_i16.to_le_bytes(), start);
        sample.observe(&[0; 100], start + QUIET);
        assert!(sample.quiet(start + QUIET));
        sample.observe(&i16::MIN.to_le_bytes(), start + QUIET);
        assert!(!sample.quiet(start + QUIET));
        assert!(sample.quiet(start + QUIET * 2));
    }
}
