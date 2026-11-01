// Adapted from spullara/tailcat-rs at b24e19b9624049c269e689edeacee4e871884d81.
// Copyright (c) 2020 Tailscale Inc & contributors. SPDX-License-Identifier: BSD-3-Clause
//! Native DERP v2 client. A connection authenticates with the WireGuard node key.
//! Datagram channels survive relay reconnections; delivery remains best effort.
use crate::protocol::{Node, PrivateKey, Region, open_box, seal_box};
use anyhow::{Context, Result, anyhow, bail};
use rand::{RngCore, rngs::OsRng};
use rustls::{
    ClientConfig, DigitallySignedStruct, SignatureScheme,
    client::{
        WebPkiServerVerifier,
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    },
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use sha2::{Digest, Sha256};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::mpsc,
    task::JoinHandle,
    time::{sleep, timeout},
};

pub type Packet = ([u8; 32], Vec<u8>);
const MAX_PACKET: usize = 64 << 10;
const MAX_FRAME: usize = (1 << 20) + 64;
const DERP_MAGIC: &[u8] = b"DERP\xf0\x9f\x94\x91";

pub struct DerpConnection {
    pub outgoing: mpsc::Sender<Packet>,
    pub incoming: mpsc::Receiver<Packet>,
    task: JoinHandle<()>,
    reconnect: tokio::sync::watch::Sender<()>,
}

impl DerpConnection {
    pub fn reconnect(&self) {
        self.reconnect.send_replace(());
    }
    pub fn close(&self) {
        self.task.abort();
    }
}

impl Drop for DerpConnection {
    fn drop(&mut self) {
        self.close();
    }
}

trait IoStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> IoStream for T {}
type RelayStream = BufReader<Box<dyn IoStream>>;

/// Connect and authenticate before returning. Subsequent failures reconnect to
/// any relay in the region without changing the channel handles.
pub async fn connect(
    private_key: &PrivateKey,
    region: &Region,
    allow_insecure: bool,
) -> Result<DerpConnection> {
    let stream = timeout(
        Duration::from_secs(10),
        open_region(private_key, region, allow_insecure),
    )
    .await
    .context("DERP connection timed out")??;
    let (outgoing, rx) = mpsc::channel(256);
    let (tx, incoming) = mpsc::channel(256);
    let key = private_key.clone();
    let region = region.clone();
    let (reconnect, requested) = tokio::sync::watch::channel(());
    let task = tokio::spawn(async move {
        relay_loop(stream, key, region, allow_insecure, rx, tx, requested).await;
    });
    Ok(DerpConnection {
        outgoing,
        incoming,
        task,
        reconnect,
    })
}

async fn open_region(
    key: &PrivateKey,
    region: &Region,
    allow_insecure: bool,
) -> Result<RelayStream> {
    let mut last_error = anyhow!("DERP region {} has no relay nodes", region.region_id);
    for node in region.nodes.iter().filter(|n| !n.stun_only) {
        match timeout(Duration::from_secs(5), open_node(key, node, allow_insecure)).await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(error)) => last_error = error.context(format!("DERP node {}", node.host_name)),
            Err(_) => last_error = anyhow!("DERP node {} timed out", node.host_name),
        }
    }
    Err(last_error)
}

fn port_of(node: &Node) -> Result<u16> {
    if node.derp_port == 0 {
        Ok(443)
    } else {
        u16::try_from(node.derp_port).context("invalid DERP port")
    }
}

async fn tcp_connect(node: &Node) -> Result<TcpStream> {
    let port = port_of(node)?;
    let mut targets = Vec::new();
    for s in [&node.ipv4, &node.ipv6] {
        if let Ok(ip) = s.parse::<IpAddr>() {
            targets.push(SocketAddr::new(ip, port));
        }
    }
    if (node.ipv4.is_empty() || node.ipv6.is_empty())
        && !node.host_name.is_empty()
        && let Ok(addrs) = tokio::net::lookup_host((node.host_name.as_str(), port)).await
    {
        for addr in addrs {
            if (addr.is_ipv4() && node.ipv4 == "none") || (addr.is_ipv6() && node.ipv6 == "none") {
                continue;
            }
            if !targets.contains(&addr) {
                targets.push(addr);
            }
        }
    }
    if targets.is_empty() {
        bail!("no usable addresses for DERP node {}", node.host_name);
    }
    // Racing v4/v6 avoids serial delays on hosts with broken IPv6 routes.
    let mut attempts = tokio::task::JoinSet::new();
    for (index, target) in targets.into_iter().enumerate() {
        attempts.spawn(async move {
            if index > 0 {
                sleep(Duration::from_millis(100 * index as u64)).await;
            }
            TcpStream::connect(target).await
        });
    }
    let mut error = None;
    while let Some(result) = attempts.join_next().await {
        match result? {
            Ok(stream) => {
                stream.set_nodelay(true)?;
                return Ok(stream);
            }
            Err(e) => error = Some(e),
        }
    }
    Err(error
        .map(anyhow::Error::from)
        .unwrap_or_else(|| anyhow!("no DERP connection attempts")))
}

