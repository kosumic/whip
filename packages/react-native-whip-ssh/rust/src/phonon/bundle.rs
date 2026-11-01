//! Read only the model files and one voice from the verified official archive.
//! The archive's pinned digest authenticates bundle.json and each file digest.
use super::{ARTIFACTS, download::verify_digest};
use serde::Deserialize;
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use zip::ZipArchive;

#[derive(Deserialize)]
struct Bundle {
    files: Vec<File>,
}
#[derive(Deserialize)]
struct File {
    path: String,
    size: u64,
    sha256: String,
}

fn safe(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
}

fn default_voice(files: &[File]) -> Result<&File, String> {
    files
        .iter()
        .filter(|file| file.path.starts_with("voices/") && file.path.ends_with(".safetensors"))
        .min_by_key(|file| (!file.path.ends_with("/default.safetensors"), &file.path))
        .ok_or_else(|| "Core ML bundle has no voice".into())
}

pub(super) fn default_voice_name(directory: &Path) -> Result<String, String> {
    let bytes =
        fs::read(directory.join("Models/bundle.json")).map_err(|error| error.to_string())?;
    let bundle: Bundle = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    Path::new(&default_voice(&bundle.files)?.path)
        .file_stem()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or_else(|| "Invalid default voice".into())
}

fn manifest(archive: &mut ZipArchive<fs::File>) -> Result<(PathBuf, Vec<u8>, Vec<File>), String> {
    let name = archive
        .file_names()
        .find(|name| {
            Path::new(name)
                .file_name()
                .is_some_and(|n| n == "bundle.json")
        })
        .ok_or("Core ML archive has no manifest")?
        .to_owned();
    if !safe(&name) {
        return Err("Invalid Core ML archive path".into());
    }
    let mut bytes = Vec::new();
    archive
        .by_name(&name)
        .map_err(|e| e.to_string())?
        .take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1_048_576 {
        return Err("Core ML manifest is too large".into());
    }
    let mut bundle: Bundle = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if bundle.files.len() > 512
        || bundle
            .files
            .iter()
            .any(|f| !safe(&f.path) || f.size > 512_000_000)
    {
        return Err("Invalid Core ML model manifest".into());
    }
    let voice = default_voice(&bundle.files)?.path.clone();
    bundle
        .files
        .retain(|f| !f.path.starts_with("voices/") || f.path == voice);
    Ok((
        Path::new(&name).parent().unwrap_or(Path::new("")).into(),
        bytes,
        bundle.files,
    ))
}

pub(super) fn verify(directory: &Path) -> Result<(), String> {
    let mut archive = ZipArchive::new(
        fs::File::open(directory.join(ARTIFACTS[0].name)).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let (_, bytes, files) = manifest(&mut archive)?;
    let model = directory.join("Models");
    if fs::read(model.join("bundle.json")).map_err(|e| e.to_string())? != bytes {
        return Err("Core ML manifest changed".into());
    }
    for file in files {
        verify_digest(&model.join(file.path), file.size, &file.sha256)?;
    }
    Ok(())
}

pub(super) fn unpack(directory: &Path, cancel: &AtomicBool) -> Result<(), String> {
    let mut archive = ZipArchive::new(
        fs::File::open(directory.join(ARTIFACTS[0].name)).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let (prefix, bytes, files) = manifest(&mut archive)?;
    let model = directory.join("Models");
    fs::create_dir_all(&model).map_err(|e| e.to_string())?;
    for file in files {
        if cancel.load(Ordering::Acquire) {
            return Err("Download cancelled".into());
        }
        let destination = model.join(&file.path);
        if verify_digest(&destination, file.size, &file.sha256).is_ok() {
            continue;
        }
        let name = prefix.join(&file.path);
        let mut input = archive
            .by_name(name.to_str().ok_or("Invalid archive path")?)
            .map_err(|e| e.to_string())?;
        if input.size() != file.size
            || input
                .unix_mode()
                .is_some_and(|mode| mode & 0o170_000 == 0o120_000)
        {
            return Err("Invalid Core ML archive entry".into());
        }
        fs::create_dir_all(destination.parent().ok_or("Invalid model path")?)
            .map_err(|e| e.to_string())?;
        let mut output = fs::File::create(&destination).map_err(|e| e.to_string())?;
        let mut buffer = vec![0u8; 65_536].into_boxed_slice();
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err("Download cancelled".into());
            }
            let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            output
                .write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
        }
        output.sync_all().map_err(|e| e.to_string())?;
        verify_digest(&destination, file.size, &file.sha256)?;
    }
    fs::write(model.join("bundle.json"), bytes).map_err(|e| e.to_string())?;
    Ok(())
}
