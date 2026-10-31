// Adapted from spullara/tailcat-rs at b24e19b9624049c269e689edeacee4e871884d81.
// Copyright (c) 2020 Tailscale Inc & contributors. SPDX-License-Identifier: BSD-3-Clause
//! Native runtime. One task owns the WireGuard peers and userspace TCP stack.
//! Application streams are bounded duplex pipes; TCP FIN is propagated independently
//! in each direction.
use crate::{
    derp,
    protocol::{self, ConnInfo, PrivateKey, Region},
};
use anyhow::{Context as _, Result, anyhow};
use boringtun::noise::{Tunn, TunnResult};
use smoltcp::{
    iface::{Config, Interface, SocketHandle, SocketSet},
    phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken},
    socket::tcp::{self, State},
    time::Instant as SmolInstant,
    wire::{HardwareAddress, IpCidr, IpEndpoint, IpProtocol, Ipv6Packet},
};
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, DuplexStream, ReadBuf},
    net::UdpSocket,
    sync::{mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;

use crate::ClientOptions;
const BUFFER_SIZE: usize = 64 * 1024;
// A TCP window can arrive as a burst of encrypted UDP packets. Small socket
// defaults drop these bursts before the actor can receive them.
const UDP_RECEIVE_BUFFER_SIZE: usize = 512 * 1024;
// Each stream has two TCP buffers and two bounded application buffers (256 KiB).
// Pending dials count toward the configured connection limit.
const MAX_CANDIDATES: usize = 32;
const MAX_PENDING_PINGS: usize = 128;
const DIRECT_TTL: Duration = Duration::from_secs(15);
const PROBE_TTL: Duration = Duration::from_secs(10);
const ADVERTISE_INTERVAL: Duration = Duration::from_secs(5);
const TIMER_INTERVAL: Duration = Duration::from_millis(250);
const WIRE_BUFFER_SIZE: usize = 65536 + 128;
use protocol::{DISCO_MAGIC, seal_disco};

struct PipeWake(tokio::sync::Notify);

impl futures_util::task::ArcWake for PipeWake {
    fn wake_by_ref(arc: &Arc<Self>) {
        arc.0.notify_one();
    }
}

#[derive(Debug, Clone)]
pub struct PingResult {
    pub latency: Duration,
    pub endpoint: Option<SocketAddr>,
    pub derp_region_id: i64,
}

/// A consistent snapshot taken by the task that owns the network stack.
#[derive(Debug, Clone)]
pub struct RuntimeStatus {
    pub address: Ipv6Addr,
    pub public_key: [u8; 32],
    pub derp_region_id: i64,
    pub active_tcp_connections: usize,
    pub peers: Vec<PeerStatus>,
}

#[derive(Debug, Clone)]
pub struct PeerStatus {
    pub public_key: [u8; 32],
    pub address: Ipv6Addr,
    pub direct_endpoint: Option<SocketAddr>,
    pub handshake_age: Option<Duration>,
    pub tx_bytes: u64,
    pub rx_bytes: u64,
}

pub(crate) struct Runtime {
    pub(crate) commands: mpsc::Sender<Command>,
    pub(crate) cancel: CancellationToken,
    stopped: tokio::sync::watch::Receiver<bool>,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
impl Runtime {
    pub(crate) async fn close(&self) {
        self.cancel.cancel();
        let mut stopped = self.stopped.clone();
        let _ = stopped.wait_for(|done| *done).await;
    }
}
pub(crate) enum Command {
    Status(oneshot::Sender<RuntimeStatus>),
    Dial {
        target: SocketAddr,
        cancel: CancellationToken,
        closed_write: oneshot::Sender<()>,
        result: oneshot::Sender<Result<DuplexStream>>,
    },
    Ping {
        disco: bool,
        result: oneshot::Sender<Result<PingResult>>,
    },
    NetworkChanged(oneshot::Sender<Result<()>>),
}
struct Link {
    socket: SocketHandle,
    // A listening smoltcp socket has no remote endpoint until it accepts its
    // SYN. Remember the intended flow now to deduplicate retransmissions.
    flow: (IpEndpoint, IpEndpoint),
    pipe: DuplexStream,
    app: Option<DuplexStream>,
    connected: Option<oneshot::Sender<Result<DuplexStream>>>,
    cancel: CancellationToken,
    write_closed: bool,
    closed_write: Option<oneshot::Sender<()>>,
    read_closed: bool,
    started: Instant,
}
struct Peer {
    key: [u8; 32],
    disco_key: [u8; 32],
    tunnel: Tunn,
    direct: Option<(SocketAddr, Instant)>,
    candidates: Vec<SocketAddr>,
}
struct PendingPing {
    started: Instant,
    sent: Instant,
    disco: bool,
    txid: [u8; 12],
    result: oneshot::Sender<Result<PingResult>>,
}

struct Actor {
    key: PrivateKey,
    local: Ipv6Addr,
    region: Region,
    options: ClientOptions,
    server: Option<[u8; 32]>,
    preshared_key: Option<[u8; 32]>,
    peers: HashMap<[u8; 32], Peer>,
    device: PacketDevice,
    iface: Interface,
    sockets: SocketSet<'static>,
    links: Vec<Link>,
    commands: mpsc::Receiver<Command>,
    cancel: CancellationToken,
    relay: derp::DerpConnection,
    udp: Arc<UdpSocket>,
    udp6: Option<Arc<UdpSocket>>,
    endpoints: Vec<SocketAddr>,
    next_port: u16,
    start: Instant,
    last_timers: Instant,
    last_advertise: Instant,
    pings: Vec<PendingPing>,
    // Transactions bind a direct-path candidate to an authenticated pong.
    probes: HashMap<[u8; 12], ([u8; 32], SocketAddr, Instant)>,
    stun_txid: [u8; 12],
    wake: Arc<PipeWake>,
    stun_tasks: tokio::task::JoinSet<()>,
}
impl Runtime {
    pub(crate) async fn start(
        key: PrivateKey,
        info: ConnInfo,
        options: ClientOptions,
    ) -> Result<Self> {
        let region = info.region.first().context("missing DERP region")?.clone();
        let relay = derp::connect(&key, &region, options.allow_insecure_relays).await?;
        let (udp, udp6, endpoints) = bind_network().await?;
        let local = protocol::tc_addr_for_key(&key.public());
        let mut device = PacketDevice::default();
        let mut config = Config::new(HardwareAddress::Ip);
        config.random_seed = rand::random();
        let mut iface = Interface::new(config, &mut device, SmolInstant::from_millis(0));
        iface.update_ip_addrs(|ips| {
            let _ = ips.push(IpCidr::new(local.into(), 128));
        });
        iface
            .routes_mut()
            .add_default_ipv6_route(local)
            .map_err(|_| anyhow!("IPv6 route"))?;
        let (commands, receiver) = mpsc::channel(32);
        let cancel = CancellationToken::new();
        let (done, stopped) = tokio::sync::watch::channel(false);
        let mut actor = Actor {
            key,
            local,
            region,
            options,
            server: Some(info.server_public),
            preshared_key: info.preshared_key,
            peers: HashMap::new(),
            device,
            iface,
            sockets: SocketSet::new(vec![]),
            links: vec![],
            commands: receiver,
            cancel: cancel.clone(),
            relay,
            udp,
            udp6,
            endpoints,
            next_port: 32768,
            start: Instant::now(),
            last_timers: Instant::now(),
            last_advertise: Instant::now() - Duration::from_secs(60),
            pings: vec![],
            probes: HashMap::new(),
            stun_txid: rand::random(),
            wake: Arc::new(PipeWake(tokio::sync::Notify::new())),
            stun_tasks: tokio::task::JoinSet::new(),
        };
        actor.add_peer(
            info.server_public,
            info.server_disco_public.context("missing disco key")?,
        );
        tokio::spawn(async move {
            actor.send_stun().await;
            actor.run().await;
            actor.cancel.cancel();
            drop(actor);
            let _ = done.send(true);
        });
        Ok(Self {
            commands,
            cancel,
            stopped,
        })
    }
}
impl Actor {
    fn add_peer(&mut self, key: [u8; 32], disco_key: [u8; 32]) {
        if self.peers.contains_key(&key)
            || !self.peers.is_empty()
            || key == [0; 32]
            || disco_key == [0; 32]
        {
            return;
        }
        let index = (self.peers.len() + 1) as u32;
        let tunnel = Tunn::new(
            self.key.0.into(),
            key.into(),
            self.preshared_key,
            Some(25),
            index,
            None,
        );
        self.peers.insert(
            key,
            Peer {
                key,
                disco_key,
                tunnel,
                direct: None,
                candidates: vec![],
            },
        );
    }
    async fn run(&mut self) {
        let mut udp_buf = vec![0; 65536];
        let mut udp6_buf = vec![0; 65536];
        loop {
            let udp6 = self.udp6.clone();
            let wake = self.wake.clone();
            let now = SmolInstant::from_millis(self.start.elapsed().as_millis() as i64);
            let delay = self
                .iface
                .poll_delay(now, &self.sockets)
                .map_or(TIMER_INTERVAL, |delay| {
                    Duration::from_millis(delay.total_millis()).min(TIMER_INTERVAL)
                });
            tokio::select! {
                _ = self.cancel.cancelled() => break,
                Some(command) = self.commands.recv() => self.command(command).await,
                packet = self.relay.incoming.recv() => {
                    match packet { Some((key,data)) => self.incoming(key, data, None).await, None => break }
                }
                packet = self.udp.recv_from(&mut udp_buf) => {
                    if let Ok((n,source)) = packet { self.udp_packet(&udp_buf[..n],source).await; }
                }
                packet = async { match &udp6 {Some(socket)=>socket.recv_from(&mut udp6_buf).await,None=>std::future::pending().await} } => {
                    if let Ok((n,source)) = packet { self.udp_packet(&udp6_buf[..n],source).await; }
                }
                _ = wake.0.notified() => {}
                _ = self.stun_tasks.join_next(), if !self.stun_tasks.is_empty() => {}
                _ = tokio::time::sleep(delay) => {}
            }
            self.tick().await;
        }
    }
    async fn command(&mut self, command: Command) {
        match command {
            Command::Status(result) => {
                let _ = result.send(self.status());
            }
            Command::Dial {
                target,
                cancel,
                closed_write,
                result,
            } => {
                if result.is_closed() {
                    return;
                }
                if self.links.len() >= self.options.max_streams {
                    let _ = result.send(Err(anyhow!("too many connections")));
                    return;
                }
                let mut socket = new_socket();
                let port = loop {
                    let candidate = self.next_port;
                    self.next_port = if candidate == u16::MAX {
                        32768
                    } else {
                        candidate + 1
                    };
                    if !self.links.iter().any(|link| link.flow.0.port == candidate) {
                        break candidate;
                    }
                };
                let target =
                    IpEndpoint::new(protocol::nat64_addr(target.ip()).into(), target.port());
                if let Err(e) = socket.connect(
                    self.iface.context(),
                    target,
                    IpEndpoint::new(self.local.into(), port),
                ) {
                    let _ = result.send(Err(anyhow!("TCP connect: {e:?}")));
                    return;
                }
                let (app, pipe) = tokio::io::duplex(BUFFER_SIZE);
                let socket = self.sockets.add(socket);
                self.links.push(Link {
                    socket,
                    flow: (IpEndpoint::new(self.local.into(), port), target),
                    pipe,
                    app: Some(app),
                    connected: Some(result),
                    cancel,
                    write_closed: false,
                    closed_write: Some(closed_write),
                    read_closed: false,
                    started: Instant::now(),
                });
                self.advertise().await;
            }
            Command::Ping { disco, result } => {
                if result.is_closed() {
                    return;
                }
                self.pings.retain(|ping| !ping.result.is_closed());
                if self.pings.len() >= MAX_PENDING_PINGS {
                    let _ = result.send(Err(anyhow!("too many pending pings")));
                    return;
                }
                let mut p = PendingPing {
                    started: Instant::now(),
                    sent: Instant::now(),
                    disco,
                    txid: rand::random(),
                    result,
                };
                self.send_ping(&mut p).await;
                self.pings.push(p);
                if disco {
                    self.advertise().await;
                }
            }
            Command::NetworkChanged(result) => {
                let network = bind_network().await;
                match network {
                    Ok((udp, udp6, endpoints)) => {
                        self.udp = udp;
                        self.udp6 = udp6;
                        self.endpoints = endpoints;
                        self.stun_txid = rand::random();
                        self.probes.clear();
                        for peer in self.peers.values_mut() {
                            peer.direct = None;
                            peer.candidates.clear();
                        }
                        self.relay.reconnect();
                        self.last_advertise = Instant::now() - Duration::from_secs(60);
                        let _ = result.send(Ok(()));
                    }
                    Err(error) => {
                        let _ = result.send(Err(error));
                    }
                }
            }
        }
    }
    fn status(&self) -> RuntimeStatus {
        let mut peers = self
            .peers
            .values()
            .map(|peer| {
                let (handshake_age, tx_bytes, rx_bytes, _, _) = peer.tunnel.stats();
                PeerStatus {
                    public_key: peer.key,
                    address: protocol::tc_addr_for_key(&peer.key),
                    direct_endpoint: peer
                        .direct
                        .filter(|(_, when)| when.elapsed() < DIRECT_TTL)
                        .map(|(endpoint, _)| endpoint),
                    handshake_age,
                    tx_bytes: tx_bytes as u64,
                    rx_bytes: rx_bytes as u64,
                }
            })
            .collect::<Vec<_>>();
        peers.sort_by_key(|peer| peer.public_key);
        RuntimeStatus {
            address: self.local,
            public_key: self.key.public(),
            derp_region_id: self.region.region_id,
            active_tcp_connections: self
                .links
                .iter()
                .filter(|link| {
                    !matches!(
                        self.sockets.get::<tcp::Socket>(link.socket).state(),
                        State::Closed | State::TimeWait
                    )
                })
                .count(),
            peers,
        }
    }
    async fn send_ping(&mut self, ping: &mut PendingPing) {
        let Some(key) = self.server else {
            return;
        };
        ping.sent = Instant::now();
        if ping.disco {
            let mut data = vec![1, 0];
            data.extend_from_slice(&ping.txid);
            data.extend_from_slice(&self.key.public());
            if let Some(peer) = self.peers.get(&key)
                && let Ok(frame) = seal_disco(&self.key, &peer.disco_key, &data)
            {
                self.send_packet(key, frame).await;
            }
        } else {
            let mut data = b"meow\x01".to_vec();
            data.extend_from_slice(&self.key.public());
            data.extend_from_slice(&self.key.disco_public());
            let _ = self.relay.outgoing.try_send((key, data));
        }
    }
    async fn incoming(&mut self, key: [u8; 32], data: Vec<u8>, source: Option<SocketAddr>) {
        if Some(key) != self.server {
            return;
        }
        if data.starts_with(b"meow") {
            if source.is_none() && protocol::is_meowed_packet(&data) {
                let mut index = 0;
                while index < self.pings.len() {
                    if !self.pings[index].disco {
                        let ping = self.pings.remove(index);
                        let _ = ping.result.send(Ok(PingResult {
                            latency: ping.started.elapsed(),
                            endpoint: None,
                            derp_region_id: self.region.region_id,
                        }));
                    } else {
                        index += 1;
                    }
                }
            }
            return;
        }
        if data.starts_with(DISCO_MAGIC) {
            self.disco_packet(key, &data, source).await;
            return;
        }
        if !self.peers.contains_key(&key) {
            return;
        }
        let mut buf = vec![0; WIRE_BUFFER_SIZE];
        let mut packet = data.as_slice();
        loop {
            let result = self.peers.get_mut(&key).unwrap().tunnel.decapsulate(
                source.map(|s| s.ip()),
                packet,
                &mut buf,
            );
            match result {
                TunnResult::WriteToNetwork(b) => {
                    let out = b.to_vec();
                    self.send_packet(key, out).await;
                }
                TunnResult::WriteToTunnelV6(b, _) => {
                    let b = b.to_vec();
                    if b.len() >= 40 && b[8..24] == protocol::tc_addr_for_key(&key).octets() {
                        self.receive_ip(b);
                    }
                }
                TunnResult::Err(e) => {
                    tracing::trace!(?e, "WireGuard packet rejected");
                    break;
                }
                _ => break,
            }
            packet = &[];
        }
    }
    fn receive_ip(&mut self, packet: Vec<u8>) {
        let Ok(ip) = Ipv6Packet::new_checked(packet.as_slice()) else {
            return;
        };
        if ip.version() == 6 && ip.dst_addr() == self.local && ip.next_header() == IpProtocol::Tcp {
            self.device.incoming.push_back(packet);
        }
    }
    async fn send_packet(&self, key: [u8; 32], packet: Vec<u8>) {
        if !self.options.relay_only
            && let Some((endpoint, when)) = self.peers.get(&key).and_then(|p| p.direct)
            && when.elapsed() < DIRECT_TTL
            && self.send_udp(&packet, endpoint).await.is_ok()
        {
            return;
        }
        // DERP is best effort. Never block the actor on a congested relay queue;
        // TCP/WireGuard retransmit dropped packets.
        let _ = self.relay.outgoing.try_send((key, packet));
    }
    async fn tick(&mut self) {
        let now = SmolInstant::from_millis(self.start.elapsed().as_millis() as i64);
        self.iface.poll(now, &mut self.device, &mut self.sockets);
        self.poll_links();
        self.iface.poll(now, &mut self.device, &mut self.sockets);
        while let Some(packet) = self.device.outgoing.pop_front() {
            if packet.len() < 40 {
                continue;
            }
            let target = Ipv6Addr::from(<[u8; 16]>::try_from(&packet[24..40]).unwrap());
            let key = self.server.or_else(|| {
                self.peers
                    .keys()
                    .find(|k| protocol::tc_addr_for_key(k) == target)
                    .copied()
            });
            if let Some(key) = key {
                let mut buf = vec![0; WIRE_BUFFER_SIZE];
                if let TunnResult::WriteToNetwork(b) = self
                    .peers
                    .get_mut(&key)
                    .unwrap()
                    .tunnel
                    .encapsulate(&packet, &mut buf)
                {
                    self.send_packet(key, b.to_vec()).await;
                }
            }
        }
        if self.last_timers.elapsed() >= TIMER_INTERVAL {
            self.last_timers = Instant::now();
            for key in self.peers.keys().copied().collect::<Vec<_>>() {
                let mut buf = vec![0; WIRE_BUFFER_SIZE];
                if let TunnResult::WriteToNetwork(b) = self
                    .peers
                    .get_mut(&key)
                    .unwrap()
                    .tunnel
                    .update_timers(&mut buf)
                {
                    self.send_packet(key, b.to_vec()).await;
                }
            }
            let mut pending = std::mem::take(&mut self.pings);
            for mut p in pending.drain(..) {
                if p.result.is_closed() {
                    continue;
                }
                if p.started.elapsed() > Duration::from_secs(10) {
                    let _ = p.result.send(Err(anyhow!("ping timed out")));
                    continue;
                }
                if p.sent.elapsed() >= Duration::from_secs(1) {
                    self.send_ping(&mut p).await;
                }
                self.pings.push(p);
            }
            self.probes.retain(|_, (_, _, t)| t.elapsed() < PROBE_TTL);
        }
        if self.last_advertise.elapsed() > ADVERTISE_INTERVAL {
            self.advertise().await;
            self.send_stun().await;
        }
    }
    fn poll_links(&mut self) {
        let wake = futures_util::task::waker_ref(&self.wake);
        let mut cx = Context::from_waker(&wake);
        let mut remove = Vec::new();
        for (index, link) in self.links.iter_mut().enumerate() {
            let socket = self.sockets.get_mut::<tcp::Socket>(link.socket);
            if matches!(socket.state(), State::Established | State::CloseWait)
                && let Some(app) = link.app.take()
                && let Some(result) = link.connected.take()
                && result.send(Ok(app)).is_err()
            {
                socket.abort();
            }
            if link.cancel.is_cancelled() || link.connected.as_ref().is_some_and(|r| r.is_closed())
            {
                socket.abort();
            }
            if link.app.is_some() && link.started.elapsed() > self.options.dial_timeout {
                socket.abort();
            }
            if socket.can_send()
                && socket.send_queue() < socket.send_capacity()
                && !link.write_closed
                && link.app.is_none()
            {
                let available = (socket.send_capacity() - socket.send_queue()).min(16384);
                let mut data = vec![0; available];
                let mut buf = ReadBuf::new(&mut data);
                match Pin::new(&mut link.pipe).poll_read(&mut cx, &mut buf) {
                    Poll::Ready(Ok(())) if buf.filled().is_empty() => {
                        link.write_closed = true;
                        socket.close();
                    }
                    Poll::Ready(Ok(())) => {
                        let _ = socket.send_slice(buf.filled());
                    }
                    Poll::Ready(Err(_)) => {
                        socket.abort();
                    }
                    Poll::Pending => {}
                }
            }
            if socket.can_recv() && link.app.is_none() {
                let _ =
                    socket.recv(
                        |data| match Pin::new(&mut link.pipe).poll_write(&mut cx, data) {
                            Poll::Ready(Ok(n)) => (n, ()),
                            Poll::Ready(Err(_)) => {
                                link.read_closed = true;
                                (data.len(), ())
                            }
                            Poll::Pending => (0, ()),
                        },
                    );
            }
            if !socket.may_recv()
                && !link.read_closed
                && link.app.is_none()
                && Pin::new(&mut link.pipe).poll_shutdown(&mut cx).is_ready()
            {
                link.read_closed = true;
            }
            // Complete shutdown after queued bytes and FIN are acknowledged.
            if link.write_closed
                && socket.send_queue() == 0
                && matches!(
                    socket.state(),
                    State::FinWait2 | State::TimeWait | State::Closed
                )
                && let Some(done) = link.closed_write.take()
            {
                let _ = done.send(());
            }
            // The TCP close handshake can finish while received bytes are
            // still queued behind a full application pipe. Preserve them until
            // the application drains them (or drops its read side).
            if link.cancel.is_cancelled()
                || (socket.state() == State::Closed && (!socket.can_recv() || link.read_closed))
            {
                if let Some(result) = link.connected.take() {
                    let _ = result.send(Err(anyhow!("TCP connection refused or closed")));
                }
                remove.push(index);
            }
        }
        // Emit resets from aborted sockets before removing their state.
        let now = SmolInstant::from_millis(self.start.elapsed().as_millis() as i64);
        self.iface.poll(now, &mut self.device, &mut self.sockets);
        for index in remove.into_iter().rev() {
            let link = self.links.swap_remove(index);
            self.sockets.remove(link.socket);
        }
    }
    async fn advertise(&mut self) {
        // Refresh server registration after either endpoint reconnects/restarts.
        if let Some(key) = self.server {
            let packet = protocol::encode_meow_ping(&self.key.public(), &self.key.disco_public());
            let _ = self.relay.outgoing.try_send((key, packet));
        }
        if self.options.relay_only {
            self.last_advertise = Instant::now();
            return;
        }
        self.last_advertise = Instant::now();
        let payload = protocol::encode_call_me_maybe(&self.endpoints);
        let keys = self.peers.keys().copied().collect::<Vec<_>>();
        for key in keys {
            let peer = &self.peers[&key];
            if let Ok(packet) = seal_disco(&self.key, &peer.disco_key, &payload) {
                let _ = self.relay.outgoing.try_send((key, packet));
            }
            let candidates = peer.candidates.clone();
            for endpoint in candidates {
                self.probe(key, endpoint).await;
            }
        }
    }
    async fn probe(&mut self, key: [u8; 32], endpoint: SocketAddr) {
        if self.options.relay_only {
            return;
        }
        if !usable_endpoint(endpoint) {
            return;
        }
        let txid: [u8; 12] = rand::random();
        let mut data = vec![1, 0];
        data.extend_from_slice(&txid);
        data.extend_from_slice(&self.key.public());
        if let Some(peer) = self.peers.get(&key)
            && let Ok(packet) = seal_disco(&self.key, &peer.disco_key, &data)
            && self.probes.len() < MAX_CANDIDATES * 2
        {
            self.probes.insert(txid, (key, endpoint, Instant::now()));
            let _ = self.send_udp(&packet, endpoint).await;
        }
    }
    async fn disco_packet(&mut self, key: [u8; 32], packet: &[u8], source: Option<SocketAddr>) {
        let Some(peer) = self.peers.get(&key) else {
            return;
        };
        if packet.len() < 78 || packet[6..38] != peer.disco_key {
            return;
        }
        let Ok((_, data)) = protocol::open_disco(&self.key, packet) else {
            return;
        };
        if data.len() < 2 || data[1] != 0 || source.is_some_and(|s| !usable_endpoint(s)) {
            return;
        }
        match data[0] {
            1 if data.len() >= 14 => {
                let mut pong = vec![2, 0];
                pong.extend_from_slice(&data[2..14]);
                let endpoint =
                    source.unwrap_or_else(|| SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), 0));
                pong.extend_from_slice(&ip16(endpoint.ip()));
                pong.extend_from_slice(&endpoint.port().to_be_bytes());
                if let Ok(frame) = seal_disco(&self.key, &peer.disco_key, &pong) {
                    if let Some(src) = source {
                        let _ = self.send_udp(&frame, src).await;
                    } else {
                        let _ = self.relay.outgoing.try_send((key, frame));
                    }
                }
                // Responding to a ping is not enough to trust its source. Probe it
                // ourselves to establish bidirectional reachability.
                if let Some(src) = source
                    && remember_endpoint(&mut self.peers.get_mut(&key).unwrap().candidates, src)
                {
                    self.probe(key, src).await;
                }
            }
            2 if data.len() >= 32 => {
                let txid: [u8; 12] = data[2..14].try_into().unwrap();
                if let Some((expected, endpoint, sent)) = self.probes.get(&txid)
                    && *expected == key
                    && source == Some(*endpoint)
                    && sent.elapsed() < PROBE_TTL
                {
                    let endpoint = *endpoint;
                    self.probes.remove(&txid);
                    self.peers.get_mut(&key).unwrap().direct = Some((endpoint, Instant::now()));
                }
                if let Some(index) = self.pings.iter().position(|p| p.disco && p.txid == txid) {
                    let p = self.pings.remove(index);
                    let _ = p.result.send(Ok(PingResult {
                        latency: p.started.elapsed(),
                        endpoint: source,
                        derp_region_id: self.region.region_id,
                    }));
                }
            }
            3 if source.is_none() && (data.len() - 2).is_multiple_of(18) => {
                let announced = protocol::parse_call_me_maybe(&data).into_iter();
                let mut endpoints = Vec::new();
                for endpoint in announced.take(MAX_CANDIDATES) {
                    remember_endpoint(&mut endpoints, endpoint);
                }
                self.peers.get_mut(&key).unwrap().candidates = endpoints.clone();
                for endpoint in endpoints {
                    self.probe(key, endpoint).await;
                }
            }
            _ => {}
        }
    }
    async fn udp_packet(&mut self, data: &[u8], source: SocketAddr) {
        if self.options.relay_only {
            return;
        }
        if data.len() >= 20
            && data[0..2] == [1, 1]
            && data[4..8] == [0x21, 0x12, 0xa4, 0x42]
            && data[8..20] == self.stun_txid
        {
            if let Some(endpoint) = parse_stun(data)
                && remember_endpoint(&mut self.endpoints, endpoint)
            {
                self.last_advertise = Instant::now() - Duration::from_secs(60);
            }
            return;
        }
        if data.starts_with(DISCO_MAGIC) && data.len() >= 38 {
            if let Some(key) = self
                .peers
                .values()
                .find(|p| p.disco_key == data[6..38])
                .map(|p| p.key)
            {
                self.incoming(key, data.to_vec(), Some(source)).await;
            }
        } else {
            let keys = self
                .peers
                .iter()
                .filter(|(_, p)| {
                    p.direct.is_some_and(|(ep, _)| ep == source) || p.candidates.contains(&source)
                })
                .map(|(k, _)| *k)
                .collect::<Vec<_>>();
            // DERP-authenticated registration bounds this trial set. BoringTun
            // verifies the WireGuard MAC and peer identity before yielding IP.
            for key in keys {
                self.incoming(key, data.to_vec(), Some(source)).await;
            }
        }
    }
    async fn send_stun(&mut self) {
        if self.options.relay_only {
            return;
        }
        let mut packet = vec![0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42];
        packet.extend_from_slice(&self.stun_txid);
        for node in self.region.nodes.iter().take(3) {
            if node.stun_port < 0 {
                continue;
            }
            let port = if node.stun_port == 0 {
                3478
            } else {
                node.stun_port as u16
            };
            let host = if !node.ipv4.is_empty() && node.ipv4 != "none" {
                node.ipv4.as_str()
            } else {
                node.host_name.as_str()
            };
            // Only known relay nodes are queried; DNS resolution occurs outside
            // the packet actor and never involves the secret tailcat address.
            let udp = self.udp.clone();
            let host = host.to_string();
            let packet = packet.clone();
            self.stun_tasks.spawn(async move {
                if let Ok(Ok(mut ips)) = tokio::time::timeout(
                    Duration::from_secs(2),
                    tokio::net::lookup_host((host.as_str(), port)),
                )
                .await
                    && let Some(addr) = ips.find(SocketAddr::is_ipv4)
                {
                    let _ = udp.send_to(&packet, addr).await;
                }
            });
        }
    }

    async fn send_udp(&self, data: &[u8], endpoint: SocketAddr) -> std::io::Result<usize> {
        if endpoint.is_ipv4() {
            self.udp.try_send_to(data, endpoint)
        } else if let Some(socket) = &self.udp6 {
            socket.try_send_to(data, endpoint)
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::AddrNotAvailable,
                "IPv6 is unavailable",
            ))
        }
    }
}

