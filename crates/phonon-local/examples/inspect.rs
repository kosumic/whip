//! Independent, model-free host: inspect pins and cancel before inference.
use phonon_local::{ARTIFACTS, DEFAULT_VOICE, Model, REVISION, Synthesizer, voices};
use std::path::Path;

fn main() -> Result<(), String> {
    println!(
        "Phonon revision {REVISION}; {} voices",
        voices::CATALOG.len()
    );
    for artifact in ARTIFACTS {
        println!(
            "{}: {} bytes, SHA-256 {}",
            artifact.name, artifact.bytes, artifact.sha256
        );
    }
    let synth = Synthesizer::default();
    let report = synth.synthesize(
        Model {
            directory: Path::new("not-installed"),
            generation: 0,
            voice: DEFAULT_VOICE,
        },
        "Cancelled before loading.",
        || false,
        |_| panic!("cancelled utterance emitted PCM"),
    )?;
    assert!(!report.completed);
    synth.clear();
    Ok(())
}
