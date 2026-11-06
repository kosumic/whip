//! One owner serializes every peer mutation and completely drains its output before the next.
use super::{audio_track::OPUS_PAYLOAD_TYPE, incoming::Ingress, network::Network};
use std::{sync::Arc, time::Instant};
use str0m::{
    Candidate, Event, Input, Output, Rtc, RtcConfig,
    change::{SdpAnswer, SdpPendingOffer},
    channel::ChannelId,
    crypto::dtls::DtlsVersion,
    media::{Direction, MediaKind, Mid},
    net::{Protocol, Receive},
    rtp::RtpWrite,
};
use tokio::sync::{mpsc, oneshot, watch};
pub(super) const DATA_CHANNEL_ID: u16 = 4;
const MAX_REMOTE_CANDIDATES: usize = 32;
const MAX_EVENT_BYTES: usize = 64 * 1024;
const DISCONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Default)]
struct ConnectionHealth {
    disconnected: Option<Instant>,
}
impl ConnectionHealth {
    fn observe(&mut self, state: str0m::IceConnectionState, now: Instant) {
        if state.is_connected() {
            self.disconnected = None;
        } else if state.is_disconnected() {
            self.disconnected.get_or_insert(now);
        }
    }
    fn deadline(&self, next: Instant) -> Instant {
        self.disconnected
            .map_or(next, |at| next.min(at + DISCONNECT_TIMEOUT))
    }
    fn check(&self, now: Instant) -> Result<(), &'static str> {
        if self
            .disconnected
            .is_some_and(|at| now.duration_since(at) >= DISCONNECT_TIMEOUT)
        {
            return Err("Voice network connection did not recover.");
        }
        Ok(())
    }
}
pub(super) enum Command {
    Answer {
        sdp: String,
        complete: oneshot::Sender<Result<(), &'static str>>,
    },
    Audio {
        data: Vec<u8>,
        timestamp: u32,
        at: Instant,
        complete: oneshot::Sender<Result<(), &'static str>>,
    },
}
pub(super) struct Driver {
    rtc: Rtc,
    network: Network,
    pending: Option<SdpPendingOffer>,
    mid: Mid,
    channel: ChannelId,
    sequence: u64,
    ingress: Ingress,
    ready: watch::Sender<bool>,
    failure: watch::Sender<Option<&'static str>>,
    health: ConnectionHealth,
    input_protocol: Option<Protocol>,
    commands: mpsc::Receiver<Command>,
    stop: watch::Receiver<bool>,
}
impl Driver {
    #[allow(
        clippy::significant_drop_tightening,
        reason = "network ownership moves into the peer driver; its sockets must remain open"
    )]
    pub async fn new(
        ingress: Ingress,
        ready: watch::Sender<bool>,
        failure: watch::Sender<Option<&'static str>>,
        commands: mpsc::Receiver<Command>,
        stop: watch::Receiver<bool>,
        protocol: Option<Protocol>,
    ) -> Result<(Self, String, bool), &'static str> {
        let mut network = Network::bind().await?;
        let candidates = network.candidates()?;
        let (rtc, pending, mid, channel, offer, prepared_client) =
            tracing::subscriber::with_default(
                tracing::subscriber::NoSubscriber::default(),
                || {
                    let material = super::prepared::take();
                    let prepared_client = material.is_some();
                    let config = match material {
                        Some(material) => RtcConfig::new()
                            .set_crypto_provider(material.provider)
                            .set_dtls_cert(material.certificate),
                        None => RtcConfig::new()
                            .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags())),
                    };
                    let mut rtc = config
                        .clear_codecs()
                        .enable_opus(true, false)
                        .set_dtls_version(DtlsVersion::Auto)
                        .set_snap_enabled(true)
                        .set_rtp_mode(true)
                        .set_sctp_max_message_size(
                            u32::try_from(MAX_EVENT_BYTES)
                                .map_err(|_| "Invalid voice event limit.")?,
                        )
                        .set_sctp_max_buffered_amount(MAX_EVENT_BYTES)
                        .build(Instant::now());
                    for candidate in candidates {
                        if protocol.is_none_or(|protocol| candidate.proto() == protocol) {
                            rtc.add_local_candidate(candidate)
                                .ok_or("Voice candidate was rejected.")?;
                            initial_drain(&mut rtc)?;
                        }
                    }
                    let mut change = rtc.sdp_api();
                    let mid =
                        change.add_media(MediaKind::Audio, Direction::SendRecv, None, None, None);
                    let channel = change.add_channel_with_config(str0m::channel::ChannelConfig {
                        label: "oai-events".into(),
                        negotiated: Some(DATA_CHANNEL_ID),
                        ..Default::default()
                    });
                    let (offer, pending) = change.apply().ok_or("Voice offer is unavailable.")?;
                    initial_drain(&mut rtc)?;
                    Ok::<_, &'static str>((
                        rtc,
                        pending,
                        mid,
                        channel,
                        offer.to_sdp_string(),
                        prepared_client,
                    ))
                },
            )?;
        network.start();
        let bytes = uuid::Uuid::new_v4();
        let bytes = bytes.as_bytes();
        let sequence = u64::from(u16::from_be_bytes([bytes[0], bytes[1]]));
        Ok((
            Self {
                rtc,
                network,
                pending: Some(pending),
                mid,
                channel,
                sequence,
                ingress,
                ready,
                failure,
                health: ConnectionHealth::default(),
                input_protocol: None,
                commands,
                stop,
            },
            offer,
            prepared_client,
        ))
    }
    pub async fn run(mut self) -> Result<(), &'static str> {
        let result = self.drive().await;
        let reason = result
            .as_ref()
            .err()
            .copied()
            .unwrap_or("Voice media connection closed.");
        if self.failure.borrow().is_none() {
            self.failure.send_replace(Some(reason));
        }
        if result.is_err() {
            crate::host_runtime::diagnostics::log_lifecycle(format_args!(
                "Voice WebRTC transport ended: {reason}"
            ));
        }
        self.ready.send_replace(false);
        self.network.close().await;
        result
    }
    async fn drive(&mut self) -> Result<(), &'static str> {
        let mut complete: Option<oneshot::Sender<Result<(), &'static str>>> = None;
        loop {
            self.health.check(Instant::now())?;
            let next = self.drain().await?;
            let deadline = self.health.deadline(next);
            if let Some(complete) = complete.take() {
                let _: Result<_, _> = complete.send(Ok(()));
            }
            if !self.rtc.is_alive() {
                return Err("Voice media connection ended.");
            }
            tokio::select! {
                biased;
                _=self.stop.changed()=>{
                    self.rtc.close().map_err(|_|"Voice peer could not close.")?;
                    self.drain().await?;
                    return Ok(());
                },
                command=self.commands.recv()=>match command {
                    Some(Command::Answer{sdp,complete:respond})=>{
                        let result=self.answer(&sdp);
                        if let Err(error)=result {let _=respond.send(Err(error));return Err(error);}
                        complete=Some(respond);
                    }
                    Some(Command::Audio{data,timestamp,at,complete:respond})=>{
                        if !*self.ready.borrow(){let _=respond.send(Err(self.failure.borrow().unwrap_or("Voice media is not connected.")));continue;}
                        let mut direct=self.rtc.direct_api();
                        let stream=direct.stream_tx_by_mid(self.mid,None).ok_or("Voice send stream is unavailable.")?;
                        stream.write_rtp(RtpWrite::new(OPUS_PAYLOAD_TYPE.into(),self.sequence.into(),timestamp,at,data));
                        self.sequence=self.sequence.checked_add(1).ok_or("Voice sequence exhausted.")?;
                        complete=Some(respond);
                    }
                    None=>return Ok(()),
                },
                packet=self.network.receive()=>{
                    let packet=packet?;
                    let Ok(contents)=packet.data.as_slice().try_into() else {continue;};
                    let input=Input::Receive(Instant::now(),Receive{proto:packet.proto,source:packet.source,destination:packet.destination,contents});
                    if self.rtc.accepts(&input) {
                        self.input_protocol = Some(packet.proto);
                        self.rtc.handle_input(input).map_err(|_|"Voice network packet was rejected.")?;
                    }
                },
                _=tokio::time::sleep_until(deadline.into())=>{
                    self.rtc.handle_input(Input::Timeout(Instant::now())).map_err(|_|"Voice peer timed out.")?;
                },
            }
        }
    }
    fn answer(&mut self, sdp: &str) -> Result<(), &'static str> {
        if sdp.len() > super::super::MAX_WIRE {
            return Err("Voice answer is too large.");
        }
        let mut count = 0;
        for line in sdp.lines().filter(|line| line.starts_with("a=candidate:")) {
            count += 1;
            if count > MAX_REMOTE_CANDIDATES {
                return Err("Too many voice candidates.");
            }
            Candidate::from_sdp_string(&line[2..]).map_err(|_| "Invalid voice candidate.")?;
        }
        let answer = SdpAnswer::from_sdp_string(sdp).map_err(|_| "Invalid voice answer.")?;
        let pending = self
            .pending
            .take()
            .ok_or("Voice answer was already applied.")?;
        self.rtc
            .sdp_api()
            .accept_answer(pending, answer)
            .map_err(|_| "Voice answer was rejected.")
    }
    async fn drain(&mut self) -> Result<Instant, &'static str> {
        loop {
            match self
                .rtc
                .poll_output()
                .map_err(|_| "Voice peer output failed.")?
            {
                Output::Timeout(deadline) => return Ok(deadline),
                Output::Transmit(packet) => self.network.send(packet).await?,
                Output::Event(Event::Connected) => {
                    if self.failure.borrow().is_none() {
                        self.ready.send_replace(true);
                    }
                }
                Output::Event(Event::IceConnectionStateChange(state)) => {
                    // ICE Disconnected is recoverable, unlike a closed peer.
                    // Keep this connection alive for its bounded recovery window.
                    self.health.observe(state, Instant::now());
                }
                Output::Event(Event::ChannelOpen(id, _)) if id != self.channel => {
                    self.rtc.direct_api().close_data_channel(id);
                }
                Output::Event(Event::ChannelClose(id)) if id == self.channel => {
                    // Like Codex's channel observer, report readiness loss to
                    // the call owner. Keep the peer alive until it retires the
                    // session and collects final usage on the sideband.
                    self.failure
                        .send_replace(Some("Voice event channel ended."));
                    self.ready.send_replace(false);
                }
                Output::Event(Event::RtpPacket(packet)) => {
                    self.ingress
                        .receive(packet, self.input_protocol == Some(Protocol::Tcp));
                }
                // Match Codex's voice host: the sideband owns typed events.
                // Mirrored data messages must never backpressure RTP/DTLS or
                // deliver an application command twice.
                Output::Event(_) => {}
            }
        }
    }
}
fn initial_drain(rtc: &mut Rtc) -> Result<(), &'static str> {
    loop {
        match rtc
            .poll_output()
            .map_err(|_| "Voice offer initialization failed.")?
        {
            Output::Timeout(_) => return Ok(()),
            Output::Event(_) => {}
            Output::Transmit(_) => return Err("Unexpected voice offer output."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ConnectionHealth, DISCONNECT_TIMEOUT};
    use std::time::{Duration, Instant};
    use str0m::IceConnectionState;

    #[test]
    fn a_transient_network_loss_can_recover_without_ending_the_call() {
        let start = Instant::now();
        let mut health = ConnectionHealth::default();
        health.observe(IceConnectionState::Disconnected, start);
        assert!(health.check(start + Duration::from_secs(1)).is_ok());
        health.observe(
            IceConnectionState::Connected,
            start + Duration::from_secs(1),
        );
        assert!(health.check(start + DISCONNECT_TIMEOUT).is_ok());
    }

    #[test]
    fn repeated_disconnect_notifications_cannot_extend_the_recovery_deadline() {
        let start = Instant::now();
        let mut health = ConnectionHealth::default();
        health.observe(IceConnectionState::Disconnected, start);
        health.observe(
            IceConnectionState::Disconnected,
            start + Duration::from_secs(1),
        );
        assert!(health.check(start + DISCONNECT_TIMEOUT).is_err());
    }
}
