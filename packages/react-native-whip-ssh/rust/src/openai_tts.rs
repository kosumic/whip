//! OpenAI Speech API -> bounded 24 kHz native PCM. No keys or audio cross JS.
//! https://developers.openai.com/api/docs/guides/text-to-speech
use native_credentials::NativeCredential;
mod stream;
use crate::app_database::{
    NativeVoiceUsageSession, VoiceUsageItem, VoiceUsageMode, VoiceUsageScope,
};
use reqwest::{
    Client, StatusCode,
    header::{AUTHORIZATION, HeaderValue},
};
use std::{future::Future, time::Duration};

pub(super) const DEFAULT_VOICE: &str = "marin";
pub(super) const VOICES: &[&str] = &[
    "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse",
    "marin", "cedar",
];
const MODEL: &str = "gpt-4o-mini-tts";
const USAGE_ITEM_ID: &str = "speech";
const ENDPOINT: &str = "https://api.openai.com/v1/audio/speech";
const MAX_AUDIO_BYTES: usize = 24_000 * 2 * 600;

async fn cancellable<T>(
    future: impl Future<Output = reqwest::Result<T>>,
    current: &impl Fn() -> bool,
) -> Result<Option<T>, String> {
    let mut future = std::pin::pin!(future);
    loop {
        if !current() {
            return Ok(None);
        }
        if let Ok(result) = tokio::time::timeout(Duration::from_millis(50), future.as_mut()).await {
            return result
                .map(Some)
                .map_err(|_| "OpenAI speech connection failed. Check your network.".into());
        }
    }
}

#[derive(Default)]
struct PcmDecoder {
    pending: Option<u8>,
    bytes: usize,
}

impl PcmDecoder {
    fn push(
        &mut self,
        bytes: &[u8],
        mut output: impl FnMut(&[f32]) -> bool,
    ) -> Result<bool, String> {
        self.bytes = self.bytes.saturating_add(bytes.len());
        if self.bytes > MAX_AUDIO_BYTES {
            return Err("OpenAI speech exceeded the audio limit.".into());
        }
        let mut samples = Vec::with_capacity(crate::speech_backend::PCM_CHUNK_SAMPLES);
        for &byte in bytes {
            if let Some(low) = self.pending.take() {
                samples.push(f32::from(i16::from_le_bytes([low, byte])) / 32768.0);
                if samples.len() == crate::speech_backend::PCM_CHUNK_SAMPLES {
                    if !output(&samples) {
                        return Ok(false);
                    }
                    samples.clear();
                }
            } else {
                self.pending = Some(byte);
            }
        }
        Ok(samples.is_empty() || output(&samples))
    }

    fn finish(&self) -> Result<(), String> {
        if self.bytes == 0 || self.pending.is_some() {
            return Err("OpenAI returned incomplete speech audio.".into());
        }
        Ok(())
    }
}

