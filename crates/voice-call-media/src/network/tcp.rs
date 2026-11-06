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
            // Preserve TCP's reliable framing when the media owner is busy.
            // Backpressure stays bounded and reaches the socket instead of
            // silently deleting an authenticated RTP/DTLS/SCTP frame.
            events
                .send(Event::Packet(Packet {
                    proto: Protocol::Tcp,
                    source: remote,
                    destination: local,
                    data,
                }))
                .await
                .map_err(|_| ())?;
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

#[cfg(test)]
mod tests {
    use super::*;
    const FRAMES: u16 = 100;

    #[tokio::test]
    #[allow(
        clippy::significant_drop_tightening,
        reason = "The connection permit moves into the worker and must live until that worker exits"
    )]
    async fn received_tcp_frames_survive_a_paused_media_consumer()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let remote = listener.local_addr()?;
        let client = TcpStream::connect(remote).await?;
        let local = client.local_addr()?;
        let (mut server, _) = listener.accept().await?;
        let (events, mut receiver) = mpsc::channel(2);
        let (_commands, commands) = mpsc::channel(2);
        let (stop, stopped) = watch::channel(false);
        let permit = std::sync::Arc::new(tokio::sync::Semaphore::new(1))
            .acquire_owned()
            .await?;
        let worker = tokio::spawn(run(
            client, remote, local, commands, events, stopped, permit,
        ));
        for sequence in 0..FRAMES {
            server.write_u16(2).await?;
            server.write_all(&sequence.to_be_bytes()).await?;
        }
        // TCP is reliable even when the media owner briefly stops polling.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let result = tokio::time::timeout(Duration::from_secs(1), async {
            for sequence in 0..FRAMES {
                let Some(Event::Packet(packet)) = receiver.recv().await else {
                    return Err("TCP media stream ended before all frames arrived");
                };
                if packet.data != sequence.to_be_bytes() {
                    return Err("TCP media frames were lost or reordered");
                }
            }
            Ok(())
        })
        .await;
        stop.send_replace(true);
        worker.await?;
        result??;
        Ok(())
    }
}
