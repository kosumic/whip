//! Agent-independent transcript domain model and agent-specific adapters.

mod codex;
mod history_gate;
mod model;
mod opencode;
mod projection;

pub use codex::*;
pub use model::*;
pub use opencode::*;
pub(crate) use projection::injected_user_context;
