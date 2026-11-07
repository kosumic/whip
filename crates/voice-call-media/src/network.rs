//! Bounded UDP/TCP I/O for the Sans-I/O peer. TCP uses RFC 4571 framing.
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use str0m::{
    Candidate,
    net::{Protocol, Transmit},
};
use tokio::{
    net::{TcpListener, TcpStream, UdpSocket},
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch},
    task::JoinSet,
};
#[path = "network/tcp.rs"]
mod tcp;
const CAPACITY: usize = 32;
const MAX_PACKET: usize = 65_535;
const ACTIVE_PORT: u16 = 9;
const MAX_LOCAL_CANDIDATES: usize = 96;
const UDP_FALLBACK_TYPE_PREFERENCE: u32 = 80;
const ICE_LOCAL_PRIORITY_MASK: u32 = 0x00ff_ffff;

fn is_usable_interface(ip: &IpAddr) -> bool {
    !ip.is_loopback()
        && !matches!(ip, IpAddr::V6(ip) if ip.is_unicast_link_local())
        // An interface can bind successfully yet be rejected by ICE, notably
        // a 169.254.x.x address on an Apple USB interface. Exclude it before
        // opening sockets so it cannot abort a call with usable Wi-Fi routes.
        && Candidate::host(SocketAddr::new(*ip, 0), Protocol::Udp).is_ok()
}
pub(super) struct Packet {
    pub proto: Protocol,
    pub source: SocketAddr,
    pub destination: SocketAddr,
    pub data: Vec<u8>,
}
enum Event {
    Packet(Packet),
    Accept(TcpStream, OwnedSemaphorePermit),
    Failed,
    Rejected,
}
pub(super) struct Network {
    udp: HashMap<SocketAddr, Arc<UdpSocket>>,
    interfaces: HashSet<IpAddr>,
    tcp4: TcpListener,
    tcp6: Option<TcpListener>,
    sender: mpsc::Sender<Event>,
    receiver: mpsc::Receiver<Event>,
    workers: JoinSet<()>,
    connections: HashMap<(SocketAddr, SocketAddr), mpsc::Sender<Vec<u8>>>,
    permits: Arc<Semaphore>,
    stop: watch::Sender<bool>,
}
impl Network {
    pub async fn bind() -> Result<Self, &'static str> {
        let interfaces: HashSet<_> = if_addrs::get_if_addrs()
            .map_err(|_| "Voice network interfaces are unavailable.")?
            .into_iter()
            .map(|interface| interface.ip())
            .filter(is_usable_interface)
            .collect();
        if interfaces.is_empty() || interfaces.len() > MAX_LOCAL_CANDIDATES / 3 {
            return Err("No usable voice network interface is available.");
        }
        let mut udp = HashMap::new();
        for ip in &interfaces {
            if let Ok(socket) = UdpSocket::bind(SocketAddr::new(*ip, 0)).await {
                let local = socket
                    .local_addr()
                    .map_err(|_| "Voice socket address is unavailable.")?;
                udp.insert(local, Arc::new(socket));
            }
        }
        let tcp4 = TcpListener::bind("0.0.0.0:0")
            .await
            .map_err(|_| "Voice TCP socket could not open.")?;
        let tcp6 = TcpListener::bind("[::]:0").await.ok();
        let (sender, receiver) = mpsc::channel(CAPACITY);
        let (stop, _) = watch::channel(false);
        Ok(Self {
            udp,
            interfaces,
            tcp4,
            tcp6,
            sender,
            receiver,
            workers: JoinSet::new(),
            connections: HashMap::new(),
            permits: Arc::new(Semaphore::new(CAPACITY)),
            stop,
        })
    }
    pub fn candidates(&self) -> Result<Vec<Candidate>, &'static str> {
        let mut candidates = Vec::new();
        for local in self.udp.keys() {
            let candidate = Candidate::host(*local, Protocol::Udp)
                .map_err(|_| "Invalid voice UDP candidate.")?;
            // Retain UDP fallback while preferring reliable TCP. API A/B tests
            // reproduced gaps during audible UDP speech on the affected path.
            candidates.push(Candidate::from_parts(
                uuid::Uuid::new_v4().simple().to_string(),
                1,
                Protocol::Udp,
                (UDP_FALLBACK_TYPE_PREFERENCE << 24) | (candidate.prio() & ICE_LOCAL_PRIORITY_MASK),
                *local,
                candidate.kind(),
                None,
                None,
                None,
            ));
        }
        for &ip in &self.interfaces {
            let tcp = if ip.is_ipv4() {
                Some(&self.tcp4)
            } else {
                self.tcp6.as_ref()
            };
            if let Some(listener) = tcp {
                let port = listener
                    .local_addr()
                    .map_err(|_| "Voice socket address is unavailable.")?
                    .port();
                candidates.push(
                    Candidate::builder()
                        .tcp()
                        .tcptype(str0m::net::TcpType::Passive)
                        .host(SocketAddr::new(ip, port))
                        .build()
                        .map_err(|_| "Invalid voice TCP candidate.")?,
                );
                candidates.push(
                    Candidate::builder()
                        .tcp()
                        .tcptype(str0m::net::TcpType::Active)
                        .host(SocketAddr::new(ip, ACTIVE_PORT))
                        .build()
                        .map_err(|_| "Invalid voice TCP candidate.")?,
                );
            }
            if candidates.len() > MAX_LOCAL_CANDIDATES {
                return Err("Too many local voice candidates.");
            }
        }
        if candidates.is_empty() {
            return Err("No voice network interface is available.");
        }
        Ok(candidates)
    }
    pub fn start(&mut self) {
        for (&local, socket) in &self.udp {
            let socket = socket.clone();
            let sender = self.sender.clone();
            let mut stop = self.stop.subscribe();
            self.workers.spawn(async move {
                let mut buffer=vec![0;MAX_PACKET];
                loop {
                    let received=tokio::select!{biased; _=stop.changed()=>return, received=socket.recv_from(&mut buffer)=>received};
                    let Ok((len,source))=received else {let _=sender.try_send(Event::Failed);return;};
                    let packet=Packet {proto:Protocol::Udp,source,destination:local,data:buffer[..len].to_vec()};
                    tokio::select! {
                        biased;
                        _=stop.changed()=>return,
                        result=sender.send(Event::Packet(packet))=>if result.is_err() { return; },
                    }
                }
            });
        }
    }
    pub async fn send(&mut self, packet: Transmit) -> Result<(), &'static str> {
        self.reap();
        match packet.proto {
            Protocol::Udp => {
                let socket = self
                    .udp
                    .get(&packet.source)
                    .ok_or("Voice source interface is unavailable.")?;
                socket
                    .send_to(&packet.contents, packet.destination)
                    .await
                    .map_err(|_| "Voice UDP send failed.")?;
            }
            Protocol::Tcp => {
                let pair = (packet.source, packet.destination);
                if !self.connections.contains_key(&pair) {
                    if packet.source.port() != ACTIVE_PORT {
                        return Ok(());
                    }
                    let Ok(permit) = self.permits.clone().try_acquire_owned() else {
                        // An unreachable pair must not prevent another ICE pair succeeding.
                        return Ok(());
                    };
                    let (sender, receiver) = mpsc::channel(CAPACITY);
                    self.connections.insert(pair, sender);
                    let events = self.sender.clone();
                    let stop = self.stop.subscribe();
                    self.workers.spawn(tcp::connect(
                        packet.destination,
                        packet.source,
                        receiver,
                        events,
                        stop,
                        permit,
                    ));
                }
                self.connections
                    .get(&pair)
                    .ok_or("Voice TCP connection is unavailable.")?
                    .try_send(packet.contents.to_vec())
                    .map_err(|_| "Voice TCP send queue is full.")?;
            }
            _ => return Err("Unsupported voice transport protocol."),
        }
        Ok(())
    }
    pub async fn receive(&mut self) -> Result<Packet, &'static str> {
        loop {
            self.reap();
            let event = tokio::select! {
                biased;
                event=self.receiver.recv()=>event.ok_or("Voice network ended.")?,
                accepted=self.tcp4.accept()=>self.accepted(accepted)?,
                accepted=async{match &self.tcp6{Some(listener)=>listener.accept().await,None=>std::future::pending().await}}=>self.accepted(accepted)?,
            };
            match event {
                Event::Packet(packet) => return Ok(packet),
                Event::Failed => return Err("Voice network receive failed."),
                Event::Rejected => {}
                Event::Accept(stream, permit) => {
                    let remote = stream
                        .peer_addr()
                        .map_err(|_| "Voice TCP peer is unavailable.")?;
                    let local = stream
                        .local_addr()
                        .map_err(|_| "Voice TCP address is unavailable.")?;
                    let (sender, receiver) = mpsc::channel(CAPACITY);
                    self.connections.insert((local, remote), sender);
                    self.workers.spawn(tcp::run(
                        stream,
                        remote,
                        local,
                        receiver,
                        self.sender.clone(),
                        self.stop.subscribe(),
                        permit,
                    ));
                }
            }
        }
    }
    fn accepted(
        &self,
        accepted: std::io::Result<(TcpStream, SocketAddr)>,
    ) -> Result<Event, &'static str> {
        let (stream, _) = accepted.map_err(|_| "Voice TCP accept failed.")?;
        let Ok(permit) = self.permits.clone().try_acquire_owned() else {
            return Ok(Event::Rejected);
        };
        Ok(Event::Accept(stream, permit))
    }
    fn reap(&mut self) {
        while self.workers.try_join_next().is_some() {}
        self.connections.retain(|_, sender| !sender.is_closed());
    }
    pub async fn close(&mut self) {
        self.stop.send_replace(true);
        self.connections.clear();
        self.workers.abort_all();
        while self.workers.join_next().await.is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_local_ipv4_does_not_disqualify_usable_wifi_and_ipv6_addresses()
    -> Result<(), Box<dyn std::error::Error>> {
        let wifi: IpAddr = "192.168.1.20".parse()?;
        let ipv6: IpAddr = "fd00::20".parse()?;
        let interfaces = ["169.254.10.20".parse()?, wifi, ipv6]
            .into_iter()
            .filter(is_usable_interface)
            .collect::<HashSet<_>>();

        assert_eq!(interfaces, HashSet::from([wifi, ipv6]));
        for ip in interfaces {
            let address = SocketAddr::new(ip, 5000);
            Candidate::host(address, Protocol::Udp)?;
            Candidate::builder()
                .tcp()
                .tcptype(str0m::net::TcpType::Passive)
                .host(address)
                .build()?;
        }
        Ok(())
    }

    #[test]
    fn non_routable_interfaces_are_not_advertised() -> Result<(), Box<dyn std::error::Error>> {
        for address in [
            "0.0.0.0",
            "::",
            "127.0.0.1",
            "::1",
            "169.254.10.20",
            "fe80::20",
            "255.255.255.255",
            "224.0.0.1",
            "ff02::1",
        ] {
            assert!(!is_usable_interface(&address.parse()?), "{address}");
        }
        Ok(())
    }
}
