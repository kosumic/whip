//! Persistent, bounded cache for short announcements in the app's backup-excluded speech directory.
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use crate::speech_backend::PCM_CHUNK_SAMPLES;

const MAX_TEXT_UNITS: usize = 160;
const MAX_ENTRIES: usize = 64;
const CACHE_DIR: &str = "openai-tts-cache";
const ENTRY_EXTENSION: &str = "pcm";
const MAX_PCM_BYTES: usize = 8 * 24_000 * size_of::<f32>();
const DIGEST_BYTES: usize = 32;

pub(crate) struct CachedPhrase {
    directory: PathBuf,
    name: String,
}

impl CachedPhrase {
    pub(crate) fn new(root: &Path, generation: u64, voice: &str, text: &str) -> Option<Self> {
        if text.is_empty() || text.encode_utf16().count() > MAX_TEXT_UNITS {
            return None;
        }
        // Model and voice are validated identifiers. A version change also
        // invalidates clips if we change the PCM format or synthesis options.
        let key = Sha256::digest(format!(
            "tts-v1\0{}\0{generation}\0{voice}\0{text}",
            super::MODEL
        ));
        Some(Self {
            directory: root.join(CACHE_DIR),
            name: format!("{key:x}.{ENTRY_EXTENSION}"),
        })
    }

    fn read(&self) -> Option<Vec<u8>> {
        let mut bytes = Vec::new();
        File::open(self.directory.join(&self.name))
            .ok()?
            .take((MAX_PCM_BYTES + DIGEST_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .ok()?;
        let pcm_len = bytes.len().checked_sub(DIGEST_BYTES)?;
        if pcm_len == 0 || pcm_len > MAX_PCM_BYTES || !pcm_len.is_multiple_of(size_of::<f32>()) {
            return None;
        }
        let (pcm, digest) = bytes.split_at(pcm_len);
        if &Sha256::digest(pcm)[..] != digest {
            return None;
        }
        bytes.truncate(pcm_len);
        Some(bytes)
    }

    fn store(&self, pcm: &[u8]) -> io::Result<()> {
        // Both native platforms serialize TTS generation on one worker.
        fs::create_dir_all(&self.directory)?;
        let temporary = self.directory.join("writing.tmp");
        let mut file = File::create(&temporary)?;
        file.write_all(pcm)?;
        file.write_all(&Sha256::digest(pcm))?;
        drop(file);
        let mut entries = Vec::new();
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == ENTRY_EXTENSION)
                && entry.file_name() != self.name.as_str()
            {
                entries.push((entry.metadata()?.modified()?, path));
            }
        }
        if entries.len() >= MAX_ENTRIES {
            entries.sort_unstable();
            for (_, path) in &entries[..=entries.len() - MAX_ENTRIES] {
                fs::remove_file(path)?;
            }
        }
        fs::rename(temporary, self.directory.join(&self.name))
    }

    pub(crate) fn play(
        &self,
        output: &mut dyn FnMut(&[f32]) -> bool,
        generate: impl FnOnce(&mut dyn FnMut(&[f32]) -> bool) -> Result<bool, String>,
    ) -> Result<bool, String> {
        if let Some(bytes) = self.read() {
            let (samples, _) = bytes.as_chunks::<4>();
            let mut chunk = Vec::with_capacity(PCM_CHUNK_SAMPLES);
            for samples in samples.chunks(PCM_CHUNK_SAMPLES) {
                chunk.clear();
                chunk.extend(samples.iter().copied().map(f32::from_le_bytes));
                if !output(&chunk) {
                    return Ok(false);
                }
            }
            return Ok(true);
        }
        let mut recording = Some(Vec::new());
        let completed = generate(&mut |samples| {
            if !output(samples) {
                return false;
            }
            if let Some(pcm) = &mut recording {
                if std::mem::size_of_val(samples) <= MAX_PCM_BYTES - pcm.len() {
                    pcm.extend(samples.iter().flat_map(|sample| sample.to_le_bytes()));
                } else {
                    recording = None;
                }
            }
            true
        })?;
        if completed && let Some(pcm) = recording.filter(|pcm| !pcm.is_empty()) {
            // Cache storage is best effort. Playback already received all PCM.
            let _ = self.store(&pcm);
        }
        Ok(completed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_phrase_replays_exact_audio_after_reopening_and_can_be_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let entry = || CachedPhrase::new(dir.path(), 0, "marin", "Muted").unwrap();
        let samples = vec![-0.125; PCM_CHUNK_SAMPLES + 7];
        assert!(
            entry()
                .play(&mut |_| true, |out| Ok(out(&samples)))
                .unwrap()
        );
        let mut replay = Vec::new();
        assert!(
            entry()
                .play(
                    &mut |chunk| {
                        assert!(chunk.len() <= PCM_CHUNK_SAMPLES);
                        replay.extend_from_slice(chunk);
                        true
                    },
                    |_| panic!("unexpected synthesis")
                )
                .unwrap()
        );
        assert_eq!(samples, replay);
        assert!(
            !entry()
                .play(&mut |_| false, |_| panic!("unexpected synthesis"))
                .unwrap()
        );
        for (voice, text) in [("cedar", "Muted"), ("marin", "Unmuted")] {
            let changed = CachedPhrase::new(dir.path(), 0, voice, text).unwrap();
            assert!(
                !changed
                    .play(&mut |_| panic!("wrong clip"), |_| Ok(false))
                    .unwrap()
            );
        }
    }

    #[test]
    fn interrupted_failed_and_oversized_audio_are_retried() {
        let dir = tempfile::tempdir().unwrap();
        let entry = CachedPhrase::new(dir.path(), 0, "marin", "Status").unwrap();
        assert!(
            !entry
                .play(&mut |_| true, |out| {
                    out(&[0.1]);
                    Ok(false)
                })
                .unwrap()
        );
        assert!(
            entry
                .play(&mut |_| true, |out| {
                    out(&[0.2]);
                    Err("interrupted".into())
                })
                .is_err()
        );
        let long_clip = vec![0.5; MAX_PCM_BYTES / size_of::<f32>() + 1];
        assert!(
            entry
                .play(&mut |_| true, |out| Ok(out(&long_clip)))
                .unwrap()
        );
        let mut regenerated = Vec::new();
        assert!(
            entry
                .play(
                    &mut |chunk| {
                        regenerated.extend_from_slice(chunk);
                        true
                    },
                    |out| Ok(out(&[0.3]))
                )
                .unwrap()
        );
        assert_eq!(regenerated, [0.3]);
    }

    #[test]
    fn growing_announcement_vocabularies_evict_older_clips() {
        let dir = tempfile::tempdir().unwrap();
        let phrase = |index| {
            CachedPhrase::new(dir.path(), 0, "marin", &format!("Tab {index} finished")).unwrap()
        };
        for i in 0..=MAX_ENTRIES {
            assert!(
                phrase(i)
                    .play(&mut |_| true, |out| Ok(out(&[0.25])))
                    .unwrap()
            );
        }
        let hits = (0..=MAX_ENTRIES)
            .filter(|i| phrase(*i).play(&mut |_| true, |_| Ok(false)).unwrap())
            .count();
        assert_eq!(hits, MAX_ENTRIES);
    }
}
