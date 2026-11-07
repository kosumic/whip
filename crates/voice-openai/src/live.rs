//! GPT-Live wire operations remain separate from Realtime function calls.
pub mod errors;
pub const CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
pub const EVENT_PREFIX: &str = "voice-live";
pub const URL: &str = "wss://api.openai.com/v1/live/sessions";

pub mod control;
pub mod usage;
pub use control::{Control, Selection};

pub mod commands;
pub use commands::{chunks, codec, send, send_with_prefix};