#[derive(Debug)]
struct NodeVerifier {
    normal: Arc<WebPkiServerVerifier>,
    expected_name: Option<ServerName<'static>>,
    expected_hash: Option<[u8; 32]>,
    insecure_for_tests: bool,
}

impl ServerCertVerifier for NodeVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        if let Some(expected) = self.expected_hash {
            let actual: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
            if actual != expected {
                return Err(rustls::Error::General(
                    "DERP certificate hash mismatch".into(),
                ));
            }
            return Ok(ServerCertVerified::assertion());
        }
        if self.insecure_for_tests {
            return Ok(ServerCertVerified::assertion());
        }
        self.normal.verify_server_cert(
            end_entity,
            intermediates,
            self.expected_name.as_ref().unwrap_or(server_name),
            ocsp,
            now,
        )
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.normal.verify_tls12_signature(message, cert, dss)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.normal.verify_tls13_signature(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.normal.supported_verify_schemes()
    }
}

fn verifier() -> Result<Arc<WebPkiServerVerifier>> {
    static VERIFIER: OnceLock<Arc<WebPkiServerVerifier>> = OnceLock::new();
    if let Some(v) = VERIFIER.get() {
        return Ok(v.clone());
    }
    let mut roots =
        rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    let v = WebPkiServerVerifier::builder_with_provider(
        Arc::new(roots),
        Arc::new(rustls::crypto::ring::default_provider()),
    )
    .build()?;
    let _ = VERIFIER.set(v.clone());
    Ok(v)
}

async fn open_node(key: &PrivateKey, node: &Node, allow_insecure: bool) -> Result<RelayStream> {
    if node.host_name.contains(['\r', '\n']) {
        bail!("invalid DERP hostname");
    }
    let tcp = tcp_connect(node).await?;
    let mut expected_hash = None;
    let mut expected_name = None;
    if let Some(hash) = node.cert_name.strip_prefix("sha256-raw:") {
        let mut raw = [0; 32];
        hex::decode_to_slice(hash, &mut raw).context("invalid DERP certificate hash")?;
        expected_hash = Some(raw);
    } else if !node.cert_name.is_empty() {
        expected_name = Some(
            ServerName::try_from(node.cert_name.clone())
                .context("invalid DERP certificate name")?,
        );
    }
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NodeVerifier {
                normal: verifier()?,
                expected_name,
                expected_hash,
                insecure_for_tests: allow_insecure && node.insecure_for_tests,
            }))
            .with_no_client_auth();
    let server_name =
        ServerName::try_from(node.host_name.clone()).context("invalid DERP hostname")?;
    let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(server_name, tcp)
        .await
        .context("DERP TLS handshake")?;
    let mut stream = BufReader::new(Box::new(tls) as Box<dyn IoStream>);
    let host = if node.host_name.contains(':') {
        format!("[{}]", node.host_name)
    } else {
        node.host_name.clone()
    };
    let host = if port_of(node)? != 443 {
        format!("{host}:{}", port_of(node)?)
    } else {
        host
    };
    stream
        .write_all(
            format!(
                "GET /derp HTTP/1.1\r\nHost: {host}\r\nUpgrade: DERP\r\nConnection: Upgrade\r\n\r\n"
            )
            .as_bytes(),
        )
        .await?;
    stream.flush().await?;
    read_http_upgrade(&mut stream).await?;
    authenticate(&mut stream, key, allow_insecure).await?;
    Ok(stream)
}

async fn read_http_upgrade<R: AsyncRead + Unpin>(stream: &mut R) -> Result<()> {
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        if headers.len() >= 16384 {
            bail!("DERP HTTP headers too large");
        }
        headers.push(stream.read_u8().await?);
    }
    let text = std::str::from_utf8(&headers).context("invalid DERP HTTP response")?;
    let status = text.lines().next().unwrap_or_default();
    if status.split_whitespace().nth(1) != Some("101") {
        bail!("DERP HTTP upgrade rejected: {status}");
    }
    let upgraded = text
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .any(|(name, value)| {
            name.eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("derp")
        });
    if !upgraded {
        bail!("DERP HTTP response lacks Upgrade: DERP");
    }
    Ok(())
}

