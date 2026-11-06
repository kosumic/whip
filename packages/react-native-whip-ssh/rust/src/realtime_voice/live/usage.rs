//! One cumulative voice-duration item per session. Backend spending is unknown.
use crate::app_database::{
    NativeVoiceUsageSession, UsageMetric, UsageQuantity, UsageRate, UsageUnit, VoicePriceSnapshot,
    VoiceUsageItem, VoiceUsageMode, VoiceUsageScope,
};

#[derive(Default)]
pub(super) struct Usage {
    pub provider: voice_openai::live::usage::DurationUsage,
    persistence: Option<NativeVoiceUsageSession>,
}
impl Usage {
    pub fn history_identity(&self) -> Option<&crate::app_database::VoiceUsageIdentity> {
        self.persistence
            .as_ref()
            .map(NativeVoiceUsageSession::identity)
    }

    pub fn start(voice: &str, preview: bool, global: bool) -> Result<Self, &'static str> {
        let mut usage = Self {
            persistence: Some(NativeVoiceUsageSession::start(
                VoiceUsageMode::Live,
                if preview {
                    VoiceUsageScope::Preview
                } else if global {
                    VoiceUsageScope::Global
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
        let was_finalized = self.provider.finalized;
        self.provider.observe(seconds, finalized)?;
        if !was_finalized {
            self.record();
        }
        Ok(())
    }
    pub fn estimate(&self) -> Option<f64> {
        self.provider
            .observed
            .then_some(self.provider.seconds * super::catalog().ok()?.pricing.usd_per_minute / 60.0)
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
                amount: self.provider.seconds,
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
            finalized: self.provider.finalized,
        };
        if let Some(session) = &mut self.persistence {
            session.record("live-duration".into(), item);
        }
    }
}
