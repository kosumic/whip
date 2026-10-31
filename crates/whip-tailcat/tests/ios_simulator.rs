//! Native simulator checks against a separately provisioned upstream server.
//! No subprocess or Go binary runs inside the simulator.
use std::{io, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    time::{sleep, timeout},
};
use whip_tailcat::{Client, ClientOptions, Identity};

async fn transfer(client: &Client) -> io::Result<()> {
    let mut stream = client.dial_tcp(22).await?;
    let payload: Vec<u8> = (0..1024 * 1024).map(|index| index as u8).collect();
    stream.write_all(&payload).await?;
    stream.shutdown().await?;
    let mut received = Vec::new();
    stream.read_to_end(&mut received).await?;
    assert_eq!(received, payload);
    Ok(())
}

#[tokio::test]
#[ignore = "requires WHIP_TAILCAT_TEST_ADDRESS from a separately provisioned upstream fixture"]
async fn upstream_transport_on_ios_simulator() -> Result<(), Box<dyn std::error::Error>> {
    let address = std::env::var("WHIP_TAILCAT_TEST_ADDRESS")?;
    let identity = Identity::generate();
    let options = ClientOptions {
        allow_insecure_relays: true,
        ..ClientOptions::default()
    };
    let client = Client::connect(&address, &identity, options.clone()).await?;
    timeout(Duration::from_secs(10), async {
        while client
            .status()
            .await?
            .peers
            .iter()
            .all(|peer| peer.direct_endpoint.is_none())
        {
            sleep(Duration::from_millis(20)).await;
        }
        Ok::<_, io::Error>(())
    })
    .await??;
    timeout(Duration::from_secs(30), transfer(&client)).await??;
    println!("PASS direct UDP, 1 MiB binary transfer, and TCP half-close");

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
    drop(stream);
    client.close().await;
    println!("PASS live TCP across UDP rebinding and DERP reconnect");

    let imported = Identity::from_saved_keys(&identity.private_key(), &identity.public_key())?;
    let relayed = Client::connect(
        &address,
        &imported,
        ClientOptions {
            relay_only: true,
            ..options
        },
    )
    .await?;
    timeout(Duration::from_secs(30), async {
        tokio::try_join!(transfer(&relayed), transfer(&relayed))?;
        Ok::<_, io::Error>(())
    })
    .await??;
    assert!(
        relayed
            .status()
            .await?
            .peers
            .iter()
            .all(|peer| peer.direct_endpoint.is_none())
    );
    relayed.close().await;
    println!("PASS forced DERP, concurrent TCP streams, and persisted identity reconnect");
    Ok(())
}
