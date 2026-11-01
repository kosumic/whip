//! Event snapshot reduction adapted from herdr-app/src/hc.rs.
use super::{
    Error,
    generated::{Status, SubscribeResult, Terminal},
    wire::MAX_PAYLOAD_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const MAX_TERMINALS: usize = 16_384;
pub const MAX_EVENT_LINE_BYTES: usize = MAX_PAYLOAD_BYTES;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub seq: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub terminal: Option<String>,
    #[serde(default)]
    pub machine: Option<String>,
    pub data: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Notification {
    Event(Event),
    Heartbeat { seq: u64 },
    Missed { seq: u64, terminals: Vec<Terminal> },
    Unknown { method: String },
}

#[derive(Default)]
pub struct Decoder {
    pending: Vec<u8>,
}

impl Decoder {
    pub fn push(&mut self, mut bytes: &[u8]) -> Result<Vec<Notification>, Error> {
        let mut messages = Vec::new();
        while !bytes.is_empty() {
            let count = bytes
                .iter()
                .position(|b| *b == b'\n')
                .map_or(bytes.len(), |at| at + 1);
            if self.pending.len().saturating_add(count) > MAX_EVENT_LINE_BYTES {
                return Err(Error::Limit("event JSONL line"));
            }
            self.pending.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.pending.last() == Some(&b'\n') {
                if !self.pending.iter().all(u8::is_ascii_whitespace) {
                    messages.push(parse(&self.pending)?);
                }
                self.pending.clear();
            }
        }
        Ok(messages)
    }
    pub fn end(&mut self) {
        self.pending.clear();
    }
}

fn parse(bytes: &[u8]) -> Result<Notification, Error> {
    #[derive(Deserialize)]
    struct Envelope {
        jsonrpc: String,
        method: String,
        params: Value,
    }
    #[derive(Deserialize)]
    struct Missed {
        seq: u64,
        terminals: Vec<Terminal>,
    }
    #[derive(Deserialize)]
    struct Heartbeat {
        seq: u64,
    }
    let message: Envelope = serde_json::from_slice(bytes)?;
    if message.jsonrpc != "2.0" {
        return Err(Error::InvalidMessage("event requires JSON-RPC 2.0".into()));
    }
    Ok(match message.method.as_str() {
        "event" => Notification::Event(serde_json::from_value(message.params)?),
        "heartbeat" => Notification::Heartbeat {
            seq: serde_json::from_value::<Heartbeat>(message.params)?.seq,
        },
        "missed" => {
            let missed: Missed = serde_json::from_value(message.params)?;
            Notification::Missed {
                seq: missed.seq,
                terminals: missed.terminals,
            }
        }
        _ => Notification::Unknown {
            method: message.method,
        },
    })
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct DocumentKey {
    pub machine: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Changes {
    pub terminals: bool,
    pub documents: Vec<(DocumentKey, u64)>,
    pub refetch_documents: bool,
    pub restarted: Vec<String>,
    pub machines: bool,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    seq: u64,
    terminals: Vec<Terminal>,
    bytes: usize,
}

impl Snapshot {
    pub fn new(reply: SubscribeResult) -> Result<Self, Error> {
        let bytes = validate_terminals(&reply.terminals)?;
        Ok(Self {
            seq: reply.seq,
            terminals: reply.terminals,
            bytes,
        })
    }
    pub fn seq(&self) -> u64 {
        self.seq
    }
    pub fn terminals(&self) -> &[Terminal] {
        &self.terminals
    }
    pub fn terminal(&self, address: &str) -> Option<&Terminal> {
        self.terminals.iter().find(|t| t.address == address)
    }

    pub fn apply(&mut self, notification: Notification) -> Result<Changes, Error> {
        match notification {
            Notification::Unknown { .. } | Notification::Heartbeat { .. } => Ok(Changes::default()),
            Notification::Missed { seq, terminals } => {
                if seq < self.seq {
                    return Ok(Changes::default());
                }
                let bytes = validate_terminals(&terminals)?;
                self.seq = seq;
                self.terminals = terminals;
                self.bytes = bytes;
                Ok(Changes {
                    terminals: true,
                    refetch_documents: true,
                    machines: true,
                    ..Changes::default()
                })
            }
            Notification::Event(event) => {
                if event.seq <= self.seq {
                    return Ok(Changes::default());
                }
                let changes = self.event(&event)?;
                self.seq = event.seq;
                Ok(changes)
            }
        }
    }

    fn event(&mut self, event: &Event) -> Result<Changes, Error> {
        let mut changes = Changes::default();
        if event.kind == "doc" {
            #[derive(Deserialize)]
            struct DocChanged {
                name: String,
                version: u64,
            }
            let changed: DocChanged = serde_json::from_value(event.data.clone())?;
            changes.documents.push((
                DocumentKey {
                    machine: event.machine.clone(),
                    name: changed.name,
                },
                changed.version,
            ));
            return Ok(changes);
        }
        if event.kind.starts_with("machine") {
            changes.machines = true;
            changes.refetch_documents = true;
            return Ok(changes);
        }
        let Some(address) = &event.terminal else {
            return Ok(changes);
        };
        let at = self.terminals.iter().position(|t| &t.address == address);
        let whole = match event.kind.as_str() {
            "created" | "restarted" => Some(&event.data),
            "labels" => event.data.get("record"),
            _ => None,
        };
        if let Some(record) = whole {
            let record: Terminal = serde_json::from_value(record.clone())?;
            if &record.address != address {
                return Err(Error::InvalidMessage(
                    "event terminal does not match its record".into(),
                ));
            }
            self.store(at, record)?;
            changes.terminals = true;
            if event.kind == "restarted" {
                changes.restarted.push(address.clone());
            }
            return Ok(changes);
        }
        let Some(at) = at else {
            return Ok(changes);
        };
        if event.kind == "removed" {
            let removed = self.terminals.remove(at);
            self.bytes -= serde_json::to_vec(&removed)?.len();
            changes.terminals = true;
            return Ok(changes);
        }
        let mut value = serde_json::to_value(&self.terminals[at])?;
        let keys: &[&str] = match event.kind.as_str() {
            "finished" | "lost" => &["reason", "exit_code", "signal", "finished_ms"],
            "status" => &["status", "records", "reported"],
            "turn" => &["turn"],
            "title" => &["title"],
            "labels" => &["labels"],
            "keep" => &["keep"],
            "size" => &["cols", "rows"],
            "foreground" => {
                value["foreground"] = event.data.clone();
                &[]
            }
            _ => return Ok(changes),
        };
        for key in keys {
            value[*key] = event
                .data
                .get(*key)
                .ok_or_else(|| {
                    Error::InvalidMessage(format!("{} event is missing {key}", event.kind))
                })?
                .clone();
        }
        if matches!(event.kind.as_str(), "finished" | "lost") {
            value["state"] = json!(if event.kind == "lost" {
                "live"
            } else {
                "finished"
            });
            value["foreground"] = Value::Null;
            if event.kind == "lost" {
                value["pid"] = Value::Null;
            }
        }
        self.store(Some(at), serde_json::from_value(value)?)?;
        changes.terminals = true;
        Ok(changes)
    }

    /// An acknowledged create can precede its event; never overwrite a newer event.
    pub fn insert_created(&mut self, terminal: Terminal) -> Result<(), Error> {
        if self.terminal(&terminal.address).is_none() {
            self.store(None, terminal)?;
        }
        Ok(())
    }
    fn store(&mut self, at: Option<usize>, terminal: Terminal) -> Result<(), Error> {
        if terminal.address.is_empty() {
            return Err(Error::InvalidMessage("empty terminal address".into()));
        }
        let old = at
            .map(|at| serde_json::to_vec(&self.terminals[at]).map(|bytes| bytes.len()))
            .transpose()?
            .unwrap_or(0);
        let bytes = self.bytes - old + serde_json::to_vec(&terminal)?.len();
        if bytes > MAX_SNAPSHOT_BYTES {
            return Err(Error::Limit("terminal snapshot bytes"));
        }
        if let Some(at) = at {
            self.terminals[at] = terminal;
        } else {
            if self.terminals.len() >= MAX_TERMINALS {
                return Err(Error::Limit("terminal records"));
            }
            self.terminals.push(terminal);
        }
        self.bytes = bytes;
        Ok(())
    }
}

pub const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
fn validate_terminals(terminals: &[Terminal]) -> Result<usize, Error> {
    if terminals.len() > MAX_TERMINALS {
        return Err(Error::Limit("terminal snapshot"));
    }
    let mut addresses = std::collections::BTreeSet::new();
    for terminal in terminals {
        if terminal.address.is_empty() || !addresses.insert(&terminal.address) {
            return Err(Error::InvalidMessage(
                "empty or duplicate terminal address".into(),
            ));
        }
    }
    let bytes = terminals.iter().try_fold(0usize, |total, terminal| {
        serde_json::to_vec(terminal).map(|bytes| total.saturating_add(bytes.len()))
    })?;
    if bytes > MAX_SNAPSHOT_BYTES {
        return Err(Error::Limit("terminal snapshot bytes"));
    }
    Ok(bytes)
}

/// The root word is authoritative only after the program has reported status.
pub fn reported_status(terminal: &Terminal) -> Option<&Status> {
    terminal
        .reported
        .unwrap_or(false)
        .then_some(terminal.status.as_ref())
        .flatten()
}

pub fn status_labels(terminal: &Terminal) -> BTreeMap<String, String> {
    terminal.labels.clone()
}
