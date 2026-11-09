//! A second app exercising the public call API, without Whip or a provider key.
use crate::support::App;
use base64::{Engine, engine::general_purpose::STANDARD};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use voice_call_media::{Capture, FRAME};
use voice_call_openai::{
    ServerEvent,
    captions::Language,
    session::{Call, Delegate, Event, Flow, LiveConfig, RealtimeConfig, Session},
    settings::AudioSettings,
    socket::{Events, Socket},
    tools::{Access, Ledger},
};
pub type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

enum Action {
    Mute(bool),
    Interrupt,
    Text(String),
    Stop,
}
struct Application {
    audio: Arc<App>,
    controls: mpsc::Receiver<Action>,
    notices: mpsc::Sender<&'static str>,
    tools: Ledger,
    tool_runs: usize,
    final_responses: usize,
    live_final: Option<f64>,
}
impl Delegate for Application {
    type Work = Action;
    async fn next_work(&mut self) -> Option<Action> {
        self.controls.recv().await
    }
    async fn work(
        &mut self,
        session: &mut Session<'_>,
        action: Action,
    ) -> Result<Flow, &'static str> {
        match action {
            Action::Mute(muted) => session.mute(&*self.audio, muted).await?,
            Action::Interrupt => session.interrupt(&*self.audio).await?,
            Action::Text(text) => session.send_text(&text).await?,
            Action::Stop => return Ok(Flow::Stop),
        }
        Ok(Flow::Continue)
    }
    async fn event(
        &mut self,
        session: &mut Session<'_>,
        event: Event,
    ) -> Result<Flow, &'static str> {
        let notice = match event {
            Event::Realtime(ServerEvent::SessionCreated { .. }) => "created",
            Event::Realtime(ServerEvent::SessionUpdated { .. }) => "ready",
            Event::Realtime(ServerEvent::ResponseOutputAudioDelta { .. }) => "audio",
            Event::Realtime(ServerEvent::ResponseCreated { .. }) => "response",
            Event::Realtime(ServerEvent::ResponseFunctionCallArgumentsDone {
                call_id,
                arguments,
                name,
                ..
            }) => {
                // This app supplies its own catalog and execution policy.
                let access = if matches!(name.as_str(), "status" | "agents_summary") {
                    Access::Read
                } else {
                    Access::Unknown
                };
                if let Ok(mutation) = self.tools.begin(&call_id, &arguments, access) {
                    self.tool_runs += 1;
                    session
                        .tool_result(call_id, json!({"status":"ready"}))
                        .await?;
                    self.tools.complete(mutation, false);
                }
                "tool"
            }
            Event::Live(frame) => match frame.event {
                oai_rt_rs::live::ServerEvent::Started { .. } => "ready",
                oai_rt_rs::live::ServerEvent::OutputAudioDelta { .. } => "audio",
                oai_rt_rs::live::ServerEvent::InputAudioMuted { .. } => "muted",
                oai_rt_rs::live::ServerEvent::InputAudioUnmuted { .. } => "unmuted",
                oai_rt_rs::live::ServerEvent::InputTranscriptDelta { .. } => "input",
                _ => "event",
            },
            _ => "event",
        };
        self.notices
            .send(notice)
            .await
            .map_err(|_| "Observer ended")?;
        Ok(Flow::Continue)
    }
    fn usage(&mut self, event: &ServerEvent) {
        if matches!(event, ServerEvent::ResponseDone { .. }) {
            self.final_responses += 1;
        }
    }
    fn live_usage(&mut self, seconds: f64, finalized: bool) {
        if finalized {
            self.live_final = Some(seconds);
        }
    }
}
async fn emit(events: &mut Events, value: Value) -> TestResult {
    events
        .send(Ok(Message::Text(value.to_string().into())))
        .await?;
    Ok(())
}
async fn notice(notices: &mut mpsc::Receiver<&'static str>, expected: &str) -> TestResult {
    loop {
        if notices.recv().await.ok_or("Observer ended")? == expected {
            return Ok(());
        }
    }
}
async fn command(
    commands: &mut futures::channel::mpsc::Receiver<Message>,
    kind: &str,
) -> TestResult<Value> {
    loop {
        let value: Value = serde_json::from_str(
            &commands
                .next()
                .await
                .ok_or("Missing command")?
                .into_text()?,
        )?;
        if value["type"] == kind {
            return Ok(value);
        }
    }
}
fn app(
    audio: Arc<App>,
    controls: mpsc::Receiver<Action>,
    notices: mpsc::Sender<&'static str>,
) -> Application {
    Application {
        audio,
        controls,
        notices,
        tools: Ledger::default(),
        tool_runs: 0,
        final_responses: 0,
        live_final: None,
    }
}
pub fn realtime_config() -> RealtimeConfig {
    RealtimeConfig {
        model: "custom-realtime".into(),
        audio: AudioSettings {
            voice: "cedar".into(),
            preview: false,
            language: Language::Auto,
            turn_detection: None,
        },
    }
}
fn settings(kind: &str) -> Value {
    json!({"type":kind,"event_id":kind,"session":{
        "id":"session","object":"realtime.session","type":"realtime","model":"custom-realtime",
        "expires_at":2_000_000_000,"output_modalities":["audio"],
        "audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"transcription":{"model":"gpt-4o-mini-transcribe"},"turn_detection":null},
        "output":{"format":{"type":"audio/pcm","rate":24000},"voice":"cedar"}}
    }})
}
#[allow(
    dead_code,
    reason = "The call example shares fixtures but runs other flows."
)]
pub async fn webrtc_continuation(completion: &str) -> TestResult {
    let audio = Arc::new(App::new(true)?);
    let (mut socket, mut commands, mut events) = Socket::relay();
    let (controls, receiver) = mpsc::channel(8);
    let (notices, mut observer) = mpsc::channel(32);
    let runner = tokio::spawn(async move {
        let mut application = app(audio.clone(), receiver, notices);
        let mut session = Session::realtime(&mut socket, realtime_config(), true);
        session.drive(&*audio, &mut application).await?;
        Ok::<_, &'static str>(application)
    });
    emit(&mut events, settings("session.updated")).await?;
    notice(&mut observer, "ready").await?;
    emit(&mut events, json!({"type":"response.created","event_id":"created","response":{"id":"reply","object":"realtime.response","status":"in_progress","output":[]}})).await?;
    emit(
        &mut events,
        json!({"type":"output_audio_buffer.started","event_id":"started","response_id":"reply"}),
    )
    .await?;
    emit(&mut events, json!({"type":"response.function_call_arguments.done","event_id":"tool","response_id":"reply","item_id":"tool","output_index":0,"call_id":"summary","name":"agents_summary","arguments":"{}"})).await?;

    // Tool execution and its output do not wait for generation or speech.
    let result = command(&mut commands, "conversation.item.create").await?;
    assert_eq!(result["item"]["type"], "function_call_output");
    assert_eq!(result["item"]["call_id"], "summary");
    emit(&mut events, json!({"type":"response.done","event_id":"done","response":{"id":"reply","object":"realtime.response","status":"completed","output":[]}})).await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(300), commands.next())
            .await
            .is_err()
    );
    emit(
        &mut events,
        json!({"type":completion,"event_id":"stale-stop","response_id":"old"}),
    )
    .await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(300), commands.next())
            .await
            .is_err()
    );
    emit(
        &mut events,
        json!({"type":completion,"event_id":"stop","response_id":"reply"}),
    )
    .await?;
    command(&mut commands, "response.create").await?;

    // A following tool-only response needs no audio-buffer completion event.
    emit(&mut events, json!({"type":"response.created","event_id":"tool-created","response":{"id":"tool-only","object":"realtime.response","status":"in_progress","output":[]}})).await?;
    emit(&mut events, json!({"type":"response.function_call_arguments.done","event_id":"tool-only-call","response_id":"tool-only","item_id":"tool-only-item","output_index":0,"call_id":"summary-two","name":"agents_summary","arguments":"{}"})).await?;
    command(&mut commands, "conversation.item.create").await?;
    emit(&mut events, json!({"type":"response.done","event_id":"tool-done","response":{"id":"tool-only","object":"realtime.response","status":"completed","output":[]}})).await?;
    command(&mut commands, "response.create").await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(300), commands.next())
            .await
            .is_err()
    );
    controls.send(Action::Stop).await?;
    let application = runner.await??;
    assert_eq!(application.tool_runs, 2);
    Ok(())
}
pub async fn realtime() -> TestResult {
    let audio = Arc::new(App::new(true)?);
    let (socket, mut commands, mut events) = Socket::relay();
    let (controls, receiver) = mpsc::channel(8);
    let (notices, mut observer) = mpsc::channel(32);
    let mut application = app(audio.clone(), receiver, notices);
    let call = Call::from_realtime(socket, realtime_config());
    let runner_audio = audio.clone();
    let runner = tokio::spawn(async move {
        call.run(&*runner_audio, &mut application).await?;
        Ok::<_, &'static str>(application)
    });
    emit(&mut events, settings("session.created")).await?;
    notice(&mut observer, "created").await?;
    audio.feed(1, &[123; FRAME])?;
    assert!(
        tokio::time::timeout(Duration::from_millis(30), commands.next())
            .await
            .is_err()
    );
    emit(&mut events, settings("session.updated")).await?;
    notice(&mut observer, "ready").await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(30), commands.next())
            .await
            .is_err()
    );
    audio.feed(2, &[123; FRAME])?;
    let input = command(&mut commands, "input_audio_buffer.append").await?;
    assert_eq!(
        STANDARD.decode(input["audio"].as_str().ok_or("Missing PCM")?)?,
        [123_i16.to_le_bytes(); FRAME].concat()
    );
    controls
        .send(Action::Text("Hello from another app".into()))
        .await?;
    let text = command(&mut commands, "conversation.item.create").await?;
    assert_eq!(text["item"]["content"][0]["text"], "Hello from another app");
    emit(&mut events, json!({"type":"response.created","event_id":"reply-created","response":{"id":"reply","object":"realtime.response","status":"in_progress","output":[]}})).await?;
    emit(&mut events, json!({"type":"response.output_audio.delta","event_id":"pcm","response_id":"reply","item_id":"voice","output_index":0,"content_index":0,"delta":STANDARD.encode(1234_i16.to_le_bytes())})).await?;
    notice(&mut observer, "audio").await?;
    assert_eq!(audio.rendered(), [1234]);
    for id in ["tool-one", "tool-mirror"] {
        emit(&mut events, json!({"type":"response.function_call_arguments.done","event_id":id,"response_id":"reply","item_id":"tool","output_index":0,"call_id":"status","name":"status","arguments":"{}"})).await?;
        notice(&mut observer, "tool").await?;
    }
    command(&mut commands, "conversation.item.create").await?;
    controls.send(Action::Interrupt).await?;
    let cancel = command(&mut commands, "response.cancel").await?;
    assert_eq!(cancel["response_id"], "reply");
    emit(&mut events, json!({"type":"response.output_audio.delta","event_id":"stale","response_id":"reply","item_id":"voice","output_index":0,"content_index":0,"delta":STANDARD.encode(5678_i16.to_le_bytes())})).await?;
    notice(&mut observer, "audio").await?;
    assert_eq!(audio.rendered(), [1234]);
    controls.send(Action::Mute(true)).await?;
    command(&mut commands, "input_audio_buffer.clear").await?;
    assert!(!audio.capture_enabled());
    controls.send(Action::Stop).await?;
    // Only final accounting is admitted after hangup, even if a tool arrives.
    command(&mut commands, "session.update").await?;
    emit(&mut events, json!({"type":"response.function_call_arguments.done","event_id":"late-tool","response_id":"reply","item_id":"late","output_index":0,"call_id":"late","name":"status","arguments":"{}"})).await?;
    emit(&mut events, json!({"type":"response.done","event_id":"final","response":{"id":"reply","object":"realtime.response","status":"cancelled","output":[],"usage":{"total_tokens":2,"input_tokens":1,"output_tokens":1}}})).await?;
    let application = runner.await??;
    assert_eq!(application.tool_runs, 1);
    assert_eq!(application.final_responses, 1);
    Ok(())
}
fn snapshot() -> Value {
    json!({"id":"live-one","expires_at":2_000_000_000,"model":"custom-live","status":"active",
        "audio":{"format":{"type":"audio/pcm","rate":24000},"output":{"voice":"custom-voice"}},"delegation":{"type":"client"}})
}
pub async fn live() -> TestResult {
    let audio = Arc::new(App::new(true)?);
    let (socket, mut commands, mut events) = Socket::relay();
    let (controls, receiver) = mpsc::channel(8);
    let (notices, mut observer) = mpsc::channel(32);
    let mut application = app(audio.clone(), receiver, notices);
    let call = Call::from_live(
        socket,
        LiveConfig {
            model: "custom-live".into(),
            voice: "custom-voice".into(),
            backend_model: None,
            session_id: None,
        },
    );
    let runner_audio = audio.clone();
    let runner = tokio::spawn(async move {
        call.run(&*runner_audio, &mut application).await?;
        Ok::<_, &'static str>(application)
    });
    emit(
        &mut events,
        json!({"type":"session.started","event_id":"start","session":snapshot()}),
    )
    .await?;
    notice(&mut observer, "ready").await?;
    command(&mut commands, "session.input_audio.append").await?;
    controls
        .send(Action::Text("Context from another app".into()))
        .await?;
    let context = command(&mut commands, "session.thinking.append").await?;
    assert_eq!(context["content"], "Context from another app");
    assert!(context["delegation_id"].is_null());
    emit(&mut events, json!({"type":"session.output_audio.delta","event_id":"pcm","delta":STANDARD.encode(1234_i16.to_le_bytes())})).await?;
    notice(&mut observer, "audio").await?;
    assert_eq!(audio.rendered(), [1234]);
    controls.send(Action::Mute(false)).await?;
    let unmute = command(&mut commands, "session.input_audio.unmute").await?;
    assert!(!audio.capture_enabled());
    emit(&mut events, json!({"type":"session.input_audio.unmuted","event_id":"stale-ack","client_event_id":"old"})).await?;
    emit(
        &mut events,
        json!({"type":"session.output_audio.delta","event_id":"barrier","delta":""}),
    )
    .await?;
    notice(&mut observer, "audio").await?;
    assert!(!audio.capture_enabled());
    emit(&mut events, json!({"type":"session.input_audio.unmuted","event_id":"ack","client_event_id":unmute["event_id"]})).await?;
    notice(&mut observer, "unmuted").await?;
    assert!(audio.capture_enabled());
    controls.send(Action::Interrupt).await?;
    command(&mut commands, "session.instructions.append").await?;
    emit(&mut events, json!({"type":"session.output_audio.delta","event_id":"stale-pcm","delta":STANDARD.encode(5678_i16.to_le_bytes())})).await?;
    notice(&mut observer, "audio").await?;
    assert_eq!(audio.rendered(), [1234]);
    emit(&mut events, json!({"type":"session.input_transcript.delta","event_id":"fresh-input","delta":"Hello","start_ms":999_999.0,"end_ms":1_000_000.0})).await?;
    notice(&mut observer, "input").await?;
    emit(&mut events, json!({"type":"session.output_audio.delta","event_id":"fresh-pcm","delta":STANDARD.encode(5678_i16.to_le_bytes())})).await?;
    notice(&mut observer, "audio").await?;
    assert_eq!(audio.rendered(), [1234, 5678]);
    controls.send(Action::Stop).await?;
    command(&mut commands, "session.close").await?;
    emit(&mut events, json!({"type":"session.closed","event_id":"closed","session":snapshot(),"reason":"close_requested","usage":{"seconds":2.5}})).await?;
    let application = runner.await??;
    assert_eq!(application.live_final, Some(2.5));
    Ok(())
}