fn usable_endpoint(endpoint: SocketAddr) -> bool {
    let ip = match endpoint.ip() {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ip)),
        ip => ip,
    };
    endpoint.port() != 0
        && !ip.is_unspecified()
        && !ip.is_multicast()
        && ip != IpAddr::V4(Ipv4Addr::BROADCAST)
}

/// Retain recent authenticated endpoint candidates, including NAT rebinding,
/// without letting an untrusted peer grow a per-peer vector without limit.
fn remember_endpoint(endpoints: &mut Vec<SocketAddr>, endpoint: SocketAddr) -> bool {
    if !usable_endpoint(endpoint) || endpoints.contains(&endpoint) {
        return false;
    }
    if endpoints.len() == MAX_CANDIDATES {
        endpoints.remove(0);
    }
    endpoints.push(endpoint);
    true
}

fn configure_udp_receive_buffer(socket: &UdpSocket) -> std::io::Result<()> {
    let socket = socket2::SockRef::from(socket);
    // Preserve larger defaults. The OS may clamp this request or account for
    // buffer space differently, so do not require an exact reported size.
    if socket.recv_buffer_size()? < UDP_RECEIVE_BUFFER_SIZE {
        socket.set_recv_buffer_size(UDP_RECEIVE_BUFFER_SIZE)?;
    }
    Ok(())
}

