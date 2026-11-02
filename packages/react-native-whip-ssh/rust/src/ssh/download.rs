//! Bounded single-file recovery. Only verified bytes reach the final pathname.
use crate::remote_ops::{DownloadDiagnostic, DownloadErrorCategory, DownloadPhase};
use russh_sftp::{
    client::{SftpSession, error::Error as SftpError},
    protocol::StatusCode,
};
use std::{fmt, future::Future, io::SeekFrom, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::watch,
};

pub(crate) const MAX_ATTEMPTS: u32 = 3;
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const BUFFER_BYTES: usize = 64 * 1024;
const REPORT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Failure {
    pub phase: DownloadPhase,
    pub category: DownloadErrorCategory,
}
impl Failure {
    pub(crate) fn new(phase: DownloadPhase, category: DownloadErrorCategory) -> Self {
        Self { phase, category }
    }
    fn retryable(self) -> bool {
        !matches!(
            self.phase,
            DownloadPhase::LocalWrite | DownloadPhase::Publishing
        ) && matches!(
            self.category,
            DownloadErrorCategory::Connection
                | DownloadErrorCategory::Timeout
                | DownloadErrorCategory::RemoteRead
                | DownloadErrorCategory::SourceChanged
                | DownloadErrorCategory::Incomplete
        )
    }
    pub(crate) fn sftp(phase: DownloadPhase, error: &SftpError) -> Self {
        let category = match error {
            SftpError::Timeout => DownloadErrorCategory::Timeout,
            SftpError::IO(_) | SftpError::UnexpectedBehavior(_) => {
                DownloadErrorCategory::Connection
            }
            SftpError::Status(status) => match status.status_code {
                StatusCode::NoConnection | StatusCode::ConnectionLost => {
                    DownloadErrorCategory::Connection
                }
                StatusCode::PermissionDenied => DownloadErrorCategory::PermissionDenied,
                StatusCode::NoSuchFile => DownloadErrorCategory::NotFound,
                _ => DownloadErrorCategory::RemoteMetadata,
            },
            _ => DownloadErrorCategory::RemoteMetadata,
        };
        Self::new(phase, category)
    }
    fn local(phase: DownloadPhase, error: &std::io::Error) -> Self {
        Self::new(
            phase,
            if error.kind() == std::io::ErrorKind::StorageFull {
                DownloadErrorCategory::NoSpace
            } else {
                DownloadErrorCategory::LocalWrite
            },
        )
    }
}
impl std::error::Error for Failure {}
impl From<Failure> for super::SshFailure {
    fn from(failure: Failure) -> Self {
        super::TransportError::Download(failure).into()
    }
}
impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self.category {
            DownloadErrorCategory::Cancelled => "Download cancelled",
            DownloadErrorCategory::Connection => {
                "SSH connection interrupted; reconnect and retry the download"
            }
            DownloadErrorCategory::Timeout => {
                "Download timed out waiting for the server; reconnect and retry"
            }
            DownloadErrorCategory::RemoteRead => {
                "The server stopped sending file data; retry the download"
            }
            DownloadErrorCategory::RemoteMetadata => {
                "Could not verify remote file metadata; retry after checking the server"
            }
            DownloadErrorCategory::PermissionDenied => {
                "The server denied access to the remote file"
            }
            DownloadErrorCategory::NotFound => "The remote file no longer exists",
            DownloadErrorCategory::LocalWrite => {
                "Could not write the private download file; check device storage"
            }
            DownloadErrorCategory::NoSpace => "Not enough device storage to finish the download",
            DownloadErrorCategory::SourceChanged => {
                "The remote file changed during the download; retry when it stops changing"
            }
            DownloadErrorCategory::Incomplete => {
                "The server returned an incomplete file; retry the download"
            }
            DownloadErrorCategory::Publish => {
                "The download finished but its local file could not be published"
            }
        };
        write!(
            f,
            "{message} (phase: {:?}, category: {:?})",
            self.phase, self.category
        )
    }
}

