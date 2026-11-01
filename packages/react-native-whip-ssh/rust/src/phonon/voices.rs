//! Public English voice catalog, pinned independently from the model checkpoint.
use super::{Artifact, DEFAULT_VOICE, REVISION, download};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::LazyLock,
};

pub(super) const REVISION_ID: &str = "0ee17205f254b5abc43b266c8a0f215565c352f7";

#[derive(Deserialize)]
pub(super) struct Voice {
    pub id: String,
    pub name: String,
    pub locale: String,
    pub description: String,
    pub file: String,
    pub bytes: u64,
    pub sha256: String,
}

pub(super) static CATALOG: LazyLock<Vec<Voice>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("voices.json")).unwrap_or_else(|error| {
        eprintln!("[Phonon] Could not read the bundled voice catalog: {error}");
        Vec::new()
    })
});

pub(super) fn find(id: &str) -> Result<&'static Voice, String> {
    CATALOG
        .iter()
        .find(|v| v.id == id)
        .ok_or_else(|| "Unknown Phonon voice".into())
}

pub(super) fn path(root: &Path, id: &str) -> PathBuf {
    root.join(REVISION)
        .join(if cfg!(target_os = "ios") {
            "Models/voices"
        } else {
            "voices"
        })
        .join(format!("{id}.safetensors"))
}

pub(super) fn partial(root: &Path, id: &str) -> PathBuf {
    root.join("voice-downloads").join(format!("{id}.partial"))
}

pub(super) fn artifact(voice: &'static Voice) -> Artifact {
    Artifact {
        name: &voice.file,
        bytes: voice.bytes,
        sha256: &voice.sha256,
    }
}

pub(super) fn installed(root: &Path, id: &str) -> bool {
    id == DEFAULT_VOICE
        || find(id).is_ok_and(|voice| {
            download::verify_digest(&path(root, id), voice.bytes, &voice.sha256).is_ok()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_verified_catalog_voices_are_selectable_offline() {
        let root = tempfile::tempdir().unwrap();
        let voice = &CATALOG[0];
        assert!(installed(root.path(), DEFAULT_VOICE));
        assert!(!installed(root.path(), &voice.id));
        assert!(find("../../outside").is_err());
        let path = path(root.path(), &voice.id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"incomplete").unwrap();
        assert!(!installed(root.path(), &voice.id));
    }
}
