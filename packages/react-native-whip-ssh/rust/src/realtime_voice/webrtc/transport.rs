// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
// Adapted from Codex at 021fccb046508938c4754982efccfb51d6e8356e.
//! Owns the accelerated DTLS/SCTP peer and bounded native media ingress.
//! Typed events belong exclusively to the WebSocket sideband, as in Codex.
use super::{
    audio_track::AudioTrack,
    driver::{Command, Driver},
    incoming::Incoming,
};
use std::time::Duration;
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use tracing::instrument::WithSubscriber;
const WAIT: Duration = Duration::from_secs(15);
const CLOSE_WAIT: Duration = Duration::from_secs(3);
#[derive(Debug, PartialEq)]
pub(crate) enum AnswerOutcome {
    Ready,
    TimedOut,
}
pub(crate) struct Transport {
    pub(crate) incoming: Incoming,
    pub(crate) audio: AudioTrack,
    pub(crate) ready: watch::Receiver<bool>,
    pub(super) failure: watch::Receiver<Option<&'static str>>,
    pub(crate) prepared_client: bool,
    offer: String,
    commands: mpsc::Sender<Command>,
    stop: watch::Sender<bool>,
    worker: Option<JoinHandle<Result<(), &'static str>>>,
}
impl Transport {
    pub(crate) async fn new() -> Result<Self, &'static str> {
        Self::with_protocol(None).await
    }
    pub(super) async fn with_protocol(
        protocol: Option<str0m::net::Protocol>,
    ) -> Result<Self, &'static str> {
        let (incoming, ingress) = Incoming::new();
        let (ready, connected) = watch::channel(false);
        let (failed, failure) = watch::channel(None);
        let (stop, stopped) = watch::channel(false);
        let (commands, command_rx) = mpsc::channel(8);
        let (driver, offer, prepared_client) =
            Driver::new(ingress, ready, failed, command_rx, stopped, protocol).await?;
        // Transport dependencies must never emit wire payloads, SDP, or keys,
        // including when a host application installs a tracing subscriber.
        let worker = tokio::spawn(
            driver
                .run()
                .with_subscriber(tracing::subscriber::NoSubscriber::default()),
        );
        Ok(Self {
            incoming,
            prepared_client,
            audio: AudioTrack::new(commands.clone(), failure.clone()),
            ready: connected,
            failure,
            offer,
            commands,
            stop,
            worker: Some(worker),
        })
    }
    pub(crate) fn offer(&self) -> String {
        self.offer.clone()
    }
    pub(crate) async fn apply_answer(&self, sdp: String) -> Result<AnswerOutcome, &'static str> {
        let (complete, result) = oneshot::channel();
        self.commands
            .send(Command::Answer { sdp, complete })
            .await
            .map_err(|_| "Voice peer ended.")?;
        result.await.map_err(|_| "Voice answer failed.")??;
        match tokio::time::timeout(WAIT, self.ready.clone().wait_for(|ready| *ready)).await {
            Ok(Ok(_)) => Ok(AnswerOutcome::Ready),
            Ok(Err(_)) => Err("Voice media connection closed."),
            Err(_) => Ok(AnswerOutcome::TimedOut),
        }
    }
    pub(crate) async fn close(&mut self) -> Result<(), &'static str> {
        self.stop.send_replace(true);
        if let Some(mut worker) = self.worker.take() {
            match tokio::time::timeout(CLOSE_WAIT, &mut worker).await {
                Ok(Ok(_)) => {}
                Ok(Err(_)) => return Err("Voice peer cleanup failed."),
                Err(_) => {
                    worker.abort();
                    let _ = worker.await;
                    return Err("Voice peer cleanup timed out.");
                }
            }
        }
        Ok(())
    }
}
impl Drop for Transport {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        if let Some(mut worker) = self.worker.take()
            && let Ok(runtime) = crate::runtime()
        {
            runtime.spawn(async move {
                if tokio::time::timeout(CLOSE_WAIT, &mut worker).await.is_err() {
                    worker.abort();
                    let _ = worker.await;
                }
            });
        }
    }
}
#[cfg(test)]
mod tests;
