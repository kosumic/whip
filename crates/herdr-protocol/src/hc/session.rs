//! Bounded request correlation and attach/event channel routing.
//! Adapted from herdr-app/src/hc.rs; all I/O and scheduling are injected by callers.
use super::{
    Error, GENERATION, RpcError,
    generated::{HelloResult, Request, Response},
    validate_hello,
    wire::{Decoder, Frame, INITIAL_CREDIT, Kind},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};

pub const MAX_PENDING_REQUESTS: usize = 128;
pub const MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_CHANNELS: usize = 64;
pub const MAX_EARLY_CHANNELS: usize = 8;
pub const MAX_HELLO_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloseReason {
    pub reason: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub signal: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StreamItem {
    Data(Vec<u8>),
    Closed(Option<CloseReason>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Ready(HelloResult),
    Reply {
        id: u64,
        result: Result<Response, Error>,
    },
    Channel(u32),
    Send(Vec<u8>),
}

struct Channel {
    queue: VecDeque<StreamItem>,
    credit: usize,
    outstanding: usize,
    in_flight: usize,
    early: bool,
    claimed: bool,
    closed: bool,
}
impl Channel {
    fn new(early: bool) -> Self {
        Self {
            queue: VecDeque::new(),
            credit: INITIAL_CREDIT,
            outstanding: 0,
            in_flight: 0,
            early,
            claimed: false,
            closed: false,
        }
    }
    fn push(&mut self, frame: Frame) -> Result<(), Error> {
        match frame.kind {
            Kind::Data => {
                if self.closed {
                    return Err(Error::InvalidFrame("DATA after CLOSE"));
                }
                if frame.payload.len() > self.credit {
                    return Err(Error::CreditExceeded(frame.channel));
                }
                self.credit -= frame.payload.len();
                self.outstanding += frame.payload.len();
                if !frame.payload.is_empty() {
                    // Coalesce adjacent DATA so legal small frames within the
                    // credit window cannot exhaust queue metadata or disrupt
                    // other channels when this consumer stalls.
                    if let Some(StreamItem::Data(bytes)) = self.queue.back_mut() {
                        bytes.extend_from_slice(&frame.payload);
                    } else {
                        self.queue.push_back(StreamItem::Data(frame.payload));
                    }
                }
            }
            Kind::Close => {
                if !self.closed {
                    let reason = if frame.payload.is_empty() {
                        None
                    } else {
                        Some(serde_json::from_slice(&frame.payload)?)
                    };
                    self.queue.push_back(StreamItem::Closed(reason));
                    self.closed = true;
                }
            }
            Kind::Credit => {} // Input is not credit-controlled by generation 1.
            _ => return Err(Error::InvalidFrame("viewer-only frame received from core")),
        }
        Ok(())
    }
}

pub struct Session {
    hello: Option<HelloResult>,
    hello_line: Vec<u8>,
    decoder: Decoder,
    next_id: u64,
    pending: BTreeMap<u64, Request>,
    pending_sizes: BTreeMap<u64, usize>,
    pending_bytes: usize,
    abandoned: VecDeque<(u64, Request)>,
    unclaimed: BTreeMap<u64, u32>,
    channels: BTreeMap<u32, Channel>,
    closed_channels: VecDeque<u32>,
    closed: bool,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            hello: None,
            hello_line: Vec::new(),
            decoder: Decoder::default(),
            next_id: 1,
            pending: BTreeMap::new(),
            pending_sizes: BTreeMap::new(),
            pending_bytes: 0,
            abandoned: VecDeque::new(),
            unclaimed: BTreeMap::new(),
            channels: BTreeMap::new(),
            closed_channels: VecDeque::new(),
            closed: false,
        }
    }
}

impl Session {
    pub fn hello_request() -> Vec<u8> {
        format!("{{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"hello\",\"params\":{{\"generation\":{GENERATION},\"framed\":true}}}}\n").into_bytes()
    }

