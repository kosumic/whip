// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
// Adapted from Codex at 021fccb046508938c4754982efccfb51d6e8356e.
//! Owns the accelerated DTLS/SCTP peer and bounded native media ingress.
//! Typed events use sideband; Live readiness uses the primary start event.
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
pub enum AnswerOutcome {
    Ready,
    TimedOut,
}
pub struct Transport {
    pub incoming: Incoming,
    pub audio: AudioTrack,
    pub ready: watch::Receiver<bool>,
    pub primary_started: watch::Receiver<Option<String>>,
    pub failure: watch::Receiver<Option<&'static str>>,
    pub statistics: watch::Receiver<crate::health::Statistics>,
    pub prepared_client: bool,
    runtime: tokio::runtime::Handle,
    offer: String,
    commands: mpsc::Sender<Command>,
    stop: watch::Sender<bool>,
    worker: Option<JoinHandle<Result<(), &'static str>>>,
}
impl Transport {
    pub async fn new() -> Result<Self, &'static str> {
        Self::configured(crate::TransportConfig::default()).await
    }
    pub async fn configured(config: crate::TransportConfig) -> Result<Self, &'static str> {
        Self::with_config(config, None).await
    }
    #[cfg(test)]
    async fn with_protocol(protocol: Option<str0m::net::Protocol>) -> Result<Self, &'static str> {
        Self::with_config(
            crate::TransportConfig {
                first_event_kind: Some("session.started".into()),
                ..Default::default()
            },
            protocol,
        )
        .await
    }
    async fn with_config(
        config: crate::TransportConfig,
        protocol: Option<str0m::net::Protocol>,
    ) -> Result<Self, &'static str> {
        let (incoming, ingress) = Incoming::new();
        let (ready, connected) = watch::channel(false);
        let (primary_started, started) = watch::channel(None);
        let (failed, failure) = watch::channel(None);
        let (statistics_tx, statistics) = watch::channel(crate::health::Statistics::default());
        let (stop, stopped) = watch::channel(false);
        let (commands, command_rx) = mpsc::channel(8);
        let (driver, offer, prepared_client) = Driver::new(
            ingress,
            ready,
            primary_started,
            failed,
            statistics_tx,
            command_rx,
            stopped,
            protocol,
            config,
        )
        .await?;
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
            primary_started: started,
            failure,
            statistics,
            offer,
            runtime: tokio::runtime::Handle::current(),
            commands,
            stop,
            worker: Some(worker),
        })
    }
    pub fn offer(&self) -> String {
        self.offer.clone()
    }
    pub async fn apply_answer(&self, sdp: String) -> Result<AnswerOutcome, &'static str> {
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
    pub async fn close(&mut self) -> Result<(), &'static str> {
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
        if let Some(mut worker) = self.worker.take() {
            self.runtime.spawn(async move {
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
