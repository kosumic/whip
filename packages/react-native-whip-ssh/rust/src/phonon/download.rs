use super::{ARTIFACTS, Artifact, REVISION};
use reqwest::{
    Client, StatusCode,
    header::{CONTENT_RANGE, RANGE},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

pub(super) fn staging(root: &Path) -> PathBuf {
    root.join(format!("{REVISION}.partial"))
}

pub(super) fn partial_bytes(root: &Path) -> u64 {
    ARTIFACTS
        .iter()
        .map(|a| fs::metadata(staging(root).join(a.name)).map_or(0, |m| m.len().min(a.bytes)))
        .sum()
}

fn verify_file(path: &Path, artifact: Artifact) -> Result<(), String> {
    verify_digest(path, artifact.bytes, artifact.sha256)
}

pub(super) fn verify_digest(path: &Path, bytes: u64, sha256: &str) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != bytes {
        return Err("The model download is incomplete. Retry the download.".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 65_536].into_boxed_slice();
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != sha256 {
        return Err("Model checksum mismatch. Retry the download.".into());
    }
    Ok(())
}

pub(super) fn verify(directory: &Path) -> Result<(), String> {
    for &artifact in ARTIFACTS {
        verify_file(&directory.join(artifact.name), artifact)?;
    }
    #[cfg(target_os = "ios")]
    super::bundle::verify(directory)?;
    Ok(())
}

fn resume_offset(
    status: StatusCode,
    range: Option<&str>,
    offset: u64,
    total: u64,
) -> Result<u64, String> {
    if status == StatusCode::OK {
        return Ok(0);
    }
    if status == StatusCode::PARTIAL_CONTENT {
        let expected = format!("bytes {offset}-{}/{total}", total - 1);
        if range == Some(expected.as_str()) {
            return Ok(offset);
        }
    }
    Err("The model server returned an invalid download range; retry the download".into())
}

async fn cancellable<T>(
    future: impl std::future::Future<Output = reqwest::Result<T>>,
    cancel: &AtomicBool,
) -> Result<T, String> {
    let mut future = std::pin::pin!(future);
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("Download cancelled".into());
        }
        if let Ok(result) = tokio::time::timeout(Duration::from_millis(50), future.as_mut()).await {
            return result.map_err(|e| e.to_string());
        }
    }
}

pub(super) fn install(
    root: &Path,
    cancel: &AtomicBool,
    progress: impl Fn(u64),
) -> Result<(), String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(install_async(root, cancel, progress))
}

async fn install_async(
    root: &Path,
    cancel: &AtomicBool,
    progress: impl Fn(u64),
) -> Result<(), String> {
    let directory = staging(root);
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut completed = 0;
    for &artifact in ARTIFACTS {
        if cancel.load(Ordering::Acquire) {
            return Err("Download cancelled".into());
        }
        let path = directory.join(artifact.name);
        #[cfg(not(target_os = "ios"))]
        let url = format!(
            "https://huggingface.co/gradium/phonon-31m-en/resolve/{REVISION}/{}",
            artifact.name
        );
        #[cfg(target_os = "ios")]
        let url = format!(
            "https://github.com/gradium-ai/xn-ptts/releases/download/v0.6.0/{}",
            artifact.name
        );
        fetch(&client, &url, &path, artifact, cancel, |bytes| {
            progress(completed + bytes);
        })
        .await?;
        completed += artifact.bytes;
    }
    if cancel.load(Ordering::Acquire) {
        return Err("Download cancelled".into());
    }
    #[cfg(target_os = "ios")]
    super::bundle::unpack(&directory, cancel)?;
    verify(&directory)?;
    if cancel.load(Ordering::Acquire) {
        return Err("Download cancelled".into());
    }
    let installed = root.join(REVISION);
    if installed.exists() {
        fs::remove_dir_all(&installed).map_err(|e| e.to_string())?;
    }
    fs::rename(directory, installed).map_err(|e| e.to_string())?;
    progress(completed);
    Ok(())
}

