//! Whip persistence sink for the provider's bounded final-usage collector.
#[cfg(test)]
use voice_openai::shutdown::FINAL_USAGE_TIMEOUT;
pub(super) use voice_openai::shutdown::collect;
impl voice_openai::shutdown::UsageSink for super::cost::CurrentChat {
    fn has_pending_usage(&self) -> bool {
        self.has_pending_usage()
    }
    fn observe(&mut self, event: &oai_rt_rs::ServerEvent) {
        self.observe(event);
    }
}
#[cfg(test)]
use super::cost::CurrentChat;
#[cfg(test)]
use oai_rt_rs::ServerEvent;
#[cfg(test)]
use serde_json::json;
#[cfg(test)]
use std::time::Duration;
#[cfg(test)]
use voice_openai::shutdown::QUIET_PERIOD;
#[cfg(test)]
mod tests;
