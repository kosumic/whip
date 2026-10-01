//! Owned loopback-only reverse TCP forwards over an existing SSH connection.
use super::{Session, TransportError, client};

#[cfg(test)]
pub(crate) mod tests;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use tokio::net::TcpStream;
use tokio::sync::{Semaphore, watch};

const BIND_ADDRESS: &str = "127.0.0.1";
const MAX_CONNECTIONS: usize = 32;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

pub(super) type Routes = RwLock<HashMap<u16, Arc<Route>>>;

pub(super) struct Route {
    target: SocketAddr,
    cancelled: watch::Sender<bool>,
    connections: Arc<Semaphore>,
}

/// Dropping the owner rejects new channels, closes active streams and cancels
/// the remote listener. The remote SSH server also removes it on disconnect.
pub(crate) struct RemoteForward {
    session: Arc<Session>,
    route: Arc<Route>,
    pub(crate) port: u16,
}

impl Drop for RemoteForward {
    fn drop(&mut self) {
        let removed = self.unregister();
        self.route.cancelled.send_replace(true);
        if !removed {
            return;
        }
        let session = self.session.clone();
        let port = self.port;
        if let Ok(runtime) = super::runtime() {
            runtime.spawn(async move {
                cancel_remote(&session, port).await;
            });
        }
    }
}

impl RemoteForward {
    fn unregister(&self) -> bool {
        let mut routes = self.session.reverse_forwards.write();
        let registered = routes
            .get(&self.port)
            .is_some_and(|route| Arc::ptr_eq(route, &self.route));
        if registered {
            routes.remove(&self.port);
        }
        drop(routes);
        registered
    }

    /// Reject new channels and close the remote listener, then let active HTTP
    /// responses finish after the local server stops. Bound the drain so a
    /// client keeping its connection open cannot delay resource cleanup.
    pub(crate) async fn close_gracefully(self) {
        if self.unregister() {
            cancel_remote(&self.session, self.port).await;
        }
        let permits = u32::try_from(MAX_CONNECTIONS).unwrap_or_default();
        let _ =
            tokio::time::timeout(DRAIN_TIMEOUT, self.route.connections.acquire_many(permits)).await;
        self.route.cancelled.send_replace(true);
    }
}

async fn cancel_remote(session: &Session, port: u16) {
    let _ = tokio::time::timeout(
        CONNECT_TIMEOUT,
        session
            .handle
            .cancel_tcpip_forward(BIND_ADDRESS, u32::from(port)),
    )
    .await;
}

pub(super) async fn open(
    session: Arc<Session>,
    local_port: u16,
    remote_port: u16,
) -> Result<RemoteForward, TransportError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // An HTTP launch timeout must not abandon a remote allocation. If the
    // caller goes away while SSH is awaiting a reply, a late owned forward is
    // dropped here and cancels the remote listener.
    tokio::spawn(async move {
        let _ = sender.send(open_owned(session, local_port, remote_port).await);
    });
    receiver.await.map_err(|_| {
        TransportError::ChannelUnavailable("SSH reverse-forward task ended".to_owned())
    })?
}

async fn open_owned(
    session: Arc<Session>,
    local_port: u16,
    remote_port: u16,
) -> Result<RemoteForward, TransportError> {
    session.ensure_alive()?;
    let returned = session
        .handle
        .tcpip_forward(BIND_ADDRESS, u32::from(remote_port))
        .await?;
    // Successful fixed-port requests carry no port in SSH's reply. Russh
    // reports zero in that case; the listener is on the requested port.
    let allocated = if returned == 0 && remote_port != 0 {
        u32::from(remote_port)
    } else {
        returned
    };
    let port = u16::try_from(allocated).ok().filter(|port| *port != 0);
    let Some(port) = port.filter(|port| remote_port == 0 || *port == remote_port) else {
        let _ = session
            .handle
            .cancel_tcpip_forward(BIND_ADDRESS, allocated)
            .await;
        return Err(TransportError::ChannelUnavailable(
            "SSH server did not allocate a reverse-forward port".to_owned(),
        ));
    };
    let (cancelled, _) = watch::channel(false);
    let route = Arc::new(Route {
        target: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), local_port),
        cancelled,
        connections: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
    });
    session.reverse_forwards.write().insert(port, route.clone());
    let owned = RemoteForward {
        session,
        route,
        port,
    };
    owned.session.ensure_alive()?;
    Ok(owned)
}

pub(super) fn close_routes(routes: &Routes) {
    let removed = std::mem::take(&mut *routes.write());
    for route in removed.into_values() {
        route.cancelled.send_replace(true);
    }
}

// No arbitrary destination is accepted from the server: port and loopback
// address must match a route registered on this precise SSH connection.
pub(super) fn accept_channel(
    routes: &Routes,
    channel: russh::Channel<client::Msg>,
    connected_address: &str,
    connected_port: u32,
    originator_address: &str,
    reply: client::ChannelOpenHandle,
) -> impl Future<Output = Result<(), TransportError>> + Send + use<> {
    let route = u16::try_from(connected_port)
        .ok()
        .and_then(|port| routes.read().get(&port).cloned())
        .filter(|_| {
            connected_address == BIND_ADDRESS
                && originator_address
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
    async move {
        let Some(route) = route else { return Ok(()) };
        let Ok(permit) = route.connections.clone().try_acquire_owned() else {
            return Ok(());
        };
        let mut cancelled = route.cancelled.subscribe();
        if *cancelled.borrow() {
            return Ok(());
        }
        reply.accept().await;
        tokio::spawn(async move {
            let _permit = permit;
            let forward = async {
                let Ok(Ok(mut target)) =
                    tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(route.target)).await
                else {
                    return;
                };
                let _ = target.set_nodelay(true);
                let mut source = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut source, &mut target).await;
            };
            tokio::select! {
                () = forward => {},
                _ = cancelled.changed() => {},
            }
        });
        Ok(())
    }
}
