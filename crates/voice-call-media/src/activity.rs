//! Diagnostic speech activity on processed PCM; never gates microphone audio.
use crate::processing::Converter;
use std::time::{Duration, Instant};

const VAD_RATE: u32 = 16_000;
const VAD_FRAME: usize = 256;
const CONFIDENCE: f32 = 0.8;

pub struct Detector {
    converter: Converter,
    vad: Box<earshot::Detector>,
}
impl Detector {
    pub fn new() -> Result<Self, &'static str> {
        Ok(Self {
            converter: Converter::new(crate::RATE as u32, VAD_RATE)?,
            vad: earshot::Detector::default_boxed(),
        })
    }
    pub fn reset(&mut self) {
        self.converter.reset();
        self.vad.reset();
    }
    /// Duration of high-confidence speech, using the embedded detector used by
    /// local calls at its required 16 kHz rate. No audio is retained for logs.
    pub fn observe(&mut self, samples: &[i16], at: Instant) -> Result<Duration, &'static str> {
        let samples: Vec<_> = samples.iter().map(|&v| f32::from(v) / 32768.0).collect();
        self.converter.push(at, &samples)?;
        let mut voiced = 0;
        while let Some((_, frame)) = self.converter.next::<VAD_FRAME>() {
            if self.vad.predict_f32(&frame) >= CONFIDENCE {
                voiced += VAD_FRAME;
            }
        }
        Ok(Duration::from_secs_f64(voiced as f64 / f64::from(VAD_RATE)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn silence_is_not_speech_across_native_batch_boundaries() -> Result<(), &'static str> {
        let mut detector = Detector::new()?;
        let at = Instant::now();
        for frame in 0..100 {
            assert_eq!(
                detector.observe(&[0; crate::FRAME], at + Duration::from_millis(frame * 20))?,
                Duration::ZERO
            );
        }
        Ok(())
    }
}