pub(super) fn speak(
    lease: u64,
    text: &str,
    voice: &str,
    (credential, revision): (NativeCredential, u64),
    mut output: impl FnMut(&[f32]) -> bool,
) -> Result<bool, String> {
    let current = || {
        crate::speech_playback::is_current(lease)
            && crate::voice_credentials::generation() == revision
    };
    if !current() {
        return Ok(false);
    }
    if !VOICES.contains(&voice) {
        return Err("Choose a supported OpenAI TTS voice.".into());
    }
    let authorization = credential.authorization();
    let mut header =
        HeaderValue::from_bytes(&authorization).map_err(|_| "Invalid OpenAI API key.")?;
    header.set_sensitive(true);
    drop(authorization);
    drop(credential);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "Could not start OpenAI speech.")?
        .block_on(async {
            let client = Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(30))
                .timeout(Duration::from_secs(600))
                .build()
                .map_err(|_| "Could not start OpenAI speech.")?;
            let request =
                client
                    .post(ENDPOINT)
                    .header(AUTHORIZATION, header)
                    .json(&serde_json::json!({
                        "model": MODEL, "voice": voice, "input": text, "response_format": "pcm",
                        "stream_format": "sse",
                    }));
            let mut accounting = NativeVoiceUsageSession::start(
                VoiceUsageMode::Tts,
                VoiceUsageScope::Speech,
                MODEL,
                voice,
            );
            let mut transcript = crate::voice_history::Conversation::default();
            transcript.assistant(text);
            if let Ok(runtime) = crate::runtime() {
                let identity = accounting.identity().clone();
                let voice = voice.to_owned();
                // History writes do not delay synthesis or audio playback.
                runtime.spawn(async move {
                    if let Err(error) = crate::voice_history::persist(
                        Some(&identity),
                        MODEL,
                        Some(&voice),
                        transcript.into_captions(),
                    )
                    .await
                    {
                        log::warn!("{error}");
                    }
                });
            }
            accounting.record(
                USAGE_ITEM_ID.into(),
                VoiceUsageItem {
                    revision: 0,
                    reported_usage: vec![],
                    estimated_usd: None,
                    price_snapshot: None,
                    finalized: false,
                },
            );
            let Some(mut response) = cancellable(request.send(), &current).await? else {
                return Ok(false);
            };
            match response.status() {
                status if status.is_success() => {}
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                    return Err("OpenAI rejected the API key or speech model access.".into());
                }
                StatusCode::TOO_MANY_REQUESTS => {
                    return Err("OpenAI speech quota or rate limit reached.".into());
                }
                _ => return Err("OpenAI could not generate speech. Try again.".into()),
            }
            let event_stream = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.starts_with("text/event-stream"));
            let mut decoder = PcmDecoder::default();
            let mut stream = stream::SpeechStream::default();
            loop {
                let Some(chunk) = cancellable(response.chunk(), &current).await? else {
                    return Ok(false);
                };
                let Some(chunk) = chunk else {
                    break;
                };
                let accepted = if event_stream {
                    stream.push(&chunk, &mut |pcm| current() && output(pcm), &mut |item| {
                        accounting.record(USAGE_ITEM_ID.into(), item);
                    })?
                } else {
                    decoder.push(&chunk, |pcm| current() && output(pcm))?
                };
                if !accepted {
                    return Ok(false);
                }
            }
            if event_stream {
                if !stream.finish(&mut |pcm| current() && output(pcm), &mut |item| {
                    accounting.record(USAGE_ITEM_ID.into(), item);
                })? {
                    return Ok(false);
                }
            } else {
                decoder.finish()?;
                // A raw-audio response has no provider token report. Preserve
                // the request as unknown instead of inventing billable tokens.
                accounting.record(
                    USAGE_ITEM_ID.into(),
                    VoiceUsageItem {
                        revision: 0,
                        reported_usage: vec![],
                        estimated_usd: None,
                        price_snapshot: None,
                        finalized: false,
                    },
                );
            }
            Ok(current())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_stream_preserves_samples_across_odd_network_chunks() {
        let mut decoder = PcmDecoder {
            pending: None,
            bytes: 0,
        };
        let bytes: Vec<_> = [i16::MIN, 0, i16::MAX, -1234]
            .into_iter()
            .flat_map(i16::to_le_bytes)
            .collect();
        let mut output = Vec::new();
        for chunk in bytes.chunks(3) {
            assert!(
                decoder
                    .push(chunk, |pcm| {
                        output.extend_from_slice(pcm);
                        true
                    })
                    .unwrap()
            );
        }
        decoder.finish().unwrap();
        assert_eq!(
            output,
            vec![-1.0, 0.0, 32767.0 / 32768.0, -1234.0 / 32768.0]
        );
    }

    #[test]
    fn incomplete_audio_fails_and_a_stopped_sink_cancels() {
        let mut decoder = PcmDecoder {
            pending: None,
            bytes: 0,
        };
        assert!(decoder.finish().is_err());
        assert!(decoder.push(&[0], |_| true).unwrap());
        assert!(decoder.finish().is_err());
        assert!(!decoder.push(&[0], |_| false).unwrap());
    }
}
