//! Verified, explicitly installed Phonon speech artifacts and streaming inference.
//!
//! Nothing is downloaded by construction, inspection, or synthesis. Run blocking
//! operations on a host worker. The host owns settings, storage placement, audio
//! devices, cancellation tokens, and any process-wide Rayon configuration.
//! See the crate README for distribution, runtime licenses, and platform limits.

mod artifacts;
#[cfg(any(target_os = "ios", test))]
mod bundle;
#[cfg(target_os = "ios")]
mod coreml;
#[cfg(not(target_os = "ios"))]
mod cpu;
pub mod download;
mod synthesis;
pub mod voices;

pub use artifacts::{ARTIFACTS, Artifact, COREML_ARTIFACT, DEFAULT_VOICE, REVISION, SAMPLE_RATE};
pub use synthesis::{Model, PCM_CHUNK_SAMPLES, SynthesisReport, Synthesizer};

#[cfg(target_os = "ios")]
use coreml as runtime;
#[cfg(not(target_os = "ios"))]
use cpu as runtime;

/// Whether this target can use Whip's native inference configuration.
/// On iOS the host must additionally check iOS 18+ at runtime. The Core ML
/// configuration uses the Neural Engine, so an arm64 simulator is insufficient.
/// CPU inference remains available to independent desktop Rust hosts.
pub const fn native_supported() -> bool {
    cfg!(all(target_os = "android", target_arch = "aarch64"))
        || cfg!(all(
            target_os = "ios",
            target_arch = "aarch64",
            not(target_abi = "sim")
        ))
}
