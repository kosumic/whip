//! Call accounting only. No audio, transcripts, credentials, or agent labels.
//! Provider adapters supply quantities and versioned pricing; this module never
//! guesses a tariff or treats missing provider billing as free usage.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{AppStorageEntry, AppStorageError, Store, database};
mod native;
pub(crate) use native::{NativeVoiceUsageSession, flush_native_voice_usage};

pub(super) const KEY: &str = "whip.voice.usage";
const VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceUsageProvider {
    Local,
    Openai,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceUsageMode {
    TurnBased,
    Realtime,
    Live,
    Tts,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceUsageScope {
    Agent,
    Global,
    Speech,
    Preview,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountingStatus {
    LiveEstimate,
    ProviderUsageFinalized,
    Incomplete,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageMetric {
    InputText,
    CachedInputText,
    OutputText,
    InputAudio,
    CachedInputAudio,
    OutputAudio,
    InputImage,
    CachedInputImage,
    Other,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageUnit {
    Tokens,
    Seconds,
    Requests,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageQuantity {
    pub metric: UsageMetric,
    pub unit: UsageUnit,
    pub amount: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageRate {
    pub metric: UsageMetric,
    pub unit: UsageUnit,
    pub usd_per_unit: f64,
}
/// Immutable evidence for an estimate, not a provider invoice. Adapters own
/// currency conversion, tariff selection, cached usage, and billing arithmetic.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoicePriceSnapshot {
    pub version: u32,
    pub id: String,
    pub source_url: String,
    pub effective_at_ms: u64,
    pub rates: Vec<UsageRate>,
}

impl VoicePriceSnapshot {
    pub(crate) fn estimate(&self, quantities: &[UsageQuantity]) -> Option<f64> {
        quantities.iter().try_fold(0.0, |sum, quantity| {
            if !valid_amount(quantity.amount) {
                return None;
            }
            let rate = self
                .rates
                .iter()
                .find(|rate| rate.metric == quantity.metric && rate.unit == quantity.unit)?;
            let total = sum + quantity.amount * rate.usd_per_unit;
            valid_amount(rate.usd_per_unit).then_some(())?;
            valid_amount(total).then_some(total)
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceUsageIdentity {
    pub session_id: String,
    pub provider: VoiceUsageProvider,
    pub mode: VoiceUsageMode,
    pub model: Option<String>,
    pub voice: Option<String>,
    pub scope: VoiceUsageScope,
    pub started_at_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceUsageItem {
    pub revision: u64,
    pub reported_usage: Vec<UsageQuantity>,
    pub estimated_usd: Option<f64>,
    pub price_snapshot: Option<VoicePriceSnapshot>,
    pub finalized: bool,
}
/// Item IDs must be stable across reconnect/replay (e.g. provider response ID).
/// Each revision REPLACES that item's cumulative quantities and estimate.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum VoiceUsageEvent {
    Started {
        call: VoiceUsageIdentity,
    },
    Usage {
        session_id: String,
        item_id: String,
        item: VoiceUsageItem,
    },
    Ended {
        session_id: String,
        ended_at_ms: u64,
    },
    /// Run once on process startup, before admitting any new calls.
    Recover,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Call {
    identity: VoiceUsageIdentity,
    ended_at_ms: Option<u64>,
    interrupted: bool,
    items: BTreeMap<String, VoiceUsageItem>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    version: u32,
    calls: BTreeMap<String, Call>,
}
impl Default for Ledger {
    fn default() -> Self {
        Self {
            version: VERSION,
            calls: BTreeMap::new(),
        }
    }
}
fn invalid() -> AppStorageError {
    AppStorageError::InvalidEntry(KEY.into())
}
fn valid_amount(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}
fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512
}
impl Ledger {
    fn load(store: &Store) -> Result<Self, AppStorageError> {
        let entries = store.read(vec![KEY.into()])?;
        let Some(raw) = entries.first().and_then(|entry| entry.value.as_deref()) else {
            return Ok(Self::default());
        };
        let version: serde_json::Value = serde_json::from_str(raw).map_err(|_| invalid())?;
        if version.get("version").and_then(serde_json::Value::as_u64) != Some(u64::from(VERSION)) {
            return Err(AppStorageError::Incompatible);
        }
        serde_json::from_str(raw).map_err(|_| invalid())
    }
    fn apply(&mut self, event: VoiceUsageEvent) -> Result<(), AppStorageError> {
        match event {
            VoiceUsageEvent::Started { call } => {
                if !valid_id(&call.session_id)
                    || call.model.as_deref().is_some_and(|s| !valid_id(s))
                    || call.voice.as_deref().is_some_and(|s| !valid_id(s))
                    || (call.provider == VoiceUsageProvider::Local)
                        != (call.mode == VoiceUsageMode::TurnBased)
                {
                    return Err(invalid());
                }
                // Original metadata is immutable, including after finalization.
                self.calls.entry(call.session_id.clone()).or_insert(Call {
                    identity: call,
                    ended_at_ms: None,
                    interrupted: false,
                    items: BTreeMap::new(),
                });
            }
            VoiceUsageEvent::Usage {
                session_id,
                item_id,
                item,
            } => {
                let call = self.calls.get_mut(&session_id).ok_or_else(invalid)?;
                if call.identity.provider == VoiceUsageProvider::Local
                    || !valid_id(&item_id)
                    || item.reported_usage.iter().any(|q| !valid_amount(q.amount))
                    || item.estimated_usd.is_some_and(|usd| !valid_amount(usd))
                    || item.estimated_usd.is_some() && item.price_snapshot.is_none()
                    || item.price_snapshot.as_ref().is_some_and(|p| {
                        p.version == 0
                            || !valid_id(&p.id)
                            || !valid_id(&p.source_url)
                            || p.rates.iter().any(|r| !valid_amount(r.usd_per_unit))
                    })
                {
                    return Err(invalid());
                }
                if let Some(old) = call.items.get(&item_id)
                    && (old.finalized || old.revision >= item.revision)
                {
                    return Ok(());
                }
                call.items.insert(item_id, item);
            }
            VoiceUsageEvent::Ended {
                session_id,
                ended_at_ms,
            } => {
                let call = self.calls.get_mut(&session_id).ok_or_else(invalid)?;
                if ended_at_ms < call.identity.started_at_ms {
                    return Err(invalid());
                }
                if call.ended_at_ms.is_none() {
                    call.ended_at_ms = Some(ended_at_ms);
                }
            }
            VoiceUsageEvent::Recover => {
                for call in self.calls.values_mut().filter(|c| c.ended_at_ms.is_none()) {
                    // The end time is unknown after process death. Keep it null,
                    // but never display the recovered call as currently active.
                    call.interrupted = true;
                }
            }
        }
        Ok(())
    }
}
impl Call {
    fn estimated_usd(&self) -> Option<f64> {
        if self.identity.provider == VoiceUsageProvider::Local {
            return Some(0.0);
        }
        if self.items.is_empty() {
            return None;
        }
        self.items.values().try_fold(0.0, |total, item| {
            let sum = total + item.estimated_usd?;
            sum.is_finite().then_some(sum)
        })
    }
    fn status(&self) -> AccountingStatus {
        if self.interrupted {
            return AccountingStatus::Incomplete;
        }
        if self.ended_at_ms.is_some()
            && !self.items.is_empty()
            && self.items.values().all(|item| item.finalized)
        {
            return AccountingStatus::ProviderUsageFinalized;
        }
        if self.ended_at_ms.is_none() && self.estimated_usd().is_some() {
            return AccountingStatus::LiveEstimate;
        }
        AccountingStatus::Incomplete
    }
    fn view(&self) -> CallView {
        CallView {
            identity: self.identity.clone(),
            ended_at_ms: self.ended_at_ms,
            active: self.ended_at_ms.is_none() && !self.interrupted,
            estimated_usd: self.estimated_usd(),
            status: self.status(),
            // Coding-agent/API spending is outside the voice adapter boundary.
            remote_agent_estimated_usd: None,
            items: self.items.clone(),
        }
    }
}
#[derive(Debug, Serialize)]
struct CallView {
    #[serde(flatten)]
    identity: VoiceUsageIdentity,
    ended_at_ms: Option<u64>,
    active: bool,
    estimated_usd: Option<f64>,
    status: AccountingStatus,
    remote_agent_estimated_usd: Option<f64>,
    items: BTreeMap<String, VoiceUsageItem>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    now_ms: u64,
    today_ms: u64,
    week_ms: u64,
    month_ms: u64,
    provider: Option<VoiceUsageProvider>,
    mode: Option<VoiceUsageMode>,
}
#[derive(Debug, Default, Serialize)]
struct Total {
    known_estimated_usd: f64,
    unknown_cost_calls: usize,
    incomplete_calls: usize,
    calls: usize,
}
#[derive(Debug, Serialize)]
struct Summary {
    calls: Vec<CallView>,
    totals: BTreeMap<&'static str, Total>,
}
impl Ledger {
    fn summary(&self, query: &Query) -> Result<Summary, AppStorageError> {
        if [query.today_ms, query.week_ms, query.month_ms]
            .iter()
            .any(|start| *start > query.now_ms)
        {
            return Err(invalid());
        }
        let mut calls: Vec<_> = self
            .calls
            .values()
            .filter(|call| {
                query.provider.is_none_or(|p| p == call.identity.provider)
                    && query.mode.is_none_or(|m| m == call.identity.mode)
                    && call.identity.started_at_ms <= query.now_ms
            })
            .map(Call::view)
            .collect();
        calls.sort_by(|a, b| {
            b.identity
                .started_at_ms
                .cmp(&a.identity.started_at_ms)
                .then_with(|| a.identity.session_id.cmp(&b.identity.session_id))
        });
        let mut totals = BTreeMap::new();
        for (period, start) in [
            ("today", query.today_ms),
            ("week", query.week_ms),
            ("month", query.month_ms),
            ("lifetime", 0),
        ] {
            let mut total = Total::default();
            for call in calls
                .iter()
                .filter(|call| call.identity.started_at_ms >= start)
            {
                total.calls += 1;
                if let Some(cost) = call.estimated_usd {
                    total.known_estimated_usd += cost;
                } else {
                    total.unknown_cost_calls += 1;
                }
                if call.status == AccountingStatus::Incomplete
                    && call.identity.provider != VoiceUsageProvider::Local
                {
                    total.incomplete_calls += 1;
                }
            }
            totals.insert(period, total);
        }
        Ok(Summary { calls, totals })
    }
}
#[cfg(test)]
fn record(store: &mut Store, event: VoiceUsageEvent) -> Result<(), AppStorageError> {
    let mut ledger = Ledger::load(store)?;
    ledger.apply(event)?;
    save(store, &ledger)
}

fn save(store: &mut Store, ledger: &Ledger) -> Result<(), AppStorageError> {
    let value = serde_json::to_string(ledger).map_err(|_| invalid())?;
    store.write(
        vec![AppStorageEntry {
            key: KEY.into(),
            value: Some(value),
        }],
        false,
    )
}
/// The database worker serializes read/reduce/commit with all other app writes.
/// A lost acknowledgement can be replayed without duplicate records or totals.
#[uniffi::export]
pub async fn record_voice_usage(event_json: String) -> Result<(), AppStorageError> {
    let event = serde_json::from_str(&event_json).map_err(|_| invalid())?;
    flush_native_voice_usage().await?;
    native::commit(event).await
}
#[uniffi::export]
pub async fn voice_usage_summary(query_json: String) -> Result<String, AppStorageError> {
    let query = serde_json::from_str(&query_json).map_err(|_| invalid())?;
    flush_native_voice_usage().await?;
    database()?
        .request(move |store| {
            serde_json::to_string(&Ledger::load(store)?.summary(&query)?).map_err(|_| invalid())
        })
        .await
}

#[cfg(test)]
mod tests;
