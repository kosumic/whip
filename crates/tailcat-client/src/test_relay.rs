// Adapted from spullara/tailcat-rs at b24e19b9624049c269e689edeacee4e871884d81.
// Copyright (c) 2020 Tailscale Inc & contributors. SPDX-License-Identifier: BSD-3-Clause
use crate::{
    derp::{Packet, read_frame, write_frame},
    protocol::{Node, PrivateKey, Region, open_box, seal_box},
};
use anyhow::{Context, Result, anyhow, bail};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::mpsc,
    task::JoinHandle,
    time::timeout,
};
const MAX_PACKET: usize = 64 << 10;
const DERP_MAGIC: &[u8] = b"DERP\xf0\x9f\x94\x91";
struct ReaderTask(JoinHandle<()>);
impl Drop for ReaderTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}
/// Owns a loopback-only relay used by hermetic integration tests and the
/// TS_DEBUG_TAILCAT_LOCAL_DERP development mode. Dropping it closes every peer.
pub struct LocalRelayGuard {
    task: JoinHandle<()>,
}
impl LocalRelayGuard {
    pub fn close(&self) {
        self.task.abort();
    }
}
impl Drop for LocalRelayGuard {
    fn drop(&mut self) {
        self.close();
    }
}

pub async fn start_local_relay() -> Result<(Region, LocalRelayGuard)> {
    let certified = rcgen::generate_simple_self_signed(vec!["localhost".into()])?;
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_no_client_auth()
    .with_single_cert(
        vec![certified.cert.der().clone()],
        rustls::pki_types::PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der()).into(),
    )?;
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let region = Region {
        region_id: 1,
        region_code: "test".into(),
        region_name: "Local test relay".into(),
        nodes: vec![Node {
            name: "t1".into(),
            region_id: 1,
            host_name: "127.0.0.1".into(),
            ipv4: "127.0.0.1".into(),
            ipv6: "none".into(),
            stun_port: -1,
            derp_port: i32::from(port),
            insecure_for_tests: true,
            ..Default::default()
        }],
    };
    let key = PrivateKey::new();
    let clients: Arc<
        tokio::sync::Mutex<std::collections::HashMap<[u8; 32], mpsc::Sender<Packet>>>,
    > = Arc::default();
    let task = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((socket, _)) = accepted else { break; };
                    let acceptor = acceptor.clone(); let key = key.clone(); let clients = clients.clone();
                    connections.spawn(async move {
                        let result = async {
                            let mut tls = timeout(Duration::from_secs(5), acceptor.accept(socket)).await??;
                            let mut headers = Vec::new();
                            while !headers.ends_with(b"\r\n\r\n") {
                                if headers.len() > 16384 { bail!("local DERP HTTP request too large"); }
                                headers.push(timeout(Duration::from_secs(5), tls.read_u8()).await??);
                            }
                            tls.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: DERP\r\nConnection: Upgrade\r\n\r\n").await?;
                            local_relay_client(tls, key, clients).await
                        }.await;
                        if let Err(error) = result { tracing::debug!(%error, "local DERP client closed"); }
                    });
                }
                _ = connections.join_next(), if !connections.is_empty() => (),
            }
        }
    });
    Ok((region, LocalRelayGuard { task }))
}

type LocalClients =
    Arc<tokio::sync::Mutex<std::collections::HashMap<[u8; 32], mpsc::Sender<Packet>>>>;

async fn local_relay_client<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    mut stream: S,
    key: PrivateKey,
    clients: LocalClients,
) -> Result<()> {
    let mut greeting = DERP_MAGIC.to_vec();
    greeting.extend(key.public());
    write_frame(&mut stream, 1, &greeting).await?;
    let (kind, info) = timeout(Duration::from_secs(5), read_frame(&mut stream)).await??;
    if kind != 2 || info.len() < 72 {
        bail!("invalid DERP client info");
    }
    let public: [u8; 32] = info[..32].try_into()?;
    let info = open_box(&key.0, &public, &info[32..])?;
    let info: serde_json::Value = serde_json::from_slice(&info)?;
    if info["version"] != 2 {
        bail!("local DERP requires protocol version 2");
    }
    let info = seal_box(&key.0, &public, br#"{"version":2}"#)?;
    let (tx, mut rx) = mpsc::channel::<Packet>(256);
    clients.lock().await.insert(public, tx.clone());
    let result = async {
        write_frame(&mut stream, 3, &info).await?;
        let (mut reader, mut writer) = tokio::io::split(stream);
        let (frames_tx, mut frames_rx) = mpsc::channel(64);
        let _reader_task = ReaderTask(tokio::spawn(async move {
            loop {
                let frame = timeout(Duration::from_secs(125), read_frame(&mut reader)).await.context("local DERP read timeout").and_then(|r| r);
                let failed = frame.is_err();
                if frames_tx.send(frame).await.is_err() || failed { break; }
            }
        }));
        let mut keepalive = tokio::time::interval(Duration::from_secs(30));
        keepalive.tick().await;
        loop {
            tokio::select! {
                packet = rx.recv() => {
                    let Some((source, data)) = packet else { return Ok::<_, anyhow::Error>(()); };
                    let mut body = source.to_vec(); body.extend(data);
                    write_frame(&mut writer, 5, &body).await?;
                }
                frame = frames_rx.recv() => {
                    let (kind, body) = frame.ok_or_else(|| anyhow!("local DERP reader stopped"))??;
                    match kind {
                        4 => {
                            if body.len() < 32 || body.len() > 32 + MAX_PACKET { bail!("invalid local DERP packet"); }
                            let destination: [u8; 32] = body[..32].try_into()?;
                            if let Some(destination) = clients.lock().await.get(&destination) { let _ = destination.try_send((public, body[32..].to_vec())); }
                        }
                        0x12 if body.len() == 8 => write_frame(&mut writer, 0x13, &body).await?,
                        _ => (),
                    }
                }
                _ = keepalive.tick() => write_frame(&mut writer, 6, &[]).await?,
            }
        }
    }.await;
    let mut clients = clients.lock().await;
    if clients
        .get(&public)
        .is_some_and(|current| current.same_channel(&tx))
    {
        clients.remove(&public);
    }
    result
}
