//! SOCKS5 CONNECT over direct-tcpip: remote DNS, end-to-end TLS, no direct fallback.
use super::*;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONNECTIONS: usize = 128;
async fn destination<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
) -> std::io::Result<(String, u16)> {
    let version = stream.read_u8().await?;
    let count = stream.read_u8().await?;
    if version != 5 || count == 0 {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut methods = vec![0; usize::from(count)];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        stream.write_all(&[5, 255]).await?;
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    stream.write_all(&[5, 0]).await?;
    let mut head = [0; 4];
    stream.read_exact(&mut head).await?;
    if head[0..3] != [5, 1, 0] {
        reply(stream, 7).await?;
        return Err(std::io::ErrorKind::Unsupported.into());
    }
    let host = match head[3] {
        1 => {
            let mut bytes = [0; 4];
            stream.read_exact(&mut bytes).await?;
            std::net::Ipv4Addr::from(bytes).to_string()
        }
        4 => {
            let mut bytes = [0; 16];
            stream.read_exact(&mut bytes).await?;
            std::net::Ipv6Addr::from(bytes).to_string()
        }
        3 => {
            let length = stream.read_u8().await?;
            let mut bytes = vec![0; usize::from(length)];
            stream.read_exact(&mut bytes).await?;
            let host = String::from_utf8(bytes).map_err(|_| std::io::ErrorKind::InvalidData)?;
            if host.is_empty() || host.bytes().any(|c| c <= 32 || c == 127) {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            host
        }
        _ => {
            reply(stream, 8).await?;
            return Err(std::io::ErrorKind::Unsupported.into());
        }
    };
    let port = stream.read_u16().await?;
    if port == 0 {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    Ok((host, port))
}
async fn reply<S: AsyncWrite + Unpin>(stream: &mut S, status: u8) -> std::io::Result<()> {
    stream.write_all(&[5, status, 0, 1, 0, 0, 0, 0, 0, 0]).await
}
pub(super) async fn open(key: String, session: Arc<Session>) -> Result<u16, TransportError> {
    session.ensure_alive()?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let (cancel_tx, mut cancel) = watch::channel(false);
    forwards()
        .write()
        .insert((key.clone(), port), cancel_tx.clone());
    let limit = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.changed() => break,
                _ = session.lifecycle.disconnected() => break,
                accepted = listener.accept() => {
                    let Ok((mut local, _)) = accepted else { break };
                    let Ok(permit) = limit.clone().try_acquire_owned() else { continue };
                    let session = session.clone(); let mut cancelled = cancel.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        let connection = async {
                            let Ok(Ok((host, remote_port))) = tokio::time::timeout(HANDSHAKE_TIMEOUT, destination(&mut local)).await else { return };
                            let channel = tokio::time::timeout(HANDSHAKE_TIMEOUT, session.handle.channel_open_direct_tcpip(host, u32::from(remote_port), "127.0.0.1", u32::from(port))).await;
                            let Ok(Ok(channel)) = channel else { let _ = reply(&mut local, 5).await; return };
                            if reply(&mut local, 0).await.is_err() { return; }
                            let mut remote = channel.into_stream(); let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                        };
                        tokio::select! { _ = cancelled.changed() => {}, _ = session.lifecycle.disconnected() => {}, _ = connection => {} }
                    });
                }
            }
        }
        let _ = cancel_tx.send(true);
        let map_key = (key, port);
        if forwards()
            .read()
            .get(&map_key)
            .is_some_and(|current| current.same_channel(&cancel_tx))
        {
            forwards().write().remove(&map_key);
        }
    });
    Ok(port)
}
#[cfg(test)]
mod tests {
    use super::super::reverse_forward::tests::Fixture;
    use super::*;

    #[test]
    fn proxy_moves_http_bytes_over_ssh_and_closes_streams_on_stop()
    -> Result<(), Box<dyn std::error::Error>> {
        crate::runtime()?.block_on(async {
            let fixture = Fixture::new(true, Duration::ZERO).await?;
            let target = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
            let port = fixture.ssh.open_browser_proxy().await?;
            let mut client = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
            client.write_all(&[5, 1, 0]).await?;
            let mut greeting = [0; 2];
            client.read_exact(&mut greeting).await?;
            assert_eq!(greeting, [5, 0]);
            client.write_all(&[5, 1, 0, 3, 9]).await?;
            client.write_all(b"localhost").await?;
            client.write_u16(target.local_addr()?.port()).await?;
            let (mut remote, _) =
                tokio::time::timeout(Duration::from_secs(2), target.accept()).await??;
            let mut response = [0; 10];
            client.read_exact(&mut response).await?;
            assert_eq!(response[1], 0);
            let request = b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n";
            client.write_all(request).await?;
            let mut received = vec![0; request.len()];
            remote.read_exact(&mut received).await?;
            assert_eq!(received, request);
            remote
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
                .await?;
            let mut reply = [0; 40];
            client.read_exact(&mut reply).await?;
            assert!(reply.ends_with(b"OK"));
            fixture.ssh.close_local_forward(port);
            let mut byte = [0];
            let result =
                tokio::time::timeout(Duration::from_secs(2), client.read(&mut byte)).await?;
            assert!(matches!(result, Ok(0) | Err(_)));
            Ok(())
        })
    }
    #[tokio::test]
    async fn reads_remote_dns_and_rejects_udp() -> Result<(), Box<dyn std::error::Error>> {
        let (mut client, mut server) = tokio::io::duplex(1024);
        let task = tokio::spawn(async move { destination(&mut server).await });
        client.write_all(&[5, 1, 0]).await?;
        let mut greeting = [0; 2];
        client.read_exact(&mut greeting).await?;
        assert_eq!(greeting, [5, 0]);
        client.write_all(&[5, 1, 0, 3, 9]).await?;
        client.write_all(b"localhost").await?;
        client.write_u16(8080).await?;
        assert_eq!(task.await??, ("localhost".into(), 8080));
        let (mut client, mut server) = tokio::io::duplex(1024);
        let task = tokio::spawn(async move { destination(&mut server).await });
        client.write_all(&[5, 1, 0, 5, 3, 0, 1]).await?;
        let mut response = [0; 12];
        client.read_exact(&mut response).await?;
        assert_eq!(response[3], 7);
        assert!(task.await?.is_err());
        Ok(())
    }
}
