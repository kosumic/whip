//! Validated browser-agent actions and a platform-neutral execution engine.
//!
//! Implement [`engine::Bridge`] to connect an existing browser. The bridge owns
//! browser permissions and native effects; this crate supplies the action model,
//! DOM programs, result limits, deadlines, cancellation, and generation fences.
#![forbid(unsafe_code)]

pub mod control;
pub mod engine;
pub mod fence;
pub mod model;
pub mod programs;

#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod tests;
