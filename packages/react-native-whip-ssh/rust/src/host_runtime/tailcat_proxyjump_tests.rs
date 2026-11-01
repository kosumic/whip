//! Opt-in real Tailcat -> OpenSSH/built-in SSH -> SSH gateway -> private sshd.
use std::{
    error::Error,
    io::{BufRead, BufReader, Write},
    os::unix::process::CommandExt,
    process::{Child, Command, Stdio},
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{sleep, timeout};

use super::*;
use crate::ssh::{SshSession, TrustedHostKey, set_trusted_host_keys, tailcat};

type TestResult<T = ()> = Result<T, Box<dyn Error>>;
const TARGET: &str = "private-target.invalid";
const BLOCKED: &str = "blocked-target.invalid";
const SHELL: &str = "proxyjump-shell";
const DEADLINE: Duration = Duration::from_secs(30);

#[derive(Default, Deserialize)]
struct ReferenceInfo {
    address: String,
    root: String,
    username: String,
    gateway_key: String,
    router_key: String,
    target_key: String,
    router_port: u16,
    tcp_port: u16,
    unix_socket: String,
}

struct Reference {
    child: Child,
    lines: mpsc::Receiver<String>,
    info: ReferenceInfo,
}

impl Drop for Reference {
    fn drop(&mut self) {
        // EOF lets Go run t.Cleanup and reap its temporary sshd processes.
        self.child.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        // Our process group includes fixture sshd/session children. This also
        // handles failed assertions or a hung fixture without touching host sshd.
        let _ = Command::new("sh")
            .args([
                "-c",
                "kill -KILL -- \"-$1\" 2>/dev/null || true",
                "fixture-cleanup",
            ])
            .arg(self.child.id().to_string())
            .status();
        let _ = self.child.wait();
    }
}

impl Reference {
    fn start(
        builtin: bool,
        relay_only: bool,
        identity: &whip_tailcat::Identity,
    ) -> TestResult<Self> {
        let mut child = Command::new(std::env::var("WHIP_TAILCAT_PROXYJUMP_REFERENCE")?)
            .arg("-test.run=^TestWhipTailcatProxyJump$")
            .env(
                "WHIP_REFERENCE_BUILTIN_SSH",
                if builtin { "1" } else { "0" },
            )
            .env(
                "WHIP_REFERENCE_RELAY_ONLY",
                if relay_only { "1" } else { "0" },
            )
            .env("WHIP_REFERENCE_CLIENT_NODE_KEY", identity.public_key())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()?;
        let stdout = child.stdout.take().ok_or("missing reference stdout")?;
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        // Install cleanup before reading metadata, including startup failures.
        let mut fixture = Self {
            child,
            lines,
            info: ReferenceInfo::default(),
        };
        fixture.info = serde_json::from_value(fixture.receive()?)?;
        Ok(fixture)
    }

    fn receive(&self) -> TestResult<serde_json::Value> {
        let deadline = Instant::now() + DEADLINE;
        loop {
            let line = self
                .lines
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))?;
            if let Ok(value) = serde_json::from_str(&line) {
                return Ok(value);
            }
        }
    }

    fn command(&mut self, command: &str) -> TestResult<serde_json::Value> {
        let stdin = self.child.stdin.as_mut().ok_or("reference stdin closed")?;
        writeln!(stdin, "{command}")?;
        stdin.flush()?;
        self.receive()
    }

    async fn idle(&mut self) -> TestResult {
        timeout(DEADLINE, async {
            loop {
                let status = self.command("status")?;
                if status["gateways"] == 0 && status["routers"] == 0 && status["targets"] == 0 {
                    return Ok::<_, Box<dyn Error>>(());
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await?
    }

    fn config(
        &self,
        builtin: bool,
        identity: &whip_tailcat::Identity,
    ) -> TestResult<HostRuntimeConfig> {
        let credential = HostSshCredential::Key {
            private_key: std::fs::read_to_string(format!("{}/client-key", self.info.root))?,
            passphrase: None,
        };
        let ssh = HostSshConfig {
            host: TARGET.into(),
            port: 22,
            username: self.info.username.clone(),
            credential,
            forward_agent: false,
            tailcat_address: None,
            tailcat_private_key: None,
            tailcat_ssh_server: false,
        };
        let gateway = HostSshConfig {
            host: "tailcat-gateway.invalid".into(),
            tailcat_address: Some(self.info.address.clone()),
            tailcat_private_key: Some(identity.private_key()),
            tailcat_ssh_server: builtin,
            ..ssh.clone()
        };
        let router = HostSshConfig {
            host: "127.0.0.1".into(),
            port: self.info.router_port,
            ..ssh.clone()
        };
        Ok(HostRuntimeConfig {
            runtime_id: uuid::Uuid::new_v4().to_string(),
            ssh,
            jump_hosts: vec![gateway, router],
            herdr_enabled: false,
            session_name: "main".into(),
            herdr_command: "herdr".into(),
            socket_path: None,
            cached_socket_path: None,
        })
    }

    fn trust(&self, config: &HostRuntimeConfig) -> Vec<TrustedHostKey> {
        config
            .jump_hosts
            .iter()
            .chain(std::iter::once(&config.ssh))
            .zip([
                &self.info.gateway_key,
                &self.info.router_key,
                &self.info.target_key,
            ])
            .map(|(ssh, key)| TrustedHostKey {
                host: if ssh.tailcat_ssh_server {
                    format!("tailcat-ssh:{}", ssh.host)
                } else {
                    ssh.host.clone()
                },
                port: ssh.port,
                key_type: "ssh-ed25519".into(),
                public_key: key.trim().into(),
            })
            .collect()
    }
}

struct OwnedRuntime(Arc<HostRuntime>);
impl Drop for OwnedRuntime {
    fn drop(&mut self) {
        let host = self.0.clone();
        if let Ok(runtime) = crate::runtime() {
            runtime.spawn(async move {
                let _ = host.disconnect().await;
            });
        }
    }
}

fn host(config: &HostRuntimeConfig) -> TestResult<OwnedRuntime> {
    Ok(OwnedRuntime(create_host_runtime(HostRuntimeConfig {
        runtime_id: uuid::Uuid::new_v4().to_string(),
        ..config.clone()
    })?))
}

async fn trust_and_authentication(
    reference: &mut Reference,
    config: &HostRuntimeConfig,
) -> TestResult {
    let trusted = reference.trust(config);
    // Each hop must independently challenge before it is accepted.
    for (index, expected) in trusted.iter().enumerate() {
        set_trusted_host_keys(trusted[..index].to_vec())?;
        let runtime = host(config)?;
        let result = runtime.0.connect().await;
        runtime.0.disconnect().await?;
        match result {
            Err(HostRuntimeError::HostKeyUnknown(challenge)) => {
                assert_eq!(
                    (challenge.host, challenge.port),
                    (expected.host.clone(), expected.port)
                );
                assert_eq!(challenge.public_key.trim(), expected.public_key);
            }
            other => return Err(format!("expected unknown key at hop {index}: {other:?}").into()),
        }
        reference.idle().await?;
    }
    // A trusted key for another hop must never authorize this hop.
    for (index, expected) in trusted.iter().enumerate() {
        let mut changed = trusted.clone();
        changed[index]
            .public_key
            .clone_from(&trusted[(index + 1) % trusted.len()].public_key);
        set_trusted_host_keys(changed)?;
        let runtime = host(config)?;
        let result = runtime.0.connect().await;
        runtime.0.disconnect().await?;
        assert!(
            matches!(result, Err(HostRuntimeError::HostKeyChanged(challenge)) if challenge.host == expected.host && challenge.port == expected.port)
        );
        reference.idle().await?;
    }
    set_trusted_host_keys(trusted)?;
    let wrong_key = std::fs::read_to_string(format!("{}/wrong-client-key", reference.info.root))?;
    for index in 0..=config.jump_hosts.len() {
        let mut rejected = config.clone();
        let ssh = if index < rejected.jump_hosts.len() {
            &mut rejected.jump_hosts[index]
        } else {
            &mut rejected.ssh
        };
        ssh.credential = HostSshCredential::Key {
            private_key: wrong_key.clone(),
            passphrase: None,
        };
        let runtime = host(&rejected)?;
        let result = runtime.0.connect().await;
        runtime.0.disconnect().await?;
        assert!(
            matches!(result, Err(HostRuntimeError::AuthenticationFailure(_))),
            "hop {index}: {result:?}"
        );
        reference.idle().await?;
    }
    Ok(())
}

async fn forwarding(ssh: &SshSession, reference: &Reference) -> TestResult {
    let mut tcp = ssh
        .open_direct_tcpip("127.0.0.1", reference.info.tcp_port)
        .await?;
    tcp.write_all(b"TCP half-close").await?;
    tcp.shutdown().await?;
    let mut bytes = Vec::new();
    timeout(DEADLINE, tcp.read_to_end(&mut bytes)).await??;
    assert_eq!(bytes, b"TCP half-close");
    let response = ssh
        .request_unix_socket(
            &reference.info.unix_socket,
            b"Herdr request\n",
            b'\n',
            5_000,
            1024,
        )
        .await?;
    assert_eq!(response, b"Herdr request");
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    ssh.open_length_prefixed_unix_socket(
        "framed-proxyjump",
        &reference.info.unix_socket,
        1024,
        Arc::new(move |bytes| {
            let _ = sender.send(bytes);
        }),
        Arc::new(|_| {}),
    )
    .await?;
    ssh.write_unix_socket("framed-proxyjump", b"Herdr frame".to_vec(), true)?;
    assert_eq!(
        timeout(DEADLINE, receiver.recv())
            .await?
            .ok_or("framed stream closed")?,
        b"Herdr frame"
    );
    ssh.close_unix_socket("framed-proxyjump")?;
    Ok(())
}

struct ShellSink(tokio::sync::mpsc::UnboundedSender<Vec<u8>>);
impl HostRuntimeEventSink for ShellSink {
    fn event(&self, event: HostRuntimeEvent) {
        if let HostRuntimeEvent::SshShellData {
            terminal_id, bytes, ..
        } = event
            && terminal_id == SHELL
        {
            let _ = self.0.send(bytes);
        }
    }
}

async fn shell_echo(
    runtime: &HostRuntime,
    receiver: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
) -> TestResult {
    // The output token never appears contiguously in the echoed input command.
    runtime.ssh_shell_input(
        SHELL.into(),
        b"printf '%s%s\\n' 'RECOVERED_' 'SHELL'\n".to_vec(),
    )?;
    timeout(DEADLINE, async {
        let mut output = Vec::new();
        loop {
            output.extend(receiver.recv().await.ok_or("shell stream closed")?);
            if output
                .windows(b"RECOVERED_SHELL".len())
                .any(|part| part == b"RECOVERED_SHELL")
            {
                return Ok::<_, Box<dyn Error>>(());
            }
        }
    })
    .await?
}

async fn cancellation(reference: &mut Reference, config: &HostRuntimeConfig) -> TestResult {
    let mut blocked = config.clone();
    blocked.ssh.host = BLOCKED.into();
    let runtime = host(&blocked)?;
    let inner = runtime.0.inner.clone();
    let mut cancel = inner.cancellation.subscribe();
    let pending = tokio::spawn(async move {
        connection::connect_chain_until_cancelled(&inner, &mut cancel).await
    });
    timeout(DEADLINE, async {
        while reference.command("status")?["blocked"]
            .as_u64()
            .unwrap_or_default()
            == 0
        {
            sleep(Duration::from_millis(20)).await;
        }
        Ok::<_, Box<dyn Error>>(())
    })
    .await??;
    runtime.0.disconnect().await?;
    assert!(timeout(DEADLINE, pending).await??.is_none());
    reference.idle().await?;
    Ok(())
}

async fn exercise(builtin: bool, relay_only: bool) -> TestResult {
    let identity = whip_tailcat::Identity::generate();
    let _relay = relay_only.then(|| tailcat::test_support::RelayOnlyIdentity::new(&identity));
    let mut reference = Reference::start(builtin, relay_only, &identity)?;
    let saved_private = identity.private_key();
    // Observe one shared actor throughout the SSH trust/authentication probes;
    // cold actor teardown/recreation has its own transport interoperability test.
    let client = tailcat::test_support::client(&reference.info.address, &saved_private).await?;
    let config = reference.config(builtin, &identity)?;
    assert!(!matches!(
        timeout(
            Duration::from_secs(2),
            tokio::net::TcpStream::connect((TARGET, 22))
        )
        .await,
        Ok(Ok(_))
    ));
    trust_and_authentication(&mut reference, &config).await?;
    cancellation(&mut reference, &config).await?;
    let runtime = host(&config)?;
    runtime.0.connect().await?;
    let ssh = connection::current_ssh(&runtime.0.inner)?;
    let output = ssh
        .execute("printf 'private target'; printf 'target stderr' >&2; exit 7")
        .await?;
    assert_eq!(output.stdout, b"private target");
    assert_eq!(output.stderr, b"target stderr");
    assert_eq!(output.exit_status, Some(7));
    assert_eq!(
        ssh.sftp_read_limited(&format!("{}/sftp.txt", reference.info.root), 1024)
            .await?,
        b"private target SFTP\n"
    );
    forwarding(&ssh, &reference).await?;
    let gateway = runtime.0.inner.jump_sessions.lock()[0].clone();
    forwarding(&gateway, &reference).await?; // also exercises the built-in nc -N/-U bridge
    if builtin {
        assert!(gateway.open_remote_forward(1).await.is_err());
    }
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    set_host_runtime_event_sink(Arc::new(ShellSink(sender)));
    runtime
        .0
        .open_ssh_shell(SHELL.into(), 80, 24, 8, 16)
        .await?;
    shell_echo(&runtime.0, &mut receiver).await?;
    if !relay_only {
        timeout(DEADLINE, async {
            while client.disco_ping().await?.endpoint.is_none() {
                sleep(Duration::from_millis(20)).await;
            }
            Ok::<_, std::io::Error>(())
        })
        .await??;
    }
    assert_eq!(
        client
            .status()
            .await?
            .peers
            .iter()
            .any(|peer| peer.direct_endpoint.is_some()),
        !relay_only
    );
    let before = client.status().await?;
    let generation = runtime.0.status().generation;
    for _ in 0..50 {
        tailcat::whip_tailcat_network_changed();
    }
    timeout(DEADLINE, async {
        while client.status().await?.network_rebinds == before.network_rebinds {
            sleep(Duration::from_millis(20)).await;
        }
        Ok::<_, std::io::Error>(())
    })
    .await??;
    sleep(Duration::from_millis(600)).await;
    assert_eq!(
        client.status().await?.network_rebinds,
        before.network_rebinds + 1
    );
    assert_eq!(client.status().await?.public_key, before.public_key);
    assert_eq!(runtime.0.status().generation, generation);
    shell_echo(&runtime.0, &mut receiver).await?;
    assert_eq!(runtime.0.status().generation, generation);
    // Lose the actual first-hop SSH stream. HostRuntime must recreate every hop
    // and restore the UI shell intent/geometry, using the saved identity/trust.
    reference.command("drop")?;
    timeout(DEADLINE, async {
        while runtime.0.status().generation <= generation
            || runtime.0.status().state != HostConnectionState::Connected
            || !runtime.0.has_ssh_shell(SHELL.into())
        {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    assert_eq!(
        runtime
            .0
            .ssh_shell_geometry(SHELL.into())
            .ok_or("shell geometry missing")?
            .columns,
        80
    );
    shell_echo(&runtime.0, &mut receiver).await?;
    let restored = connection::current_ssh(&runtime.0.inner)?;
    assert_eq!(
        restored.execute("printf reconnected").await?.stdout,
        b"reconnected"
    );
    assert!(
        reference.command("status")?["forwards"]
            .as_u64()
            .unwrap_or_default()
            >= 2
    );
    let mut unsupported = config.clone();
    unsupported
        .ssh
        .tailcat_address
        .clone_from(&config.jump_hosts[0].tailcat_address);
    unsupported
        .ssh
        .tailcat_private_key
        .clone_from(&config.jump_hosts[0].tailcat_private_key);
    unsupported.jump_hosts[0].tailcat_address = None;
    unsupported.jump_hosts[0].tailcat_private_key = None;
    unsupported.jump_hosts[0].tailcat_ssh_server = false;
    assert!(matches!(
        create_host_runtime(unsupported),
        Err(HostRuntimeError::InvalidConfiguration(_))
    ));
    assert!(
        SshSession::connect(
            &connection::ssh_config(&config.jump_hosts[0]),
            Some(&restored)
        )
        .await
        .is_err()
    );
    runtime.0.disconnect().await?;
    reference.idle().await?;
    clear_host_runtime_event_sink();
    eprintln!("Tailcat ProxyJump: builtin={builtin} relay_only={relay_only} passed");
    Ok(())
}

#[test]
#[ignore = "run tests/test-tailcat-proxyjump.sh for local Tailcat/DERP/OpenSSH fixtures"]
fn tailcat_first_hop_proxyjump_end_to_end() -> TestResult {
    let _guard = tests::EVENT_SINK_TEST_LOCK.lock();
    crate::runtime()?.block_on(async {
        for builtin in [false, true] {
            for relay_only in [false, true] {
                eprintln!("Tailcat ProxyJump: builtin={builtin} relay_only={relay_only} starting");
                timeout(Duration::from_secs(180), exercise(builtin, relay_only)).await??;
            }
        }
        Ok(())
    })
}
