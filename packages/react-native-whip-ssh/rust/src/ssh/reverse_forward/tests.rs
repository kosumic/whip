use super::*;
use crate::ssh::{AgentState, ConnectionLifecycle, RusshHandler, SshSession};
use std::error::Error;
use std::future::{Future, ready};
use std::sync::atomic::{AtomicUsize, Ordering};

use russh::server;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Default)]
struct ServerState {
    listeners: RwLock<HashMap<u16, watch::Sender<bool>>>,
    handle: RwLock<Option<server::Handle>>,
    allocated: AtomicUsize,
    cancelled: AtomicUsize,
}

/// A real SSH server on loopback, with actual remote TCP listeners. Tests use
/// the production forwarded-channel handler and owned forward implementation.
pub(crate) struct Fixture {
    pub(crate) ssh: Arc<SshSession>,
    state: Arc<ServerState>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        for cancel in self
            .state
            .listeners
            .write()
            .drain()
            .map(|(_, cancel)| cancel)
        {
            cancel.send_replace(true);
        }
        let ssh = self.ssh.clone();
        if let Ok(runtime) = crate::runtime() {
            runtime.spawn(async move { ssh.disconnect().await });
        }
    }
}

impl Fixture {
    pub(crate) async fn new(allow: bool, delay: Duration) -> Result<Self, Box<dyn Error>> {
        let mut rng =
            russh::keys::ssh_key::rand_core::UnwrapErr(russh::keys::ssh_key::getrandom::SysRng);
        let key = russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519)?;
        let public_key = key.public_key().clone();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        });
        let listener = TcpListener::bind((BIND_ADDRESS, 0)).await?;
        let address = listener.local_addr()?;
        let state = Arc::new(ServerState::default());
        let server_state = state.clone();
        let task = tokio::spawn(async move {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let handler = ForwardServer {
                state: server_state,
                allow,
                delay,
            };
            if let Ok(session) = server::run_stream(config, stream, handler).await {
                let _ = session.await;
            }
        });
        let lifecycle = Arc::new(ConnectionLifecycle::default());
        let agent = Arc::new(AgentState::default());
        let reverse_forwards = Arc::new(Routes::default());
        let client = RusshHandler {
            host: BIND_ADDRESS.to_owned(),
            port: address.port(),
            agent: agent.clone(),
            lifecycle: lifecycle.clone(),
            reverse_forwards: reverse_forwards.clone(),
            fixture_key: Some(public_key),
        };
        let mut handle =
            client::connect(Arc::new(client::Config::default()), address, client).await?;
        assert!(handle.authenticate_none("test").await?.success());
        let ssh = Arc::new(SshSession {
            inner: Arc::new(Session {
                handle,
                agent,
                lifecycle,
                reverse_forwards,
            }),
            resource_key: format!("reverse-forward-test-{}", address.port()),
        });
        Ok(Self { ssh, state, task })
    }

    pub(crate) fn local_port(&self, remote_port: u16) -> Option<u16> {
        self.ssh
            .inner
            .reverse_forwards
            .read()
            .get(&remote_port)
            .map(|route| route.target.port())
    }
}

struct ForwardServer {
    state: Arc<ServerState>,
    allow: bool,
    delay: Duration,
}
impl Drop for ForwardServer {
    fn drop(&mut self) {
        for cancel in self
            .state
            .listeners
            .write()
            .drain()
            .map(|(_, cancel)| cancel)
        {
            cancel.send_replace(true);
        }
    }
}
impl server::Handler for ForwardServer {
    type Error = russh::Error;

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: russh::Channel<server::Msg>,
        host: &str,
        port: u32,
        _originator: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if !self.allow {
            return Ok(());
        }
        let Ok(port) = u16::try_from(port) else {
            return Ok(());
        };
        let Ok(mut target) = TcpStream::connect((host, port)).await else {
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut target).await;
        });
        Ok(())
    }

    fn auth_none(
        &mut self,
        _user: &str,
    ) -> impl Future<Output = Result<server::Auth, Self::Error>> {
        ready(Ok(server::Auth::Accept))
    }

    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        if !self.allow || address != BIND_ADDRESS || *port != 0 {
            return Ok(false);
        }
        let listener = TcpListener::bind((BIND_ADDRESS, 0)).await?;
        let allocated = listener.local_addr()?.port();
        *port = u32::from(allocated);
        let (stop, mut stopped) = watch::channel(false);
        self.state.listeners.write().insert(allocated, stop);
        self.state.allocated.fetch_add(1, Ordering::Relaxed);
        let handle = session.handle();
        *self.state.handle.write() = Some(handle.clone());
        tokio::spawn(async move {
            loop {
                let connection = tokio::select! {
                    result = listener.accept() => result,
                    _ = stopped.changed() => break,
                };
                let Ok((mut source, peer)) = connection else {
                    break;
                };
                let handle = handle.clone();
                tokio::spawn(async move {
                    let Ok(channel) = handle
                        .channel_open_forwarded_tcpip(
                            BIND_ADDRESS,
                            u32::from(allocated),
                            peer.ip().to_string(),
                            u32::from(peer.port()),
                        )
                        .await
                    else {
                        return;
                    };
                    let mut target = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut source, &mut target).await;
                });
            }
        });
        tokio::time::sleep(self.delay).await;
        Ok(true)
    }

    fn cancel_tcpip_forward(
        &mut self,
        address: &str,
        port: u32,
        _session: &mut server::Session,
    ) -> impl Future<Output = Result<bool, Self::Error>> {
        if address != BIND_ADDRESS {
            return ready(Ok(false));
        }
        let Some(cancel) = u16::try_from(port)
            .ok()
            .and_then(|port| self.state.listeners.write().remove(&port))
        else {
            return ready(Ok(false));
        };
        cancel.send_replace(true);
        self.state.cancelled.fetch_add(1, Ordering::Relaxed);
        ready(Ok(true))
    }
}

