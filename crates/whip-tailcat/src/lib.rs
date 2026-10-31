#![doc = include_str!("../README.md")]

mod derp;
mod protocol;
mod runtime;

#[cfg(test)]
mod test_relay;

use runtime::{Command, Runtime};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fmt, io,
    pin::Pin,
    sync::{Arc, Weak},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, DuplexStream, ReadBuf},
    sync::{Mutex, oneshot},
};
use tokio_util::sync::CancellationToken;

pub use runtime::{PeerStatus, PingResult, RuntimeStatus};

/// Persistent Tailcat identity. Export it explicitly to application-owned secure
/// storage. Import errors never cause replacement keys to be generated.
#[derive(Clone)]
pub struct Identity(protocol::PrivateKey);

impl Identity {
    pub fn generate() -> Self {
        Self(protocol::PrivateKey::new())
    }

    pub fn from_private_key(private_key: &str) -> io::Result<Self> {
        private_key
            .parse()
            .map(Self)
            .map_err(|_| invalid("Invalid Tailcat private key"))
    }

    /// Validate both fields when importing Whip's existing saved identities.
    pub fn from_saved_keys(private_key: &str, public_key: &str) -> io::Result<Self> {
        let identity = Self::from_private_key(private_key)?;
        let public = protocol::parse_hex_key(public_key, "nodekey:")
            .map_err(|_| invalid("Invalid Tailcat public key"))?;
        if identity.0.public() != public {
            return Err(invalid("Tailcat identity keys do not match"));
        }
        Ok(identity)
    }

    pub fn private_key(&self) -> String {
        self.0.to_string()
    }
    pub fn public_key(&self) -> String {
        format!("nodekey:{}", hex::encode(self.0.public()))
    }
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Identity")
            .field("public_key", &self.public_key())
            .finish_non_exhaustive()
    }
}

/// Validate the complete compact `tc…` encoding without contacting a relay.
/// The address contains access credentials and is never included in errors.
pub fn validate_address(address: &str) -> io::Result<()> {
    parse_address(address).map(|_| ())
}

fn parse_address(address: &str) -> io::Result<protocol::ConnInfo> {
    let info =
        protocol::parse_addr(address.trim()).map_err(|_| invalid("Invalid Tailcat address"))?;
    if info.server_public == [0; 32]
        || info.server_disco_public.is_none_or(|key| key == [0; 32])
        || info.region.len() > 1
        || (info.region.is_empty() && info.region_id <= 0)
    {
        return Err(invalid(
            "Tailcat address requires server, discovery key, and DERP region",
        ));
    }
    Ok(info)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientOptions {
    pub connect_timeout: Duration,
    pub dial_timeout: Duration,
    /// Disable all direct-path discovery and use DERP for encrypted packets.
    pub relay_only: bool,
    /// Each stream uses four bounded 64 KiB TCP/application buffers.
    pub max_streams: usize,
    pub derp_map_url: Option<String>,
    /// Honor InsecureForTests only for separately provisioned test relays.
    /// Production callers should keep this false.
    pub allow_insecure_relays: bool,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(30),
            dial_timeout: Duration::from_secs(20),
            relay_only: false,
            max_streams: 32,
            derp_map_url: None,
            allow_insecure_relays: false,
        }
    }
}

/// A cloneable owner of one server/identity's network actor. Streams keep that
/// actor alive after their originating client handle is dropped.
#[derive(Clone)]
pub struct Client {
    runtime: Arc<Runtime>,
    options: ClientOptions,
    server_addr: std::net::Ipv6Addr,
}

impl Client {
    pub async fn connect(
        address: &str,
        identity: &Identity,
        options: ClientOptions,
    ) -> io::Result<Self> {
        if !(1..=256).contains(&options.max_streams)
            || options.connect_timeout.is_zero()
            || options.dial_timeout.is_zero()
        {
            return Err(invalid("Invalid Tailcat client limits"));
        }
        let mut info = parse_address(address)?;
        let server_addr = protocol::tc_addr_for_key(&info.server_public);
        let timeout = options.connect_timeout;
        tokio::time::timeout(timeout, async {
            info.expand(options.derp_map_url.as_deref())
                .await
                .map_err(io::Error::other)?;
            let runtime = Arc::new(
                Runtime::start(identity.0.clone(), info, options.clone())
                    .await
                    .map_err(io::Error::other)?,
            );
            let client = Self {
                runtime,
                options,
                server_addr,
            };
            client.ping().await?;
            Ok(client)
        })
        .await
        .map_err(|_| timed_out())?
    }

