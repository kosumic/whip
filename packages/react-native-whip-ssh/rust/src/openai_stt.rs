//! Bounded file dictation with native credentials and recording-specific context.
use crate::app_database::{
    NativeVoiceUsageSession, UsageMetric, UsageQuantity, UsageRate, UsageUnit, VoicePriceSnapshot,
    VoiceUsageItem, VoiceUsageMode, VoiceUsageScope,
};
use parking_lot::Mutex;
use reqwest::{
    Client, StatusCode,
    header::{AUTHORIZATION, HeaderValue},
    multipart::{Form, Part},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::Read,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const MODEL: &str = "gpt-transcribe";
const ENDPOINT: &str = "https://api.openai.com/v1/audio/transcriptions";
const MAX_AUDIO_BYTES: u64 = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_CONTEXT_CHARS: usize = 4_000;
const USD_PER_MINUTE: f64 = 0.0045;
type Session = (String, Arc<AtomicBool>);
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

#[derive(Deserialize)]
struct Recording {
    id: String,
    uri: String,
    #[serde(default)]
    draft: String,
    #[serde(default)]
    recent: Vec<String>,
}

pub(super) fn command(action: &str) -> Option<Result<Value, String>> {
    if let Some(id) = action.strip_prefix("stt-start:") {
        return Some((|| {
            if id.is_empty() || id.len() > 128 {
                return Err("Invalid dictation session.".into());
            }
            // SAFETY: Only the previously warmed native cache is used here.
            unsafe { crate::voice_credentials::read(None, std::ptr::null_mut()) }
                .map_err(crate::voice_credentials::message)?;
            let previous = SESSION
                .lock()
                .replace((id.into(), Arc::new(AtomicBool::new(true))));
            if let Some((_, active)) = previous {
                active.store(false, Ordering::Release);
            }
            Ok(json!({}))
        })());
    }
    if let Some(id) = action.strip_prefix("stt-cancel:") {
        let mut session = SESSION.lock();
        if session.as_ref().is_some_and(|(current, _)| current == id)
            && let Some((_, active)) = session.take()
        {
            active.store(false, Ordering::Release);
        }
        drop(session);
        return Some(Ok(json!({})));
    }
    action.strip_prefix("stt:").map(|input| {
        let recording: Recording =
            serde_json::from_str(input).map_err(|_| "Invalid dictation recording.")?;
        let active = SESSION
            .lock()
            .as_ref()
            .filter(|(id, _)| *id == recording.id)
            .map(|(_, active)| Arc::clone(active))
            .ok_or("Dictation cancelled.")?;
        let result = transcribe(&recording, &active);
        let mut session = SESSION.lock();
        if session.as_ref().is_some_and(|(id, _)| *id == recording.id) {
            session.take();
        }
        result
    })
}

fn prompt(recording: &Recording) -> String {
    // Give the draft priority, then the newest chat context. Bound by Unicode
    // characters so multilingual drafts are never cut inside a code point.
    let mut sources = Vec::new();
    let mut remaining = MAX_CONTEXT_CHARS;
    for source in std::iter::once(&recording.draft).chain(recording.recent.iter().rev().take(10)) {
        let text: String = source.chars().take(remaining).collect();
        remaining = remaining.saturating_sub(text.chars().count() + 1);
        if !text.trim().is_empty() {
            sources.push(text);
        }
        if remaining == 0 {
            break;
        }
    }
    sources.join("\n")
}

fn form(recording: &Recording, audio: Vec<u8>) -> Result<Form, String> {
    Ok(Form::new()
        .text("model", MODEL)
        .text("response_format", "json")
        .text("prompt", prompt(recording))
        .part(
            "file",
            Part::bytes(audio)
                .file_name("dictation.m4a")
                .mime_str("audio/mp4")
                .map_err(|_| "Invalid audio format.")?,
        ))
}

fn transcribe(recording: &Recording, active: &AtomicBool) -> Result<Value, String> {
    // SAFETY: Only the previously warmed native cache is used here.
    let (key, generation) = unsafe { crate::voice_credentials::read(None, std::ptr::null_mut()) }
        .map_err(crate::voice_credentials::message)?;
    let current =
        || active.load(Ordering::Acquire) && crate::voice_credentials::generation() == generation;
    if !current() {
        return Err("Dictation cancelled.".into());
    }
    let path = url::Url::parse(&recording.uri)
        .ok()
        .and_then(|uri| uri.to_file_path().ok())
        .filter(|path| path.extension().is_some_and(|extension| extension == "m4a"))
        .ok_or("Invalid dictation recording.")?;
    let file = std::fs::File::open(path).map_err(|_| "Could not read dictation recording.")?;
    let mut audio = Vec::new();
    file.take(MAX_AUDIO_BYTES + 1)
        .read_to_end(&mut audio)
        .map_err(|_| "Could not read dictation recording.")?;
    if audio.is_empty() || audio.len() as u64 > MAX_AUDIO_BYTES {
        return Err("Dictation recording is empty or too large.".into());
    }
    let mut authorization =
        HeaderValue::from_bytes(&key.authorization()).map_err(|_| "Invalid OpenAI API key.")?;
    authorization.set_sensitive(true);
    drop(key);
    let form = form(recording, audio)?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "Could not start OpenAI dictation.")?
        .block_on(async {
            let client = Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(90))
                .build()
                .map_err(|_| "Could not start OpenAI dictation.")?;
            let mut accounting = NativeVoiceUsageSession::start(
                VoiceUsageMode::Stt,
                VoiceUsageScope::Speech,
                MODEL,
                "",
            );
            let operation = async {
                let mut response = client
                    .post(ENDPOINT)
                    .header(AUTHORIZATION, authorization)
                    .multipart(form)
                    .send()
                    .await
                    .map_err(|_| "network")?;
                match response.status() {
                    status if status.is_success() => {}
                    StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                        return Err("OpenAI rejected the API key or model access.");
                    }
                    StatusCode::TOO_MANY_REQUESTS => {
                        return Err("OpenAI rate limit or API balance exceeded.");
                    }
                    _ => return Err("OpenAI dictation failed. Try again."),
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(|_| "network")? {
                    if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                        return Err("OpenAI transcript is too large.");
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let value: Value =
                    serde_json::from_slice(&bytes).map_err(|_| "Invalid OpenAI transcript.")?;
                let text = value["text"].as_str().ok_or("Invalid OpenAI transcript.")?;
                let seconds = value["usage"]["seconds"]
                    .as_f64()
                    .filter(|seconds| seconds.is_finite() && *seconds >= 0.0);
                let price = VoicePriceSnapshot {
                    version: 1,
                    id: "openai-gpt-transcribe-2026-11-09".into(),
                    source_url: "https://developers.openai.com/api/docs/models/gpt-transcribe"
                        .into(),
                    effective_at_ms: 1_794_182_400_000,
                    rates: vec![UsageRate {
                        metric: UsageMetric::InputAudio,
                        unit: UsageUnit::Seconds,
                        usd_per_unit: USD_PER_MINUTE / 60.0,
                    }],
                };
                accounting.record(
                    "transcription".into(),
                    VoiceUsageItem {
                        revision: 0,
                        reported_usage: seconds
                            .map(|amount| UsageQuantity {
                                metric: UsageMetric::InputAudio,
                                unit: UsageUnit::Seconds,
                                amount,
                            })
                            .into_iter()
                            .collect(),
                        estimated_usd: seconds.map(|seconds| seconds * USD_PER_MINUTE / 60.0),
                        price_snapshot: Some(price),
                        finalized: seconds.is_some(),
                    },
                );
                if let Ok(runtime) = crate::runtime() {
                    let identity = accounting.identity().clone();
                    let mut transcript = crate::voice_history::Conversation::default();
                    transcript.user(text);
                    runtime.spawn(async move {
                        if let Err(error) = crate::voice_history::persist(
                            Some(&identity),
                            MODEL,
                            None,
                            transcript.into_captions(),
                        )
                        .await
                        {
                            log::warn!("{error}");
                        }
                    });
                }
                Ok(json!({"text": text}))
            };
            let mut operation = std::pin::pin!(operation);
            loop {
                if !current() {
                    return Err("Dictation cancelled.".into());
                }
                if let Ok(result) =
                    tokio::time::timeout(Duration::from_millis(50), operation.as_mut()).await
                {
                    return result.map_err(String::from);
                }
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_prioritizes_draft_and_recent_chat_with_a_unicode_budget() {
        let recording = Recording {
            id: String::new(),
            uri: String::new(),
            draft: "修正 Whip".into(),
            recent: vec!["old text".into(), "new context".repeat(MAX_CONTEXT_CHARS)],
        };
        let context = prompt(&recording);
        assert!(context.starts_with("修正 Whip\nnew context"));
        assert!(!context.contains("old text"));
        assert!(context.chars().count() <= MAX_CONTEXT_CHARS);
    }

    #[tokio::test]
    async fn transcription_upload_contains_model_audio_and_context()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().route(
                    "/",
                    axum::routing::post(|body: axum::body::Bytes| async move {
                        let body = String::from_utf8_lossy(&body);
                        assert!(body.contains("name=\"model\"\r\n\r\ngpt-transcribe"));
                        assert!(body.contains("name=\"prompt\"\r\n\r\nWhip draft\nrecent context"));
                        assert!(body.contains("filename=\"dictation.m4a\""));
                        assert!(body.contains("Content-Type: audio/mp4"));
                        assert!(body.contains("audio fixture"));
                        "{\"text\":\"Whip\"}"
                    }),
                ),
            )
            .await
        });
        let recording = Recording {
            id: "test".into(),
            uri: String::new(),
            draft: "Whip draft".into(),
            recent: vec!["recent context".into()],
        };
        let upload = form(&recording, b"audio fixture".to_vec())?;
        let response: Value = Client::new()
            .post(format!("http://{address}/"))
            .multipart(upload)
            .send()
            .await?
            .json()
            .await?;
        server.abort();
        assert_eq!(response["text"], "Whip");
        Ok(())
    }
}