async fn fetch(
    client: &Client,
    url: &str,
    path: &Path,
    artifact: Artifact,
    cancel: &AtomicBool,
    progress: impl Fn(u64),
) -> Result<(), String> {
    if verify_file(path, artifact).is_ok() {
        progress(artifact.bytes);
        return Ok(());
    }
    let mut offset = fs::metadata(path).map_or(0, |m| m.len());
    // Complete-but-corrupt files must be redownloaded rather than resumed past EOF.
    if offset >= artifact.bytes {
        fs::remove_file(path).map_err(|e| e.to_string())?;
        offset = 0;
    }
    let mut request = client.get(url);
    if offset > 0 {
        request = request.header(RANGE, format!("bytes={offset}-"));
    }
    let mut response = cancellable(request.send(), cancel)
        .await?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    offset = resume_offset(
        response.status(),
        response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok()),
        offset,
        artifact.bytes,
    )?;
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .append(offset > 0)
        .open(path)
        .map_err(|e| e.to_string())?;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("Download cancelled".into());
        }
        let Some(buffer) = cancellable(response.chunk(), cancel).await? else {
            break;
        };
        if offset + buffer.len() as u64 > artifact.bytes {
            return Err(format!("Oversized model file: {}", artifact.name));
        }
        file.write_all(&buffer).map_err(|e| e.to_string())?;
        offset += buffer.len() as u64;
        progress(offset);
    }
    file.sync_all().map_err(|e| e.to_string())?;
    if let Err(error) = verify_file(path, artifact) {
        fs::remove_file(path).map_err(|e| e.to_string())?;
        return Err(error);
    }
    Ok(())
}

pub(super) fn install_voice(
    root: &Path,
    voice: &'static super::voices::Voice,
    cancel: &AtomicBool,
    progress: impl Fn(u64),
) -> Result<(), String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?
        .block_on(async {
            let partial = super::voices::partial(root, &voice.id);
            fs::create_dir_all(partial.parent().ok_or("Invalid voice path")?)
                .map_err(|error| error.to_string())?;
            let client = Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(10))
                .build()
                .map_err(|error| error.to_string())?;
            let url = format!(
                "https://huggingface.co/gradium/phonon-voices/resolve/{}/{}",
                super::voices::REVISION_ID,
                voice.file
            );
            fetch(
                &client,
                &url,
                &partial,
                super::voices::artifact(voice),
                cancel,
                progress,
            )
            .await?;
            if cancel.load(Ordering::Acquire) {
                return Err("Download cancelled".into());
            }
            let destination = super::voices::path(root, &voice.id);
            fs::create_dir_all(destination.parent().ok_or("Invalid voice path")?)
                .map_err(|error| error.to_string())?;
            fs::rename(partial, destination).map_err(|error| error.to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resume_requires_the_exact_remaining_range_and_restarts_when_ignored() {
        assert_eq!(
            resume_offset(StatusCode::PARTIAL_CONTENT, Some("bytes 5-9/10"), 5, 10),
            Ok(5)
        );
        assert_eq!(resume_offset(StatusCode::OK, None, 5, 10), Ok(0));
        assert!(resume_offset(StatusCode::PARTIAL_CONTENT, Some("bytes 0-9/10"), 5, 10).is_err());
        assert!(resume_offset(StatusCode::PARTIAL_CONTENT, None, 5, 10).is_err());
    }
    #[test]
    fn incomplete_and_corrupt_files_cannot_be_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("artifact");
        let artifact = Artifact {
            name: "artifact",
            bytes: 3,
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        };
        fs::write(&path, b"ab").unwrap();
        assert!(verify_file(&path, artifact).is_err());
        fs::write(&path, b"bad").unwrap();
        assert!(verify_file(&path, artifact).is_err());
        fs::write(&path, b"abc").unwrap();
        assert!(verify_file(&path, artifact).is_ok());
        assert!(verify(dir.path()).is_err());
    }
}
