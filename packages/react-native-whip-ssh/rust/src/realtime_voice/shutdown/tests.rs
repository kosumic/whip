#![allow(
    clippy::expect_used,
    reason = "Test fixture and fake-provider assertions."
)]

use super::*;
use crate::app_database::{
    NativeVoiceUsageSession, VoiceUsageEvent, VoiceUsageIdentity, VoiceUsageMode,
    VoiceUsageProvider, VoiceUsageScope,
};
use crate::realtime_voice::{models, socket};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio_tungstenite::tungstenite::Message;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn event(value: Value) -> ServerEvent {
    serde_json::from_value(value).expect("valid provider fixture")
}

fn response(kind: &str, id: &str) -> Value {
    json!({"type":kind,"event_id":format!("{kind}:{id}"),"response":{
        "id":id,"object":"realtime.response","status":if kind == "response.created" {"in_progress"} else {"cancelled"},
        "output":[],"usage":if kind == "response.created" {Value::Null} else {
            json!({"total_tokens":1000,"input_tokens":0,"output_tokens":1000,
                "output_token_details":{"text_tokens":0,"audio_tokens":1000}})
        }
    }})
}

fn chat() -> CurrentChat {
    let model = models::selected(None).expect("default model");
    let mut costs = CurrentChat::new(model);
    costs.observe(&event(
        json!({"type":"session.updated","event_id":"confirmed","session":{
            "id":"session","object":"realtime.session","expires_at":4_000_000_000_u64,
            "type":"realtime","model":model.id,"output_modalities":["audio"]
        }}),
    ));
    costs
}