    pub async fn dial_tcp(&self, port: u16) -> io::Result<Stream> {
        if port == 0 {
            return Err(invalid("TCP port must be nonzero"));
        }
        let cancel = CancellationToken::new();
        let (closed_write, write_shutdown) = oneshot::channel();
        let guard = cancel.clone().drop_guard();
        let target = std::net::SocketAddr::new(self.server_addr.into(), port);
        let stream = tokio::time::timeout(self.options.dial_timeout, async {
            let (result, receiver) = oneshot::channel();
            self.send(Command::Dial {
                target,
                cancel: cancel.clone(),
                closed_write,
                result,
            })
            .await?;
            self.receive(receiver).await?.map_err(io::Error::other)
        })
        .await
        .map_err(|_| timed_out())??;
        guard.disarm();
        Ok(Stream {
            stream,
            runtime: self.runtime.clone(),
            cancel,
            write_shutdown,
            write_closed: false,
        })
    }

    /// Relay-authenticated server registration probe.
    pub async fn ping(&self) -> io::Result<PingResult> {
        self.do_ping(false).await
    }

    /// Authenticated discovery probe, reporting the direct endpoint when used.
    pub async fn disco_ping(&self) -> io::Result<PingResult> {
        self.do_ping(true).await
    }

    async fn do_ping(&self, disco: bool) -> io::Result<PingResult> {
        tokio::time::timeout(self.options.connect_timeout, async {
            let (result, receiver) = oneshot::channel();
            self.send(Command::Ping { disco, result }).await?;
            self.receive(receiver).await?.map_err(io::Error::other)
        })
        .await
        .map_err(|_| timed_out())?
    }

    pub async fn status(&self) -> io::Result<RuntimeStatus> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::Status(result)).await?;
        self.receive(receiver).await
    }

    /// Call after mobile network changes or foreground resume. Rebind UDP,
    /// discard stale endpoint leases and reconnect DERP, retaining identity and
    /// the existing TCP/WireGuard state. Success schedules relay reconnection;
    /// use ping/dial to wait for peer reachability.
    pub async fn network_changed(&self) -> io::Result<()> {
        let (result, receiver) = oneshot::channel();
        self.send(Command::NetworkChanged(result)).await?;
        self.receive(receiver).await?.map_err(io::Error::other)
    }

    /// Close all clones and their streams, and wait for actor teardown.
    pub async fn close(&self) {
        self.runtime.close().await;
    }

    async fn send(&self, command: Command) -> io::Result<()> {
        tokio::select! {
            biased;
            _ = self.runtime.cancel.cancelled() => Err(closed()),
            result = self.runtime.commands.send(command) => result.map_err(|_| closed()),
        }
    }

    async fn receive<T>(&self, receiver: oneshot::Receiver<T>) -> io::Result<T> {
        tokio::select! {
            biased;
            _ = self.runtime.cancel.cancelled() => Err(closed()),
            result = receiver => result.map_err(|_| closed()),
        }
    }
}

#[derive(Default)]
struct CachedClient {
    runtime: Weak<Runtime>,
    configuration: [u8; 32],
}

type ClientSlot = Arc<Mutex<CachedClient>>;

/// Application-owned registry for concurrent connects with the same identity
/// and server. Conflicting active configurations are rejected. Share one
/// registry across a host's sessions; it retains only weak actor references.
#[derive(Default)]
pub struct ClientCache {
    clients: Mutex<HashMap<[u8; 32], ClientSlot>>,
}

