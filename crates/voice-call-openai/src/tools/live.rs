//! Attributed GPT-Live Responses tool batches and continuation scheduling.
use oai_rt_rs::live::{
    FunctionCall, FunctionCallTracker, ResponseAttribution, ResponseEvent, ResponseKey,
    ResponseLifecycleKind,
};
use std::collections::BTreeSet;

#[cfg(test)]
mod tests;

/// Per-call limits selected by the host.
#[derive(Clone, Copy)]
pub struct Limits {
    pub responses: usize,
    pub pending: usize,
    pub calls: usize,
    pub calls_per_response: usize,
    pub argument_bytes: usize,
}

/// Tracks ownership and completion of GPT-Live Responses tool calls.
pub struct LiveTools {
    limits: Limits,
    tracker: FunctionCallTracker,
    responses: BTreeSet<ResponseKey>,
    open: BTreeSet<ResponseKey>,
    completed: BTreeSet<ResponseKey>,
    batches: BTreeSet<ResponseKey>,
    continuation: bool,
    requested: bool,
    requested_id: Option<String>,
    calls: BTreeSet<String>,
}

pub struct Batch {
    pub key: ResponseKey,
    pub calls: Vec<FunctionCall>,
}

impl LiveTools {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            tracker: FunctionCallTracker::default(),
            responses: BTreeSet::new(),
            open: BTreeSet::new(),
            completed: BTreeSet::new(),
            batches: BTreeSet::new(),
            continuation: false,
            requested: false,
            requested_id: None,
            calls: BTreeSet::new(),
        }
    }

    pub fn busy(&self) -> bool {
        !self.open.is_empty() || !self.batches.is_empty() || self.requested || self.continuation
    }
    /// Only a complete, attributed, successful response can produce a batch.
    /// An error is terminal for the current provider session.
    pub fn observe(
        &mut self,
        scope: Option<&str>,
        event: &ResponseEvent,
    ) -> Result<Option<Batch>, &'static str> {
        let attribution = self
            .tracker
            .observe(scope, event)
            .map_err(|_| "Global Live backend event identity changed. Start a new call.")?;
        let key = match attribution {
            ResponseAttribution::Owned(key) if key.delegation_id.is_some() => key,
            ResponseAttribution::Unowned if matches!(event, ResponseEvent::Unknown { .. }) => {
                return Ok(None);
            }
            _ => {
                return Err(
                    "Global Live backend event has no unambiguous owner. Start a new call.",
                );
            }
        };
        if key.response_id.is_empty()
            || key.response_id.len() > 256
            || key
                .delegation_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > 128)
        {
            return Err("Invalid global Live backend identity.");
        }
        if !self.responses.contains(&key) {
            if self.responses.len() >= self.limits.responses
                || self.open.len() + self.batches.len() >= self.limits.pending
            {
                return Err("Global Live backend request limit reached. Start a new call.");
            }
            self.responses.insert(key.clone());
            self.open.insert(key.clone());
        }
        if matches!(
            event,
            ResponseEvent::Lifecycle {
                kind: ResponseLifecycleKind::Created,
                ..
            }
        ) {
            self.requested = false;
            self.requested_id = None;
        }
        if matches!(
            self.tracker.terminal(&key),
            Some(ResponseLifecycleKind::Failed | ResponseLifecycleKind::Incomplete)
        ) {
            return Err(
                "Global Live backend did not complete. Inspect the app before trying again.",
            );
        }
        if self.tracker.terminal(&key) != Some(ResponseLifecycleKind::Completed)
            || self.completed.contains(&key)
        {
            return Ok(None);
        }
        let calls = self
            .tracker
            .ready_calls(&key)
            .ok_or("Global Live tool results are incomplete. No request will be replayed.")?;
        if calls.len() > self.limits.calls_per_response
            || calls.iter().any(|call| {
                call.call_id.is_empty()
                    || call.call_id.len() > 128
                    || call.args.len() > self.limits.argument_bytes
            })
        {
            return Err("Global Live tool request exceeds the call limits.");
        }
        let calls = calls.to_vec();
        for call in &calls {
            if self.calls.len() >= self.limits.calls || !self.calls.insert(call.call_id.clone()) {
                return Err("Global Live repeated a tool identity. No request will be replayed.");
            }
        }
        self.completed.insert(key.clone());
        self.open.remove(&key);
        if calls.is_empty() {
            return Ok(None);
        }
        self.batches.insert(key.clone());
        Ok(Some(Batch { key, calls }))
    }

    pub fn request(&mut self) {
        self.continuation = true;
    }

    pub fn request_sent(&mut self, id: String) {
        self.requested_id = Some(id);
    }

    /// A failed create must not wedge future explicit requests or retry itself.
    /// Unrelated rejections cannot release a different in-flight response.
    pub fn rejected(&mut self, id: Option<&str>) -> bool {
        if id.is_some() && id == self.requested_id.as_deref() {
            self.requested = false;
            self.requested_id = None;
            self.continuation = false;
            true
        } else {
            false
        }
    }

    pub fn finished(&mut self, key: &ResponseKey) -> Result<(), &'static str> {
        if !self.batches.remove(key) {
            return Err("Global Live tool completion has no owner.");
        }
        self.request();
        Ok(())
    }

    /// Typed input and tool continuations wait until all outstanding outputs exist.
    pub fn take_continuation(&mut self) -> bool {
        if self.continuation && !self.requested && self.open.is_empty() && self.batches.is_empty() {
            self.continuation = false;
            self.requested = true;
            true
        } else {
            false
        }
    }
}
