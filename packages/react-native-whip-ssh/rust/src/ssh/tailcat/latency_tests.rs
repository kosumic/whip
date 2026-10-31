//! Opt-in network/Rust key-to-PTY-echo measurements; excludes phone UI rendering.

use std::{
    error::Error,
    sync::Arc,
    time::{Duration, Instant},
};

use crate::ssh::{
    SshConnectionConfig, SshCredential, SshSession, TrustedHostKey, set_trusted_host_keys,
};

const SSH_PORT: u16 = 22;
const TAILCAT_HOST: &str = "whip-tailcat-latency.invalid";
const SHELL_ID: &str = "live-latency";
const READY: &[u8] = b"WHIP_LATENCY_READY\n";
const WARMUP: usize = 16;
const SAMPLES: usize = 128;
const PACE: Duration = Duration::from_millis(50);
const TIMEOUT: Duration = Duration::from_secs(15);
type TestResult<T> = Result<T, Box<dyn Error>>;
type EchoReceiver = tokio::sync::mpsc::UnboundedReceiver<(Instant, Vec<u8>)>;

fn setting_file(name: &str) -> TestResult<String> {
    Ok(std::fs::read_to_string(std::env::var(name)?)?)
}

async fn echo(ssh: &SshSession, receiver: &mut EchoReceiver, key: u8) -> TestResult<f64> {
    let started = Instant::now();
    ssh.shell_input(SHELL_ID, vec![key])?;
    let (arrived, bytes) = tokio::time::timeout(TIMEOUT, receiver.recv())
        .await?
        .ok_or("PTY echo channel closed")?;
    if bytes != [key] {
        return Err("unexpected PTY data during single-byte echo measurement".into());
    }
    Ok(arrived.duration_since(started).as_secs_f64() * 1000.0)
}

fn summary(case: &str, samples: &mut [f64]) -> serde_json::Value {
    samples.sort_by(f64::total_cmp);
    let percentile = |percent: usize| samples[(samples.len() * percent).div_ceil(100) - 1];
    serde_json::json!({
        "case": case, "samples": samples.len(),
        "min_ms": samples[0], "p50_ms": percentile(50),
        "p95_ms": percentile(95), "p99_ms": percentile(99),
        "max_ms": samples[samples.len() - 1],
    })
}

pub(super) async fn measure(
    case: &str,
    config: &SshConnectionConfig,
) -> TestResult<Vec<serde_json::Value>> {
    let ssh =
        tokio::time::timeout(Duration::from_secs(60), SshSession::connect(config, None)).await??;
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    ssh.open_shell(
        SHELL_ID,
        "xterm-256color",
        80,
        24,
        Arc::new(move |bytes| {
            let _ = sender.send((Instant::now(), bytes));
        }),
        Arc::new(|_| {}),
        Some("stty raw -echo && printf 'WHIP_LATENCY_READY\\n' && exec cat"),
    )
    .await?;
    let mut ready = Vec::new();
    while !ready.windows(READY.len()).any(|bytes| bytes == READY) {
        let (_, bytes) = tokio::time::timeout(TIMEOUT, receiver.recv())
            .await?
            .ok_or("PTY closed before becoming ready")?;
        ready.extend(bytes);
    }
    for _ in 0..WARMUP {
        echo(&ssh, &mut receiver, b'w').await?;
        tokio::time::sleep(PACE).await;
    }
    let mut typing = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        tokio::time::sleep(PACE).await;
        typing.push(echo(&ssh, &mut receiver, b'x').await?);
    }
    let typing = summary(case, &mut typing);
    eprintln!("KEY_ECHO {typing}");
    let mut idle = Vec::with_capacity(10);
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        idle.push(echo(&ssh, &mut receiver, b'i').await?);
    }
    let idle = summary(&format!("{case}-after-1s-idle"), &mut idle);
    eprintln!("KEY_ECHO {idle}");
    ssh.close_shell(SHELL_ID)?;
    ssh.disconnect().await;
    Ok(vec![typing, idle])
}

#[test]
#[ignore = "requires live SSH/Tailcat credentials; reports network/Rust PTY echo latency"]
fn live_remote_typing_latency() -> TestResult<()> {
    let direct_host = std::env::var("WHIP_TAILCAT_LIVE_DIRECT_HOST")?;
    let public_key = setting_file("WHIP_TAILCAT_LIVE_HOST_KEY_FILE")?;
    let key_type = public_key
        .split_whitespace()
        .next()
        .ok_or("missing SSH host key")?;
    set_trusted_host_keys(
        [direct_host.as_str(), TAILCAT_HOST]
            .into_iter()
            .map(|host| TrustedHostKey {
                host: host.into(),
                port: SSH_PORT,
                key_type: key_type.into(),
                public_key: public_key.trim().into(),
            })
            .collect(),
    )?;
    let mut config = SshConnectionConfig {
        host: direct_host,
        port: SSH_PORT,
        username: std::env::var("WHIP_TAILCAT_LIVE_USER")?,
        tailcat_address: None,
        tailcat_private_key: None,
        tailcat_ssh_server: false,
        credential: SshCredential::Key {
            private_key: setting_file("WHIP_TAILCAT_LIVE_KEY_FILE")?,
            passphrase: None,
        },
        forward_agent: false,
    };
    let mut results = Vec::new();
    tokio::runtime::Runtime::new()?.block_on(async {
        results.extend(measure("direct-ssh", &config).await?);
        config.host = TAILCAT_HOST.into();
        config.tailcat_private_key = Some(super::generate_tailcat_identity()?.private_key);
        config.tailcat_address = Some(
            setting_file("WHIP_TAILCAT_LIVE_ADDRESS_FILE")?
                .trim()
                .into(),
        );
        let case = if std::env::var("TS_DEBUG_ALWAYS_USE_DERP")
            .is_ok_and(|value| value == "true" || value == "1")
        {
            "tailcat-forced-derp"
        } else {
            "tailcat-default"
        };
        results.extend(measure(case, &config).await?);
        Ok::<_, Box<dyn Error>>(())
    })?;
    if let Ok(path) = std::env::var("WHIP_TAILCAT_LATENCY_RESULTS") {
        std::fs::write(path, serde_json::to_vec_pretty(&results)?)?;
    }
    Ok(())
}
