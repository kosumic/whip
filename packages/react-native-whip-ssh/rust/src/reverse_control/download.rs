//! Native cache files cross SSH as bytes only; browser credentials never enter Rust.
use super::browser::model::{BrowserError, ErrorCode};
use crate::{remote_ops::normalize_remote_path, ssh::SshSession};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::watch;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeDownload {
    local_path: String,
    bytes: u64,
    mime_type: String,
}

struct CachedFile(PathBuf);
impl Drop for CachedFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
struct CancelUpload(watch::Sender<bool>);
impl Drop for CancelUpload {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}
fn failed() -> BrowserError {
    // Never export native/SSH errors, URLs, cookies, or cache paths.
    BrowserError::new(
        ErrorCode::DownloadFailed,
        "Could not transfer browser download to SSH host",
    )
}

fn cached_download(
    value: Value,
    max_bytes: u32,
) -> Result<(NativeDownload, CachedFile), BrowserError> {
    let result: NativeDownload = serde_json::from_value(value).map_err(|_| failed())?;
    let path = PathBuf::from(&result.local_path);
    if !path.is_absolute()
        || path
            .parent()
            .and_then(std::path::Path::file_name)
            .and_then(std::ffi::OsStr::to_str)
            != Some("whip-browser-downloads")
    {
        return Err(failed());
    }
    let cached = CachedFile(path);
    let metadata = std::fs::symlink_metadata(&cached.0).map_err(|_| failed())?;
    if !metadata.is_file()
        || metadata.len() != result.bytes
        || result.bytes > u64::from(max_bytes)
        || result.mime_type.len() > 256
        || result.mime_type.chars().any(char::is_control)
    {
        return Err(failed());
    }
    Ok((result, cached))
}

pub(super) async fn transfer(
    ssh: Arc<SshSession>,
    value: Value,
    destination: &str,
    max_bytes: u32,
) -> Result<Value, BrowserError> {
    let (result, cached) = cached_download(value, max_bytes)?;
    let home = ssh.remote_home().await.map_err(|_| failed())?;
    let destination = normalize_remote_path(Some(destination), &home).map_err(|_| failed())?;
    let (sender, cancel) = watch::channel(false);
    let cancellation = CancelUpload(sender);
    // A dropped MCP future signals cancellation while this task finishes SFTP's
    // rollback and removes the phone cache file. Do not abort the transfer future.
    let upload_destination = destination.clone();
    let upload = tokio::spawn(async move {
        let _cached = cached;
        ssh.transfer_upload(
            &result.local_path,
            &upload_destination,
            cancel,
            Arc::new(|_, _| {}),
        )
        .await
    });
    upload.await.map_err(|_| failed())?.map_err(|_| failed())?;
    drop(cancellation);
    Ok(
        json!({"destination_path": destination, "bytes": result.bytes, "mime_type": result.mime_type}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staging_validates_size_and_removes_files_on_rejection_or_drop()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let directory = root.path().join("whip-browser-downloads");
        std::fs::create_dir(&directory)?;
        let path = directory.join("report");
        for (reported, maximum, accepted) in [(4, 4, true), (5, 4, false), (4, 3, false)] {
            std::fs::write(&path, [0, 1, 255, 10])?;
            let value = json!({"local_path":path,"bytes":reported,"mime_type":"application/pdf"});
            let result = cached_download(value, maximum);
            assert_eq!(result.is_ok(), accepted);
            drop(result);
            assert!(!path.exists());
        }
        let external = root.path().join("external");
        std::fs::write(&external, "keep")?;
        assert!(
            cached_download(
                json!({"local_path":external,"bytes":4,"mime_type":"text/csv"}),
                4
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&external)?, b"keep");
        Ok(())
    }

    #[test]
    fn upload_cancellation_is_signalled_when_the_mcp_future_drops() {
        let (sender, receiver) = watch::channel(false);
        let guard = CancelUpload(sender);
        assert!(!*receiver.borrow());
        drop(guard);
        assert!(*receiver.borrow());
    }
}