fn bind_udp6(port: u16) -> std::io::Result<UdpSocket> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV6,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )?;
    socket.set_only_v6(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), port).into())?;
    UdpSocket::from_std(socket.into())
}

fn new_socket() -> tcp::Socket<'static> {
    let mut socket = tcp::Socket::new(
        tcp::SocketBuffer::new(vec![0; BUFFER_SIZE]),
        tcp::SocketBuffer::new(vec![0; BUFFER_SIZE]),
    );
    socket.set_congestion_control(tcp::CongestionControl::Cubic);
    socket.set_nagle_enabled(false);
    socket.set_ack_delay(None);
    socket.set_timeout(Some(smoltcp::time::Duration::from_secs(60)));
    socket
}
fn ip16(ip: IpAddr) -> [u8; 16] {
    match ip {
        IpAddr::V4(ip) => ip.to_ipv6_mapped().octets(),
        IpAddr::V6(ip) => ip.octets(),
    }
}
fn parse_stun(data: &[u8]) -> Option<SocketAddr> {
    let mut offset = 20;
    let length = 20 + u16::from_be_bytes([*data.get(2)?, *data.get(3)?]) as usize;
    if length > data.len() {
        return None;
    }
    while offset + 4 <= length {
        let kind = u16::from_be_bytes([data[offset], data[offset + 1]]);
        let size = u16::from_be_bytes([data[offset + 2], data[offset + 3]]) as usize;
        offset += 4;
        let b = data.get(offset..offset + size)?;
        if kind == 0x20 && size >= 8 && b[1] == 1 {
            let port = u16::from_be_bytes([b[2], b[3]]) ^ 0x2112;
            let ip = Ipv4Addr::new(b[4] ^ 0x21, b[5] ^ 0x12, b[6] ^ 0xa4, b[7] ^ 0x42);
            return Some(SocketAddr::new(ip.into(), port));
        }
        offset += (size + 3) & !3;
    }
    None
}

