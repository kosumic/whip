//! Duration-only diagnostics: never include targets, payloads or credentials.
use serde::Serialize;
use std::time::Instant;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Timings {
    #[serde(rename = "offerMs")]
    pub offer: Option<u64>,
    #[serde(rename = "negotiationMs")]
    pub negotiation: Option<u64>,
    #[serde(rename = "preparationMs")]
    pub preparation: Option<u64>,
    #[serde(rename = "credentialsMs")]
    pub credentials: Option<u64>,
    #[serde(rename = "websocketMs")]
    pub websocket: Option<u64>,
    #[serde(rename = "configurationMs")]
    pub configuration: Option<u64>,
    #[serde(rename = "listeningMs")]
    pub listening: Option<u64>,
    #[serde(rename = "firstInputMs")]
    pub first_input: Option<u64>,
}

pub(super) fn elapsed(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostics_expose_only_optional_duration_fields() -> Result<(), serde_json::Error> {
        let value = serde_json::to_value(Timings::default())?;
        assert_eq!(
            value,
            serde_json::json!({
                "offerMs":null,"negotiationMs":null,"preparationMs":null,"credentialsMs":null,"websocketMs":null,
                "configurationMs":null,"listeningMs":null,"firstInputMs":null
            })
        );
        Ok(())
    }
}