    pub fn hello(&self) -> Option<&HelloResult> {
        self.hello.as_ref()
    }
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn request(&mut self, request: Request) -> Result<(u64, Vec<u8>), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        let hello = self
            .hello
            .as_ref()
            .ok_or_else(|| Error::InvalidMessage("hello is incomplete".into()))?;
        if matches!(request, Request::Hello(..)) {
            return Err(Error::InvalidMessage("hello already negotiated".into()));
        }
        if !hello.methods.iter().any(|m| m == request.method()) {
            return Err(Error::MissingMethod(request.method().into()));
        }
        if self.pending.len() >= MAX_PENDING_REQUESTS {
            return Err(Error::Limit("pending RPC requests"));
        }
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or(Error::Limit("request identifiers"))?;
        let payload = serde_json::to_vec(
            &json!({"jsonrpc":"2.0","id":id,"method":request.method(),"params":request.params()?}),
        )?;
        let bytes = Frame {
            channel: 0,
            kind: Kind::Data,
            payload,
        }
        .encode()?;
        if self.pending_bytes.saturating_add(bytes.len()) > MAX_PENDING_BYTES {
            return Err(Error::Limit("pending RPC bytes"));
        }
        self.pending_bytes += bytes.len();
        self.pending_sizes.insert(id, bytes.len());
        self.pending.insert(id, request);
        Ok((id, bytes))
    }

    /// Drop a request without replaying it. Late attach replies are detached.
    pub fn cancel(&mut self, id: u64) -> Result<Vec<Vec<u8>>, Error> {
        if let Some(channel) = self.unclaimed.remove(&id) {
            return Ok(self.close_channel(channel)?.into_iter().collect());
        }
        if let Some(request) = self.pending.remove(&id) {
            self.pending_bytes -= self.pending_sizes.remove(&id).unwrap_or(0);
            if self.abandoned.len() >= MAX_PENDING_REQUESTS * 2 {
                self.abandoned.pop_front();
            }
            // Only stream replies need tombstones, and their argument payloads
            // are no longer needed to decode/detach a late channel.
            let request = match request {
                Request::TerminalAttach(_) => {
                    Request::terminal_attach(super::generated::TerminalAttachParams::default())
                }
                Request::EventsSubscribe(_) => {
                    Request::events_subscribe(super::generated::EventsSubscribeParams::default())
                }
                _ => return Ok(Vec::new()),
            };
            self.abandoned.push_back((id, request));
        }
        Ok(Vec::new())
    }

    pub fn receive(&mut self, mut bytes: &[u8]) -> Result<Vec<Action>, Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        let mut actions = Vec::new();
        if self.hello.is_none() {
            let count = bytes
                .iter()
                .position(|b| *b == b'\n')
                .map_or(bytes.len(), |at| at + 1);
            if self.hello_line.len().saturating_add(count) > MAX_HELLO_BYTES {
                return Err(Error::Limit("hello line"));
            }
            self.hello_line.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.hello_line.last() != Some(&b'\n') {
                return Ok(actions);
            }
            let value: Value = serde_json::from_slice(&self.hello_line)?;
            envelope(&value)?;
            if value.get("id").and_then(Value::as_u64) != Some(0) {
                return Err(Error::InvalidMessage("hello reply has the wrong id".into()));
            }
            let hello: HelloResult = serde_json::from_value(result(value)?)?;
            validate_hello(&hello)?;
            self.hello_line.clear();
            self.hello = Some(hello.clone());
            actions.push(Action::Ready(hello));
        }
        for frame in self.decoder.push(bytes)? {
            if frame.channel == 0 {
                if frame.kind != Kind::Data {
                    return Err(Error::InvalidFrame("channel zero requires DATA"));
                }
                self.reply(&frame.payload, &mut actions)?;
            } else {
                self.stream(frame, &mut actions)?;
            }
        }
        Ok(actions)
    }

    fn reply(&mut self, payload: &[u8], actions: &mut Vec<Action>) -> Result<(), Error> {
        let value: Value = serde_json::from_slice(payload)?;
        envelope(&value)?;
        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            return Err(Error::InvalidMessage(
                "channel-zero reply requires an integer id".into(),
            ));
        };
        if let Some(request) = self.pending.remove(&id) {
            self.pending_bytes -= self.pending_sizes.remove(&id).unwrap_or(0);
            let response = result(value).and_then(|value| request.decode(value));
            if request.opens_channel() {
                if let Err(error) = &response
                    && !matches!(error, Error::Rpc(_))
                {
                    return Err(error.clone());
                }
                if let Ok(response) = &response {
                    let channel =
                        response
                            .stream_channel()
                            .filter(|c| *c != 0)
                            .ok_or_else(|| {
                                Error::InvalidMessage(
                                    "attach/subscription returned no stream channel".into(),
                                )
                            })?;
                    self.register_channel(channel)?;
                    self.unclaimed.insert(id, channel);
                }
            }
            actions.push(Action::Reply {
                id,
                result: response,
            });
        } else {
            let abandoned = self
                .abandoned
                .iter()
                .position(|(old, _)| *old == id)
                .and_then(|at| self.abandoned.remove(at));
            let channel = match abandoned {
                Some((_, request)) if request.opens_channel() => result(value)
                    .and_then(|value| request.decode(value))
                    .ok()
                    .and_then(|r| r.stream_channel()),
                None if id < self.next_id => value
                    .get("result")
                    .and_then(|v| v.get("channel"))
                    .and_then(Value::as_u64)
                    .and_then(|c| u32::try_from(c).ok()),
                Some(_) | None => None,
            };
            // Cancellation tombstones are bounded. Very late stream replies
            // are detached even after their tombstone has been evicted.
            if let Some(channel) = channel.filter(|c| *c != 0) {
                if self
                    .channels
                    .get(&channel)
                    .is_some_and(|state| !state.early)
                {
                    return Err(Error::InvalidMessage("core reused a live channel".into()));
                }
                self.channels.remove(&channel);
                actions.push(Action::Send(close_frame(channel)?));
                self.remember_closed(channel);
            }
        }
        // Unknown IDs can be replies to canceled requests; they never fulfill a new call.
        Ok(())
    }

    fn register_channel(&mut self, channel: u32) -> Result<(), Error> {
        if let Some(existing) = self.channels.get_mut(&channel) {
            if !existing.early {
                return Err(Error::InvalidMessage("core reused a live channel".into()));
            }
            existing.early = false;
        } else {
            if self.channels.len() >= MAX_CHANNELS {
                return Err(Error::Limit("open channels"));
            }
            self.channels.insert(channel, Channel::new(false));
        }
        Ok(())
    }

    fn stream(&mut self, frame: Frame, actions: &mut Vec<Action>) -> Result<(), Error> {
        let channel = frame.channel;
        if self.closed_channels.contains(&channel) {
            return Ok(());
        }
        if !self.channels.contains_key(&channel) {
            let opening = self.pending.values().any(Request::opens_channel)
                || self.abandoned.iter().any(|(_, r)| r.opens_channel());
            if !opening {
                return Err(Error::UnknownChannel(channel));
            }
            if self.channels.len() >= MAX_CHANNELS
                || self.channels.values().filter(|c| c.early).count() >= MAX_EARLY_CHANNELS
            {
                return Err(Error::Limit("early channels"));
            }
            self.channels.insert(channel, Channel::new(true));
        }
        if let Some(state) = self.channels.get_mut(&channel) {
            state.push(frame)?;
        }
        actions.push(Action::Channel(channel));
        Ok(())
    }

    /// Claim only after the typed reply has been accepted by its live caller.
    pub fn claim_channel(&mut self, channel: u32) -> Result<(), Error> {
        let state = self
            .channels
            .get_mut(&channel)
            .ok_or(Error::UnknownChannel(channel))?;
        if state.early || state.claimed {
            return Err(Error::InvalidMessage("channel not claimable".into()));
        }
        state.claimed = true;
        self.unclaimed.retain(|_, value| *value != channel);
        Ok(())
    }

    pub fn take_channel(&mut self, channel: u32) -> Result<Vec<StreamItem>, Error> {
        let state = self
            .channels
            .get_mut(&channel)
            .ok_or(Error::UnknownChannel(channel))?;
        if !state.claimed {
            return Err(Error::InvalidMessage("channel not claimed".into()));
        }
        let items: Vec<_> = state.queue.drain(..).collect();
        state.in_flight += items
            .iter()
            .map(|item| match item {
                StreamItem::Data(bytes) => bytes.len(),
                StreamItem::Closed(_) => 0,
            })
            .sum::<usize>();
        Ok(items)
    }

    /// Credit follows consumption by the caller's bounded sink, never mere receipt.
    pub fn consumed(&mut self, channel: u32, bytes: usize) -> Result<Option<Vec<u8>>, Error> {
        let state = self
            .channels
            .get_mut(&channel)
            .ok_or(Error::UnknownChannel(channel))?;
        if bytes > state.in_flight {
            return Err(Error::InvalidFrame("credit exceeds delivered data"));
        }
        state.in_flight -= bytes;
        state.outstanding -= bytes;
        state.credit += bytes;
        if state.closed || bytes == 0 {
            return Ok(None);
        }
        let count = u32::try_from(bytes).map_err(|_| Error::Limit("credit count"))?;
        Ok(Some(
            Frame {
                channel,
                kind: Kind::Credit,
                payload: count.to_le_bytes().to_vec(),
            }
            .encode()?,
        ))
    }

    pub fn channel_frame(
        &self,
        channel: u32,
        kind: Kind,
        payload: Vec<u8>,
    ) -> Result<Vec<u8>, Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        let state = self
            .channels
            .get(&channel)
            .ok_or(Error::UnknownChannel(channel))?;
        if !state.claimed || state.closed {
            return Err(Error::UnknownChannel(channel));
        }
        if matches!(kind, Kind::Credit | Kind::Close) {
            return Err(Error::InvalidFrame(
                "use consumed or close_channel for control frames",
            ));
        }
        Frame {
            channel,
            kind,
            payload,
        }
        .encode()
    }

    pub fn close_channel(&mut self, channel: u32) -> Result<Option<Vec<u8>>, Error> {
        if self.channels.remove(&channel).is_none() {
            return Ok(None);
        }
        self.unclaimed.retain(|_, value| *value != channel);
        self.remember_closed(channel);
        Ok(Some(close_frame(channel)?))
    }

    fn remember_closed(&mut self, channel: u32) {
        if self.closed_channels.len() >= MAX_CHANNELS * 2 {
            self.closed_channels.pop_front();
        }
        self.closed_channels.push_back(channel);
    }

    pub fn end(&mut self) -> Result<(), Error> {
        let result = if self.hello.is_none() || !self.hello_line.is_empty() {
            Err(Error::InvalidFrame("truncated hello"))
        } else {
            self.decoder.end()
        };
        self.closed = true;
        self.pending.clear();
        self.pending_sizes.clear();
        self.pending_bytes = 0;
        self.abandoned.clear();
        self.unclaimed.clear();
        self.channels.clear();
        result
    }
}

fn close_frame(channel: u32) -> Result<Vec<u8>, Error> {
    Frame {
        channel,
        kind: Kind::Close,
        payload: Vec::new(),
    }
    .encode()
}

fn envelope(value: &Value) -> Result<(), Error> {
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(Error::InvalidMessage("expected JSON-RPC 2.0".into()));
    }
    if value.get("result").is_some() == value.get("error").is_some() {
        return Err(Error::InvalidMessage(
            "reply requires exactly one result or error".into(),
        ));
    }
    Ok(())
}

fn result(mut value: Value) -> Result<Value, Error> {
    if let Some(error) = value.get_mut("error") {
        return Err(Error::Rpc(serde_json::from_value::<RpcError>(
            error.take(),
        )?));
    }
    value
        .get_mut("result")
        .map(Value::take)
        .ok_or_else(|| Error::InvalidMessage("reply result missing".into()))
}
