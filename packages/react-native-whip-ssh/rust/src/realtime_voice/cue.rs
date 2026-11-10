//! Local cues share device output and its echo reference, but not speech accounting.
use std::io::Read;

const MAX_SECONDS: usize = 5;
const MAX_FILE_BYTES: usize = super::RATE * 2 * MAX_SECONDS + 4096;
const INVALID: &str = "The bundled voice cue is not PCM16 mono at the call sample rate.";

#[derive(Default)]
pub(super) struct Cue {
    generation: u64,
    pending: bool,
    samples: Vec<i16>,
    offset: usize,
}

impl Cue {
    pub fn begin(&mut self) -> u64 {
        let Some(generation) = self.generation.checked_add(1) else {
            return 0;
        };
        self.generation = generation;
        self.pending = true;
        self.samples.clear();
        self.offset = 0;
        generation
    }
    pub fn load(&mut self, generation: u64, samples: Vec<i16>) -> bool {
        if !self.playing(generation) || !self.samples.is_empty() || samples.is_empty() {
            return false;
        }
        self.samples = samples;
        true
    }
    pub fn playing(&self, generation: u64) -> bool {
        self.generation == generation && self.pending
    }
    pub fn stop(&mut self, generation: u64) {
        if self.generation == generation {
            self.clear();
        }
    }
    pub fn clear(&mut self) {
        self.pending = false;
        self.samples.clear();
        self.offset = 0;
    }
    pub fn mix(&mut self, output: &mut [i16]) {
        if !self.pending || self.samples.is_empty() {
            return;
        }
        let count = output.len().min(self.samples.len() - self.offset);
        for (output, cue) in output[..count]
            .iter_mut()
            .zip(&self.samples[self.offset..][..count])
        {
            // Match the existing cue player's half-volume setting. Saturation
            // preserves simultaneous speech without wrapping PCM amplitudes.
            *output = output.saturating_add(cue / 2);
        }
        self.offset += count;
        if self.offset == self.samples.len() {
            self.clear();
        }
    }
}

pub(super) fn load(path: &str) -> Result<Vec<i16>, &'static str> {
    let mut bytes = Vec::new();
    let file = std::fs::File::open(path).map_err(|_| INVALID)?;
    if !file.metadata().map_err(|_| INVALID)?.is_file() {
        return Err(INVALID);
    }
    file.take(u64::try_from(MAX_FILE_BYTES + 1).map_err(|_| INVALID)?)
        .read_to_end(&mut bytes)
        .map_err(|_| INVALID)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(INVALID);
    }
    decode(&bytes)
}

fn decode(bytes: &[u8]) -> Result<Vec<i16>, &'static str> {
    if bytes.get(..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return Err(INVALID);
    }
    let number = |bytes: &[u8]| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    let mut offset = 12_usize;
    let mut format = false;
    let mut data = None;
    while let Some(header) = bytes.get(offset..offset + 8) {
        let length = usize::try_from(number(&header[4..])).map_err(|_| INVALID)?;
        let start = offset + 8;
        let end = start.checked_add(length).ok_or(INVALID)?;
        let chunk = bytes.get(start..end).ok_or(INVALID)?;
        match &header[..4] {
            b"fmt " => {
                format = chunk.len() >= 16
                    && chunk[..4] == [1, 0, 1, 0]
                    && usize::try_from(number(&chunk[4..8])).ok() == Some(super::RATE)
                    && chunk[12..16] == [2, 0, 16, 0];
            }
            b"data" if data.is_none() => data = Some(chunk),
            _ => {}
        }
        offset = end.checked_add(length % 2).ok_or(INVALID)?;
    }
    let data = data
        .filter(|data| {
            !data.is_empty()
                && data.len().is_multiple_of(2)
                && data.len() <= super::RATE * 2 * MAX_SECONDS
        })
        .ok_or(INVALID)?;
    if !format {
        return Err(INVALID);
    }
    Ok(data
        .as_chunks::<2>()
        .0
        .iter()
        .copied()
        .map(i16::from_le_bytes)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixing_preserves_speech_clips_safely_and_finishes_at_the_sample_boundary() {
        let mut cue = Cue::default();
        let generation = cue.begin();
        assert!(cue.load(generation, vec![2000, 1000, -2000]));
        let mut speech = [32000, 20];
        cue.mix(&mut speech);
        assert_eq!(speech, [i16::MAX, 520]);
        assert!(cue.playing(generation));
        let mut tail = [100, 200];
        cue.mix(&mut tail);
        assert_eq!(tail, [-900, 200]);
        assert!(!cue.playing(generation));
    }

    #[test]
    fn cancelling_loading_or_old_cues_cannot_affect_a_replacement() {
        let mut cue = Cue::default();
        let old = cue.begin();
        cue.stop(old);
        assert!(!cue.load(old, vec![1000]));
        let current = cue.begin();
        assert!(!cue.load(old, vec![1000]));
        cue.stop(old);
        assert!(cue.load(current, vec![2000]));
        let mut output = [0];
        cue.mix(&mut output);
        assert_eq!(output, [1000]);
    }

    #[test]
    fn bundled_cue_decodes_with_the_native_device_format() -> Result<(), &'static str> {
        let bytes = include_bytes!("../../../../../assets/audio/voice-ready.wav");
        let samples = decode(bytes)?;
        assert!(samples.len() > super::super::FRAME);
        assert!(samples.iter().any(|sample| sample.unsigned_abs() > 64));
        assert!(decode(&bytes[..bytes.len() / 2]).is_err());
        Ok(())
    }
}
