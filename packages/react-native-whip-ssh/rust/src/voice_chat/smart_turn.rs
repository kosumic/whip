//! Whisper-compatible features following GymAmi's Smart Turn implementation.
//! Reference: kosumic/gymami, 41f1ccffd480571eb81212f4a289cb2a7e07b39c.
use rustfft::{Fft, FftPlanner, num_complex::Complex};
use std::{path::Path, sync::Arc};
use tract_onnx::prelude::*;

pub(super) const AUDIO_SAMPLES: usize = 8 * 16_000;
const FRAMES: usize = 800;
const MELS: usize = 80;
const FFT: usize = 400;
const HOP: usize = 160;

pub(super) struct SmartTurn {
    model: Arc<TypedRunnableModel>,
    features: Features,
}
impl SmartTurn {
    pub(super) fn load(path: &Path) -> Result<Self, String> {
        let model = tract_onnx::onnx()
            .with_ignore_value_info(true)
            .with_ignore_output_shapes(true)
            .model_for_path(path)
            .and_then(|m| m.with_input_fact(0, f32::fact([1, MELS, FRAMES]).into()))
            .and_then(InferenceModelExt::into_optimized)
            .and_then(IntoRunnable::into_runnable)
            .map_err(|error| format!("Cannot load Smart Turn: {error:#}"))?;
        Ok(Self {
            model,
            features: Features::new(),
        })
    }
    pub(super) fn predict(&mut self, audio: &[f32]) -> Result<f32, String> {
        let features = self.features.extract(audio);
        let input =
            Tensor::from_shape(&[1, MELS, FRAMES], &features).map_err(|error| error.to_string())?;
        let output = self
            .model
            .run(tvec!(input.into()))
            .map_err(|error| format!("Smart Turn failed: {error}"))?;
        let probability = output
            .first()
            .ok_or("Missing Smart Turn output")?
            .to_plain_array_view::<f32>()
            .map_err(|error| error.to_string())?
            .iter()
            .next()
            .copied()
            .ok_or("Empty Smart Turn output")?;
        if !probability.is_finite() || !(0.0..=1.0).contains(&probability) {
            return Err("Invalid Smart Turn probability".into());
        }
        Ok(probability)
    }
}

/// Matches WhisperFeatureExtractor(chunk_length=8, do_normalize=True): left
/// pad the waveform, normalize, centered reflect STFT, Slaney-normalized mel
/// filters, log10, dynamic range clipping, then (log_mel + 4) / 4.
struct Features {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    filters: Vec<Vec<f32>>,
    audio: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
}

#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "Whisper uses bounded indices and deliberately rounds double-precision preprocessing to f32"
)]
impl Features {
    fn new() -> Self {
        let fft = FftPlanner::new().plan_fft_forward(FFT);
        let scratch = vec![Complex::default(); fft.get_inplace_scratch_len()];
        let to_mel = |hz: f64| {
            if hz < 1000. {
                hz / (200. / 3.)
            } else {
                15. + (hz / 1000.).ln() / (6.4_f64.ln() / 27.)
            }
        };
        let to_hz = |mel: f64| {
            if mel < 15. {
                mel * (200. / 3.)
            } else {
                1000. * ((mel - 15.) * (6.4_f64.ln() / 27.)).exp()
            }
        };
        let points: Vec<f64> = (0..MELS + 2)
            .map(|i| to_hz(to_mel(8000.) * i as f64 / (MELS + 1) as f64))
            .collect();
        let filters = (0..MELS)
            .map(|mel| {
                (0..=FFT / 2)
                    .map(|bin| {
                        let frequency = bin as f64 * 16_000. / FFT as f64;
                        let lower = (frequency - points[mel]) / (points[mel + 1] - points[mel]);
                        let upper =
                            (points[mel + 2] - frequency) / (points[mel + 2] - points[mel + 1]);
                        (lower.min(upper).max(0.) * 2. / (points[mel + 2] - points[mel])) as f32
                    })
                    .collect()
            })
            .collect();
        Self {
            fft,
            scratch,
            window: (0..FFT)
                .map(|i| {
                    (0.5 - 0.5 * (2. * std::f64::consts::PI * i as f64 / FFT as f64).cos()) as f32
                })
                .collect(),
            filters,
            audio: vec![0.; AUDIO_SAMPLES],
            spectrum: vec![Complex::default(); FFT],
        }
    }
    fn extract(&mut self, input: &[f32]) -> Vec<f32> {
        self.audio.fill(0.);
        let count = input.len().min(AUDIO_SAMPLES);
        self.audio[AUDIO_SAMPLES - count..].copy_from_slice(&input[input.len() - count..]);
        let mean = self.audio.iter().map(|x| f64::from(*x)).sum::<f64>() / AUDIO_SAMPLES as f64;
        let variance = self
            .audio
            .iter()
            .map(|x| (f64::from(*x) - mean).powi(2))
            .sum::<f64>()
            / AUDIO_SAMPLES as f64;
        let scale = (variance + 1e-7).sqrt();
        for sample in &mut self.audio {
            *sample = ((f64::from(*sample) - mean) / scale) as f32;
        }
        let mut output = vec![0_f32; MELS * FRAMES];
        let mut maximum = f32::NEG_INFINITY;
        for frame in 0..FRAMES {
            for i in 0..FFT {
                let position = (frame * HOP + i).cast_signed() - (FFT / 2).cast_signed();
                let index = if position < 0 {
                    (-position).cast_unsigned()
                } else if position >= AUDIO_SAMPLES.cast_signed() {
                    2 * AUDIO_SAMPLES - position.cast_unsigned() - 2
                } else {
                    position.cast_unsigned()
                };
                self.spectrum[i] = Complex::new(self.audio[index] * self.window[i], 0.);
            }
            self.fft
                .process_with_scratch(&mut self.spectrum, &mut self.scratch);
            for mel in 0..MELS {
                let power = self.filters[mel]
                    .iter()
                    .zip(&self.spectrum)
                    .map(|(filter, bin)| filter * bin.norm_sqr())
                    .sum::<f32>();
                let log = power.max(1e-10).log10();
                maximum = maximum.max(log);
                output[mel * FRAMES + frame] = log;
            }
        }
        for feature in &mut output {
            *feature = (feature.max(maximum - 8.) + 4.) / 4.;
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reference_audio() -> Vec<f32> {
        include_bytes!("../../tests/fixtures/voice-counting-16k.f32")
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect()
    }
    #[test]
    fn whisper_features_match_the_upstream_reference() {
        let features = Features::new().extract(&reference_audio());
        for (index, expected) in [
            (599, 0.745_229_96),
            (630, 0.864_995),
            (680, 1.108_921_8),
            (8639, 0.653_498_5),
            (32639, 0.693_099_5),
            (40639, 0.422_263_38),
            (63839, 0.072_821_68),
        ] {
            assert!(
                (features[index] - expected).abs() < 5e-5,
                "feature {index}: {}",
                features[index]
            );
        }
    }
    #[test]
    #[ignore = "Set WHIP_SMART_TURN_MODEL to the verified FP32 model file"]
    fn smart_turn_matches_the_upstream_completion_probability() {
        let path = std::env::var("WHIP_SMART_TURN_MODEL").unwrap();
        let probability = SmartTurn::load(Path::new(&path))
            .unwrap()
            .predict(&reference_audio())
            .unwrap();
        assert!((probability - 0.990_348_7).abs() < 1e-4, "{probability}");
    }
}
