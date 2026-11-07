#![allow(dead_code)]
//! Deterministic packet scheduler around real ICE, DTLS, SCTP and SRTP peers.
//! The clock is simulated; certificates, authentication and encryption are real.
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use str0m::{
    Candidate, Event, Input, Output, Rtc, RtcConfig,
    channel::{ChannelConfig, ChannelId},
    crypto::{
        CryptoProvider,
        dtls::{DtlsCert, DtlsVersion},
    },
    media::{Direction, MediaKind, Mid},
    net::{Protocol, Receive},
    rtp::RtpWrite,
};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub const CHANNEL: u16 = 4;
const PAYLOAD: u8 = 111;
const DEADLINE: Duration = Duration::from_secs(15);
const OPUS_SILENCE: [u8; 3] = [0xf8, 0xff, 0xfe];

#[derive(Clone, Copy)]
pub struct Options {
    pub sped: bool,
    pub remote_sped: bool,
    pub protocol: Protocol,
    pub rtt: Duration,
    /// Drop every Nth UDP datagram (0 disables). TCP is reliable.
    pub loss_every: usize,
    /// A peer advertises SPED but does not consume embedded handshake packets.
    pub blackhole_sped: bool,
    pub answer_delay: Duration,
    pub bad_fingerprint: bool,
    pub remote_dtls_client: bool,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            sped: true,
            remote_sped: true,
            protocol: Protocol::Udp,
            rtt: Duration::from_millis(40),
            loss_every: 0,
            blackhole_sped: false,
            answer_delay: Duration::ZERO,
            bad_fingerprint: false,
            remote_dtls_client: false,
        }
    }
}
#[derive(Default, Clone, Debug)]
pub struct Stages {
    pub ice: Option<Duration>,
    pub dtls_start: Option<Duration>,
    pub authenticated: Option<Duration>,
    pub channel: Option<Duration>,
    pub channel_open: Option<Duration>,
    pub first_rtp: Option<Duration>,
    pub ready: Option<Duration>,
}
pub struct Peer {
    pub rtc: Rtc,
    pub stages: Stages,
    pub address: SocketAddr,
    pub channel: Option<ChannelId>,
    mid: Option<Mid>,
    next_audio: Option<Instant>,
    audio_sequence: u64,
    event_sent: bool,
    pub event_received: bool,
}
struct Packet {
    at: Instant,
    to: usize,
    protocol: Protocol,
    source: SocketAddr,
    destination: SocketAddr,
    bytes: Vec<u8>,
}
pub struct Pair {
    pub peers: [Peer; 2],
    pub start: Instant,
    pub now: Instant,
    options: Options,
    answer: Option<(str0m::change::SdpPendingOffer, str0m::change::SdpAnswer)>,
    packets: Vec<Packet>,
    sequence: usize,
    pub dropped: usize,
    pub embedded: usize,
    pub max_packet: usize,
}
pub fn material() -> Result<(Arc<CryptoProvider>, [DtlsCert; 2])> {
    let provider = Arc::new(str0m::crypto::from_feature_flags());
    let cert = || -> Result<DtlsCert> {
        provider
            .dtls_provider
            .generate_certificate()
            .ok_or_else(|| "No certificate".into())
    };
    let certificates = [cert()?, cert()?];
    Ok((provider, certificates))
}
impl Pair {
    pub fn new(
        options: Options,
        prepared: Option<(Arc<CryptoProvider>, [DtlsCert; 2])>,
    ) -> Result<Self> {
        let (provider, certificates) = match prepared {
            Some(material) => material,
            None => material()?,
        };
        let start = Instant::now();
        let mut addresses: [SocketAddr; 2] =
            ["192.0.2.1:10000".parse()?, "192.0.2.2:20000".parse()?];
        if options.protocol == Protocol::Tcp {
            addresses[0].set_port(9);
        }
        let mut peers = Vec::new();
        for (index, certificate) in certificates.into_iter().enumerate() {
            let config = RtcConfig::new()
                .set_crypto_provider(provider.clone())
                .set_dtls_cert(certificate)
                .clear_codecs()
                .enable_opus(true, false)
                .set_rtp_mode(true)
                .set_dtls_version(DtlsVersion::Auto)
                .set_snap_enabled(true)
                .set_ice_lite(index == 1 && !options.remote_dtls_client);
            #[cfg(feature = "sped-benchmark")]
            let config = config.set_sped_enabled(if index == 0 {
                options.sped
            } else {
                options.remote_sped && !options.blackhole_sped
            });
            let mut rtc = config.build(start);
            let candidate = if options.protocol == Protocol::Tcp {
                Candidate::builder()
                    .tcp()
                    .host(addresses[index])
                    .tcptype(if index == 0 {
                        str0m::net::TcpType::Active
                    } else {
                        str0m::net::TcpType::Passive
                    })
                    .build()?
            } else {
                Candidate::host(addresses[index], "udp")?
            };
            rtc.add_local_candidate(candidate)
                .ok_or("Candidate rejected")?;
            peers.push(Peer {
                rtc,
                address: addresses[index],
                stages: Stages::default(),
                channel: None,
                mid: None,
                next_audio: None,
                audio_sequence: 1,
                event_sent: false,
                event_received: false,
            });
        }
        let mut peers: [Peer; 2] = peers.try_into().map_err(|_| "Peer count")?;
        let mut changes = peers[0].rtc.sdp_api();
        let mid = changes.add_media(MediaKind::Audio, Direction::SendRecv, None, None, None);
        let channel = changes.add_channel_with_config(ChannelConfig {
            label: "events".into(),
            negotiated: Some(CHANNEL),
            ..Default::default()
        });
        let (offer, pending) = changes.apply().ok_or("Missing offer")?;
        peers[0].mid = Some(mid);
        peers[0].channel = Some(channel);
        peers[1].channel = Some(
            peers[1]
                .rtc
                .direct_api()
                .create_data_channel(ChannelConfig {
                    label: "events".into(),
                    negotiated: Some(CHANNEL),
                    ..Default::default()
                }),
        );
        if options.remote_dtls_client {
            peers[1].rtc.direct_api().start_dtls(true)?;
        }
        let answer = peers[1].rtc.sdp_api().accept_offer(offer)?;
        let answer = if options.blackhole_sped {
            str0m::change::SdpAnswer::from_sdp_string(
                &answer
                    .to_sdp_string()
                    .replace("a=ice-options:trickle", "a=ice-options:trickle sped"),
            )?
        } else {
            answer
        };
        let answer = if options.bad_fingerprint {
            let text = answer.to_sdp_string();
            let fingerprint = text
                .lines()
                .find_map(|line| line.strip_prefix("a=fingerprint:sha-256 "))
                .ok_or("No fingerprint")?;
            let wrong = if fingerprint.starts_with("00") {
                "11"
            } else {
                "00"
            };
            str0m::change::SdpAnswer::from_sdp_string(
                &text.replace(fingerprint, &format!("{wrong}{}", &fingerprint[2..])),
            )?
        } else {
            answer
        };
        let answer = if options.answer_delay.is_zero() {
            peers[0].rtc.sdp_api().accept_answer(pending, answer)?;
            None
        } else {
            Some((pending, answer))
        };
        let mut pair = Self {
            peers,
            start,
            now: start,
            options,
            answer,
            packets: vec![],
            sequence: 0,
            dropped: 0,
            embedded: 0,
            max_packet: 0,
        };
        for peer in &mut pair.peers {
            peer.rtc.handle_input(Input::Timeout(start))?;
        }
        Ok(pair)
    }
    pub fn fell_back(&self) -> bool {
        #[cfg(feature = "sped-benchmark")]
        {
            self.peers[0].rtc.sped_stats().fallback.is_some()
        }
        #[cfg(not(feature = "sped-benchmark"))]
        {
            false
        }
    }
    pub fn negotiated(&self) -> bool {
        #[cfg(feature = "sped-benchmark")]
        {
            self.peers[0].rtc.sped_stats().negotiated
        }
        #[cfg(not(feature = "sped-benchmark"))]
        {
            false
        }
    }
    pub fn restart_ice(&mut self) -> Result<()> {
        let mut changes = self.peers[0].rtc.sdp_api();
        changes.ice_restart(true);
        let (offer, pending) = changes.apply().ok_or("Missing restart offer")?;
        let answer = self.peers[1].rtc.sdp_api().accept_offer(offer)?;
        self.peers[0].rtc.sdp_api().accept_answer(pending, answer)?;
        for peer in &mut self.peers {
            peer.stages.first_rtp = None;
            peer.next_audio = None;
        }
        Ok(())
    }
    pub fn change_path(&mut self) -> Result<()> {
        let old = Candidate::host(self.peers[0].address, "udp")?;
        self.peers[0].rtc.direct_api().invalidate_candidate(&old);
        self.peers[1].rtc.direct_api().invalidate_candidate(&old);
        let address = "192.0.2.3:30000".parse()?;
        let candidate = Candidate::host(address, "udp")?;
        self.peers[0]
            .rtc
            .add_local_candidate(candidate.clone())
            .ok_or("Path candidate rejected")?;
        self.peers[1].rtc.add_remote_candidate(candidate);
        self.peers[0].address = address;
        Ok(())
    }
    pub fn complete(&self) -> bool {
        self.peers
            .iter()
            .all(|peer| peer.stages.first_rtp.is_some() && peer.event_received)
    }
    pub fn run(&mut self) -> Result<()> {
        while !self.complete() {
            self.step()?;
        }
        Ok(())
    }
    pub fn step(&mut self) -> Result<()> {
        if self.now.duration_since(self.start) >= self.options.answer_delay
            && let Some((pending, answer)) = self.answer.take()
        {
            self.peers[0].rtc.sdp_api().accept_answer(pending, answer)?;
        }
        if self.now.duration_since(self.start) > DEADLINE {
            return Err(format!(
                "Handshake deadline: {:?} / {:?}",
                self.peers[0].stages, self.peers[1].stages
            )
            .into());
        }
        let mut next = self.now + Duration::from_millis(10);
        for index in 0..2 {
            loop {
                match self.peers[index].rtc.poll_output()? {
                    Output::Timeout(at) => {
                        next = next.min(at);
                        break;
                    }
                    Output::Transmit(packet) => {
                        let bytes = packet.contents.to_vec();
                        let dtls = is_dtls(&bytes) || embedded_dtls(&bytes).is_some();
                        if dtls {
                            self.peers[index]
                                .stages
                                .dtls_start
                                .get_or_insert(self.now.duration_since(self.start));
                        }
                        if embedded_dtls(&bytes).is_some() {
                            self.embedded += 1;
                        }
                        self.max_packet = self.max_packet.max(bytes.len());
                        self.sequence += 1;
                        if self.options.protocol == Protocol::Udp
                            && self.options.loss_every > 0
                            && self.sequence.is_multiple_of(self.options.loss_every)
                        {
                            self.dropped += 1;
                            continue;
                        }
                        // Exercise RFC 4571 framing and deframing, not a TCP stack.
                        let bytes = if packet.proto == Protocol::Tcp {
                            let mut frame = u16::try_from(bytes.len())?.to_be_bytes().to_vec();
                            frame.extend(bytes);
                            let size = usize::from(u16::from_be_bytes([frame[0], frame[1]]));
                            frame[2..2 + size].to_vec()
                        } else {
                            bytes
                        };
                        self.packets.push(Packet {
                            at: self.now + self.options.rtt / 2,
                            to: 1 - index,
                            protocol: packet.proto,
                            source: packet.source,
                            destination: packet.destination,
                            bytes,
                        });
                    }
                    Output::Event(event) => {
                        let elapsed = self.now.duration_since(self.start);
                        let peer = &mut self.peers[index];
                        match event {
                            Event::IceConnectionStateChange(state) if state.is_connected() => {
                                peer.stages.ice.get_or_insert(elapsed);
                            }
                            Event::Connected => {
                                peer.stages.authenticated.get_or_insert(elapsed);
                                peer.stages.ready.get_or_insert(elapsed);
                                if peer.stages.channel_open.is_some() {
                                    peer.stages.channel.get_or_insert(elapsed);
                                }
                            }
                            Event::ChannelOpen(id, _) => {
                                peer.channel = Some(id);
                                peer.stages.channel_open.get_or_insert(elapsed);
                                if peer.stages.ready.is_some() {
                                    peer.stages.channel.get_or_insert(elapsed);
                                }
                            }
                            Event::MediaAdded(media) => {
                                peer.mid = Some(media.mid);
                            }
                            Event::RtpPacket(packet) => {
                                if packet.payload.as_ref() != OPUS_SILENCE {
                                    return Err("Incorrect authenticated RTP payload".into());
                                }
                                peer.stages.first_rtp.get_or_insert(elapsed);
                            }
                            Event::ChannelData(data) => {
                                if data.data != b"authenticated-event" {
                                    return Err("Incorrect data channel payload".into());
                                }
                                peer.event_received = true;
                            }
                            _ => {}
                        }
                    }
                }
                #[cfg(feature = "sped-benchmark")]
                if self.peers[index].rtc.is_dtls_connected() {
                    self.peers[index]
                        .stages
                        .authenticated
                        .get_or_insert(self.now.duration_since(self.start));
                }
            }
            let peer = &mut self.peers[index];
            if peer.stages.ready.is_some() && peer.next_audio.is_none_or(|at| self.now >= at) {
                let mid = peer.mid.ok_or("No audio MID")?;
                peer.rtc
                    .direct_api()
                    .stream_tx_by_mid(mid, None)
                    .ok_or("No RTP stream")?
                    .write_rtp(RtpWrite::new(
                        PAYLOAD.into(),
                        peer.audio_sequence.into(),
                        u32::try_from(peer.audio_sequence * 960)?,
                        self.now,
                        OPUS_SILENCE.to_vec(),
                    ));
                peer.next_audio = Some(self.now + Duration::from_millis(20));
                next = next.min(self.now);
                peer.audio_sequence += 1;
            }
            if peer.stages.ready.is_some()
                && !peer.event_sent
                && let Some(id) = peer.channel
                && let Some(mut channel) = peer.rtc.channel(id)
            {
                channel.write(false, b"authenticated-event")?;
                peer.event_sent = true;
                next = next.min(self.now);
            }
        }
        if let Some(at) = self.packets.iter().map(|packet| packet.at).min() {
            next = next.min(at);
        }
        self.now = next.max(self.now + Duration::from_micros(1));
        let mut index = 0;
        while index < self.packets.len() {
            if self.packets[index].at > self.now {
                index += 1;
                continue;
            }
            let packet = self.packets.remove(index);
            let peer = &mut self.peers[packet.to];
            // Model a broken advertised implementation by giving ICE the same
            // authenticated check but using an otherwise identical ordinary peer.
            let receive = Receive {
                proto: packet.protocol,
                source: packet.source,
                destination: packet.destination,
                contents: packet.bytes.as_slice().try_into()?,
            };
            let input = Input::Receive(self.now, receive);
            if peer.rtc.accepts(&input) {
                peer.rtc.handle_input(input)?;
            }
        }
        for peer in &mut self.peers {
            peer.rtc.handle_input(Input::Timeout(self.now))?;
        }
        Ok(())
    }
}
fn is_dtls(bytes: &[u8]) -> bool {
    bytes.first().is_some_and(|byte| (20..=63).contains(byte))
}
pub fn embedded_dtls(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.len() < 20 || bytes[4..8] != [0x21, 0x12, 0xa4, 0x42] {
        return None;
    }
    let mut cursor = 20;
    while cursor + 4 <= bytes.len() {
        let typ = u16::from_be_bytes([bytes[cursor], bytes[cursor + 1]]);
        let len = usize::from(u16::from_be_bytes([bytes[cursor + 2], bytes[cursor + 3]]));
        let value = bytes.get(cursor + 4..cursor + 4 + len)?;
        if typ == 0xc070 {
            return Some(value);
        }
        cursor += 4 + len.div_ceil(4) * 4;
    }
    None
}
