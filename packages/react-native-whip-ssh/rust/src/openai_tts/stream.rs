//! Bounded Speech API SSE framing; only decoded PCM goes to the native player.
use crate::app_database::{
    UsageMetric, UsageQuantity, UsageRate, UsageUnit, VoicePriceSnapshot, VoiceUsageItem,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;

const MAX_EVENT_BYTES: usize = 1_048_576;
const MILLION: f64 = 1_000_000.0;
const TEXT_INPUT: f64 = 0.60;
const AUDIO_OUTPUT: f64 = 12.0;

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Event {
    #[serde(rename = "speech.audio.delta")]
    Audio { audio: String },
    #[serde(rename = "speech.audio.done")]
    Done { usage: Option<serde_json::Value> },
    #[serde(rename = "error")]
    Error,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(rename = "input_tokens")]
    input: u32,
    #[serde(rename = "output_tokens")]
    output: u32,
    #[serde(rename = "total_tokens")]
    total: u32,
}

fn usage_item(usage: Option<serde_json::Value>) -> VoiceUsageItem {
    let usage = usage
        .and_then(|value| serde_json::from_value::<Usage>(value).ok())
        .filter(|usage| usage.input.checked_add(usage.output) == Some(usage.total));
    let price = VoicePriceSnapshot {
        version: 1,
        id: "openai-gpt-4o-mini-tts-2026-11-04".into(),
        source_url: "https://developers.openai.com/api/docs/models/gpt-4o-mini-tts".into(),
        effective_at_ms: 1_793_750_400_000,
        rates: vec![
            UsageRate {
                metric: UsageMetric::InputText,
                unit: UsageUnit::Tokens,
                usd_per_unit: TEXT_INPUT / MILLION,
            },
            UsageRate {
                metric: UsageMetric::OutputAudio,
                unit: UsageUnit::Tokens,
                usd_per_unit: AUDIO_OUTPUT / MILLION,
            },
        ],
    };
    let reported_usage = usage
        .as_ref()
        .map(|usage| {
            vec![
                UsageQuantity {
                    metric: UsageMetric::InputText,
                    unit: UsageUnit::Tokens,
                    amount: f64::from(usage.input),
                },
                UsageQuantity {
                    metric: UsageMetric::OutputAudio,
                    unit: UsageUnit::Tokens,
                    amount: f64::from(usage.output),
                },
            ]
        })
        .unwrap_or_default();
    let finalized = usage.is_some();
    VoiceUsageItem {
        revision: 0,
        estimated_usd: usage.and_then(|_| price.estimate(&reported_usage)),
        price_snapshot: Some(price),
        reported_usage,
        finalized,
    }
}

#[derive(Default)]
pub(super) struct SpeechStream {
    line: Vec<u8>,
    data: Vec<u8>,
    pcm: super::PcmDecoder,
    done: bool,
}

impl SpeechStream {
    pub(super) fn push(
        &mut self,
        bytes: &[u8],
        output: &mut impl FnMut(&[f32]) -> bool,
        usage: &mut impl FnMut(VoiceUsageItem),
    ) -> Result<bool, String> {
        for &byte in bytes {
            if byte == b'\n' {
                if self.line.last() == Some(&b'\r') {
                    self.line.pop();
                }
                if self.line.is_empty() {
                    if !self.dispatch(output, usage)? {
                        return Ok(false);
                    }
                } else if let Some(data) = self.line.strip_prefix(b"data:") {
                    let data = data.strip_prefix(b" ").unwrap_or(data);
                    if self.data.len().saturating_add(data.len() + 1) > MAX_EVENT_BYTES {
                        return Err("OpenAI speech event exceeded the stream limit.".into());
                    }
                    if !self.data.is_empty() {
                        self.data.push(b'\n');
                    }
                    self.data.extend_from_slice(data);
                }
                self.line.clear();
            } else {
                if self.line.len() >= MAX_EVENT_BYTES {
                    return Err("OpenAI speech event exceeded the stream limit.".into());
                }
                self.line.push(byte);
            }
        }
        Ok(true)
    }

    fn dispatch(
        &mut self,
        output: &mut impl FnMut(&[f32]) -> bool,
        usage: &mut impl FnMut(VoiceUsageItem),
    ) -> Result<bool, String> {
        if self.data.is_empty() {
            return Ok(true);
        }
        if self.data == b"[DONE]" {
            self.data.clear();
            return Ok(true);
        }
        let event = serde_json::from_slice::<Event>(&self.data)
            .map_err(|_| "OpenAI returned an invalid speech event.")?;
        self.data.clear();
        match event {
            Event::Audio { audio } => {
                if self.done {
                    return Err("OpenAI returned audio after speech completion.".into());
                }
                let bytes = STANDARD
                    .decode(audio)
                    .map_err(|_| "OpenAI returned invalid speech audio.")?;
                self.pcm.push(&bytes, output)
            }
            Event::Done { usage: reported } => {
                if !self.done {
                    usage(usage_item(reported));
                    self.done = true;
                }
                Ok(true)
            }
            Event::Error => Err("OpenAI could not complete speech generation.".into()),
            Event::Other => Ok(true),
        }
    }

    pub(super) fn finish(
        &mut self,
        output: &mut impl FnMut(&[f32]) -> bool,
        usage: &mut impl FnMut(VoiceUsageItem),
    ) -> Result<bool, String> {
        if !self.line.is_empty() && !self.push(b"\n", output, usage)? {
            return Ok(false);
        }
        if !self.dispatch(output, usage)? {
            return Ok(false);
        }
        self.pcm.finish()?;
        if !self.done {
            return Err("OpenAI speech ended before its final usage event.".into());
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests;
