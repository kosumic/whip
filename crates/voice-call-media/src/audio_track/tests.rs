use super::{AudioTrack, EncodedAudio, SEND_TIMEOUT};
use crate::driver::Command;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};

#[tokio::test]
async fn capture_jitter_and_mute_preserve_the_twenty_ms_source_grid() -> Result<(), &'static str> {
    let (sender, mut receiver) = mpsc::channel(8);
    let output = tokio::spawn(async move {
        let mut frames = Vec::new();
        while let Some(Command::Audio {
            data,
            timestamp,
            complete,
            ..
        }) = receiver.recv().await
        {
            frames.push((timestamp, data));
            let _ = complete.send(Ok(()));
        }
        frames
    });
    let (_failure, failed) = watch::channel(None);
    let mut audio = AudioTrack::new(sender, failed);
    let start = Instant::now();
    let speech = vec![0xf8, 0xff, 0xfe];
    for offset in [0, 23, 41, 61, 82] {
        audio
            .send(EncodedAudio {
                data: speech.clone(),
                at: start + Duration::from_millis(offset),
            })
            .await?;
    }
    // No duplicate packet when capture and the muted ticker share one interval.
    audio
        .send_muted_silence(start + Duration::from_millis(90))
        .await?;
    audio
        .send_muted_silence(start + Duration::from_millis(103))
        .await?;
    // A longer callback gap advances whole source packets without synthetic loss.
    audio
        .send(EncodedAudio {
            data: speech,
            at: start + Duration::from_millis(185),
        })
        .await?;
    drop(audio);
    let frames = output.await.map_err(|_| "sender task failed")?;
    assert_eq!(
        frames.iter().map(|frame| frame.0).collect::<Vec<_>>(),
        [0, 960, 1920, 2880, 3840, 4800, 8640]
    );
    let mut decoder =
        opus::Decoder::new(24_000, opus::Channels::Mono).map_err(|_| "decoder failed")?;
    let mut pcm = [0; 480];
    assert_eq!(
        decoder
            .decode(&frames[5].1, &mut pcm, false)
            .map_err(|_| "invalid muted Opus")?,
        480
    );
    assert!(pcm.iter().all(|sample| sample.abs() < 8));
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn stalled_sender_ends_within_the_capture_deadline() {
    let (sender, _receiver) = mpsc::channel(1);
    let (_failure, failed) = watch::channel(None);
    let mut audio = AudioTrack::new(sender, failed);
    let start = tokio::time::Instant::now();
    assert_eq!(
        audio
            .send(EncodedAudio {
                data: vec![0xf8, 0xff, 0xfe],
                at: Instant::now()
            })
            .await,
        Err("voice audio sender stalled")
    );
    assert!(start.elapsed() <= SEND_TIMEOUT);
}

#[tokio::test]
async fn transport_failure_survives_an_in_flight_audio_acknowledgement() -> Result<(), &'static str>
{
    let (sender, mut receiver) = mpsc::channel(1);
    let (failure, failed) = watch::channel(None);
    let worker = tokio::spawn(async move {
        let Some(Command::Audio { complete, .. }) = receiver.recv().await else {
            return Err("No audio frame");
        };
        drop(complete);
        tokio::task::yield_now().await;
        failure.send_replace(Some("Voice UDP send failed."));
        Ok(())
    });
    let mut audio = AudioTrack::new(sender, failed);
    assert_eq!(
        audio.send_muted_silence(Instant::now()).await,
        Err("Voice UDP send failed.")
    );
    worker.await.map_err(|_| "Transport fixture failed")??;
    Ok(())
}
