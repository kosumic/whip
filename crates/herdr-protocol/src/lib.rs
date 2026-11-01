#![doc = include_str!("../README.md")]
pub mod control;
mod control_schema;
mod event_schema;
pub mod events;
pub mod hc;
pub mod terminal;
mod terminal_schema;

/// Legacy Herdr protocols 17–22. Root module paths remain compatible.
pub mod legacy {
    pub use crate::{control, events, terminal};
}
