//! A playback-only Live session: paced silence in, one bounded sample out.
use super::{State, codec, send, update_usage, usage};
use crate::realtime_voice::{
    Config, FRAME, PREVIEW_AUDIO_LIMIT, PREVIEW_TIMEOUT, RealtimeVoiceAdapter, bounded_text,
    capture_worker, socket::RawSocket,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures::{SinkExt, StreamExt};
use oai_rt_rs::live::{self as api, Command, Nullable, ServerEvent};
use std::{
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const QUIET: Duration = Duration::from_secs(2);
const AUDIBLE: u16 = 64;
// Keep the commentary append below Live's 500-token limit even when the
// editable sample contains multibyte text; the sample is already in input.
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

pub(super) async fn drive(
    owner: &Arc<RealtimeVoiceAdapter>,
    config: &Config,
    socket: &mut RawSocket,
    state: &mut State,
    usage: &mut usage::Usage,
    mut commands: mpsc::Receiver<super::super::Command>,
) -> Result<(), &'static str> {
    let mut cancelled = owner.cancel.subscribe();
    let started = Instant::now();
    let mut tick = tokio::time::interval(capture_worker::PACKET_DURATION);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let silence = STANDARD.encode([0_u8; FRAME * 2]);
    let mut sample = Sample::default();
    loop {
        if owner.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        tokio::select! {
            biased;
            _ = cancelled.changed() => return Ok(()),
            // Preview never admits microphone, typed input, tools, or agent work.
            _ = commands.recv() => return Ok(()),
            frame = socket.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    let frame = codec().decode_server(&text).map_err(|_| "GPT-Live returned an invalid preview event.")?;
                    if !state.unique(&frame)? { continue; }
                    owner.view.lock().server_events += 1;
                    match frame.event {
                        ServerEvent::Started { session, .. } => {
                            if state.session_id.is_some() { return Err("GPT-Live preview started more than once."); }
                            state.pin_session(&session, config)?;
                            owner.view.lock().media_ready = true;
                            owner.view.lock().phase = "muted";
                            owner.ready.store(true, Ordering::Release);
                            send(socket, Command::InputAudioMute).await?;
                            send(socket, Command::CommentaryAppend {
                                content: REQUEST.into(), delegation_id: Nullable(None),
                            }).await?;
                        }
                        _ if state.session_id.is_none() => return Err("GPT-Live preview did not start correctly."),
                        ServerEvent::Updated { session, .. } => state.pin_session(&session, config)?,
                        ServerEvent::UsageUpdated { usage: reported, .. } => {
                            usage.observe(reported.seconds, false)?;
                            update_usage(owner, usage);
                        }
                        ServerEvent::OutputAudioDelta { delta, .. } => {
                            let pcm = STANDARD.decode(delta).map_err(|_| "GPT-Live returned invalid preview audio.")?;
                            if !pcm.len().is_multiple_of(2) { return Err("GPT-Live returned invalid preview audio."); }
                            sample.observe(&pcm, Instant::now());
                            // Live may stream silence continuously. Stop admitting that
                            // silence once quiet, so the actual device queue can drain.
                            if !sample.quiet(Instant::now()) {
                                let mut output = owner.output.lock();
                                if output.generated + pcm.len() / 2 > PREVIEW_AUDIO_LIMIT {
                                    return Err("Voice preview exceeded its audio limit.");
                                }
                                output.append("live-preview".into(), 0, pcm)?;
                            }
                        }
                        ServerEvent::OutputTranscriptDelta { delta, .. } => bounded_text(&mut owner.view.lock().text, &delta),
                        ServerEvent::Closed { session, usage: reported, reason, .. } => {
                            state.pin_session(&session, config)?;
                            usage.observe(reported.seconds, reason != api::CloseReason::ConnectionLost)?;
                            return Err("GPT-Live closed before the voice preview finished.");
                        }
                        ServerEvent::DelegationCreated { .. } => return Err("Voice previews cannot delegate work."),
                        ServerEvent::Error { .. } => return Err("GPT-Live rejected the voice preview."),
                        _ => {}
                    }
                }
                Some(Ok(Message::Ping(bytes))) => {
                    tokio::time::timeout(capture_worker::SEND_TIMEOUT, socket.send(Message::Pong(bytes)))
                        .await.map_err(|_| "GPT-Live preview upload timed out.")?
                        .map_err(|_| "GPT-Live preview disconnected.")?;
                }
                Some(Ok(Message::Close(_)) | Err(_)) | None => return Err("GPT-Live preview disconnected."),
                _ => {}
            },
            _ = tick.tick() => {
                if !owner.speech.is_current() { return Err("Voice preview was replaced by another speech session."); }
                if started.elapsed() > PREVIEW_TIMEOUT { return Err("Voice preview timed out. Please try again."); }
                if state.session_id.is_none() { continue; }
                let drained = { let output = owner.output.lock(); output.generated == output.played };
                // Live has no audio-done event. Quiet plus native playback receipts
                // gives this short sample a bounded, conservative completion point.
                if sample.quiet(Instant::now()) && drained { return Ok(()); }
                owner.view.lock().phase = if drained { "muted" } else { "speaking" };
                send(socket, Command::InputAudioAppend { audio: silence.clone() }).await?;
                owner.view.lock().uploaded_packets += 1;
            },
        }
    }
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
