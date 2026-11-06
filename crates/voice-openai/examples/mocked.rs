//! Credential-free host and signaling fixtures for both provider protocols.
#[path = "../tests/support/mod.rs"]
mod support;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};
use support::{App, MockCredential};
use tokio_tungstenite::tungstenite::Message;
use voice_openai::{
    live,
    socket::Socket,
    tools::{Access, Ledger, function_output},
};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result {
    // This attempt is cancelled before signaling. It must not access credentials.
    let app = Arc::new(App::new(false)?);
    let credential = MockCredential::default();
    let update = voice_openai::typed(json!({"type":"session.update","session":{
        "type":"realtime", "instructions":"A second app's prompt", "tools":[],
        "audio":{"output":{"voice":"cedar"}}
    }}))?;
    let result =
        voice_openai::connect_realtime(app.clone(), &credential, update, "gpt-realtime-1.5").await;
    assert_eq!(
        result.err().ok_or("cancelled call connected")?.message,
        voice_openai::recovery::CANCELLED
    );
    assert_eq!(credential.0.load(Ordering::Relaxed), 0);

    // A mock signaling/sideband adapter can supply the same bounded Socket API.
    let (mut socket, mut commands, mut events) = Socket::relay();
    let provider = tokio::spawn(async move {
        let command = commands
            .next()
            .await
            .ok_or("missing configuration")?
            .into_text()
            .map_err(|_| "not text")?;
        let value: Value = serde_json::from_str(&command).map_err(|_| "invalid command")?;
        assert_eq!(value["type"], "session.update");
        events.send(Ok(Message::Text(json!({"type":"response.function_call_arguments.done",
            "event_id":"tool-event", "call_id":"mock-tool", "name":"status", "arguments":"{}"
        }).to_string().into()))).await.map_err(|_| "mock event receiver ended")?;
        let output = commands
            .next()
            .await
            .ok_or("missing tool result")?
            .into_text()
            .map_err(|_| "not text")?;
        let output: Value = serde_json::from_str(&output).map_err(|_| "invalid output")?;
        assert_eq!(output["item"]["call_id"], "mock-tool");
        Ok::<_, &'static str>(())
    });
    voice_openai::send_value(&mut socket, json!({"type":"session.update","session":{
        "type":"realtime", "instructions":"Host-supplied context", "tools":[{"type":"function","name":"status",
        "parameters":{"type":"object","properties":{},"additionalProperties":false}}],
        "audio":{"input":{"turn_detection":{"type":"server_vad","threshold":0.5,"prefix_padding_ms":300,"silence_duration_ms":500}},"output":{"voice":"cedar"}}
    }})).await?;
    let event = socket.next().await;
    let text = socket
        .receive_text(event)
        .await?
        .ok_or("missing tool event")?;
    let event: Value = serde_json::from_str(&text)?;
    let mut ledger = Ledger::default();
    let id = event["call_id"].as_str().ok_or("missing call ID")?;
    // The host's own tool catalog authorizes status as read-only, then executes it.
    let mutation = ledger.begin(id, "{}", Access::Read)?;
    voice_openai::send(
        &mut socket,
        function_output(id.into(), json!({"status":"ready"})),
    )
    .await?;
    ledger.complete(mutation, false);
    provider.await??;
    socket.close().await?;

    let (mut socket, mut commands, _events) = Socket::relay();
    let sent = live::send(&mut socket, oai_rt_rs::live::Command::InputAudioMute).await?;
    let command: Value = serde_json::from_str(
        &commands
            .next()
            .await
            .ok_or("missing Live mute")?
            .into_text()?,
    )?;
    assert_eq!(command["event_id"], sent);
    let mut control = live::Control::default();
    control.muted = Some((sent.clone(), true, std::time::Instant::now()));
    assert!(control.confirm_mute(Some(&sent), true));
    let mut usage = live::usage::DurationUsage::default();
    usage.observe(1.5, false)?;
    usage.observe(2.0, true)?;
    assert_eq!(usage.seconds, 2.0);
    socket.close().await?;
    app.current.store(false, Ordering::Release);
    app.input.close();
    println!("Mock Realtime tools, Live mute/usage and cancelled native media stopped cleanly.");
    Ok(())
}
