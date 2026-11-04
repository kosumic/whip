//! Portable policy for Android/iOS speech backends, with no platform dependencies.
//!
//! Applications own the executor, native player, and policy configuration. Call
//! the core under your coordinator lock, release it, then dispatch native work.
//! A native backend reports completion only after the last audio frame played.
#![doc = include_str!("../README.md")]
mod ownership;
mod queue;

pub use ownership::{Admission, Arbiter, LeaseId, Preemption};
pub use queue::{Playback, PlaybackQueue, QueueConfig, QueueItem, WaitingLimits};
