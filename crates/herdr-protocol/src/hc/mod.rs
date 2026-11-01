//! Transport-neutral herdr-core generation-1 protocol.
//!
//! Source contracts and adapted algorithms are pinned in UPSTREAM.md.
pub mod client;
pub mod control;
pub mod documents;
pub mod edits;
pub mod endpoint;
pub mod events;
pub mod generated;
pub mod projection;
pub mod session;
pub mod terminal;
pub mod wire;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

pub const GENERATION: u32 = 1;
pub const REQUIRED_METHODS: &[&str] = &[
    "terminal.list",
    "terminal.attach",
    "terminal.run",
    "terminal.send",
    "terminal.read",
    "terminal.kill",
    "events.subscribe",
    "doc.get",
    "doc.set",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcErrorData {
    pub kind: String,
    #[serde(default)]
    pub hint: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<RpcErrorData>,
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "hc API error {}: {}", self.code, self.message)
    }
}
impl std::error::Error for RpcError {}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("unsupported hc generation {0}; supported generation is 1")]
    UnsupportedGeneration(u32),
    #[error("hc does not provide required method {0}")]
    MissingMethod(String),
    #[error("hc did not negotiate framed mode")]
    FramingNotNegotiated,
    #[error("hc frame of {0} bytes exceeds the 16 MiB limit")]
    FrameTooLarge(usize),
    #[error("invalid hc frame: {0}")]
    InvalidFrame(&'static str),
    #[error("hc protocol limit exceeded: {0}")]
    Limit(&'static str),
    #[error("invalid hc message: {0}")]
    InvalidMessage(String),
    #[error("hc channel {0} exceeded granted credit")]
    CreditExceeded(u32),
    #[error("hc channel {0} is not open")]
    UnknownChannel(u32),
    #[error("hc connection is closed")]
    Closed,
    #[error("hc {0} was not found; refresh the host state")]
    NotFound(&'static str),
    #[error("{0} is not available on herdr-core")]
    Unsupported(&'static str),
    #[error("the desktop document changed while it was being read or written")]
    DocumentConflict,
    #[error(transparent)]
    Rpc(#[from] RpcError),
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::InvalidMessage(error.to_string())
    }
}

pub fn validate_hello(hello: &generated::HelloResult) -> Result<(), Error> {
    if hello.generation != GENERATION {
        return Err(Error::UnsupportedGeneration(hello.generation));
    }
    if !hello.framed {
        return Err(Error::FramingNotNegotiated);
    }
    for method in REQUIRED_METHODS {
        if !hello.methods.iter().any(|m| m == method) {
            return Err(Error::MissingMethod((*method).into()));
        }
    }
    Ok(())
}
