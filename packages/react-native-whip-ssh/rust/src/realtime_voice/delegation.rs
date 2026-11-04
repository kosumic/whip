//! Deferred work belongs to this call, never to a UI view or a replacement agent.
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Instant;

use serde_json::json;
use tokio::task::JoinSet;
use tokio_tungstenite::WebSocketStream;

use super::{
    SilentArguments, ToolCompletion, ToolLedger, feedback, function_output, response, send,
    spawn_delegation,
};
use crate::host_runtime::realtime_agent::{Delegation, Delivery, PinnedAgent};

pub(super) const MAX_PENDING: usize = 8;

pub(super) struct Pending {
    pub call_id: String,
    pub request: Delegation,
}

#[derive(Default)]
pub(super) struct Deferred {
    pending: VecDeque<Pending>,
    running: bool,
}

impl Deferred {
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn has_capacity(&self, active: usize) -> bool {
        self.pending.len().saturating_add(active) < MAX_PENDING
    }

    pub fn push(&mut self, request: Pending, active: usize) -> Result<(), &'static str> {
        if !self.has_capacity(active) {
            return Err("queue_full");
        }
        self.pending.push_back(request);
        Ok(())
    }

    pub fn take(&mut self) -> Option<Pending> {
        if self.running {
            return None;
        }
        let request = self.pending.pop_front()?;
        self.running = true;
        Some(request)
    }

    pub fn finish(&mut self) {
        self.running = false;
    }

    pub fn cancel(&mut self) -> usize {
        let count = self.pending.len();
        self.pending.clear();
        count
    }
}

pub(super) struct Dispatch<'a> {
    pub ledger: &'a mut ToolLedger,
    pub deferred: &'a mut Deferred,
    pub handoff: &'a mut Option<feedback::Handoff>,
    pub tools: &'a mut JoinSet<ToolCompletion>,
    pub responses: &'a mut response::ResponseCreateQueue,
}

pub(super) struct Invocation {
    pub call_id: String,
    pub name: String,
    pub arguments: String,
    pub response_id: String,
    pub already_spoke: bool,
}

impl Dispatch<'_> {
    pub async fn handle<S>(
        self,
        socket: &mut WebSocketStream<S>,
        agent: &Arc<PinnedAgent>,
        call: Invocation,
    ) -> Result<bool, &'static str>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let mutation = match self
            .ledger
            .begin(&call.call_id, &call.name, &call.arguments)
        {
            Ok(mutation) => mutation,
            Err("duplicate") => return Ok(false),
            Err("limit") => return Err("Realtime tool limit reached. Start a new call."),
            Err(error) => {
                send(
                    socket,
                    function_output(call.call_id, json!({"error":error})),
                )
                .await?;
                self.responses.request_create();
                return Ok(false);
            }
        };
        if !mutation {
            if serde_json::from_str::<SilentArguments>(&call.arguments).is_err() {
                send(
                    socket,
                    function_output(call.call_id, json!({"error":"invalid_arguments"})),
                )
                .await?;
                self.responses.request_create();
            } else {
                if let Some(handoff) = self.handoff.as_mut() {
                    handoff.silence();
                }
                send(socket, function_output(call.call_id, json!({}))).await?;
                // A no-op result must not create a response or a spoken fallback.
            }
            return Ok(false);
        }
        let request = match Delegation::parse(&call.arguments) {
            Ok(request) => request,
            Err(error) => {
                send(
                    socket,
                    function_output(call.call_id, json!({"error":error})),
                )
                .await?;
                self.responses.request_create();
                return Ok(false);
            }
        };
        if !self.deferred.has_capacity(self.tools.len()) {
            send(socket, function_output(call.call_id, json!({"error":"queue_full","guidance":"No request was admitted. Let pending work finish."}))).await?;
            self.responses.request_create();
            return Ok(false);
        }
        let followup = self.handoff.is_some();
        if self.handoff.is_none() {
            *self.handoff = Some(feedback::Handoff::new(
                call.call_id.clone(),
                call.response_id,
                agent
                    .feedback_snapshot(None)
                    .map_err(|_| "The bound voice agent changed.")?,
                call.already_spoke,
                Instant::now(),
            ));
        }
        let later = request.delivery == Delivery::Later;
        let pending = Pending {
            call_id: call.call_id.clone(),
            request,
        };
        if later {
            self.deferred
                .push(pending, self.tools.len())
                .map_err(|_| "Voice delegation queue overflowed.")?;
            send(socket, function_output(call.call_id, json!({"delivery":"queued","completion":"not_started","guidance":"Queued in this voice call. Unsent requests are cancelled when the call ends; admission is not completion."}))).await?;
            self.responses.request_create();
        } else {
            spawn_delegation(self.tools, agent.clone(), pending, false, followup);
        }
        Ok(true)
    }
}
