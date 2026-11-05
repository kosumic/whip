//! Synchronous, text-free rows and derived search for caller-owned transcripts.
#![doc = include_str!("../README.md")]
pub mod rows;
mod schema;
pub mod search;
macro_rules! define_type {
    ($kind:ident, $item:item) => {
        $item
    };
}
view_type_schema!(define_type);
pub use rows::RowProjection;
pub use search::SearchState;
