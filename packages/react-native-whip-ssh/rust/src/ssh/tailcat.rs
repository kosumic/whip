//! Whip's SSH adapter for the pure-Rust, SSH-independent Tailcat transport.

use std::{io, sync::OnceLock};

#[derive(Clone, serde::Deserialize, uniffi::Record)]
pub struct TailcatIdentity {
    pub private_key: String,
    pub public_key: String,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum TailcatIdentityError {
    #[error("Could not generate the Tailcat client identity")]
    GenerationFailed,
    #[error("Invalid Tailcat client public key")]
    InvalidPublicKey,
    #[error("Tailcat's SSH server requires an SSH public key")]
    SshPublicKeyRequired,
    #[error("SSH port must be greater than zero")]
    InvalidPort,
}

#[uniffi::export]
pub fn tailcat_server_command(
    client_public_key: Option<String>,
    port: u16,
    builtin_ssh: bool,
    ssh_public_key: Option<String>,
) -> Result<String, TailcatIdentityError> {
    let mut prefix = String::from("tailcat serve --key=whip");
    if let Some(client_public_key) = client_public_key {
        let valid = client_public_key
            .strip_prefix("nodekey:")
            .is_some_and(|key| key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()));
        if !valid {
            return Err(TailcatIdentityError::InvalidPublicKey);
        }
        prefix.push_str(" --allow=");
        prefix.push_str(&client_public_key);
    }
    if builtin_ssh {
        let public_key = ssh_public_key.ok_or(TailcatIdentityError::SshPublicKeyRequired)?;
        let public_key = crate::public_keys::inspect_public_key(public_key, false)
            .map_err(|_| TailcatIdentityError::SshPublicKeyRequired)?;
        Ok(format!(
            "{prefix} --ssh-authorized-keys={} ssh",
            crate::remote_ops::shell_quote(&public_key.public_key)
        ))
    } else if port == 0 {
        Err(TailcatIdentityError::InvalidPort)
    } else {
        Ok(format!("{prefix} {port}"))
    }
}

#[uniffi::export]
pub fn generate_tailcat_identity() -> Result<TailcatIdentity, TailcatIdentityError> {
    let identity = whip_tailcat::Identity::generate();
    Ok(TailcatIdentity {
        private_key: identity.private_key(),
        public_key: identity.public_key(),
    })
}

pub(super) type Stream = whip_tailcat::Stream;

// The registry owns weak references; active streams own their network actor.
// Sharing avoids duplicate DERP registrations for one saved host identity.
static CLIENTS: OnceLock<whip_tailcat::ClientCache> = OnceLock::new();

pub(super) async fn connect(address: &str, port: u16, private_key: &str) -> io::Result<Stream> {
    connect_with_options(
        address,
        port,
        private_key,
        whip_tailcat::ClientOptions::default(),
    )
    .await
}

async fn connect_with_options(
    address: &str,
    port: u16,
    private_key: &str,
    options: whip_tailcat::ClientOptions,
) -> io::Result<Stream> {
    let identity = whip_tailcat::Identity::from_private_key(private_key)?;
    let client = CLIENTS
        .get_or_init(whip_tailcat::ClientCache::default)
        .connect(address, &identity, options)
        .await
        .map_err(transport_error)?;
    client.dial_tcp(port).await.map_err(transport_error)
}

fn transport_error(error: io::Error) -> io::Error {
    // Do not propagate relay metadata from secret server addresses into UI/logs.
    io::Error::new(
        error.kind(),
        "Tailcat connection failed; check the address and server",
    )
}

