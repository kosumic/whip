//! OpenCode v1 delivers a summary assistant's metadata and text parts independently.
use super::{AgentTranscriptMessage, AgentTranscriptPart, Deserialize, Serialize, Value};

pub(super) fn compaction_completed(info: &Value) -> Option<bool> {
    (info["role"] == "assistant" && info["summary"] == true).then(|| {
        info["error"].is_null()
            && info["finish"]
                .as_str()
                .is_some_and(|finish| !finish.is_empty() && finish != "error")
    })
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(super) struct V1Compaction {
    pub(super) completed: bool,
    // Keep the provider's IDs and order for later replacements and removals.
    pub(super) text: Vec<(String, String)>,
}

impl V1Compaction {
    pub(super) fn upsert(&mut self, part: AgentTranscriptPart) -> bool {
        let AgentTranscriptPart::Text { id, text, .. } = part else {
            return self.remove(part.id());
        };
        if let Some((_, old)) = self.text.iter_mut().find(|(key, _)| key == &id) {
            if *old == text {
                return false;
            }
            *old = text;
        } else {
            self.text.push((id, text));
        }
        true
    }

    pub(super) fn remove(&mut self, id: &str) -> bool {
        let before = self.text.len();
        self.text.retain(|(key, _)| key != id);
        before != self.text.len()
    }

    pub(super) fn project(&self, message: &mut AgentTranscriptMessage) {
        message.parts.clear();
        if self.completed {
            let summary = self
                .text
                .iter()
                .map(|(_, text)| text.trim())
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            message.parts.push(AgentTranscriptPart::context_compaction(
                format!("{}:compaction", message.id),
                Some(summary),
                message.completed_at_ms.or(message.created_at_ms),
            ));
        }
    }
}
