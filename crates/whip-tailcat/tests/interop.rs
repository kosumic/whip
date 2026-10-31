//! Run with tests/interop.sh. Go is an optional, separately built test fixture.
use std::{io, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    time::{sleep, timeout},
};
use whip_tailcat::{Client, ClientCache, ClientOptions, Identity};

struct Reference {
    _child: Child,
    address: String,
}

impl Reference {
    async fn start(no_psk: bool) -> Result<Self, Box<dyn std::error::Error>> {
        let binary = std::env::var("WHIP_TAILCAT_REFERENCE")?;
        let mut child = Command::new(binary)
            .arg("-test.run=^TestWhipTailcatReference$")
            .env("WHIP_REFERENCE_NO_PSK", if no_psk { "1" } else { "0" })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let mut lines =
            BufReader::new(child.stdout.take().ok_or("missing fixture output")?).lines();
        let address = timeout(Duration::from_secs(10), async {
            while let Some(line) = lines.next_line().await? {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line)
                    && let Some(address) = value["address"].as_str()
                {
                    return Ok::<_, io::Error>(address.to_owned());
                }
            }
            Err(io::Error::other("fixture did not print an address"))
        })
        .await??;
        Ok(Self {
            _child: child,
            address,
        })
    }
}

fn options(relay_only: bool) -> ClientOptions {
    ClientOptions {
        relay_only,
        allow_insecure_relays: true,
        ..ClientOptions::default()
    }
}

async fn echo(client: &Client, seed: u8) -> io::Result<()> {
    let mut stream = client.dial_tcp(22).await?;
    let payload: Vec<u8> = (0..1024 * 1024)
        .map(|index| (index as u8).wrapping_add(seed))
        .collect();
    stream.write_all(&payload).await?;
    stream.shutdown().await?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;
    assert_eq!(response, payload);
    Ok(())
}

#[tokio::test]
#[ignore = "requires the separately built upstream Go fixture; run tests/interop.sh"]
async fn direct_udp_binary_transfer_and_half_close() -> Result<(), Box<dyn std::error::Error>> {
    let reference = Reference::start(false).await?;
    let identity = Identity::generate();
    let client = Client::connect(&reference.address, &identity, options(false)).await?;
    timeout(Duration::from_secs(10), async {
        loop {
            if client
                .status()
                .await?
                .peers
                .iter()
                .any(|peer| peer.direct_endpoint.is_some())
            {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
        Ok::<_, io::Error>(())
    })
    .await??;
    timeout(Duration::from_secs(30), echo(&client, 17)).await??;
    assert!(client.disco_ping().await?.endpoint.is_some());
    client.close().await;
    Ok(())
}

#[tokio::test]
#[ignore = "requires the separately built upstream Go fixture; run tests/interop.sh"]
async fn forced_derp_shared_identity_concurrency_and_reconnect()
-> Result<(), Box<dyn std::error::Error>> {
    let reference = Reference::start(false).await?;
    let generated = Identity::generate();
    let identity = Identity::from_saved_keys(&generated.private_key(), &generated.public_key())?;
    let cache = ClientCache::default();
    let (first, second) = tokio::try_join!(
        cache.connect(&reference.address, &identity, options(true)),
        cache.connect(&reference.address, &identity, options(true)),
    )?;
    timeout(Duration::from_secs(30), async {
        tokio::try_join!(echo(&first, 0), echo(&second, 255))?;
        Ok::<_, io::Error>(())
    })
    .await??;
    assert_eq!(
        first.status().await?.public_key,
        second.status().await?.public_key
    );
    assert!(
        matches!(cache.connect(&reference.address, &identity, options(false)).await,
        Err(error) if error.kind() == io::ErrorKind::InvalidInput)
    );
    assert!(
        first
            .status()
            .await?
            .peers
            .iter()
            .all(|peer| peer.direct_endpoint.is_none())
    );
    first.close().await;
    assert!(second.dial_tcp(22).await.is_err());
    let reconnected = cache
        .connect(&reference.address, &identity, options(true))
        .await?;
    timeout(Duration::from_secs(30), echo(&reconnected, 42)).await??;
    reconnected.close().await;
    Ok(())
}

#[tokio::test]
#[ignore = "requires the separately built upstream Go fixture; run tests/interop.sh"]
async fn network_change_preserves_live_tcp_and_stream_owns_client()
-> Result<(), Box<dyn std::error::Error>> {
    let reference = Reference::start(false).await?;
    let client = Client::connect(&reference.address, &Identity::generate(), options(false)).await?;
    let mut stream = client.dial_tcp(23).await?;
    stream.write_all(b"before").await?;
    let mut received = [0; 6];
    stream.read_exact(&mut received).await?;
    assert_eq!(&received, b"before");
    client.network_changed().await?;
    timeout(Duration::from_secs(20), async {
        stream.write_all(b"after!").await?;
        stream.read_exact(&mut received).await?;
        Ok::<_, io::Error>(())
    })
    .await??;
    assert_eq!(&received, b"after!");
    drop(client);
    stream.write_all(b"owned!").await?;
    timeout(Duration::from_secs(5), stream.read_exact(&mut received)).await??;
    assert_eq!(&received, b"owned!");
    Ok(())
}

#[tokio::test]
#[ignore = "requires the separately built upstream Go fixture; run tests/interop.sh"]
async fn bounded_streams_drop_cancellation_and_close_interrupt_idle_reads()
-> Result<(), Box<dyn std::error::Error>> {
    let reference = Reference::start(false).await?;
    let opts = ClientOptions {
        max_streams: 1,
        ..options(true)
    };
    let client = Client::connect(&reference.address, &Identity::generate(), opts).await?;
    let stream = client.dial_tcp(23).await?;
    assert!(client.dial_tcp(23).await.is_err());
    drop(stream);
    timeout(Duration::from_secs(2), async {
        while client.status().await?.active_tcp_connections != 0 {
            sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, io::Error>(())
    })
    .await??;
    let mut stream = client.dial_tcp(23).await?;
    let idle = tokio::spawn(async move { stream.read_u8().await });
    sleep(Duration::from_millis(20)).await;
    timeout(Duration::from_secs(1), client.close()).await?;
    assert!(timeout(Duration::from_secs(1), idle).await??.is_err());
    Ok(())
}

#[tokio::test]
#[ignore = "requires the separately built upstream Go fixture; run tests/interop.sh"]
async fn legacy_no_psk_and_remote_half_close() -> Result<(), Box<dyn std::error::Error>> {
    let reference = Reference::start(true).await?;
    let client = Client::connect(&reference.address, &Identity::generate(), options(true)).await?;
    let mut stream = client.dial_tcp(24).await?;
    let mut received = Vec::new();
    timeout(Duration::from_secs(5), stream.read_to_end(&mut received)).await??;
    assert_eq!(received, b"server-finished");
    stream.write_all(b"client-finished").await?;
    stream.shutdown().await?;
    client.close().await;
    Ok(())
}
