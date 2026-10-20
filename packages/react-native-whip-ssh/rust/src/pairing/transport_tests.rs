use super::*;
use crate::host_runtime::HostSshCredential;
use russh::server;
use std::{
    collections::HashMap,
    future::{Future, ready},
    net::SocketAddr,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::{
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
};

const INTERNAL_HOST: &str = "pairing.internal.invalid";
const JUMP_USER: &str = "jump-user";
const JUMP_PASSWORD: &str = "jump-password";
const ENROLLED_KEY: &str = "ssh-ed25519 AAAA phone";

#[derive(Clone)]
struct PairingServer {
    forward: Option<SocketAddr>,
    expected_key: ssh_key::PublicKey,
    requests: Arc<AtomicUsize>,
    channels: HashMap<russh::ChannelId, Vec<u8>>,
}

impl server::Handler for PairingServer {
    type Error = russh::Error;

    fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> impl Future<Output = Result<server::Auth, Self::Error>> {
        assert_eq!((user, password), (JUMP_USER, JUMP_PASSWORD));
        ready(Ok(server::Auth::Accept))
    }

    fn auth_publickey(
        &mut self,
        user: &str,
        key: &ssh_key::PublicKey,
    ) -> impl Future<Output = Result<server::Auth, Self::Error>> {
        assert_eq!(user, "alice");
        assert_eq!(key, &self.expected_key);
        ready(Ok(server::Auth::Accept))
    }

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
        assert_eq!((host, port), (INTERNAL_HOST, 22));
        self.requests.fetch_add(1, Ordering::Relaxed);
        let mut target = TcpStream::connect(self.forward.unwrap()).await?;
        reply.accept().await;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut target).await;
        });
        Ok(())
    }

    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), Vec::new());
        reply.accept().await;
        Ok(())
    }

    fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        command: &[u8],
        session: &mut server::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> {
        assert_eq!(command, b"whipair");
        ready(session.channel_success(channel))
    }

    fn data(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        _session: &mut server::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> {
        if let Some(request) = self.channels.get_mut(&channel) {
            request.extend_from_slice(data);
        }
        ready(Ok(()))
    }

    fn channel_eof(
        &mut self,
        channel: russh::ChannelId,
        session: &mut server::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> {
        let Some(request) = self.channels.remove(&channel) else {
            return ready(Ok(()));
        };
        let request: serde_json::Value = serde_json::from_slice(&request).unwrap();
        assert_eq!(request["public_key"], ENROLLED_KEY);
        assert_eq!(request["device_name"], "phone");
        self.requests.fetch_add(1, Ordering::Relaxed);
        ready(
            session
                .data(
                    channel,
                    br#"{"approved":true,"already_present":false}"#.to_vec(),
                )
                .and_then(|()| session.exit_status_request(channel, 0))
                .and_then(|()| session.eof(channel))
                .and_then(|()| session.close(channel)),
        )
    }
}

struct Fixture {
    address: SocketAddr,
    host_key: ssh_key::PublicKey,
    requests: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Fixture {
    async fn new(forward: Option<SocketAddr>) -> Result<Self, Box<dyn std::error::Error>> {
        let key = temporary_private_key(&[3; ED25519_SEED_BYTES]);
        let host_key = key.public_key().clone();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let requests = Arc::new(AtomicUsize::new(0));
        let handler = PairingServer {
            forward,
            expected_key: temporary_private_key(&[7; ED25519_SEED_BYTES])
                .public_key()
                .clone(),
            requests: requests.clone(),
            channels: HashMap::new(),
        };
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        let config = config.clone();
                        let handler = handler.clone();
                        connections.spawn(async move {
                            if let Ok(session) = server::run_stream(config, stream, handler).await {
                                let _ = session.await;
                            }
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok(Self {
            address,
            host_key,
            requests,
            task,
        })
    }

    fn jump_config(host: &str, port: u16) -> HostSshConfig {
        HostSshConfig {
            host: host.to_owned(),
            port,
            username: JUMP_USER.to_owned(),
            credential: HostSshCredential::Password {
                password: JUMP_PASSWORD.to_owned(),
            },
            forward_agent: false,
        }
    }

    fn code(&self, via_jump: bool, pinned_key: &ssh_key::PublicKey) -> String {
        let mut payload = if via_jump {
            let mut address = vec![ADDRESS_HOSTNAME, u8::try_from(INTERNAL_HOST.len()).unwrap()];
            address.extend_from_slice(INTERNAL_HOST.as_bytes());
            address.extend_from_slice(&22_u16.to_be_bytes());
            address
        } else {
            let mut address = vec![ADDRESS_IPV4, 127, 0, 0, 1];
            address.extend_from_slice(&self.address.port().to_be_bytes());
            address
        };
        payload.push(5);
        payload.extend_from_slice(b"alice");
        payload.extend_from_slice(&[7; ED25519_SEED_BYTES]);
        payload.extend_from_slice(&Sha256::digest(pinned_key.to_bytes().unwrap()));
        format!("{ENVELOPE_PREFIX}{}", super::tests::base45_encode(&payload))
    }
}

#[test]
fn pairs_directly_and_through_nested_jump_hosts() -> Result<(), Box<dyn std::error::Error>> {
    crate::runtime()?.block_on(async {
        let target = Fixture::new(None).await?;
        let inner = Fixture::new(Some(target.address)).await?;
        let outer = Fixture::new(Some(inner.address)).await?;
        let jumps = vec![
            Fixture::jump_config("127.0.0.1", outer.address.port()),
            Fixture::jump_config(INTERNAL_HOST, 22),
        ];
        let untrusted = pair_host(
            &target.code(true, &target.host_key),
            ENROLLED_KEY,
            "phone",
            &jumps,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            untrusted,
            PairingError::JumpHost(SshFailure::HostKeyUnknown(_))
        ));
        assert_eq!(target.requests.load(Ordering::Relaxed), 0);
        crate::ssh::set_trusted_host_keys(vec![
            crate::ssh::TrustedHostKey {
                host: "127.0.0.1".into(),
                port: outer.address.port(),
                key_type: "ssh-ed25519".into(),
                public_key: outer.host_key.to_openssh()?,
            },
            crate::ssh::TrustedHostKey {
                host: INTERNAL_HOST.into(),
                port: 22,
                key_type: "ssh-ed25519".into(),
                public_key: inner.host_key.to_openssh()?,
            },
        ])?;
        for via_jump in [false, true] {
            let result = pair_host(
                &target.code(via_jump, &target.host_key),
                ENROLLED_KEY,
                "phone",
                if via_jump { &jumps } else { &[] },
            )
            .await?;
            assert_eq!(result.ssh_user, "alice");
            assert_eq!(result.ssh_host_public_key, target.host_key.to_openssh()?);
            assert_eq!(
                result.ssh_host,
                if via_jump { INTERNAL_HOST } else { "127.0.0.1" }
            );
        }
        assert_eq!(target.requests.load(Ordering::Relaxed), 2);
        assert_eq!(inner.requests.load(Ordering::Relaxed), 1);
        assert_eq!(outer.requests.load(Ordering::Relaxed), 1);

        let wrong_key = temporary_private_key(&[4; ED25519_SEED_BYTES]);
        let error = pair_host(
            &target.code(true, wrong_key.public_key()),
            ENROLLED_KEY,
            "phone",
            &jumps,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, PairingError::HostKeyMismatch));
        assert_eq!(target.requests.load(Ordering::Relaxed), 2);
        Ok(())
    })
}