pub(crate) struct Connection {
    pub sftp: Arc<SftpSession>,
    pub generation: u64,
}
#[async_trait::async_trait]
pub(crate) trait Source: Send + Sync {
    async fn connect(
        &self,
        renew: bool,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Connection, Failure>;
    fn check(&self) -> Result<(), Failure> {
        Ok(())
    }
    async fn interrupted(&self) -> Failure {
        std::future::pending().await
    }
    fn diagnostic(&self, _event: DownloadDiagnostic) {}
}
pub(crate) struct FixedSource(pub Arc<SftpSession>);
#[async_trait::async_trait]
impl Source for FixedSource {
    async fn connect(&self, _: bool, _: &mut watch::Receiver<bool>) -> Result<Connection, Failure> {
        Ok(Connection {
            sftp: self.0.clone(),
            generation: 0,
        })
    }
}

async fn step<T>(
    cancel: &mut watch::Receiver<bool>,
    source: &dyn Source,
    phase: DownloadPhase,
    future: impl Future<Output = Result<T, Failure>>,
) -> Result<T, Failure> {
    source.check()?;
    if *cancel.borrow() {
        return Err(Failure::new(phase, DownloadErrorCategory::Cancelled));
    }
    tokio::select! {
        biased;
        () = super::wait_for_transfer_cancel(cancel) => Err(Failure::new(phase,DownloadErrorCategory::Cancelled)),
        mut failure = source.interrupted(), if matches!(phase, DownloadPhase::Metadata | DownloadPhase::RemoteRead | DownloadPhase::Verifying) => { failure.phase=phase; Err(failure) },
        result = tokio::time::timeout(IO_TIMEOUT,future) => result.unwrap_or(Err(Failure::new(phase,DownloadErrorCategory::Timeout))),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    size: u64,
    modified: Option<u32>,
}
impl Identity {
    fn from(metadata: &russh_sftp::protocol::FileAttributes) -> Result<Self, Failure> {
        if metadata.is_dir() {
            return Err(Failure::new(
                DownloadPhase::Metadata,
                DownloadErrorCategory::SourceChanged,
            ));
        }
        let size = metadata.size.ok_or(Failure::new(
            DownloadPhase::Metadata,
            DownloadErrorCategory::RemoteMetadata,
        ))?;
        Ok(Self {
            size,
            modified: metadata.mtime,
        })
    }
}
struct Partial {
    path: PathBuf,
}
impl Drop for Partial {
    fn drop(&mut self) {
        let path = self.path.clone();
        if let Ok(runtime) = crate::runtime() {
            runtime.spawn(async move {
                let _ = fs::remove_file(path).await;
            });
        }
    }
}
struct Download<'a> {
    source: &'a dyn Source,
    remote: &'a str,
    local: &'a str,
    partial: Partial,
    bytes: u64,
    identity: Option<Identity>,
    restart: bool,
    event: DownloadDiagnostic,
}
impl Download<'_> {
    fn report(&mut self, phase: DownloadPhase, error: Option<DownloadErrorCategory>) {
        self.event.phase = phase;
        self.event.bytes_transferred = self.bytes;
        self.event.error_category = error;
        self.event.total_bytes = self.identity.map(|identity| identity.size);
        self.event.source_modified_at = self
            .identity
            .and_then(|identity| identity.modified.map(u64::from));
        self.source.diagnostic(self.event.clone());
    }
    async fn attempt(
        &mut self,
        renew: bool,
        cancel: &mut watch::Receiver<bool>,
        progress: &mut (impl FnMut(u64, Option<u64>) + Send),
    ) -> Result<(), Failure> {
        self.report(DownloadPhase::Connecting, None);
        let mut connection_cancel = cancel.clone();
        let connection = step(
            cancel,
            self.source,
            DownloadPhase::Connecting,
            self.source.connect(renew, &mut connection_cancel),
        )
        .await?;
        self.event.ssh_generation = connection.generation;
        let source = step(cancel, self.source, DownloadPhase::Metadata, async {
            connection
                .sftp
                .open(self.remote)
                .await
                .map_err(|error| Failure::sftp(DownloadPhase::Metadata, &error))
        })
        .await?;
        let metadata = step(cancel, self.source, DownloadPhase::Metadata, async {
            source
                .metadata()
                .await
                .map_err(|error| Failure::sftp(DownloadPhase::Metadata, &error))
        })
        .await?;
        let identity = Identity::from(&metadata)?;
        // Missing mtime cannot prove that retained bytes belong to this version.
        let reusable =
            !self.restart && self.identity == Some(identity) && identity.modified.is_some();
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true);
        if self.identity.is_none() {
            options.create_new(true);
        }
        #[cfg(unix)]
        options.mode(0o600);
        let mut destination = step(cancel, self.source, DownloadPhase::LocalWrite, async {
            options
                .open(&self.partial.path)
                .await
                .map_err(|error| Failure::local(DownloadPhase::LocalWrite, &error))
        })
        .await?;
        if !reusable || self.bytes > identity.size {
            step(cancel, self.source, DownloadPhase::LocalWrite, async {
                destination
                    .set_len(0)
                    .await
                    .map_err(|error| Failure::local(DownloadPhase::LocalWrite, &error))
            })
            .await?;
            self.bytes = 0;
        }
        self.identity = Some(identity);
        self.restart = false;
        self.report(DownloadPhase::Metadata, None);
        let mut source = source;
        step(cancel, self.source, DownloadPhase::RemoteRead, async {
            source.seek(SeekFrom::Start(self.bytes)).await.map_err(|_| {
                Failure::new(DownloadPhase::RemoteRead, DownloadErrorCategory::RemoteRead)
            })
        })
        .await?;
        step(cancel, self.source, DownloadPhase::LocalWrite, async {
            destination
                .seek(SeekFrom::Start(self.bytes))
                .await
                .map_err(|error| Failure::local(DownloadPhase::LocalWrite, &error))
        })
        .await?;
        progress(self.bytes, Some(identity.size));
        let mut buffer = vec![0; BUFFER_BYTES];
        let mut reported = self.bytes;
        let mut last_report = std::time::Instant::now();
        let mut diagnostic_bytes = self.bytes;
        self.report(DownloadPhase::RemoteRead, None);
        loop {
            let count = step(cancel, self.source, DownloadPhase::RemoteRead, async {
                source.read(&mut buffer).await.map_err(|_| {
                    Failure::new(DownloadPhase::RemoteRead, DownloadErrorCategory::RemoteRead)
                })
            })
            .await?;
            if count == 0 {
                break;
            }
            if self.bytes.saturating_add(count as u64) > identity.size {
                self.restart = true;
                return Err(Failure::new(
                    DownloadPhase::Verifying,
                    DownloadErrorCategory::SourceChanged,
                ));
            }
            step(cancel, self.source, DownloadPhase::LocalWrite, async {
                destination
                    .write_all(&buffer[..count])
                    .await
                    .map_err(|error| Failure::local(DownloadPhase::LocalWrite, &error))?;
                // Tokio may acknowledge buffered bytes before its blocking write
                // settles. Confirm the write before retaining this resume offset.
                destination
                    .flush()
                    .await
                    .map_err(|error| Failure::local(DownloadPhase::LocalWrite, &error))
            })
            .await?;
            self.bytes += count as u64;
            if self.bytes.saturating_sub(reported) >= 256 * 1024
                || last_report.elapsed() >= Duration::from_millis(100)
            {
                progress(self.bytes, Some(identity.size));
                reported = self.bytes;
                last_report = std::time::Instant::now();
            }
            if self.bytes.saturating_sub(diagnostic_bytes) >= REPORT_BYTES {
                self.report(DownloadPhase::RemoteRead, None);
                diagnostic_bytes = self.bytes;
            }
        }
        self.report(DownloadPhase::Verifying, None);
        if self.bytes != identity.size {
            return Err(Failure::new(
                DownloadPhase::Verifying,
                DownloadErrorCategory::Incomplete,
            ));
        }
        let current = step(cancel, self.source, DownloadPhase::Verifying, async {
            source
                .metadata()
                .await
                .map_err(|error| Failure::sftp(DownloadPhase::Verifying, &error))
        })
        .await?;
        let path_metadata = step(cancel, self.source, DownloadPhase::Verifying, async {
            connection
                .sftp
                .metadata(self.remote)
                .await
                .map_err(|error| Failure::sftp(DownloadPhase::Verifying, &error))
        })
        .await?;
        if Identity::from(&current)? != identity || Identity::from(&path_metadata)? != identity {
            self.restart = true;
            return Err(Failure::new(
                DownloadPhase::Verifying,
                DownloadErrorCategory::SourceChanged,
            ));
        }
        let local_metadata = step(cancel, self.source, DownloadPhase::Verifying, async {
            destination
                .metadata()
                .await
                .map_err(|error| Failure::local(DownloadPhase::Verifying, &error))
        })
        .await?;
        if local_metadata.len() != self.bytes {
            return Err(Failure::new(
                DownloadPhase::Verifying,
                DownloadErrorCategory::LocalWrite,
            ));
        }
        step(cancel, self.source, DownloadPhase::LocalWrite, async {
            destination
                .sync_all()
                .await
                .map_err(|error| Failure::local(DownloadPhase::LocalWrite, &error))
        })
        .await?;
        drop(destination);
        drop(source);
        self.report(DownloadPhase::Publishing, None);
        // Cancellation is checked before rename. Once rename commits, a late
        // cancellation must not remove a complete file or an old destination.
        self.source.check()?;
        if *cancel.borrow() {
            return Err(Failure::new(
                DownloadPhase::Publishing,
                DownloadErrorCategory::Cancelled,
            ));
        }
        fs::rename(&self.partial.path, self.local)
            .await
            .map_err(|_| Failure::new(DownloadPhase::Publishing, DownloadErrorCategory::Publish))?;
        progress(self.bytes, Some(identity.size));
        self.report(DownloadPhase::Completed, None);
        Ok(())
    }
}

