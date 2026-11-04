//! A server event can arrive on both WebRTC and its sideband; apply it once.
use std::collections::{HashSet, VecDeque};
#[derive(Default)]
pub(super) struct Seen {
    ids: HashSet<String>,
    order: VecDeque<String>,
}
impl Seen {
    pub fn accept(&mut self, text: &str) -> Result<bool, &'static str> {
        let event: serde_json::Value =
            serde_json::from_str(text).map_err(|_| "Invalid Realtime event.")?;
        let Some(id) = event["event_id"].as_str() else {
            return Ok(true);
        };
        if id.len() > 512 {
            return Err("Invalid Realtime event identifier.");
        }
        if !self.ids.insert(id.into()) {
            return Ok(false);
        }
        self.order.push_back(id.into());
        if self.order.len() > 1024
            && let Some(old) = self.order.pop_front()
        {
            self.ids.remove(&old);
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mirrored_sideband_and_datachannel_events_are_applied_once() -> Result<(), &'static str> {
        let mut seen = Seen::default();
        let event = r#"{"event_id":"event_1","type":"response.function_call_arguments.done","call_id":"tool_1"}"#;
        assert!(seen.accept(event)?);
        assert!(!seen.accept(event)?);
        assert!(seen.accept(r#"{"event_id":"event_2","type":"response.output_audio_transcript.delta","delta":"new"}"#)?);
        assert!(seen.accept("not json").is_err());
        Ok(())
    }
}
