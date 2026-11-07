//! Bounded, call-scoped tool admission. Catalog and execution belong to the host.
use std::collections::HashSet;

pub const MAX_CALLS: usize = 128;
pub const MAX_ARGUMENT_BYTES: usize = 64 * 1024;
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Unknown,
    Read,
    Mutate,
}
#[derive(Default)]
pub struct Ledger {
    seen: HashSet<String>,
    mutation_uncertain: bool,
}
impl Ledger {
    pub fn begin(
        &mut self,
        id: &str,
        arguments: &str,
        access: Access,
    ) -> Result<bool, &'static str> {
        if self.seen.contains(id) {
            return Err("duplicate");
        }
        if self.seen.len() >= MAX_CALLS {
            return Err("limit");
        }
        if id.is_empty() || id.len() > 128 {
            return Err("invalid_call_id");
        }
        self.seen.insert(id.to_owned());
        if access == Access::Unknown || arguments.len() > MAX_ARGUMENT_BYTES {
            return Err("invalid_tool");
        }
        let mutation = access == Access::Mutate;
        if mutation && self.mutation_uncertain {
            return Err("outcome_unknown");
        }
        Ok(mutation)
    }
    pub fn complete(&mut self, mutation: bool, uncertain: bool) {
        if mutation {
            self.mutation_uncertain |= uncertain;
        }
    }
}
pub fn function_output(call_id: String, value: serde_json::Value) -> crate::ClientEvent {
    crate::ClientEvent::ConversationItemCreate {
        event_id: None,
        previous_item_id: None,
        item: Box::new(oai_rt_rs::Item::FunctionCallOutput {
            id: None,
            phase: None,
            call_id,
            output: value.to_string(),
        }),
    }
}
