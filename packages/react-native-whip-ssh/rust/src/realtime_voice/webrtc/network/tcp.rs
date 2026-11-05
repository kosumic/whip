use super::{
    Duration, Event, MAX_PACKET, OwnedSemaphorePermit, Packet, Protocol, SocketAddr, TcpStream,
    mpsc, watch,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpSocket;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
pub(super) async fn connect(
    remote: SocketAddr,
    local: SocketAddr,
    receiver: mpsc::Receiver<Vec<u8>>,
    events: mpsc::Sender<Event>,
    mut stop: watch::Receiver<bool>,
    permit: OwnedSemaphorePermit,
) {
    let socket = if local.is_ipv4() {
        TcpSocket::new_v4()
    } else {
        TcpSocket::new_v6()
    };
    let Ok(socket) = socket else {
        return;
    };
    if socket.bind(SocketAddr::new(local.ip(), 0)).is_err() {
        return;
    }
    let stream = tokio::select! {biased; _=stop.changed()=>return,result=tokio::time::timeout(CONNECT_TIMEOUT,socket.connect(remote))=>result};
    // Other ICE pairs can still succeed when one address cannot be reached.
    if let Ok(Ok(stream)) = stream {
        run(stream, remote, local, receiver, events, stop, permit).await;
    }
}
pub(super) async fn run(
    mut stream: TcpStream,
    remote: SocketAddr,
    local: SocketAddr,
    mut receiver: mpsc::Receiver<Vec<u8>>,
    events: mpsc::Sender<Event>,
    mut stop: watch::Receiver<bool>,
    _permit: OwnedSemaphorePermit,
) {
    let _ = stream.set_nodelay(true);
    let (mut reader, mut writer) = stream.split();
    let reading = async {
        let mut idle = CONNECT_TIMEOUT;
        loop {
            let data = tokio::time::timeout(idle, async {
                let length = reader.read_u16().await.map_err(|_| ())?;
                let mut data = vec![0; usize::from(length)];
                reader.read_exact(&mut data).await.map_err(|_| ())?;
                Ok::<_, ()>(data)
            })
            .await
            .map_err(|_| ())??;
            if data.is_empty() {
                continue;
            }
            idle = IDLE_TIMEOUT;
            let _ = events.try_send(Event::Packet(Packet {
                proto: Protocol::Tcp,
                source: remote,
                destination: local,
                data,
            }));
        }
        #[allow(
            unreachable_code,
            reason = "the read loop returns only through I/O errors"
        )]
        Ok::<(), ()>(())
    };
    let writing = async {
        while let Some(data) = receiver.recv().await {
            if data.len() > MAX_PACKET {
                return Err(());
            }
            writer
                .write_u16(u16::try_from(data.len()).map_err(|_| ())?)
                .await
                .map_err(|_| ())?;
            writer.write_all(&data).await.map_err(|_| ())?;
        }
        Ok::<(), ()>(())
    };
    tokio::select! {biased; _=stop.changed()=>{}, _=reading=>{}, _=writing=>{}}
}
