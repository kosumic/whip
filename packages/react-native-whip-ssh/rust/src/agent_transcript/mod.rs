//! Agent-independent transcript domain model and agent-specific adapters.

mod claude;
mod codex;
mod history_gate;
mod jsonl;
mod metadata;
mod model;
mod opencode;
mod projection;
mod title;

pub use claude::*;
pub use codex::*;
pub use jsonl::*;
pub(crate) use metadata::{CodexUsageTracker, tool_duration, tool_input_json};
pub use model::*;
pub use opencode::*;
pub(crate) use projection::{
    canonical_tool_name, command_title, injected_user_context, is_question_tool,
    question_tool_input, questions_from_input, tool_input, transcript_questions, user_prompt_parts,
};
