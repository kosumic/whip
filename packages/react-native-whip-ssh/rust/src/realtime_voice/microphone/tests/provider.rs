use super::*;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::future::{Future, ready};
use tokio_tungstenite::tungstenite::Message;
use voice_call_openai::{
    RealtimeSocket,
    session::{Delegate, Event, Flow, LiveConfig, RealtimeConfig, Session},
    socket::Events,
};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[derive(Default)]
struct Acknowledgements(Vec<bool>);

impl Delegate for Acknowledgements {
    type Work = ();

    async fn next_work(&mut self) -> Option<()> {
        std::future::pending().await
    }

    fn work(
        &mut self,
        _: &mut Session<'_>,
        (): (),
    ) -> impl Future<Output = Result<Flow, &'static str>> + Send {
        ready(Ok(Flow::Stop))
    }

    fn event(
        &mut self,
        _: &mut Session<'_>,
        event: Event,
    ) -> impl Future<Output = Result<Flow, &'static str>> + Send {
        use oai_rt_rs::live::ServerEvent;
        if let Event::Live(frame) = event {
            match frame.event {
                ServerEvent::InputAudioMuted { .. } => self.0.push(true),
                ServerEvent::InputAudioUnmuted { .. } => self.0.push(false),
                ServerEvent::UsageUpdated { .. } => return ready(Ok(Flow::Stop)),
                _ => {}
            }
        }
        ready(Ok(Flow::Continue))
    }
}

/// A usage event fences delivery, including acknowledgements the protocol drops.
async fn receive(
    session: &mut Session<'_>,
    events: &mut Events,
    owner: &RealtimeVoiceAdapter,
    frame: Value,
) -> TestResult<Vec<bool>> {
    for mut value in [
        frame,
        json!({"type":"session.usage.updated","usage":{"seconds":0.0}}),
    ] {
        value["event_id"] = json!(uuid::Uuid::new_v4().to_string());
        events
            .send(Ok(Message::Text(value.to_string().into())))
            .await?;
    }
    let mut observer = Acknowledgements::default();
    tokio::time::timeout(Duration::from_secs(1), session.drive(owner, &mut observer)).await??;
    Ok(observer.0)
}

async fn wire(commands: &mut futures::channel::mpsc::Receiver<Message>) -> TestResult<Value> {
    let message = tokio::time::timeout(Duration::from_secs(1), commands.next())
        .await?
        .ok_or("Missing provider command")?;
    Ok(serde_json::from_str(message.to_text()?)?)
}

async fn acknowledge(
    session: &mut Session<'_>,
    events: &mut Events,
    owner: &RealtimeVoiceAdapter,
    command: &Value,
) -> TestResult<Vec<bool>> {
    let kind = match command["type"].as_str() {
        Some("session.input_audio.mute") => "session.input_audio.muted",
        Some("session.input_audio.unmute") => "session.input_audio.unmuted",
        _ => return Err("Invalid microphone command".into()),
    };
    receive(
        session,
        events,
        owner,
        json!({"type":kind,"client_event_id":command["event_id"]}),
    )
    .await
}

#[tokio::test]
async fn recovered_realtime_unmute_clears_provider_input_at_the_original_deadline() -> TestResult {
    let (owner, mut controls) = owner(false)?;
    owner.set_microphone(true, Some(Duration::from_secs(60)))?;
    let deadline = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
    owner.retire_session();
    while controls.try_recv().is_ok() {}
    owner.retiring.store(false, Ordering::Release);
    owner.ready.store(true, Ordering::Release);
    // Readiness can precede the first captured packet clearing this UI phase.
    owner.view.lock().phase = "reconnecting";
    owner.microphone_tick(deadline);
    let crate::realtime_voice::Command::Mute(muted) = controls.try_recv()? else {
        return Err("Missing unmute control".into());
    };
    assert!(!muted);

    let config: crate::realtime_voice::Config = serde_json::from_value(json!({"voice":"cedar"}))?;
    let (mut socket, mut commands, _events) = RealtimeSocket::relay();
    let mut session = Session::realtime(
        &mut socket,
        RealtimeConfig {
            model: config.model()?.id.clone(),
            audio: config.audio_settings()?,
        },
        true,
    );
    session.mute(&*owner, muted).await?;
    assert_eq!(
        wire(&mut commands).await?["type"],
        "input_audio_buffer.clear"
    );
    assert!(owner.input.accepts(owner.input.generation()));
    assert_eq!(owner.microphone.lock().announcements, [true, false]);
    owner.close();
    Ok(())
}

#[tokio::test]
async fn recovered_live_unmute_waits_for_matching_ack_and_newer_intent_wins() -> TestResult {
    let (owner, mut controls) = owner(true)?;
    owner.set_microphone(true, Some(Duration::from_secs(60)))?;
    let deadline = owner.microphone.lock().deadline.ok_or("Missing deadline")?;
    owner.retire_session();
    while controls.try_recv().is_ok() {}
    owner.microphone_tick(deadline);
    assert!(controls.try_recv().is_err());
    owner.retiring.store(false, Ordering::Release);

    let (mut socket, mut commands, mut events) = RealtimeSocket::relay();
    let mut session = Session::live(
        &mut socket,
        LiveConfig {
            model: "gpt-live-1".into(),
            voice: "quartz".into(),
            backend_model: None,
            session_id: None,
        },
        true,
    );
    receive(
        &mut session,
        &mut events,
        &owner,
        json!({"type":"session.started","session":{
            "id":"recovered", "model":"gpt-live-1", "status":"active", "expires_at":2_000_000_000
        }}),
    )
    .await?;
    owner.ready.store(true, Ordering::Release);
    owner.view.lock().phase = "muted";
    // Startup restores the retained mute to the replacement provider.
    session.mute(&*owner, owner.is_muted()).await?;
    let mute = wire(&mut commands).await?;
    assert_eq!(mute["type"], "session.input_audio.mute");
    owner.microphone_tick(deadline + Duration::from_secs(60));
    let crate::realtime_voice::Command::Mute(muted) = controls.try_recv()? else {
        return Err("Missing unmute control".into());
    };
    assert!(!muted);
    session.mute(&*owner, muted).await?;
    let unmute = wire(&mut commands).await?;
    assert_eq!(unmute["type"], "session.input_audio.unmute");
    assert!(!owner.input.accepts(owner.input.generation()));

    assert!(
        acknowledge(&mut session, &mut events, &owner, &mute)
            .await?
            .is_empty()
    );
    assert!(!owner.input.accepts(owner.input.generation()));

    // User mutes before the pending auto-unmute acknowledgement arrives.
    owner.set_microphone(true, None)?;
    assert_eq!(
        acknowledge(&mut session, &mut events, &owner, &unmute).await?,
        [false]
    );
    assert!(owner.view.lock().muted);
    assert!(!owner.input.accepts(owner.input.generation()));

    owner.set_microphone(false, None)?;
    session.mute(&*owner, false).await?;
    let latest = wire(&mut commands).await?;
    assert!(
        acknowledge(&mut session, &mut events, &owner, &unmute)
            .await?
            .is_empty()
    );
    assert!(!owner.input.accepts(owner.input.generation()));
    assert_eq!(
        acknowledge(&mut session, &mut events, &owner, &latest).await?,
        [false]
    );
    assert!(owner.input.accepts(owner.input.generation()));
    owner.microphone_tick(deadline + Duration::from_secs(600));
    assert!(!owner.view.lock().muted);
    assert!(owner.microphone.lock().deadline.is_none());
    owner.close();
    Ok(())
}