#[tokio::test(start_paused = true)]
async fn late_cancelled_responses_and_captions_are_persisted_without_starting_work() -> TestResult {
    let (mut socket, mut commands, mut events) = socket::Socket::relay();
    let mut costs = chat();
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let sink = recorded.clone();
    costs.persist(NativeVoiceUsageSession::new(
        VoiceUsageIdentity {
            session_id: "shutdown-test".into(),
            provider: VoiceUsageProvider::Openai,
            mode: VoiceUsageMode::Realtime,
            scope: VoiceUsageScope::Agent,
            model: Some("gpt-realtime-1.5".into()),
            voice: Some("marin".into()),
            started_at_ms: 1,
        },
        Box::new(move |event| sink.lock().push(event)),
    ));
    costs.observe(&event(response("response.created", "active")));
    costs.observe(&event(
        json!({"type":"input_audio_buffer.committed","event_id":"committed","item_id":"caption"}),
    ));
    let provider = tokio::spawn(async move {
        let mut kinds = Vec::new();
        for _ in 0..4 {
            let value: Value = serde_json::from_str(
                &commands
                    .next()
                    .await
                    .expect("shutdown control")
                    .into_text()
                    .expect("text"),
            )
            .expect("JSON control");
            kinds.push(value["type"].as_str().expect("event type").to_owned());
            if value["type"] == "session.update" {
                assert_eq!(
                    value["session"]["audio"]["input"]
                        .as_object()
                        .expect("input config")
                        .get("turn_detection"),
                    Some(&Value::Null)
                );
            }
        }
        assert!(kinds.iter().any(|kind| kind == "response.cancel"));
        assert!(kinds.iter().all(|kind| matches!(
            kind.as_str(),
            "session.update"
                | "input_audio_buffer.clear"
                | "response.cancel"
                | "output_audio_buffer.clear"
        )));
        tokio::time::sleep(Duration::from_millis(100)).await;
        events
            .send(Ok(Message::Text(
                response("response.created", "late").to_string().into(),
            )))
            .await
            .expect("late response");
        let cancel: Value = serde_json::from_str(
            &commands
                .next()
                .await
                .expect("late cancel")
                .into_text()
                .expect("text"),
        )
        .expect("JSON");
        assert_eq!(cancel["type"], "response.cancel");
        assert_eq!(cancel["response_id"], "late");
        for id in ["active", "late", "active"] {
            events
                .send(Ok(Message::Text(
                    response("response.done", id).to_string().into(),
                )))
                .await
                .expect("usage event");
        }
        events.send(Ok(Message::Text(json!({"type":"conversation.item.input_audio_transcription.completed",
            "event_id":"caption-final","item_id":"caption","content_index":0,"transcript":"fixture",
            "usage":{"type":"tokens","input_tokens":100,"output_tokens":10,"total_tokens":110}
        }).to_string().into()))).await.expect("caption usage");
    });
    collect(&mut socket, &mut costs, true, || true).await;
    provider.await?;
    assert!(!costs.has_pending_usage());
    assert!((costs.estimated_usd().ok_or("missing final estimate")? - 0.128_175).abs() < 1e-12);
    drop(costs);
    let recorded = recorded.lock().clone();
    assert!(matches!(
        recorded.last(),
        Some(VoiceUsageEvent::Ended { .. })
    ));
    let finalized: Vec<_> = recorded
        .iter()
        .filter_map(|event| match event {
            VoiceUsageEvent::Usage { item, .. } if item.finalized => Some(item),
            _ => None,
        })
        .collect();
    assert_eq!(finalized.len(), 3);
    assert!(finalized.iter().all(|item| item.estimated_usd.is_some()));
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn silent_provider_is_bounded_and_preserves_priced_parts() {
    let (mut socket, _commands, _events) = socket::Socket::relay();
    let mut costs = chat();
    costs.observe(&event(response("response.done", "known")));
    costs.observe(&event(response("response.created", "missing")));
    let started = tokio::time::Instant::now();
    collect(&mut socket, &mut costs, false, || true).await;
    assert_eq!(started.elapsed(), FINAL_USAGE_TIMEOUT);
    assert!(costs.has_pending_usage());
    assert_eq!(costs.estimated_usd(), Some(0.064));
}

#[tokio::test(start_paused = true)]
async fn revoked_credentials_send_no_shutdown_requests() {
    let (mut socket, mut commands, _events) = socket::Socket::relay();
    collect(&mut socket, &mut chat(), true, || false).await;
    drop(socket);
    assert!(commands.next().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn confirmed_idle_session_finishes_after_the_short_tail() {
    let (mut socket, mut commands, mut events) = socket::Socket::relay();
    let provider = tokio::spawn(async move {
        for _ in 0..3 {
            commands.next().await.expect("shutdown request");
        }
        let model = models::selected(None).expect("default model");
        events
            .send(Ok(Message::Text(
                json!({"type":"session.updated","event_id":"stopped","session":{
                    "id":"session","object":"realtime.session","expires_at":4_000_000_000_u64,
                    "type":"realtime","model":model.id,"output_modalities":["audio"],
                    "audio":{"input":{"turn_detection":null}}
                }})
                .to_string()
                .into(),
            )))
            .await
            .expect("stop confirmation");
        std::future::pending::<()>().await;
    });
    let started = tokio::time::Instant::now();
    collect(&mut socket, &mut chat(), false, || true).await;
    provider.abort();
    let _ = provider.await;
    assert_eq!(started.elapsed(), QUIET_PERIOD);
}

#[tokio::test(start_paused = true)]
async fn revocation_interrupts_a_blocked_shutdown_write() -> TestResult {
    let (mut outgoing, _commands) = futures::channel::mpsc::channel(0);
    outgoing.try_send(Message::Text("queued control".into()))?;
    let (_events, incoming) = futures::channel::mpsc::channel(1);
    let mut socket = socket::Socket::Sideband { outgoing, incoming };
    let current = Arc::new(AtomicBool::new(true));
    let revoke = current.clone();
    let revocation = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        revoke.store(false, Ordering::Release);
    });
    let started = tokio::time::Instant::now();
    collect(&mut socket, &mut chat(), false, || {
        current.load(Ordering::Acquire)
    })
    .await;
    revocation.await?;
    assert!(started.elapsed() <= Duration::from_millis(150));
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn revocation_during_collection_stops_waiting_for_usage() -> TestResult {
    let (mut socket, _commands, _events) = socket::Socket::relay();
    let mut costs = chat();
    costs.observe(&event(response("response.created", "pending")));
    let current = Arc::new(AtomicBool::new(true));
    let revoke = current.clone();
    let revocation = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        revoke.store(false, Ordering::Release);
    });
    let started = tokio::time::Instant::now();
    collect(&mut socket, &mut costs, false, || {
        current.load(Ordering::Acquire)
    })
    .await;
    revocation.await?;
    assert!(started.elapsed() <= Duration::from_millis(150));
    assert!(costs.has_pending_usage());
    Ok(())
}
