use ptts::{
    checkpoint::{Checkpoint, ResolveOptions},
    preprocess::Lang,
    synth::{DeviceKind, Quant, Session, SpeechOptions, Synth},
};
use std::path::{Path, PathBuf};

pub(super) struct Engine {
    synth: Synth,
    root: PathBuf,
    session: Option<(String, Session)>,
}

pub(super) fn load(path: &Path) -> Result<Engine, String> {
    let checkpoint = Checkpoint::resolve(
        path,
        ResolveOptions {
            quant: Quant::Q80,
            weights: Some("model.q8.gguf"),
        },
    )
    .map_err(|e| e.to_string())?;
    let mut synth = checkpoint
        .builder(Lang::En)
        .device(DeviceKind::Cpu)
        .build()
        .map_err(|e| e.to_string())?;
    synth
        .add_voice_file(
            super::DEFAULT_VOICE,
            &path.join("default-voice.safetensors"),
        )
        .map_err(|e| e.to_string())?;
    if synth.sample_rate() != super::SAMPLE_RATE {
        return Err("Unexpected Phonon audio format".into());
    }
    Ok(Engine {
        synth,
        session: None,
        root: path.parent().ok_or("Invalid model path")?.into(),
    })
}

pub(super) fn speak(
    engine: &mut Engine,
    text: &str,
    voice: &str,
    sink: &mut dyn FnMut(&[f32]) -> bool,
) -> Result<(), String> {
    if voice != super::DEFAULT_VOICE && !engine.synth.voices().iter().any(|name| name == voice) {
        let item = super::voices::find(voice)?;
        let path = super::voices::path(&engine.root, voice);
        super::download::verify_digest(&path, item.bytes, &item.sha256)?;
        engine
            .synth
            .add_voice_file(voice, &path)
            .map_err(|e| e.to_string())?;
    }
    if engine
        .session
        .as_ref()
        .is_none_or(|(name, _)| name != voice)
    {
        let session = engine
            .synth
            .session_default(&SpeechOptions::default().voice(voice))
            .map_err(|e| e.to_string())?;
        engine.session = Some((voice.to_owned(), session));
    }
    let (_, session) = engine
        .session
        .as_ref()
        .ok_or("Speech session is unavailable")?;
    // Phonon already runs bounded synthesis/decode workers. Reuse its primed
    // session; finish or drop this stream before starting the next utterance.
    for pcm in session.stream(text).map_err(|e| e.to_string())? {
        if !sink(&pcm.map_err(|e| e.to_string())?) {
            break;
        }
    }
    Ok(())
}
