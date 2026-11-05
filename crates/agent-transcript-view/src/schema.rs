//! Shared declarations; Whip registers these same types as remote FFI types.
#[doc(hidden)]
#[macro_export]
macro_rules! view_type_schema {
    ($apply:ident) => {
        $apply!(
            Enum,
            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub enum AgentChatRowSpacing {
                None,
                Turn,
                Part,
            }
        );
        $apply!(
            Enum,
            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub enum AgentChatPartKind {
                Text,
                Reasoning,
                Tool,
                Plan,
                Notice,
            }
        );
        $apply!(
            Enum,
            #[derive(Clone, Debug, PartialEq, Eq)]
            pub enum AgentChatRowContent {
                User {
                    message_id: String,
                },
                Part {
                    message_id: String,
                    part_id: String,
                    part_index: u32,
                    kind: AgentChatPartKind,
                    first: bool,
                    streaming: bool,
                },
                Error {
                    message_id: String,
                },
                Changes,
                Diff {
                    index: u32,
                },
                Meta,
            }
        );
        $apply!(
            Record,
            #[derive(Clone, Debug, PartialEq, Eq)]
            pub struct AgentChatRow {
                pub id: String,
                pub turn_id: String,
                pub spacing: AgentChatRowSpacing,
                pub content: AgentChatRowContent,
            }
        );
        $apply!(
            Enum,
            #[derive(Clone, Debug, PartialEq, Eq)]
            pub enum AgentChatRowPatch {
                Reset {
                    rows: Vec<AgentChatRow>,
                },
                /// A zero delete count inserts; empty rows remove; both replace.
                Splice {
                    index: u32,
                    delete_count: u32,
                    rows: Vec<AgentChatRow>,
                },
            }
        );
        $apply!(
            Record,
            #[derive(Clone, Debug, PartialEq, Eq)]
            pub struct AgentChatRowUpdate {
                pub base_revision: u64,
                pub revision: u64,
                pub transcript_revision: u64,
                pub patches: Vec<AgentChatRowPatch>,
            }
        );
        $apply!(
            Record,
            #[derive(Clone, Debug, PartialEq, Eq)]
            pub struct ChatSearchMatch {
                pub document_id: String,
                /// List rows to expand before scrolling to the document.
                pub reveal: Vec<String>,
                /// Byte offset in the original document; identity only, never a JS string offset.
                pub offset: u64,
                pub before: String,
                pub matched: String,
                pub after: String,
                pub leading: bool,
                pub trailing: bool,
            }
        );
        $apply!(
            Record,
            #[derive(Clone, Default)]
            pub struct ChatSearchResults {
                pub query: String,
                pub matches: Vec<ChatSearchMatch>,
                pub selected: Option<u32>,
                pub truncated: bool,
            }
        );
        $apply!(
            Record,
            #[derive(Clone)]
            pub struct ChatSearchFocus {
                pub document_id: String,
                pub offset: u64,
            }
        );
    };
}
