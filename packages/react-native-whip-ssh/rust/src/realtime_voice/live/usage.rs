//! One cumulative voice-duration item per session. Backend spending is unknown.
use crate::app_database::{
    NativeVoiceUsageSession, UsageMetric, UsageQuantity, UsageRate, UsageUnit, VoicePriceSnapshot,
    VoiceUsageItem, VoiceUsageMode, VoiceUsageScope,
};

pub(super) struct Usage {
    pub seconds: f64,
    pub finalized: bool,
    persistence: Option<NativeVoiceUsageSession>,
    observed: bool,
}
impl Default for Usage {
    fn default() -> Self {
        Self {
            seconds: 0.0,
            finalized: false,
            persistence: None,
            observed: false,
        }
    }
}
impl Usage {
    pub fn start(voice: &str, preview: bool) -> Result<Self, &'static str> {
        let mut usage = Self {
            persistence: Some(NativeVoiceUsageSession::start(
                VoiceUsageMode::Live,
                if preview {
                    VoiceUsageScope::Preview
                } else {
                    VoiceUsageScope::Agent
                },
                &super::catalog()?.model,
                voice,
            )),
            ..Self::default()
        };
        usage.record();
        Ok(usage)
    }
    pub fn observe(&mut self, seconds: f64, finalized: bool) -> Result<(), &'static str> {
        if !seconds.is_finite() || seconds < 0.0 {
            return Err("GPT-Live returned invalid duration usage.");
        }
        if self.finalized {
            return Ok(());
        }
        if finalized && seconds < self.seconds {
            return Err("GPT-Live final duration disagrees with earlier usage.");
        }
        self.seconds = self.seconds.max(seconds);
        self.observed = true;
        self.finalized = finalized;
        self.record();
        Ok(())
    }
    pub fn estimate(&self) -> Option<f64> {
        self.observed
            .then_some(self.seconds * super::catalog().ok()?.pricing.usd_per_minute / 60.0)
    }
    fn record(&mut self) {
        let Ok(catalog) = super::catalog() else {
            return;
        };
        let pricing = &catalog.pricing;
        let item = VoiceUsageItem {
            revision: 0,
            reported_usage: vec![UsageQuantity {
                metric: UsageMetric::Other,
                unit: UsageUnit::Seconds,
                amount: self.seconds,
            }],
            estimated_usd: self.estimate(),
            price_snapshot: Some(VoicePriceSnapshot {
                version: 1,
                id: pricing.id.clone(),
                source_url: pricing.source_url.clone(),
                effective_at_ms: pricing.effective_at_ms,
                rates: vec![UsageRate {
                    metric: UsageMetric::Other,
                    unit: UsageUnit::Seconds,
                    usd_per_unit: pricing.usd_per_minute / 60.0,
                }],
            }),
            finalized: self.finalized,
        };
        if let Some(session) = &mut self.persistence {
            session.record("live-duration".into(), item);
        }
    }
}