async fn authenticate<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    key: &PrivateKey,
    _allow_insecure: bool,
) -> Result<()> {
    let (kind, greeting) = read_frame(stream).await?;
    if kind != 1 || greeting.len() < 40 || &greeting[..8] != DERP_MAGIC {
        bail!("invalid DERP server greeting");
    }
    let server_key: [u8; 32] = greeting[8..40].try_into()?;
    let info = serde_json::to_vec(
        &serde_json::json!({ "version": 2, "CanAckPings": true, "AppName": "tailcat-client" }),
    )?;
    let mut packet = key.public().to_vec();
    packet.extend(seal_box(&key.0, &server_key, &info)?);
    write_frame(stream, 2, &packet).await?;
    loop {
        let (kind, data) = read_frame(stream).await?;
        match kind {
            3 => {
                let info =
                    open_box(&key.0, &server_key, &data).context("DERP server authentication")?;
                let _: serde_json::Value =
                    serde_json::from_slice(&info).context("invalid DERP server info")?;
                write_frame(stream, 7, &[1]).await?;
                return Ok(());
            }
            6 => (),
            0x12 if data.len() == 8 => write_frame(stream, 0x13, &data).await?,
            _ => bail!("unexpected DERP frame {kind:#x} during authentication"),
        }
    }
}

pub(crate) async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<(u8, Vec<u8>)> {
    let kind = reader.read_u8().await?;
    let length = reader.read_u32().await? as usize;
    if length > MAX_FRAME {
        bail!("DERP frame too large: {length}");
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await?;
    Ok((kind, body))
}

pub(crate) async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    kind: u8,
    body: &[u8],
) -> Result<()> {
    if body.len() > MAX_FRAME {
        bail!("DERP frame too large: {}", body.len());
    }
    let mut header = [kind, 0, 0, 0, 0];
    header[1..].copy_from_slice(&(body.len() as u32).to_be_bytes());
    writer.write_all(&header).await?;
    writer.write_all(body).await?;
    writer.flush().await?;
    Ok(())
}

struct ReaderTask(JoinHandle<()>);
impl Drop for ReaderTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn relay_session(
    stream: RelayStream,
    outgoing: &mut mpsc::Receiver<Packet>,
    incoming: &mpsc::Sender<Packet>,
) -> Result<()> {
    let (mut reader, mut writer) = tokio::io::split(stream);
    let (frames_tx, mut frames_rx) = mpsc::channel(64);
    // Frame reads run in their own task: cancelling read_exact in select! could
    // otherwise consume a partial header and corrupt the entire stream.
    let _reader_task = ReaderTask(tokio::spawn(async move {
        loop {
            let frame = timeout(Duration::from_secs(125), read_frame(&mut reader))
                .await
                .context("DERP keepalive timeout")
                .and_then(|r| r);
            let failed = frame.is_err();
            if frames_tx.send(frame).await.is_err() || failed {
                break;
            }
        }
    }));
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    loop {
        tokio::select! {
            packet = outgoing.recv() => {
                let Some((destination, packet)) = packet else { return Ok(()); };
                if packet.len() > MAX_PACKET { tracing::warn!(length = packet.len(), "discarding oversized DERP packet"); continue; }
                let mut body = destination.to_vec(); body.extend(packet);
                write_frame(&mut writer, 4, &body).await?;
            }
            frame = frames_rx.recv() => {
                let (kind, body) = frame.ok_or_else(|| anyhow!("DERP reader stopped"))??;
                match kind {
                    5 => {
                        if body.len() < 32 || body.len() > 32 + MAX_PACKET { bail!("invalid DERP packet length"); }
                        let source = body[..32].try_into()?;
                        // Backpressure the relay reader instead of discarding a burst
                        // from a fast peer before the userspace TCP stack can consume it.
                        if incoming.send((source, body[32..].to_vec())).await.is_err() { return Ok(()); }
                    }
                    0x12 if body.len() == 8 => write_frame(&mut writer, 0x13, &body).await?,
                    0x14 if !body.is_empty() => tracing::warn!(message = %String::from_utf8_lossy(&body), "DERP health"),
                    0x15 => bail!("DERP server restarting"),
                    _ => (), // Keepalives, pongs, peer notifications and future extensions.
                }
            }
            _ = heartbeat.tick() => {
                let mut ping = [0; 8]; OsRng.fill_bytes(&mut ping);
                write_frame(&mut writer, 0x12, &ping).await?;
            }
            _ = incoming.closed() => return Ok(()),
        }
    }
}

