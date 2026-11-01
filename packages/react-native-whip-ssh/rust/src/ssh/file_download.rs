//! Retain a private partial file only while bounded, cancellable recovery runs.
use std::future::Future;
use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::watch;

use super::{
    NEXT_TEMP_ID, TRANSFER_BUFFER_BYTES as BUFFER_BYTES, TRANSFER_PROGRESS_BYTES as PROGRESS_BYTES,
    TRANSFER_PROGRESS_INTERVAL, TransportError, transfer_cancelled, wait_for_transfer_cancel,
};

const MAX_ATTEMPTS: u32 = 4;
const IO_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
enum Failure {
    Retry(&'static str),
    Stop(TransportError),
}

fn failure(category: &str) -> TransportError {
    TransportError::InvalidRequest(format!("SFTP download: {category}"))
}

// Drop also handles a future being aborted. A process exit can leave the private
// staging directory behind; the app expires those directories before transfers.
struct PartialFile(PathBuf);

impl Drop for PartialFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    size: u64,
    modified: Option<u32>,
}

impl Identity {
    fn read(metadata: &FileAttributes) -> Result<Self, Failure> {
        if !metadata.file_type().is_file() {
            return Err(Failure::Stop(failure("source is no longer a regular file")));
        }
        Ok(Self {
            size: metadata.size.ok_or_else(|| {
                Failure::Stop(failure(
                    "source size is unavailable; cannot verify download",
                ))
            })?,
            modified: metadata.mtime,
        })
    }
}

async fn remote<T, E: Into<TransportError>>(
    cancel: &mut watch::Receiver<bool>,
    category: &'static str,
    future: impl Future<Output = Result<T, E>>,
) -> Result<T, Failure> {
    tokio::select! {
        biased;
        () = wait_for_transfer_cancel(cancel) => {
            Err(Failure::Stop(transfer_cancelled("download")))
        }
        result = tokio::time::timeout(IO_TIMEOUT, future) => {
            result.map_err(|_| Failure::Retry("remote operation timed out"))?
                .map_err(|error| match error.into() {
                    TransportError::Sftp(russh_sftp::client::error::Error::Status(status))
                        if status.status_code == russh_sftp::protocol::StatusCode::PermissionDenied =>
                    {
                        Failure::Stop(failure("source access denied; check remote permissions"))
                    }
                    TransportError::Sftp(russh_sftp::client::error::Error::Status(status))
                        if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
                    {
                        Failure::Stop(failure("source no longer exists; refresh the remote directory"))
                    }
                    _ => Failure::Retry(category),
                })
        }
    }
}

fn local(error: std::io::Error) -> TransportError {
    let category = if error.kind() == std::io::ErrorKind::StorageFull {
        "local storage is full; free space and retry"
    } else {
        "local staging write failed; check available storage and retry"
    };
    failure(category)
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Self::Stop(local(error))
    }
}

struct Download {
    file: fs::File,
    identity: Option<Identity>,
    copied: u64,
}

impl Download {
    async fn attempt(
        &mut self,
        sftp: &SftpSession,
        path: &str,
        cancel: &mut watch::Receiver<bool>,
        progress: &mut (impl FnMut(u64, Option<u64>) + Send),
    ) -> Result<(), Failure> {
        let mut source = remote(cancel, "source could not be opened", sftp.open(path)).await?;
        let identity = Identity::read(
            &remote(cancel, "source metadata unavailable", source.metadata()).await?,
        )?;
        if self.identity != Some(identity) || identity.modified.is_none() {
            self.file.set_len(0).await.map_err(Failure::from)?;
            self.copied = 0;
        }
        self.identity = Some(identity);
        self.file
            .seek(SeekFrom::Start(self.copied))
            .await
            .map_err(Failure::from)?;
        remote(
            cancel,
            "remote seek failed",
            source.seek(SeekFrom::Start(self.copied)),
        )
        .await?;
        progress(self.copied, Some(identity.size));
        let mut buffer = vec![0; BUFFER_BYTES];
        let mut reported = self.copied;
        let mut last_report = Instant::now();
        loop {
            let count = remote(cancel, "remote read interrupted", source.read(&mut buffer)).await?;
            if count == 0 {
                if self.copied != identity.size {
                    return Err(Failure::Retry("source ended before its advertised size"));
                }
                break;
            }
            if self.copied.saturating_add(count as u64) > identity.size {
                self.identity = None;
                return Err(Failure::Retry("source grew during download"));
            }
            self.file
                .write_all(&buffer[..count])
                .await
                .map_err(Failure::from)?;
            self.copied += count as u64;
            if self.copied - reported >= PROGRESS_BYTES
                || last_report.elapsed() >= TRANSFER_PROGRESS_INTERVAL
            {
                progress(self.copied, Some(identity.size));
                reported = self.copied;
                last_report = Instant::now();
            }
        }
        let handle_identity = Identity::read(
            &remote(cancel, "source verification interrupted", source.metadata()).await?,
        )?;
        let path_identity = Identity::read(
            &remote(
                cancel,
                "source verification interrupted",
                sftp.metadata(path),
            )
            .await?,
        )?;
        if identity != handle_identity || identity != path_identity {
            self.identity = None;
            return Err(Failure::Retry("source changed during download"));
        }
        self.file.flush().await.map_err(Failure::from)?;
        self.file.sync_data().await.map_err(Failure::from)?;
        if self.file.metadata().await.map_err(Failure::from)?.len() != identity.size {
            return Err(Failure::Stop(failure(
                "local staging file changed or was truncated",
            )));
        }
        progress(self.copied, Some(identity.size));
        Ok(())
    }
}

