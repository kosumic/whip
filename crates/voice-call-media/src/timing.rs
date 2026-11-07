//! Only these duration-only events cross the transport's tracing isolation.
use std::time::Instant;

#[derive(Clone, Copy)]
pub(super) enum Stage {
    Ice,
    Dtls,
    Channel,
    Ready,
    RtpSent,
    RtpReceived,
}
impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::Ice => "ice_connected",
            Self::Dtls => "dtls_authenticated",
            Self::Channel => "data_channel_ready",
            Self::Ready => "transport_ready",
            Self::RtpSent => "first_rtp_sent",
            Self::RtpReceived => "first_rtp_received",
        }
    }
}
pub(super) struct Timing {
    started: Option<Instant>,
    recorded: u8,
    dispatcher: tracing::Dispatch,
}
impl Timing {
    pub fn new() -> Self {
        Self {
            started: None,
            recorded: 0,
            dispatcher: tracing::dispatcher::get_default(Clone::clone),
        }
    }
    pub fn start(&mut self) {
        self.started = Some(Instant::now());
    }
    pub fn record(&mut self, stage: Stage, stats: str0m::SpedStats) {
        let Some(started) = self.started else {
            return;
        };
        let bit = 1 << stage as u8;
        if self.recorded & bit != 0 {
            return;
        }
        self.recorded |= bit;
        let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        // Do not run any dependency code under the host subscriber. Only this
        // fixed event and these non-sensitive fields bypass NoSubscriber.
        tracing::dispatcher::with_default(&self.dispatcher, || {
            tracing::info!(
                stage = stage.name(), elapsed_ms,
                sped_negotiated = stats.negotiated,
                sped_embedded_sent = stats.embedded_sent,
                sped_embedded_received = stats.embedded_received,
                sped_fallback = ?stats.fallback,
                "Voice transport negotiation timing"
            );
        });
    }
}
