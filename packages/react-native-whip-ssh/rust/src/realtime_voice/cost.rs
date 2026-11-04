//! Current-call USD estimates from provider usage, never token-count guesses.
//! Realtime model rates live in models.json; transcription rates checked 2026-11-04:
//! https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe
//! Coding-agent charges are outside this voice API estimate.
use std::collections::BTreeMap;

use super::models::{Model, Rates};
use crate::app_database::{
    NativeVoiceUsageSession, UsageMetric, UsageQuantity, UsageRate, UsageUnit, VoicePriceSnapshot,
    VoiceUsageItem,
};
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

pub(super) struct CurrentChat {
    model: &'static Model,
    model_supported: Option<bool>,
    items: BTreeMap<(Kind, String, u32), VoiceUsageItem>,
    invalid: bool,
    persistence: Option<NativeVoiceUsageSession>,
}

impl CurrentChat {
    pub(super) fn new(model: &'static Model) -> Self {
        Self {
            model,
            model_supported: None,
            items: BTreeMap::new(),
            invalid: false,
            persistence: None,
        }
    }

    pub(super) fn persist(&mut self, session: NativeVoiceUsageSession) {
        self.persistence = Some(session);
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
                self.record(Kind::Response, &response.id, 0, pending());
            }
            ServerEvent::ResponseDone { response, .. }
            | ServerEvent::ResponseCancelled { response, .. } => {
                self.record(
                    Kind::Response,
                    &response.id,
                    0,
                    priced(
                        response.usage.as_ref().and_then(response_quantities),
                        self.model
                            .rates
                            .as_ref()
                            .map(|rates| response_snapshot(self.model.id.as_str(), rates)),
                    ),
                );
            }
            ServerEvent::InputAudioBufferCommitted { item_id, .. } => {
                self.record(Kind::Transcription, item_id, 0, pending());
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
                    priced(
                        usage.as_ref().and_then(transcription_quantities),
                        Some(transcription_snapshot()),
                    ),
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
                priced(None, Some(transcription_snapshot())),
            ),
            _ => return false,
        }
        true
    }

    fn record(&mut self, kind: Kind, id: &str, index: u32, charge: VoiceUsageItem) {
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
        if !charge.finalized {
            self.items.entry(key.clone()).or_insert(charge);
        } else {
            self.items.insert(key.clone(), charge);
        }
        if let Some(item) = self.items.get(&key) {
            let item = ledger_item(item, self.valid(), false);
            if let Some(session) = &mut self.persistence {
                session.record(item_id(&key), item);
            }
        }
    }

    fn valid(&self) -> bool {
        !self.invalid && self.model_supported == Some(true)
    }

    pub(super) fn estimated_usd(&self) -> Option<f64> {
        if !self.valid() {
            return None;
        }
        self.items.values().try_fold(0.0, |sum, charge| {
            let amount = if charge.finalized {
                charge.estimated_usd?
            } else {
                0.0
            };
            let sum = sum + amount;
            sum.is_finite().then_some(sum)
        })
    }
}

impl Drop for CurrentChat {
    fn drop(&mut self) {
        let valid = self.valid();
        if let Some(session) = &mut self.persistence {
            for (key, item) in &self.items {
                session.record(item_id(key), ledger_item(item, valid, true));
            }
            if self.invalid {
                session.record("accounting-incomplete".into(), pending());
            }
        }
    }
}

fn item_id((kind, id, index): &(Kind, String, u32)) -> String {
    format!(
        "{}:{id}:{index}",
        match kind {
            Kind::Response => "response",
            Kind::Transcription => "transcription",
        }
    )
}

fn ledger_item(item: &VoiceUsageItem, valid: bool, ended: bool) -> VoiceUsageItem {
    let mut item = item.clone();
    if !valid {
        item.estimated_usd = None;
    }
    // Keep terminal provider reports replaceable until the call ends: a later
    // response.done can refine an earlier response.cancelled for the same ID.
    item.finalized &= ended;
    item
}

fn pending() -> VoiceUsageItem {
    VoiceUsageItem {
        revision: 0,
        reported_usage: vec![],
        estimated_usd: None,
        price_snapshot: None,
        finalized: false,
    }
}

fn priced(
    quantities: Option<Vec<UsageQuantity>>,
    price_snapshot: Option<VoicePriceSnapshot>,
) -> VoiceUsageItem {
    let estimated_usd = quantities
        .as_ref()
        .and_then(|quantities| price_snapshot.as_ref()?.estimate(quantities));
    VoiceUsageItem {
        revision: 0,
        reported_usage: quantities.unwrap_or_default(),
        estimated_usd,
        price_snapshot,
        finalized: true,
    }
}

fn tokens(metric: UsageMetric, amount: u32) -> UsageQuantity {
    UsageQuantity {
        metric,
        unit: UsageUnit::Tokens,
        amount: f64::from(amount),
    }
}

fn snapshot(model: &str, rates: &[(UsageMetric, f64)]) -> VoicePriceSnapshot {
    VoicePriceSnapshot {
        version: 1,
        id: format!("openai-{model}-2026-11-04"),
        source_url: format!("https://developers.openai.com/api/docs/models/{model}"),
        effective_at_ms: 1_793_750_400_000,
        rates: rates
            .iter()
            .map(|(metric, rate)| UsageRate {
                metric: *metric,
                unit: UsageUnit::Tokens,
                usd_per_unit: rate / MILLION,
            })
            .collect(),
    }
}

fn response_snapshot(model: &str, rates: &Rates) -> VoicePriceSnapshot {
    use UsageMetric::*;
    snapshot(
        model,
        &[
            (InputText, rates.text_input),
            (InputAudio, rates.audio_input),
            (InputImage, rates.image_input),
            (CachedInputText, rates.cached_text_input),
            (CachedInputAudio, rates.cached_audio_input),
            (CachedInputImage, rates.cached_image_input),
            (OutputText, rates.text_output),
            (OutputAudio, rates.audio_output),
        ],
    )
}

fn transcription_snapshot() -> VoicePriceSnapshot {
    snapshot(
        "gpt-4o-mini-transcribe",
        &[
            (UsageMetric::InputAudio, TRANSCRIPTION_INPUT),
            (UsageMetric::OutputText, TRANSCRIPTION_OUTPUT),
        ],
    )
}

fn response_quantities(usage: &Usage) -> Option<Vec<UsageQuantity>> {
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
    use UsageMetric::*;
    Some(vec![
        tokens(InputText, text.checked_sub(cached_text)?),
        tokens(InputAudio, audio.checked_sub(cached_audio)?),
        tokens(InputImage, image.checked_sub(cached_image)?),
        tokens(CachedInputText, cached_text),
        tokens(CachedInputAudio, cached_audio),
        tokens(CachedInputImage, cached_image),
        tokens(OutputText, output_text),
        tokens(OutputAudio, output_audio),
    ])
}

fn transcription_quantities(usage: &Usage) -> Option<Vec<UsageQuantity>> {
    if usage.input_tokens.checked_add(usage.output_tokens)? != usage.total_tokens {
        return None;
    }
    Some(vec![
        tokens(UsageMetric::InputAudio, usage.input_tokens),
        tokens(UsageMetric::OutputText, usage.output_tokens),
    ])
}

#[cfg(test)]
mod tests;