async fn wait_until(check: impl Fn() -> bool) -> Result<(), Box<dyn Error>> {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !check() {
        if std::time::Instant::now() >= deadline {
            return Err("SSH cleanup timed out".into());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Ok(())
}

#[test]
fn reverse_forward_moves_bytes_over_ssh_and_closes_active_streams_on_drop()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = Fixture::new(true, Duration::ZERO).await?;
        let target = TcpListener::bind((BIND_ADDRESS, 0)).await?;
        let owned = fixture
            .ssh
            .open_remote_forward(target.local_addr()?.port())
            .await?;
        let remote_port = owned.port;
        let mut remote = TcpStream::connect((BIND_ADDRESS, remote_port)).await?;
        remote.write_all(b"hello").await?;
        let (mut local, _) =
            tokio::time::timeout(Duration::from_secs(2), target.accept()).await??;
        let mut message = [0; 5];
        local.read_exact(&mut message).await?;
        assert_eq!(&message, b"hello");
        local.write_all(b"world").await?;
        remote.read_exact(&mut message).await?;
        assert_eq!(&message, b"world");
        drop(owned);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), remote.read(&mut message)).await??,
            0
        );
        wait_until(|| fixture.state.listeners.read().is_empty()).await?;
        assert!(fixture.ssh.inner.reverse_forwards.read().is_empty());
        assert!(
            TcpStream::connect((BIND_ADDRESS, remote_port))
                .await
                .is_err()
        );
        Ok(())
    })
}

#[test]
fn unexpected_server_channels_cannot_reach_arbitrary_local_ports_or_other_hosts()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = Fixture::new(true, Duration::ZERO).await?;
        let target = TcpListener::bind((BIND_ADDRESS, 0)).await?;
        let owned = fixture
            .ssh
            .open_remote_forward(target.local_addr()?.port())
            .await?;
        let handle = fixture
            .state
            .handle
            .read()
            .clone()
            .ok_or("missing server handle")?;
        for (address, port, origin) in [
            ("0.0.0.0", u32::from(owned.port), BIND_ADDRESS),
            (BIND_ADDRESS, u32::from(owned.port) + 1, BIND_ADDRESS),
            (BIND_ADDRESS, u32::from(owned.port), "203.0.113.9"),
        ] {
            assert!(
                tokio::time::timeout(
                    Duration::from_secs(2),
                    handle.channel_open_forwarded_tcpip(address, port, origin, 1234),
                )
                .await?
                .is_err()
            );
        }
        let other = Fixture::new(true, Duration::ZERO).await?;
        let other_owned = other
            .ssh
            .open_remote_forward(target.local_addr()?.port())
            .await?;
        let other_handle = other
            .state
            .handle
            .read()
            .clone()
            .ok_or("missing second server handle")?;
        assert_ne!(owned.port, other_owned.port);
        assert!(
            tokio::time::timeout(
                Duration::from_secs(2),
                other_handle.channel_open_forwarded_tcpip(
                    BIND_ADDRESS,
                    u32::from(owned.port),
                    BIND_ADDRESS,
                    1234
                ),
            )
            .await?
            .is_err()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(30), target.accept())
                .await
                .is_err()
        );
        Ok(())
    })
}

#[test]
fn cancelled_forward_startup_releases_a_late_remote_allocation() -> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = Fixture::new(true, Duration::from_millis(150)).await?;
        let target = TcpListener::bind((BIND_ADDRESS, 0)).await?;
        assert!(
            tokio::time::timeout(
                Duration::from_millis(25),
                fixture.ssh.open_remote_forward(target.local_addr()?.port()),
            )
            .await
            .is_err()
        );
        wait_until(|| fixture.state.cancelled.load(Ordering::Relaxed) == 1).await?;
        assert_eq!(fixture.state.allocated.load(Ordering::Relaxed), 1);
        assert!(fixture.state.listeners.read().is_empty());
        assert!(fixture.ssh.inner.reverse_forwards.read().is_empty());
        Ok(())
    })
}

#[test]
fn host_disconnect_closes_forwarded_connections_and_rejects_new_routes()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let fixture = Fixture::new(true, Duration::ZERO).await?;
        let target = TcpListener::bind((BIND_ADDRESS, 0)).await?;
        let owned = fixture
            .ssh
            .open_remote_forward(target.local_addr()?.port())
            .await?;
        let mut remote = TcpStream::connect((BIND_ADDRESS, owned.port)).await?;
        let (_local, _) = tokio::time::timeout(Duration::from_secs(2), target.accept()).await??;
        fixture.ssh.disconnect().await;
        let mut buffer = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), remote.read(&mut buffer)).await??,
            0
        );
        assert!(
            fixture
                .ssh
                .open_remote_forward(target.local_addr()?.port())
                .await
                .is_err()
        );
        assert!(fixture.ssh.inner.reverse_forwards.read().is_empty());
        Ok(())
    })
}
