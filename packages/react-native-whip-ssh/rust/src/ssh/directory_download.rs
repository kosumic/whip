//! Bounded, non-link-following downloads into a newly created local directory.
use super::*;

const MAX_DOWNLOAD_ENTRIES: usize = 100_000;
const MAX_DOWNLOAD_DEPTH: usize = 128;

async fn step<T, E: Into<TransportError>>(
    cancel: &mut watch::Receiver<bool>,
    future: impl Future<Output = Result<T, E>>,
) -> Result<T, TransportError> {
    if *cancel.borrow() {
        return Err(transfer_cancelled("download"));
    }
    tokio::select! {
        biased;
        _ = cancel.changed() => Err(transfer_cancelled("download")),
        result = future => result.map_err(Into::into),
    }
}

pub(super) async fn download(
    sftp: Arc<SftpSession>,
    remote: &str,
    local: &str,
    mut cancel: watch::Receiver<bool>,
    progress: Arc<dyn Fn(u64, Option<u64>) + Send + Sync>,
) -> Result<String, TransportError> {
    if *cancel.borrow() {
        return Err(transfer_cancelled("download"));
    }
    let root = step(&mut cancel, sftp.canonicalize(remote)).await?;
    // Refuse to merge into or replace an existing local tree.
    fs::create_dir(local).await?;
    let result = async {
        let mut pending = vec![(remote.to_owned(), std::path::PathBuf::from(local), 0)];
        let mut visited = 0;
        let mut copied = 0_u64;
        progress(0, None);
        while let Some((remote, local, depth)) = pending.pop() {
            if depth > MAX_DOWNLOAD_DEPTH {
                return Err(TransportError::InvalidRequest(
                    "Directory download exceeds the depth limit".into(),
                ));
            }
            let metadata = step(&mut cancel, sftp.symlink_metadata(&remote)).await?;
            let canonical = step(&mut cancel, sftp.canonicalize(&remote)).await?;
            if !metadata.file_type().is_dir()
                || !(canonical == root || canonical.starts_with(&format!("{root}/")))
            {
                return Err(TransportError::InvalidRequest(format!(
                    "Directory changed or escaped the download root: {remote}"
                )));
            }
            // Read protocol filenames directly. The legacy listing helper adds
            // a display-only slash to directories, unsuitable for local paths.
            let entries = step(&mut cancel, sftp.read_dir(&remote)).await?;
            for entry in entries {
                let filename = entry.file_name();
                if matches!(filename.as_str(), "." | "..") {
                    continue;
                }
                visited += 1;
                if visited > MAX_DOWNLOAD_ENTRIES {
                    return Err(TransportError::InvalidRequest(
                        "Directory download exceeds the entry limit".into(),
                    ));
                }
                crate::remote_ops::validate_remote_filename(&filename)
                    .map_err(TransportError::InvalidRequest)?;
                if *cancel.borrow() {
                    return Err(transfer_cancelled("download"));
                }
                let child_remote = crate::remote_ops::join_remote_path(&remote, &filename)
                    .map_err(TransportError::InvalidRequest)?;
                let child_local = local.join(&filename);
                // Recheck metadata before acting, and never intentionally follow links.
                let metadata = step(&mut cancel, sftp.symlink_metadata(&child_remote)).await?;
                if metadata.file_type().is_dir() {
                    fs::create_dir(&child_local).await?;
                    pending.push((child_remote, child_local, depth + 1));
                } else if metadata.file_type().is_file() {
                    let child_local = child_local.to_str().ok_or_else(|| {
                        TransportError::InvalidRequest("Local path is not UTF-8".into())
                    })?;
                    let mut file_bytes = 0;
                    sftp_transfer_file_on(
                        sftp.clone(),
                        child_local.to_owned(),
                        child_remote,
                        false,
                        cancel.clone(),
                        |bytes, _| {
                            file_bytes = bytes;
                            progress(copied.saturating_add(bytes), None);
                        },
                    )
                    .await?;
                    copied = copied.saturating_add(file_bytes);
                } else {
                    return Err(TransportError::InvalidRequest(format!(
                        "Cannot download symlink or special file: {child_remote}"
                    )));
                }
            }
        }
        if *cancel.borrow() {
            return Err(transfer_cancelled("download"));
        }
        progress(copied, Some(copied));
        Ok(local.to_owned())
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_dir_all(local).await;
    }
    result
}