pub(crate) async fn download(
    source: &dyn Source,
    remote: &str,
    local: &str,
    cancel: watch::Receiver<bool>,
    progress: impl FnMut(u64, Option<u64>) + Send,
) -> Result<String, Failure> {
    download_with_attempts(source, remote, local, cancel, progress, 1).await
}
async fn download_with_attempts(
    source: &dyn Source,
    remote: &str,
    local: &str,
    mut cancel: watch::Receiver<bool>,
    mut progress: impl FnMut(u64, Option<u64>) + Send,
    first_attempt: u32,
) -> Result<String, Failure> {
    let mut download = Download {
        source,
        remote,
        local,
        partial: Partial {
            path: PathBuf::from(format!("{local}.whip-download-{}", uuid::Uuid::new_v4())),
        },
        bytes: 0,
        identity: None,
        restart: false,
        event: DownloadDiagnostic {
            transfer_id: String::new(),
            phase: DownloadPhase::Connecting,
            attempt: 0,
            bytes_transferred: 0,
            total_bytes: None,
            source_modified_at: None,
            ssh_generation: 0,
            error_category: None,
        },
    };
    for attempt in first_attempt..=MAX_ATTEMPTS {
        download.event.attempt = attempt;
        match download
            .attempt(attempt > first_attempt, &mut cancel, &mut progress)
            .await
        {
            Ok(()) => return Ok(local.into()),
            Err(error) => {
                download.report(error.phase, Some(error.category));
                if !error.retryable() || attempt == MAX_ATTEMPTS {
                    return Err(error);
                }
                download.report(DownloadPhase::WaitingForConnection, Some(error.category));
                step(
                    &mut cancel,
                    source,
                    DownloadPhase::WaitingForConnection,
                    async {
                        tokio::time::sleep(Duration::from_millis(250 * u64::from(attempt))).await;
                        Ok(())
                    },
                )
                .await?;
            }
        }
    }
    unreachable!("bounded download loop always returns")
}

