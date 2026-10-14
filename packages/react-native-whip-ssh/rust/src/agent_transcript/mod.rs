//! Agent-independent transcript domain model and agent-specific adapters.

mod claude;
mod codex;
mod history_gate;
mod jsonl;
mod metadata;
mod model;
mod opencode;
mod projection;

pub use claude::*;
pub use codex::*;
pub use jsonl::*;
pub(crate) use metadata::{CodexUsageTracker, tool_duration, tool_input_json};
pub use model::*;
pub use opencode::*;
pub(crate) use projection::{
    command_title, injected_user_context, question_tool_input, questions_from_input,
    transcript_questions, user_prompt_parts,
};
