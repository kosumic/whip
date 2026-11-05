//! Whip's viewport owner and zero-copy remote FFI registration.
#[cfg(test)]
mod benchmark;
mod model;
mod owner;
pub(crate) use agent_transcript_view::RowProjection;
#[cfg(test)]
pub(crate) use agent_transcript_view::rows::row_id;
pub use agent_transcript_view::{
    AgentChatPartKind, AgentChatRow, AgentChatRowContent, AgentChatRowPatch, AgentChatRowSpacing,
    AgentChatRowUpdate,
};
pub use owner::AgentChatRows;
