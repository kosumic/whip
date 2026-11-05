//! Register the portable crate's actual types in Whip's existing namespace.
use agent_transcript_view::{
    AgentChatPartKind, AgentChatRow, AgentChatRowContent, AgentChatRowPatch, AgentChatRowSpacing,
    AgentChatRowUpdate, ChatSearchFocus, ChatSearchMatch, ChatSearchResults,
};
macro_rules! native_type {
    ($kind:ident, $item:item) => {
        #[uniffi::remote($kind)]
        $item
    };
}
agent_transcript_view::view_type_schema!(native_type);
