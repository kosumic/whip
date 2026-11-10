//! Native 24kHz PCM/Opus bridge. Device callbacks and audio never cross JavaScript.
use super::{audio_track::EncodedAudio, playout::Playout, transport::Transport};
use crate::{Host, RATE, capture_worker};
use std::time::{Duration, Instant};
use tokio::sync::watch;

const FRAME_DURATION: Duration = capture_worker::PACKET_DURATION;

#[expect(
    clippy::significant_drop_tightening,
    reason = "The jitter buffer owns ingress permits across media ticks until the loop exits"
)]
pub async fn run(
    owner: &impl Host,
    peer: &mut Transport,
    mut stop: watch::Receiver<bool>,
) -> Result<(), &'static str> {
    let rate = u32::try_from(RATE).map_err(|_| "Invalid voice sample rate.")?;
    let mut encoder = opus::Encoder::new(rate, opus::Channels::Mono, opus::Application::Voip)
        .map_err(|_| "Voice encoder could not start.")?;
    let mut playout = Playout::new()?;
    let mut frame = ::audio_ingress::Packet::new(owner.packet_samples());
    let mut pending = capture_worker::Pending::new(owner);
    let mut encoded = vec![0; 1275];
    let mut last_silence = None::<Instant>;
    let mut tick = tokio::time::interval(Duration::from_millis(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if *stop.borrow() || !owner.current() {
            return Ok(());
        }
        if pending.refresh(owner)? {
            encoder
                .reset_state()
                .map_err(|_| "Voice encoder reset failed.")?;
        }
        tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            _ = tick.tick() => {
                if !*peer.ready.borrow() { return Err(peer.failure.borrow().unwrap_or("Realtime media connection ended.")); }
                if peer.statistics.has_changed().unwrap_or(false) {
                    let network = peer.statistics.borrow_and_update().clone();
                    owner.statistics(crate::Statistics { network: Some(network), ..Default::default() });
                }
                playout.tick(owner, &mut peer.incoming, Instant::now())?;
                if last_silence.is_none_or(|last| last.elapsed() >= FRAME_DURATION) && !owner.capture_enabled() {
                    tokio::select! {
                        biased;
                        _ = stop.changed() => return Ok(()),
                        result = peer.audio.send_muted_silence(Instant::now()) => result?,
                    }
                    last_silence = Some(Instant::now());
                }
                if !owner.current() { return Ok(()); }
            }
            _ = tokio::task::yield_now(), if pending.ready() => {
                if pending.refresh(owner)? { encoder.reset_state().map_err(|_| "Voice encoder reset failed.")?; }
                let Some(captured) = pending.take() else { continue; };
                if !captured.current(owner) { pending.reset(owner)?; encoder.reset_state().map_err(|_| "Voice encoder reset failed.")?; continue; }
                let count = encoder.encode(&captured.samples, &mut encoded).map_err(|_| "Voice encoding failed.")?;
                // A control may arrive while encoding. Never commit a second
                // old-generation packet after an in-flight send completes.
                if !captured.current(owner) { pending.reset(owner)?; encoder.reset_state().map_err(|_| "Voice encoder reset failed.")?; continue; }
                tokio::select! {
                    biased;
                    _ = stop.changed() => return Ok(()),
                    result = peer.audio.send(EncodedAudio { data: encoded[..count].to_vec(), at: captured.at }) => result?,
                }
                owner.uploaded();
                last_silence = Some(Instant::now());
            }
            captured = owner.next_capture(&mut frame), if !pending.ready() => {
                if captured? { pending.reset(owner)?; encoder.reset_state().map_err(|_| "Voice encoder reset failed.")?; }
                if pending.refresh(owner)? { encoder.reset_state().map_err(|_| "Voice encoder reset failed.")?; }
                owner.process_capture(&mut frame)?;
                pending.push(&frame)?;
            }
        }
    }
}
