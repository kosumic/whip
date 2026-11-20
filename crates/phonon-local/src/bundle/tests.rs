use super::*;
use std::io::Write;
use zip::{ZipWriter, write::SimpleFileOptions};

const DIGEST: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

fn archive(root: &Path, file_path: &str, body: &[u8], declared: u64) {
    let file = fs::File::create(root.join(COREML_ARTIFACT.name)).unwrap();
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    zip.start_file("bundle/Models/bundle.json", options)
        .unwrap();
    let manifest = serde_json::json!({ "files": [
        { "path": file_path, "size": declared, "sha256": DIGEST },
        { "path": "voices/default.safetensors", "size": 3, "sha256": DIGEST },
        { "path": "voices/optional.safetensors", "size": 3, "sha256": DIGEST }
    ]});
    zip.write_all(manifest.to_string().as_bytes()).unwrap();
    zip.start_file(format!("bundle/Models/{file_path}"), options)
        .unwrap();
    zip.write_all(body).unwrap();
    zip.start_file("bundle/Models/voices/default.safetensors", options)
        .unwrap();
    zip.write_all(b"abc").unwrap();
    // The optional voice is deliberately absent: only the default is extracted.
    zip.finish().unwrap();
}

#[test]
fn extracts_and_verifies_models_and_only_the_default_voice() {
    let root = tempfile::tempdir().unwrap();
    archive(root.path(), "decoder.mlmodelc/data", b"abc", 3);
    unpack(root.path(), &AtomicBool::new(false)).unwrap();
    verify(root.path()).unwrap();
    assert_eq!(default_voice_name(root.path()).unwrap(), "default");
    assert!(
        root.path()
            .join("Models/voices/default.safetensors")
            .exists()
    );
    assert!(
        !root
            .path()
            .join("Models/voices/optional.safetensors")
            .exists()
    );
    fs::write(root.path().join("Models/decoder.mlmodelc/data"), b"bad").unwrap();
    assert!(verify(root.path()).is_err());
    unpack(root.path(), &AtomicBool::new(false)).unwrap();
    verify(root.path()).unwrap();
    fs::write(root.path().join("Models/bundle.json"), b"{}").unwrap();
    assert!(verify(root.path()).is_err());
}

#[test]
fn rejects_traversal_size_mismatch_and_cancellation() {
    for (path, body, size) in [
        ("../outside", b"abc".as_slice(), 3),
        ("/absolute", b"abc".as_slice(), 3),
        ("decoder/data", b"abc".as_slice(), 4),
        ("decoder/data", b"bad".as_slice(), 3),
    ] {
        let root = tempfile::tempdir().unwrap();
        archive(root.path(), path, body, size);
        assert!(unpack(root.path(), &AtomicBool::new(false)).is_err());
    }
    let root = tempfile::tempdir().unwrap();
    archive(root.path(), "decoder/data", b"abc", 3);
    assert!(unpack(root.path(), &AtomicBool::new(true)).is_err());
    assert!(!root.path().join("Models/bundle.json").exists());
}

#[test]
fn rejects_symbolic_links_in_archive_entries() {
    let root = tempfile::tempdir().unwrap();
    let file = fs::File::create(root.path().join(COREML_ARTIFACT.name)).unwrap();
    let mut zip = ZipWriter::new(file);
    zip.start_file("bundle.json", SimpleFileOptions::default())
        .unwrap();
    let manifest = serde_json::json!({"files": [
        {"path": "voices/default.safetensors", "size": 3, "sha256": DIGEST}
    ]});
    zip.write_all(manifest.to_string().as_bytes()).unwrap();
    zip.add_symlink(
        "voices/default.safetensors",
        "abc",
        SimpleFileOptions::default(),
    )
    .unwrap();
    zip.finish().unwrap();
    assert!(unpack(root.path(), &AtomicBool::new(false)).is_err());
}