pub(crate) async fn download<F, Fut>(
    local_path: String,
    remote_path: String,
    transfer_id: &str,
    mut cancel: watch::Receiver<bool>,
    mut progress: impl FnMut(u64, Option<u64>) + Send,
    mut connection: F,
) -> Result<String, TransportError>
where
    F: FnMut() -> Fut + Send,
    Fut: Future<Output = Result<Arc<SftpSession>, TransportError>> + Send,
{
    if *cancel.borrow() {
        return Err(transfer_cancelled("download"));
    }
    let partial_path = PathBuf::from(format!(
        "{local_path}.whip-download-{}",
        NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial_path)
        .await
        .map_err(|error| {
            let error = local(error);
            crate::host_runtime::diagnostics::log_lifecycle(format_args!(
                "SFTP download id={transfer_id} phase=staging error={error}"
            ));
            error
        })?;
    let partial = PartialFile(partial_path);
    let mut download = Download {
        file,
        identity: None,
        copied: 0,
    };
    for attempt in 1..=MAX_ATTEMPTS {
        let result = match remote(&mut cancel, "SSH reconnect unavailable", connection()).await {
            Ok(sftp) => {
                download
                    .attempt(&sftp, &remote_path, &mut cancel, &mut progress)
                    .await
            }
            Err(error) => Err(error),
        };
        // Only identifiers, phases, byte counts and metadata enter diagnostics.
        // Server errors can contain private remote paths, so never log them.
        let phase = match &result {
            Ok(()) => "verified".to_owned(),
            Err(Failure::Retry(category)) => (*category).to_owned(),
            // Stop errors are constructed above from sanitized categories,
            // never from server-supplied strings or filesystem paths.
            Err(Failure::Stop(error)) => error.to_string(),
        };
        crate::host_runtime::diagnostics::log_lifecycle(format_args!(
            "SFTP download id={transfer_id} attempt={attempt}/{MAX_ATTEMPTS} phase={phase} bytes={} total={:?} mtime={:?}",
            download.copied,
            download.identity.map(|identity| identity.size),
            download.identity.and_then(|identity| identity.modified)
        ));
        match result {
            Ok(()) => {
                if *cancel.borrow() {
                    return Err(transfer_cancelled("download"));
                }
                // Preserve the exact-path API's atomic replacement behavior.
                // User-selected destinations are protected separately by Expo's
                // non-overwriting copy from this private, verified staging tree.
                fs::rename(&partial.0, &local_path).await.map_err(|_| {
                    failure("local publication failed; check staging storage and retry")
                })?;
                return Ok(local_path);
            }
            Err(Failure::Stop(error)) => return Err(error),
            Err(Failure::Retry(category)) if attempt == MAX_ATTEMPTS => {
                return Err(failure(&format!(
                    "{category} after {MAX_ATTEMPTS} attempts; check the connection and source, then retry"
                )));
            }
            Err(Failure::Retry(_)) => {
                tokio::select! {
                    biased;
                    () = wait_for_transfer_cancel(&mut cancel) => return Err(transfer_cancelled("download")),
                    () = tokio::time::sleep(Duration::from_millis(250 * u64::from(attempt))) => {}
                }
            }
        }
    }
    unreachable!("bounded download loop always returns")
}

#[cfg(test)]
mod tests;
