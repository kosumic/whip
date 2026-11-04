//! Current-call USD estimates from provider usage, never token-count guesses.
//! Realtime model rates live in models.json; transcription rates checked 2026-11-04:
//! https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe
//! Coding-agent charges are outside this voice API estimate.
use std::collections::BTreeMap;

use super::models::{Model, Rates};
use oai_rt_rs::{ServerEvent, Usage};

const MILLION: f64 = 1_000_000.0;
const MAX_ITEMS: usize = 4096;
const MAX_ID_BYTES: usize = 256;
const TRANSCRIPTION_INPUT: f64 = 1.25;
const TRANSCRIPTION_OUTPUT: f64 = 5.0;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Response,
    Transcription,
}

enum Charge {
    Pending,
    Final(Option<f64>),
}

pub(super) struct CurrentChat {
    model: &'static Model,
    model_supported: Option<bool>,
    items: BTreeMap<(Kind, String, u32), Charge>,
    invalid: bool,
}

impl CurrentChat {
    pub(super) fn new(model: &'static Model) -> Self {
        Self {
            model,
            model_supported: None,
            items: BTreeMap::new(),
            invalid: false,
        }
    }

    pub(super) fn observe(&mut self, event: &ServerEvent) -> bool {
        match event {
            ServerEvent::SessionUpdated { session, .. }
            | ServerEvent::SessionCreated { session, .. } => {
                let supported =
                    self.model.accepts(&session.config.model) && self.model.rates.is_some();
                self.model_supported = Some(self.model_supported.unwrap_or(true) && supported);
            }
            ServerEvent::ResponseCreated { response, .. } => {
                self.record(Kind::Response, &response.id, 0, Charge::Pending);
            }
            ServerEvent::ResponseDone { response, .. }
            | ServerEvent::ResponseCancelled { response, .. } => {
                self.record(
                    Kind::Response,
                    &response.id,
                    0,
                    Charge::Final(response.usage.as_ref().and_then(|usage| {
                        self.model
                            .rates
                            .as_ref()
                            .and_then(|rates| response_cost(usage, rates))
                    })),
                );
            }
            ServerEvent::InputAudioBufferCommitted { item_id, .. } => {
                self.record(Kind::Transcription, item_id, 0, Charge::Pending);
            }
            ServerEvent::InputAudioTranscriptionCompleted {
                item_id,
                content_index,
                usage,
                ..
            } => {
                self.record(
                    Kind::Transcription,
                    item_id,
                    *content_index,
                    Charge::Final(usage.as_ref().and_then(transcription_cost)),
                );
            }
            ServerEvent::InputAudioTranscriptionFailed {
                item_id,
                content_index,
                ..
            } => self.record(
                Kind::Transcription,
                item_id,
                *content_index,
                Charge::Final(None),
            ),
            _ => return false,
        }
        true
    }

    fn record(&mut self, kind: Kind, id: &str, index: u32, charge: Charge) {
        if id.is_empty() || id.len() > MAX_ID_BYTES {
            self.invalid = true;
            return;
        }
        let key = (kind, id.to_owned(), index);
        if !self.items.contains_key(&key) && self.items.len() >= MAX_ITEMS {
            self.invalid = true;
            return;
        }
        // Replayed creation cannot erase finalized usage. Terminal reports for
        // one ID replace earlier reports (including cancel/done duplicates).
        if matches!(charge, Charge::Pending) {
            self.items.entry(key).or_insert(charge);
        } else {
            self.items.insert(key, charge);
        }
    }

    pub(super) fn estimated_usd(&self) -> Option<f64> {
        if self.invalid || self.model_supported != Some(true) {
            return None;
        }
        self.items.values().try_fold(0.0, |sum, charge| {
            let amount = match charge {
                Charge::Pending => 0.0, // Live estimates advance with reported usage.
                Charge::Final(amount) => (*amount)?,
            };
            let sum = sum + amount;
            sum.is_finite().then_some(sum)
        })
    }
}

fn response_cost(usage: &Usage, rates: &Rates) -> Option<f64> {
    if usage.input_tokens.checked_add(usage.output_tokens)? != usage.total_tokens {
        return None;
    }
    let (mut text, mut audio, mut image, mut cached_text, mut cached_audio, mut cached_image) =
        (0, 0, 0, 0, 0, 0);
    if usage.input_tokens > 0 {
        let input = usage.input_token_details.as_ref()?;
        text = input.text_tokens.unwrap_or(0);
        audio = input.audio_tokens.unwrap_or(0);
        image = input.image_tokens.unwrap_or(0);
        if text.checked_add(audio)?.checked_add(image)? != usage.input_tokens {
            return None;
        }
        let cached = input.cached_tokens.or(usage.cached_tokens)?;
        if let Some(details) = input
            .cached_tokens_details
            .as_ref()
            .or(usage.cached_tokens_details.as_ref())
        {
            cached_text = details.text_tokens.unwrap_or(0);
            cached_audio = details.audio_tokens.unwrap_or(0);
            cached_image = details.image_tokens.unwrap_or(0);
        }
        if cached_text
            .checked_add(cached_audio)?
            .checked_add(cached_image)?
            != cached
        {
            return None;
        }
    }
    let (mut output_text, mut output_audio) = (0, 0);
    if usage.output_tokens > 0 {
        let output = usage.output_token_details.as_ref()?;
        output_text = output.text_tokens.unwrap_or(0);
        output_audio = output.audio_tokens.unwrap_or(0);
        if output_text.checked_add(output_audio)? != usage.output_tokens {
            return None;
        }
    }
    Some(
        (f64::from(text.checked_sub(cached_text)?) * rates.text_input
            + f64::from(audio.checked_sub(cached_audio)?) * rates.audio_input
            + f64::from(image.checked_sub(cached_image)?) * rates.image_input
            + f64::from(cached_text) * rates.cached_text_input
            + f64::from(cached_audio) * rates.cached_audio_input
            + f64::from(cached_image) * rates.cached_image_input
            + f64::from(output_text) * rates.text_output
            + f64::from(output_audio) * rates.audio_output)
            / MILLION,
    )
}

fn transcription_cost(usage: &Usage) -> Option<f64> {
    if usage.input_tokens.checked_add(usage.output_tokens)? != usage.total_tokens {
        return None;
    }
    Some(
        (f64::from(usage.input_tokens) * TRANSCRIPTION_INPUT
            + f64::from(usage.output_tokens) * TRANSCRIPTION_OUTPUT)
            / MILLION,
    )
}

#[cfg(test)]
mod tests;