#[derive(Default)]
struct PacketDevice {
    incoming: VecDeque<Vec<u8>>,
    outgoing: VecDeque<Vec<u8>>,
}
struct ReceiveToken(Vec<u8>);
struct TransmitToken<'a>(&'a mut VecDeque<Vec<u8>>);
impl RxToken for ReceiveToken {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}
impl TxToken for TransmitToken<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut buf = vec![0; len];
        let result = f(&mut buf);
        self.0.push_back(buf);
        result
    }
}
impl Device for PacketDevice {
    type RxToken<'a> = ReceiveToken;
    type TxToken<'a> = TransmitToken<'a>;
    fn receive(&mut self, _: SmolInstant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        self.incoming
            .pop_front()
            .map(|p| (ReceiveToken(p), TransmitToken(&mut self.outgoing)))
    }
    fn transmit(&mut self, _: SmolInstant) -> Option<Self::TxToken<'_>> {
        Some(TransmitToken(&mut self.outgoing))
    }
    fn capabilities(&self) -> DeviceCapabilities {
        let mut c = DeviceCapabilities::default();
        c.medium = Medium::Ip;
        c.max_transmission_unit = 1280;
        c.max_burst_size = Some(64);
        c
    }
}

async fn bind_network() -> Result<(Arc<UdpSocket>, Option<Arc<UdpSocket>>, Vec<SocketAddr>)> {
    let udp = Arc::new(UdpSocket::bind("0.0.0.0:0").await?);
    configure_udp_receive_buffer(&udp)?;
    let port = udp.local_addr()?.port();
    let udp6 = bind_udp6(port).ok().map(Arc::new);
    if let Some(socket) = &udp6 {
        configure_udp_receive_buffer(socket)?;
    }
    let mut endpoints = Vec::new();
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for interface in interfaces {
            let ip = interface.ip();
            if !matches!(ip, IpAddr::V6(ip) if udp6.is_none() || ip.is_unicast_link_local()) {
                remember_endpoint(&mut endpoints, SocketAddr::new(ip, port));
            }
        }
    }
    Ok((udp, udp6, endpoints))
}