pub(crate) async fn download_entry(
    source: &dyn Source,
    remote: &str,
    local: &str,
    mut cancel: watch::Receiver<bool>,
    progress: Arc<dyn Fn(u64, Option<u64>) + Send + Sync>,
) -> Result<String, super::SshFailure> {
    for attempt in 1..=MAX_ATTEMPTS {
        let mut connection_cancel = cancel.clone();
        let prepared = async {
            let connection = step(
                &mut cancel,
                source,
                DownloadPhase::Connecting,
                source.connect(attempt > 1, &mut connection_cancel),
            )
            .await?;
            let mut metadata = step(&mut cancel, source, DownloadPhase::Metadata, async {
                connection
                    .sftp
                    .symlink_metadata(remote)
                    .await
                    .map_err(|error| Failure::sftp(DownloadPhase::Metadata, &error))
            })
            .await?;
            if metadata.file_type().is_symlink() {
                metadata = step(&mut cancel, source, DownloadPhase::Metadata, async {
                    connection
                        .sftp
                        .metadata(remote)
                        .await
                        .map_err(|error| Failure::sftp(DownloadPhase::Metadata, &error))
                })
                .await?;
                if !metadata.file_type().is_file() {
                    return Err(Failure::new(
                        DownloadPhase::Metadata,
                        DownloadErrorCategory::RemoteMetadata,
                    ));
                }
            }
            Ok((connection, metadata))
        }
        .await;
        match prepared {
            Ok((connection, metadata)) => {
                if metadata.file_type().is_dir() {
                    return super::directory_download::download(
                        connection.sftp,
                        remote,
                        local,
                        cancel,
                        progress,
                    )
                    .await
                    .map_err(Into::into);
                }
                if !metadata.file_type().is_file() {
                    return Err(Failure::new(
                        DownloadPhase::Metadata,
                        DownloadErrorCategory::RemoteMetadata,
                    )
                    .into());
                }
                return download_with_attempts(
                    source,
                    remote,
                    local,
                    cancel,
                    move |bytes, total| {
                        progress(bytes, total);
                    },
                    attempt,
                )
                .await
                .map_err(Into::into);
            }
            Err(error) if error.retryable() && attempt < MAX_ATTEMPTS => {}
            Err(error) => return Err(error.into()),
        }
    }
    unreachable!("bounded preparation loop always returns")
}

#[cfg(test)]
mod tests;