async fn relay_loop(
    mut stream: RelayStream,
    key: PrivateKey,
    region: Region,
    allow_insecure: bool,
    mut outgoing: mpsc::Receiver<Packet>,
    incoming: mpsc::Sender<Packet>,
    mut requested: tokio::sync::watch::Receiver<()>,
) {
    loop {
        tokio::select! {
            result = relay_session(stream, &mut outgoing, &incoming) => {
                if let Err(error) = result { tracing::debug!(%error, "DERP reconnecting"); }
            }
            _ = requested.changed() => (),
        }
        if outgoing.is_closed() || incoming.is_closed() {
            return;
        }
        let mut delay = Duration::from_millis(100);
        loop {
            tokio::select! { _ = sleep(delay) => (), _ = incoming.closed() => return }
            if outgoing.is_closed() {
                return;
            }
            let result = tokio::select! {
                result = timeout(Duration::from_secs(10), open_region(&key, &region, allow_insecure)) => result,
                _ = requested.changed() => continue,
            };
            match result {
                Ok(Ok(connected)) => {
                    stream = connected;
                    break;
                }
                Ok(Err(error)) => tracing::debug!(%error, "DERP reconnect failed"),
                Err(_) => tracing::debug!("DERP reconnect timed out"),
            }
            delay = (delay * 2).min(Duration::from_secs(10));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_relay::start_local_relay;

    #[tokio::test]
    async fn frame_roundtrip_and_size_limits() {
        let (mut a, mut b) = tokio::io::duplex(128);
        let sender = tokio::spawn(async move {
            write_frame(&mut a, 4, b"hello").await.unwrap();
        });
        assert_eq!(read_frame(&mut b).await.unwrap(), (4, b"hello".to_vec()));
        sender.await.unwrap();
        let mut oversized: &[u8] = &[4, 255, 255, 255, 255];
        assert!(read_frame(&mut oversized).await.is_err());
    }

    #[tokio::test]
    async fn authentication_uses_nacl_and_protocol_v2() {
        let client_key = PrivateKey([7; 32]);
        let server_key = PrivateKey([8; 32]);
        let expected = client_key.public();
        let (mut client, mut server) = tokio::io::duplex(8192);
        let task = tokio::spawn(async move {
            let mut greeting = DERP_MAGIC.to_vec();
            greeting.extend(server_key.public());
            write_frame(&mut server, 1, &greeting).await.unwrap();
            let (kind, body) = read_frame(&mut server).await.unwrap();
            assert_eq!(kind, 2);
            assert_eq!(body[..32], expected);
            let info = open_box(&server_key.0, &expected, &body[32..]).unwrap();
            let json: serde_json::Value = serde_json::from_slice(&info).unwrap();
            assert_eq!(json["version"], 2);
            assert_eq!(json["AppName"], "tailcat-client");
            assert_eq!(json["CanAckPings"], true);
            let info = seal_box(&server_key.0, &expected, br#"{"version":2}"#).unwrap();
            write_frame(&mut server, 3, &info).await.unwrap();
            assert_eq!(read_frame(&mut server).await.unwrap(), (7, vec![1]));
        });
        authenticate(&mut client, &client_key, false).await.unwrap();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn http_upgrade_preserves_following_protocol_bytes() {
        let mut data: &[u8] = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: DERP\r\nConnection: Upgrade\r\n\r\n\x01\x02";
        read_http_upgrade(&mut data).await.unwrap();
        assert_eq!(data, &[1, 2]);
        let mut rejected: &[u8] = b"HTTP/1.1 200 OK\r\n\r\n";
        assert!(read_http_upgrade(&mut rejected).await.is_err());
    }

    #[tokio::test]
    async fn real_tls_relay_routes_authenticated_packets() {
        let (region, _guard) = start_local_relay().await.unwrap();
        let a = PrivateKey::new();
        let b = PrivateKey::new();
        let mut first = connect(&a, &region, true).await.unwrap();
        let mut second = connect(&b, &region, true).await.unwrap();
        first
            .outgoing
            .send((b.public(), b"hello".to_vec()))
            .await
            .unwrap();
        assert_eq!(
            timeout(Duration::from_secs(2), second.incoming.recv())
                .await
                .unwrap()
                .unwrap(),
            (a.public(), b"hello".to_vec())
        );
        second
            .outgoing
            .send((a.public(), b"world".to_vec()))
            .await
            .unwrap();
        assert_eq!(
            timeout(Duration::from_secs(2), first.incoming.recv())
                .await
                .unwrap()
                .unwrap(),
            (b.public(), b"world".to_vec())
        );
    }
}
