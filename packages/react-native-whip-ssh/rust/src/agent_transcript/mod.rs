//! Agent-independent transcript domain model and agent-specific adapters.

mod claude;
mod codex;
mod history_gate;
mod jsonl;
mod model;
mod opencode;
mod projection;

pub use claude::*;
pub use codex::*;
pub use jsonl::*;
pub use model::*;
pub use opencode::*;
pub(crate) use projection::{injected_user_context, user_prompt_parts};
