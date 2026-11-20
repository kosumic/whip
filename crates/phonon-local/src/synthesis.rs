use crate::{download, runtime};
use parking_lot::Mutex;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// Whip's existing upper bound for a synchronous PCM callback (80 ms at 24 kHz).
pub const PCM_CHUNK_SAMPLES: usize = 1_920;

/// A verified model directory, host invalidation generation, and selected voice.
/// Increment the generation after adding/removing voices or replacing artifacts.
#[derive(Clone, Copy)]
pub struct Model<'a> {
    pub directory: &'a Path,
    pub generation: u64,
    pub voice: &'a str,
}

/// Synthesis completion is distinct from the host's final audio-device drain.
#[derive(Debug, Default)]
pub struct SynthesisReport {
    pub completed: bool,
    pub cold: bool,
    pub model_load: Duration,
    pub first_pcm: Option<Duration>,
    pub elapsed: Duration,
    pub samples: usize,
}

trait Engine: Sized {
    fn load(path: &Path) -> Result<Self, String>;
    fn speak(
        &mut self,
        text: &str,
        voice: &str,
        sink: &mut dyn FnMut(&[f32]) -> bool,
    ) -> Result<(), String>;
}

impl Engine for runtime::Engine {
    fn load(path: &Path) -> Result<Self, String> {
        download::verify(path)?;
        runtime::load(path)
    }
    fn speak(
        &mut self,
        text: &str,
        voice: &str,
        sink: &mut dyn FnMut(&[f32]) -> bool,
    ) -> Result<(), String> {
        runtime::speak(self, text, voice, sink)
    }
}

struct Loaded<E> {
    directory: PathBuf,
    generation: u64,
    engine: E,
}

struct Cache<E>(Mutex<Option<Loaded<E>>>);

impl<E> Default for Cache<E> {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

impl<E: Engine> Cache<E> {
    fn clear(&self) {
        self.0.lock().take();
    }

    fn synthesize(
        &self,
        model: Model<'_>,
        text: &str,
        is_current: impl Fn() -> bool,
        mut sink: impl FnMut(&[f32]) -> bool,
    ) -> Result<SynthesisReport, String> {
        let mut report = SynthesisReport::default();
        if !is_current() {
            return Ok(report);
        }
        let mut loaded = self.0.lock();
        if !is_current() {
            return Ok(report);
        }
        let started = Instant::now();
        report.cold = loaded.as_ref().is_none_or(|cached| {
            cached.directory != model.directory || cached.generation != model.generation
        });
        if report.cold {
            let engine = match E::load(model.directory) {
                Ok(engine) => engine,
                Err(_) if !is_current() => return Ok(report),
                Err(error) => return Err(error),
            };
            *loaded = Some(Loaded {
                directory: model.directory.into(),
                generation: model.generation,
                engine,
            });
        }
        if !is_current() {
            return Ok(report);
        }
        report.model_load = started.elapsed();
        let engine = &mut loaded.as_mut().ok_or("Phonon failed to load")?.engine;
        let mut cancelled = false;
        let result = engine.speak(text, model.voice, &mut |pcm| {
            // Once a sink declines PCM it must never be called again, even if a
            // runtime emits another buffer while winding down.
            if cancelled {
                return false;
            }
            for chunk in pcm.chunks(PCM_CHUNK_SAMPLES) {
                if !is_current() {
                    cancelled = true;
                    return false;
                }
                report.first_pcm.get_or_insert_with(|| started.elapsed());
                if !sink(chunk) {
                    cancelled = true;
                    return false;
                }
                report.samples += chunk.len();
            }
            true
        });
        // Some runtimes surface their stream abort as an error. Cancellation is
        // a normal outcome and must not trigger a provider fallback.
        if !cancelled && is_current() {
            result?;
            report.completed = true;
        }
        report.elapsed = started.elapsed();
        Ok(report)
    }
}

/// An independent model cache. Calls serialize inference and synchronous sinks;
/// no PCM queue is accumulated here. A slow sink provides backpressure.
#[derive(Default)]
pub struct Synthesizer(Cache<runtime::Engine>);

impl Synthesizer {
    /// Waits for in-flight synthesis, then releases the engine and its files.
    /// Cancel the host lease first. Never hold a settings lock while waiting.
    pub fn clear(&self) {
        self.0.clear();
    }

    /// Uses local artifacts only. `is_current` is checked before/after loading,
    /// after waiting for inference, and before each bounded PCM chunk. Runtime
    /// model compilation itself cannot be preempted. Returning false from the
    /// sink cancels the utterance; borrowed PCM is valid only during that call.
    /// The host is responsible for utterance limits and final native drain.
    pub fn synthesize(
        &self,
        model: Model<'_>,
        text: &str,
        is_current: impl Fn() -> bool,
        sink: impl FnMut(&[f32]) -> bool,
    ) -> Result<SynthesisReport, String> {
        self.0.synthesize(model, text, is_current, sink)
    }
}

#[cfg(test)]
mod tests;
