//! Opt-in only: no downloads. Supply a previously verified installation directory.
use phonon_local::{DEFAULT_VOICE, Model, PCM_CHUNK_SAMPLES, Synthesizer};
use std::path::PathBuf;

#[test]
#[ignore = "requires explicit PHONON_MODEL_DIR and real inference hardware"]
fn synthesizes_reuses_and_cancels_a_real_model() {
    let directory =
        PathBuf::from(std::env::var_os("PHONON_MODEL_DIR").expect("set PHONON_MODEL_DIR"));
    let synth = Synthesizer::default();
    let model = Model {
        directory: &directory,
        generation: 0,
        voice: DEFAULT_VOICE,
    };
    let mut samples = 0;
    let first = synth
        .synthesize(
            model,
            "Hello from Phonon.",
            || true,
            |pcm| {
                assert!(!pcm.is_empty() && pcm.len() <= PCM_CHUNK_SAMPLES);
                assert!(pcm.iter().all(|value| value.is_finite()));
                samples += pcm.len();
                true
            },
        )
        .unwrap();
    assert!(first.completed && first.cold && samples > 0);
    let cancelled = synth
        .synthesize(model, "Cancel this utterance.", || true, |_| false)
        .unwrap();
    assert!(!cancelled.completed && !cancelled.cold);
    synth.clear();
}