#[cfg(test)]
mod latency_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const SSH_PUBLIC_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti";

    #[test]
    fn identities_are_distinct_and_server_commands_allow_the_saved_client()
    -> Result<(), Box<dyn std::error::Error>> {
        let first = generate_tailcat_identity()?;
        let second = generate_tailcat_identity()?;
        assert_ne!(
            Sha256::digest(first.private_key.as_bytes()),
            Sha256::digest(second.private_key.as_bytes())
        );
        assert_ne!(first.public_key, second.public_key);
        assert!(first.private_key.starts_with("privkey:"));
        assert!(first.public_key.starts_with("nodekey:"));
        assert_eq!(
            tailcat_server_command(None, 2222, false, None)?,
            "tailcat serve --key=whip 2222"
        );
        assert_eq!(
            tailcat_server_command(None, 2222, true, Some(SSH_PUBLIC_KEY.into()))?,
            format!("tailcat serve --key=whip --ssh-authorized-keys='{SSH_PUBLIC_KEY}' ssh")
        );
        let forwarded = tailcat_server_command(Some(first.public_key.clone()), 2222, false, None)?;
        assert_eq!(
            forwarded,
            format!("tailcat serve --key=whip --allow={} 2222", first.public_key)
        );
        let builtin = tailcat_server_command(
            Some(first.public_key.clone()),
            2222,
            true,
            Some(SSH_PUBLIC_KEY.into()),
        )?;
        assert_eq!(
            builtin,
            format!(
                "tailcat serve --key=whip --allow={} --ssh-authorized-keys='{SSH_PUBLIC_KEY}' ssh",
                first.public_key
            )
        );
        assert_eq!(
            tailcat_server_command(
                Some(first.public_key.clone()),
                22,
                true,
                Some(format!("{SSH_PUBLIC_KEY} phone,work"))
            )?,
            builtin,
        );
        assert!(tailcat_server_command(None, 22, true, None).is_err());
        assert!(tailcat_server_command(Some(first.public_key.clone()), 22, true, None).is_err());
        assert!(tailcat_server_command(None, 0, false, None).is_err());
        assert!(tailcat_server_command(Some(first.public_key), 0, false, None).is_err());
        assert!(
            tailcat_server_command(Some("nodekey:invalid; command".into()), 22, false, None)
                .is_err()
        );
        assert!(tailcat_server_command(Some(String::new()), 22, false, None).is_err());
        Ok(())
    }

    #[test]
    fn builtin_ssh_has_its_own_host_key_identity_and_tunnel_port() {
        let mut config = crate::ssh::SshConnectionConfig {
            host: "host.example".into(),
            port: 2222,
            username: "user".into(),
            credential: crate::ssh::SshCredential::Key {
                private_key: "key".into(),
                passphrase: None,
            },
            forward_agent: false,
            tailcat_address: Some("tc-address".into()),
            tailcat_private_key: Some("privkey:key".into()),
            tailcat_ssh_server: false,
        };
        assert_eq!(
            crate::ssh::ssh_host_identity(&config),
            ("host.example".into(), 2222)
        );
        config.tailcat_ssh_server = true;
        assert_eq!(
            crate::ssh::ssh_host_identity(&config),
            ("tailcat-ssh:host.example".into(), 22)
        );
        assert_eq!(config.port, 2222);
    }

    struct Fixture(Child);

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.0.stdin.take();
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    #[ignore = "run tests/test-tailcat.sh to build the local Go relay fixture"]
    fn stream_round_trip_preserves_half_close_and_drop_cancels_idle_io()
    -> Result<(), Box<dyn std::error::Error>> {
        let binary = std::env::var("WHIP_TAILCAT_TEST_RELAY")?;
        let mut fixture = Fixture(
            Command::new(binary)
                .arg("-test.run=^TestWhipTailcatReference$")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()?,
        );
        let stdout = fixture.0.stdout.take().ok_or("missing fixture output")?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let info: serde_json::Value = serde_json::from_str(&line)?;
        let address = info["address"].as_str().ok_or("missing fixture address")?;
        let runtime = tokio::runtime::Runtime::new()?;
        let identity = generate_tailcat_identity()?;
        runtime.block_on(async {
            let mut stream = connect_with_options(
                address,
                22,
                &identity.private_key,
                whip_tailcat::ClientOptions {
                    allow_insecure_relays: true,
                    ..whip_tailcat::ClientOptions::default()
                },
            )
            .await?;
            let mut simultaneous = connect_with_options(
                address,
                22,
                &identity.private_key,
                whip_tailcat::ClientOptions {
                    allow_insecure_relays: true,
                    ..whip_tailcat::ClientOptions::default()
                },
            )
            .await?;
            let payload = (0..=250_u8).cycle().take(512 * 1024).collect::<Vec<_>>();
            stream.write_all(&payload).await?;
            stream.shutdown().await?;
            let mut response = Vec::new();
            tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut response))
                .await??;
            assert_eq!(response, payload);
            simultaneous.write_all(b"shared-client").await?;
            simultaneous.shutdown().await?;
            let mut second_response = Vec::new();
            tokio::time::timeout(
                Duration::from_secs(10),
                simultaneous.read_to_end(&mut second_response),
            )
            .await??;
            assert_eq!(second_response, b"shared-client");
            drop(simultaneous);
            drop(stream);
            let idle = connect_with_options(
                address,
                22,
                &identity.private_key,
                whip_tailcat::ClientOptions {
                    allow_insecure_relays: true,
                    ..whip_tailcat::ClientOptions::default()
                },
            )
            .await?;
            drop(idle);
            Ok::<_, Box<dyn std::error::Error>>(())
        })?;
        drop(fixture);
        // A leaked blocking read/write worker would hold runtime shutdown open.
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            drop(runtime);
            let _ = done.send(());
        });
        finished.recv_timeout(Duration::from_secs(5))?;
        Ok(())
    }

    #[test]
    fn invalid_address_fails_without_exposing_the_address() -> Result<(), Box<dyn std::error::Error>>
    {
        tokio::runtime::Runtime::new()?.block_on(async {
            let identity = generate_tailcat_identity()?;
            let secret = "invalid-secret-address";
            let Err(error) = connect(secret, 22, &identity.private_key).await else {
                return Err("invalid Tailcat address was accepted".into());
            };
            assert!(!error.to_string().contains(secret));
            Ok(())
        })
    }

    #[test]
    #[ignore = "requires a remote Tailcat serve 22 and WHIP_TAILCAT_LIVE_* file paths"]
    fn live_remote_ssh_over_tailcat() -> Result<(), Box<dyn std::error::Error>> {
        use crate::ssh::{
            SshConnectionConfig, SshCredential, SshSession, TrustedHostKey, set_trusted_host_keys,
        };

        const HOST_ALIAS: &str = "whip-tailcat-live.invalid";
        const SSH_PORT: u16 = 22;
        let read_setting = |name: &str| -> Result<String, Box<dyn std::error::Error>> {
            Ok(std::fs::read_to_string(std::env::var(name)?)?)
        };
        let address = read_setting("WHIP_TAILCAT_LIVE_ADDRESS_FILE")?;
        let private_key = read_setting("WHIP_TAILCAT_LIVE_KEY_FILE")?;
        let public_key = read_setting("WHIP_TAILCAT_LIVE_HOST_KEY_FILE")?;
        let expected_host = std::env::var("WHIP_TAILCAT_LIVE_EXPECT_HOST")?;
        let username = std::env::var("WHIP_TAILCAT_LIVE_USER")?;
        let builtin_ssh =
            std::env::var("WHIP_TAILCAT_LIVE_BUILTIN_SSH").is_ok_and(|value| value == "1");
        let identity = match std::env::var("WHIP_TAILCAT_LIVE_IDENTITY_FILE") {
            Ok(path) => serde_json::from_str::<TailcatIdentity>(&std::fs::read_to_string(path)?)?,
            Err(_) => generate_tailcat_identity()?,
        };
        let key_type = public_key
            .split_whitespace()
            .next()
            .ok_or("missing host key type")?;
        set_trusted_host_keys(vec![TrustedHostKey {
            host: if builtin_ssh {
                format!("tailcat-ssh:{HOST_ALIAS}")
            } else {
                HOST_ALIAS.into()
            },
            port: SSH_PORT,
            key_type: key_type.into(),
            public_key: public_key.trim().into(),
        }])?;
        let config = SshConnectionConfig {
            // This reserved hostname cannot provide a direct-TCP fallback.
            host: HOST_ALIAS.into(),
            // Built-in mode must select its internal port 22, independently of sshd.
            port: if builtin_ssh { 2222 } else { SSH_PORT },
            username: username.clone(),
            tailcat_address: Some(address.trim().into()),
            tailcat_private_key: Some(identity.private_key),
            tailcat_ssh_server: builtin_ssh,
            credential: SshCredential::Key {
                private_key,
                passphrase: None,
            },
            forward_agent: false,
        };
        tokio::runtime::Runtime::new()?.block_on(async {
            let started = std::time::Instant::now();
            let ssh = tokio::time::timeout(Duration::from_secs(60), SshSession::connect(&config, None)).await??;
            eprintln!("Live Tailcat SSH connected in {} ms; SSH host key verified", started.elapsed().as_millis());
            let output = ssh.execute("printf 'WHIP_TAILCAT_SSH_OK\\n'; hostname; id -un; printf 'STDERR_OK\\n' >&2; exit 7").await?;
            assert_eq!(output.exit_status, Some(7));
            assert_eq!(String::from_utf8(output.stdout)?, format!("WHIP_TAILCAT_SSH_OK\n{expected_host}\n{username}\n"));
            assert_eq!(output.stderr, b"STDERR_OK\n");
            eprintln!("Remote exec/stdout/stderr/exit status verified on {expected_host} as {username}");
            if builtin_ssh {
                let peer = ssh.execute("printf %s \"$TAILCAT_PEER_KEY\"").await?;
                assert_eq!(String::from_utf8(peer.stdout)?, identity.public_key);
                eprintln!("Server observed the persistent client identity accepted by --allow");
                super::latency_tests::measure("tailcat-builtin-ssh", &config).await?;
                eprintln!("Concurrent SSH sessions sharing the saved Tailcat identity verified");
                if let Ok(socket_path) = std::env::var("WHIP_TAILCAT_LIVE_ECHO_SOCKET") {
                    let response = ssh.request_unix_socket(&socket_path, b"WHIP_SOCKET_OK\n", b'\n', 5_000, 1024).await?;
                    assert_eq!(response, b"WHIP_SOCKET_OK");
                    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
                    ssh.open_length_prefixed_unix_socket("builtin-echo", &socket_path, 1024,
                        Arc::new(move |bytes| { let _ = sender.send(bytes); }), Arc::new(|_| {})).await?;
                    ssh.write_unix_socket("builtin-echo", b"FRAMED_OK".to_vec(), true)?;
                    let frame = tokio::time::timeout(Duration::from_secs(5), receiver.recv()).await?.ok_or("framed echo closed")?;
                    assert_eq!(frame, b"FRAMED_OK");
                    ssh.close_unix_socket("builtin-echo")?;
                    eprintln!("Unix-socket requests and framed Herdr streams over SSH exec verified");
                }
                if let Ok(port_file) = std::env::var("WHIP_TAILCAT_LIVE_ECHO_PORT_FILE") {
                    let port = std::fs::read_to_string(port_file)?.trim().parse::<u16>()?;
                    let mut socket = ssh.open_direct_tcpip("127.0.0.1", port).await?;
                    socket.write_all(b"WHIP_TCP_OK").await?;
                    socket.shutdown().await?;
                    let mut bytes = Vec::new();
                    tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut bytes)).await??;
                    assert_eq!(bytes, b"WHIP_TCP_OK");
                    eprintln!("TCP forwarding over SSH exec and socket half-close verified");
                }
            }

            let hostname = ssh.sftp_read_limited("/etc/hostname", 1024).await?;
            assert_eq!(String::from_utf8(hostname)?.trim(), expected_host);
            eprintln!("SFTP read of /etc/hostname verified");

            let payload = (0..=250_u8).cycle().take(512 * 1024).collect::<Vec<_>>();
            let echoed = tokio::time::timeout(Duration::from_secs(30), ssh.execute_with_input("cat", &payload)).await??;
            assert_eq!(echoed.exit_status, Some(0));
            assert_eq!(echoed.stdout, payload);
            eprintln!("512 KiB SSH stdin/stdout round trip verified");
            ssh.disconnect().await;

            if builtin_ssh {
                let mut stranger = config.clone();
                stranger.tailcat_private_key = Some(generate_tailcat_identity()?.private_key);
                let attempt = tokio::time::timeout(Duration::from_secs(8), SshSession::connect(&stranger, None)).await;
                assert!(!matches!(attempt, Ok(Ok(_))), "allowlisted server admitted a different Tailcat identity");
                eprintln!("Server rejected a different Tailcat client identity");
            }

            let ssh = tokio::time::timeout(Duration::from_secs(60), SshSession::connect(&config, None)).await??;
            let output = ssh.execute("printf WHIP_TAILCAT_RECONNECTED").await?;
            assert_eq!(output.stdout, b"WHIP_TAILCAT_RECONNECTED");
            ssh.disconnect().await;
            eprintln!("Disconnect and fresh Tailcat/SSH reconnect verified");
            Ok::<_, Box<dyn std::error::Error>>(())
        })
    }
}