impl ClientCache {
    pub async fn connect(
        &self,
        address: &str,
        identity: &Identity,
        options: ClientOptions,
    ) -> io::Result<Client> {
        let info = parse_address(address)?;
        let mut digest = Sha256::new();
        digest.update(identity.0.0);
        digest.update(info.server_public);
        let key: [u8; 32] = digest.finalize().into();
        let mut digest = Sha256::new();
        digest.update(serde_json::to_vec(&info).map_err(io::Error::other)?);
        digest.update(format!("{options:?}").as_bytes());
        let configuration: [u8; 32] = digest.finalize().into();
        // Serialize creation per configuration. Other hosts can connect while
        // this host is waiting for the network.
        let entry = {
            let mut clients = self.clients.lock().await;
            clients.retain(|_, slot| {
                Arc::strong_count(slot) > 1
                    || slot
                        .try_lock()
                        .map_or(true, |cached| cached.runtime.strong_count() > 0)
            });
            clients.entry(key).or_default().clone()
        };
        let mut cached = entry.lock().await;
        if let Some(runtime) = cached.runtime.upgrade()
            && !runtime.cancel.is_cancelled()
        {
            if cached.configuration != configuration {
                return Err(invalid(
                    "Tailcat client is already active with different settings",
                ));
            }
            return Ok(Client {
                runtime,
                options,
                server_addr: protocol::tc_addr_for_key(&info.server_public),
            });
        }
        let client = Client::connect(address, identity, options).await?;
        *cached = CachedClient {
            runtime: Arc::downgrade(&client.runtime),
            configuration,
        };
        Ok(client)
    }
}

/// A bounded TCP byte stream, including independent FIN in both directions.
pub struct Stream {
    stream: DuplexStream,
    runtime: Arc<Runtime>,
    cancel: CancellationToken,
    write_shutdown: oneshot::Receiver<()>,
    write_closed: bool,
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.runtime.cancel.is_cancelled() {
            return Poll::Ready(Err(closed()));
        }
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.runtime.cancel.is_cancelled() {
            return Poll::Ready(Err(closed()));
        }
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.runtime.cancel.is_cancelled() {
            return Poll::Ready(Err(closed()));
        }
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.runtime.cancel.is_cancelled() {
            return Poll::Ready(Err(closed()));
        }
        if self.write_closed {
            return Poll::Ready(Ok(()));
        }
        match Pin::new(&mut self.stream).poll_shutdown(cx) {
            Poll::Ready(Ok(())) => (),
            other => return other,
        }
        match std::future::Future::poll(Pin::new(&mut self.write_shutdown), cx) {
            Poll::Ready(Ok(())) => {
                self.write_closed = true;
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(_)) => Poll::Ready(Err(closed())),
            Poll::Pending => Poll::Pending,
        }
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn closed() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionAborted, "Tailcat client is closed")
}
fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "Tailcat operation timed out")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_identity_round_trips_without_replacement() -> io::Result<()> {
        let identity = Identity::generate();
        let private = identity.private_key();
        let imported = Identity::from_saved_keys(&private, &identity.public_key())?;
        assert_eq!(imported.private_key(), private);
        assert_eq!(imported.public_key(), identity.public_key());
        assert!(!format!("{imported:?}").contains(&private));
        assert!(Identity::from_saved_keys(&private, &Identity::generate().public_key()).is_err());
        Ok(())
    }

    #[test]
    fn invalid_identity_is_an_error_and_never_echoes_secrets() {
        for key in [
            "",
            "invalid-private-key",
            &format!("privkey:{}", "00".repeat(32)),
        ] {
            let error = Identity::from_private_key(key).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            if !key.is_empty() {
                assert!(!error.to_string().contains(key));
            }
        }
    }

    #[tokio::test]
    async fn invalid_addresses_and_limits_fail_before_network_io() {
        let identity = Identity::generate();
        for address in ["", "not-a-tailcat-address", "tc!!!!"] {
            let result = Client::connect(address, &identity, ClientOptions::default()).await;
            assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::InvalidInput));
        }
        let result = Client::connect(
            "",
            &identity,
            ClientOptions {
                max_streams: 0,
                ..ClientOptions::default()
            },
        )
        .await;
        assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::InvalidInput));
    }
}
