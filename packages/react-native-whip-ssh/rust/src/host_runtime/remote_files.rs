//! Remote path resolution, preview ownership, transfer progress, and Git execution.

use super::*;
use std::future::Future;
use std::time::Duration;

use crate::remote_ops::{
    GitDiff, GitRepository, GitStatusEntry, MAX_ACTIVE_PREVIEWS, PreviewInfo, PreviewState,
    REMOTE_TEXT_MAX_BYTES, RemoteDirectoryListing, RemoteFileEntry, RemoteFileKind,
    TransferProgress, TransferResult, TransferState, attachment_filename, git_diff_command,
    git_repository_command, git_status_command, join_remote_path, normalize_remote_path,
    parse_git_diff, parse_git_repository, parse_git_status, remote_filename,
};

fn remote_file_entry(
    name: String,
    path: String,
    metadata: crate::ssh::SftpMetadata,
) -> RemoteFileEntry {
    let kind = if metadata.is_directory {
        RemoteFileKind::Directory
    } else if metadata.is_regular {
        RemoteFileKind::File
    } else if metadata.is_symlink {
        RemoteFileKind::Symlink
    } else {
        RemoteFileKind::Other
    };
    RemoteFileEntry {
        name,
        path,
        kind,
        size: metadata.size,
        modified_at: metadata.modified_at,
        permissions: metadata.permissions,
    }
}

pub(super) async fn resolved_remote_path(
    inner: &RuntimeInner,
    path: Option<&str>,
) -> Result<String, HostRuntimeError> {
    let generation = current_generation(inner)?;
    let ssh = current_ssh(inner)?;
    let resolved = resolved_ssh_path(&ssh, path).await?;
    validate_generation(inner, generation)?;
    Ok(resolved)
}

async fn resolved_ssh_path(
    ssh: &SshSession,
    path: Option<&str>,
) -> Result<String, HostRuntimeError> {
    if let Some(path) = path.map(str::trim).filter(|path| path.starts_with('/')) {
        return crate::remote_ops::normalize_absolute(path)
            .map_err(HostRuntimeError::RemoteFileFailure);
    }
    let home = ssh.remote_home().await?;
    let home = crate::remote_ops::normalize_absolute(home.trim())
        .map_err(HostRuntimeError::RemoteFileFailure)?;
    normalize_remote_path(path, &home).map_err(HostRuntimeError::RemoteFileFailure)
}

pub(super) fn update_transfer_progress(
    inner: &Arc<RuntimeInner>,
    transfer_id: &str,
    bytes_transferred: u64,
    total_bytes: Option<u64>,
) {
    let progress = {
        let mut transfers = inner.operations.transfers.lock();
        let Some(slot) = transfers.get_mut(transfer_id) else {
            return;
        };
        if !matches!(
            slot.progress.state,
            TransferState::Pending | TransferState::Running
        ) {
            return;
        }
        slot.progress.state = TransferState::Running;
        slot.progress.bytes_transferred = slot.progress.bytes_transferred.max(bytes_transferred);
        slot.progress.total_bytes = total_bytes;
        let progress = slot.progress.clone();
        drop(transfers);
        progress
    };
    emit(HostRuntimeEvent::TransferProgressChanged {
        runtime_id: inner.id.clone(),
        progress,
    });
}

pub(super) fn finish_transfer(
    inner: &Arc<RuntimeInner>,
    transfer_id: &str,
    generation: u64,
    result: Result<TransferResult, String>,
) {
    let current_generation = inner.state.lock().generation;
    let connected = inner.state.lock().connection == HostConnectionState::Connected;
    let (progress, notify) = {
        let mut transfers = inner.operations.transfers.lock();
        let Some(slot) = transfers.get_mut(transfer_id) else {
            return;
        };
        if matches!(
            slot.progress.state,
            TransferState::Completed | TransferState::Failed
        ) {
            return;
        }
        if slot.progress.state == TransferState::Cancelled {
            slot.result = Some(Err("transfer cancelled".to_owned()));
        } else if slot.generation != generation || current_generation != generation || !connected {
            slot.progress.state = TransferState::Failed;
            slot.result = Some(Err("host connection changed during transfer".to_owned()));
        } else {
            slot.progress.state = if result.is_ok() {
                TransferState::Completed
            } else {
                TransferState::Failed
            };
            slot.result = Some(result);
        }
        let result = (slot.progress.clone(), slot.notify.clone());
        drop(transfers);
        result
    };
    emit(HostRuntimeEvent::TransferProgressChanged {
        runtime_id: inner.id.clone(),
        progress,
    });
    notify.notify_one();
}

pub(super) fn invalidate_remote_operations(
    inner: &Arc<RuntimeInner>,
    generation: u64,
    reason: &str,
) {
    inner.directory_cache.lock().clear();
    inner.operations.cancel_generation(generation, reason);
    let previews = inner.operations.disconnect_previews(generation);
    for (preview_id, _) in &previews {
        emit(HostRuntimeEvent::PreviewStateChanged {
            runtime_id: inner.id.clone(),
            preview_id: preview_id.clone(),
            state: PreviewState::Disconnected,
            error: Some(reason.to_owned()),
        });
    }
    let ssh = current_ssh(inner).ok();
    if let (Some(ssh), Ok(runtime)) = (ssh, crate::runtime()) {
        runtime.spawn(async move {
            for (_, preview) in previews {
                crate::remote_preview::stop_preview(&ssh, preview.resource).await;
            }
        });
    }
}

pub(super) fn register_preview(
    inner: &RuntimeInner,
    id: String,
    generation: u64,
    preview: crate::remote_ops::ManagedPreview,
) -> Result<(), Box<(HostRuntimeError, crate::remote_ops::ManagedPreview)>> {
    let state = inner.state.lock();
    if state.connection != HostConnectionState::Connected || state.generation != generation {
        return Err(Box::new((
            HostRuntimeError::StaleOperation(
                "preview opened after its host connection was replaced".to_owned(),
            ),
            preview,
        )));
    }
    drop(state);
    let mut previews = inner.operations.previews.lock();
    if previews.len() >= MAX_ACTIVE_PREVIEWS {
        return Err(Box::new((
            HostRuntimeError::PreviewFailure(format!(
                "at most {MAX_ACTIVE_PREVIEWS} previews may be open at once"
            )),
            preview,
        )));
    }
    previews.insert(id, preview);
    drop(previews);
    Ok(())
}

pub(super) async fn start_path_preview_inner(
    inner: Arc<RuntimeInner>,
    remote_path: String,
    html: bool,
) -> Result<PreviewInfo, HostRuntimeError> {
    if inner.operations.previews.lock().len() >= MAX_ACTIVE_PREVIEWS {
        return Err(HostRuntimeError::PreviewFailure(format!(
            "at most {MAX_ACTIVE_PREVIEWS} previews may be open at once"
        )));
    }
    let generation = current_generation(&inner)?;
    let remote_path = resolved_remote_path(&inner, Some(&remote_path)).await?;
    let id = inner.operations.next_id("preview");
    let ssh = current_ssh(&inner)?;
    let (info, preview) = if html {
        crate::remote_preview::start_html_preview(ssh.clone(), id.clone(), generation, &remote_path)
            .await?
    } else {
        crate::remote_preview::start_remote_file_preview(
            ssh.clone(),
            id.clone(),
            generation,
            &remote_path,
        )
        .await?
    };
    if let Err(error_preview) = register_preview(&inner, id, generation, preview) {
        let (error, preview) = *error_preview;
        crate::remote_preview::stop_preview(&ssh, preview.resource).await;
        return Err(error);
    }
    Ok(info)
}

pub(super) async fn transfer_setup_step<T, E, F>(
    cancel: &mut watch::Receiver<bool>,
    future: F,
) -> Result<T, String>
where
    E: std::fmt::Display,
    F: Future<Output = Result<T, E>>,
{
    if *cancel.borrow() {
        return Err("transfer cancelled".to_owned());
    }
    tokio::select! {
        biased;
        changed = cancel.changed() => {
            let _ = changed;
            Err("transfer cancelled".to_owned())
        }
        result = future => result.map_err(|error| error.to_string()),
    }
}

struct TransferPaths {
    local_path: String,
    remote_path: String,
}

// Invalidate on both sides of a mutation, including errors/cancellation that may
// leave a partial upload or recursively-created directory on the server.
struct DirectoryMutation {
    inner: Arc<RuntimeInner>,
    generation: u64,
    paths: Vec<String>,
    ancestors: bool,
}

impl DirectoryMutation {
    fn new(inner: Arc<RuntimeInner>, generation: u64, paths: Vec<String>, ancestors: bool) -> Self {
        inner
            .directory_cache
            .lock()
            .invalidate(generation, &paths, ancestors);
        Self {
            inner,
            generation,
            paths,
            ancestors,
        }
    }
}

impl Drop for DirectoryMutation {
    fn drop(&mut self) {
        self.inner
            .directory_cache
            .lock()
            .invalidate(self.generation, &self.paths, self.ancestors);
    }
}

#[cfg(test)]
mod directory_mutation_tests {
    use super::*;

    #[test]
    fn mutation_guard_invalidates_before_and_after_partial_work() {
        let inner = super::super::tests::connected_runtime_inner("directory-mutation");
        let now = std::time::Instant::now();
        let listing = RemoteDirectoryListing {
            path: "/home".into(),
            entries: Vec::new(),
        };
        let request = inner.directory_cache.lock().begin(1, now);
        inner.directory_cache.lock().insert(request, listing.clone(), now);
        let mutation = DirectoryMutation::new(inner.clone(), 1, vec!["/home/file".into()], false);
        assert!(inner.directory_cache.lock().lookup(1, "/home", now).is_none());
        let during = inner.directory_cache.lock().begin(1, now);
        inner.directory_cache.lock().insert(during, listing.clone(), now);
        let pending = inner.directory_cache.lock().begin(1, now);
        drop(mutation);
        inner.directory_cache.lock().insert(pending, listing, now);
        assert!(inner.directory_cache.lock().lookup(1, "/home", now).is_none());
    }
}

fn start_transfer<F, Fut>(
    inner: &Arc<RuntimeInner>,
    operation: F,
) -> Result<String, HostRuntimeError>
where
    F: FnOnce(
            Arc<SshSession>,
            watch::Receiver<bool>,
            Arc<dyn Fn(u64, Option<u64>) + Send + Sync>,
        ) -> Fut
        + Send
        + 'static,
    Fut: Future<Output = Result<TransferPaths, String>> + Send + 'static,
{
    let generation = current_generation(inner)?;
    let ssh = current_ssh(inner)?;
    let (transfer_id, cancel, _) = inner
        .operations
        .begin_transfer(generation)
        .map_err(HostRuntimeError::TransferFailure)?;
    let id = transfer_id.clone();
    let inner = inner.clone();
    crate::runtime()
        .map_err(HostRuntimeError::SshTransportFailure)?
        .spawn(async move {
            let progress_inner = inner.clone();
            let progress_id = id.clone();
            let progress = Arc::new(move |bytes, total| {
                update_transfer_progress(&progress_inner, &progress_id, bytes, total);
            });
            let result = operation(ssh, cancel, progress)
                .await
                .map(|paths| TransferResult {
                    transfer_id: id.clone(),
                    local_path: Some(paths.local_path),
                    remote_path: Some(paths.remote_path),
                });
            finish_transfer(&inner, &id, generation, result);
        });
    Ok(transfer_id)
}

pub(super) async fn execute_generation_checked(
    inner: &RuntimeInner,
    command: &str,
) -> Result<crate::ssh::CommandOutput, HostRuntimeError> {
    const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
    let generation = current_generation(inner)?;
    let output = tokio::time::timeout(GIT_COMMAND_TIMEOUT, current_ssh(inner)?.execute(command))
        .await
        .map_err(|_| {
            HostRuntimeError::GitFailure(
                "remote Git operation timed out after 30 seconds".to_owned(),
            )
        })??;
    validate_generation(inner, generation)?;
    Ok(output)
}

pub(super) fn command_failure(kind: &str, output: &crate::ssh::CommandOutput) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.lines().take(3).collect::<Vec<_>>().join("\n");
    if detail.is_empty() {
        format!(
            "{kind} exited with status {}",
            output
                .exit_status
                .map_or_else(|| "unknown".to_owned(), |value| value.to_string())
        )
    } else {
        format!("{kind} failed: {detail}")
    }
}
#[uniffi::export]
impl HostRuntime {
    pub fn cached_directory(&self, path: String) -> Option<RemoteDirectoryListing> {
        let generation = current_generation(&self.inner).ok()?;
        // Navigation uses the canonical path returned by list_directory. Paths
        // requiring home resolution fall through to a fresh asynchronous read.
        let path = crate::remote_ops::normalize_absolute(path.trim()).ok()?;
        self.inner
            .directory_cache
            .lock()
            .lookup(generation, &path, std::time::Instant::now())
    }

    pub async fn list_directory(
        &self,
        path: Option<String>,
    ) -> Result<RemoteDirectoryListing, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let path = resolved_remote_path(&inner, path.as_deref()).await?;
                let cache_request = inner
                    .directory_cache
                    .lock()
                    .begin(generation, std::time::Instant::now());
                let entries = current_ssh(&inner)?.sftp_list(&path).await?;
                validate_generation(&inner, generation)?;
                let entries = entries
                    .into_iter()
                    .filter_map(|entry| {
                        let name = entry.filename.trim_end_matches('/').to_owned();
                        if name.is_empty() || matches!(name.as_str(), "." | "..") {
                            return None;
                        }
                        let entry_path = join_remote_path(&path, &name).ok()?;
                        Some(remote_file_entry(name, entry_path, entry.metadata))
                    })
                    .collect::<Vec<_>>();
                inner.git_discovery.lock().observe(
                    generation,
                    &path,
                    &entries,
                    std::time::Instant::now(),
                );
                let listing = RemoteDirectoryListing { path, entries };
                inner.directory_cache.lock().insert(
                    cache_request,
                    listing.clone(),
                    std::time::Instant::now(),
                );
                Ok(listing)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!(
                    "remote directory task failed: {error}"
                ))
            })?
    }

    /// Resolve target metadata on demand while preserving the requested symlink path.
    pub async fn stat_remote_path(
        &self,
        path: String,
    ) -> Result<RemoteFileEntry, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let path = resolved_remote_path(&inner, Some(&path)).await?;
                let metadata = current_ssh(&inner)?.sftp_stat(&path).await?;
                validate_generation(&inner, generation)?;
                let name = remote_filename(&path).unwrap_or_else(|_| "/".to_owned());
                Ok(remote_file_entry(name, path, metadata))
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!("remote stat task failed: {error}"))
            })?
    }

    pub async fn read_remote_text(
        &self,
        path: String,
        max_bytes: Option<u64>,
    ) -> Result<String, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let path = resolved_remote_path(&inner, Some(&path)).await?;
                let limit = max_bytes
                    .unwrap_or(REMOTE_TEXT_MAX_BYTES)
                    .clamp(1, REMOTE_TEXT_MAX_BYTES);
                let bytes = current_ssh(&inner)?.sftp_read_limited(&path, limit).await?;
                validate_generation(&inner, generation)?;
                String::from_utf8(bytes).map_err(|_| {
                    HostRuntimeError::RemoteFileFailure(
                        "remote file is not valid UTF-8 text".to_owned(),
                    )
                })
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!("remote text task failed: {error}"))
            })?
    }

    pub async fn create_remote_directory(&self, path: String) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let path = resolved_remote_path(&inner, Some(&path)).await?;
                let _mutation =
                    DirectoryMutation::new(inner.clone(), generation, vec![path.clone()], true);
                current_ssh(&inner)?.sftp_create_dir_all(&path).await?;
                validate_generation(&inner, generation)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!("remote mkdir task failed: {error}"))
            })?
    }

    pub async fn rename_remote_path(
        &self,
        from: String,
        to: String,
    ) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let from = resolved_remote_path(&inner, Some(&from)).await?;
                let to = resolved_remote_path(&inner, Some(&to)).await?;
                let _mutation = DirectoryMutation::new(
                    inner.clone(),
                    generation,
                    vec![from.clone(), to.clone()],
                    false,
                );
                current_ssh(&inner)?.sftp_rename(&from, &to).await?;
                validate_generation(&inner, generation)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!("remote rename task failed: {error}"))
            })?
    }

    pub async fn remove_remote_path(
        &self,
        path: String,
        directory: bool,
    ) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let path = resolved_remote_path(&inner, Some(&path)).await?;
                let _mutation =
                    DirectoryMutation::new(inner.clone(), generation, vec![path.clone()], false);
                current_ssh(&inner)?.sftp_remove(&path, directory).await?;
                validate_generation(&inner, generation)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!("remote remove task failed: {error}"))
            })?
    }

    pub fn start_upload(
        &self,
        local_path: String,
        remote_directory: String,
    ) -> Result<String, HostRuntimeError> {
        let inner = self.inner.clone();
        let generation = current_generation(&inner)?;
        start_transfer(&self.inner, move |ssh, mut cancel, progress| async move {
            let filename = std::path::Path::new(&local_path)
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "local upload path has no UTF-8 filename".to_owned())?;
            let directory = transfer_setup_step(
                &mut cancel,
                resolved_ssh_path(&ssh, Some(&remote_directory)),
            )
            .await?;
            let remote_path = join_remote_path(&directory, filename)?;
            let _mutation =
                DirectoryMutation::new(inner, generation, vec![remote_path.clone()], false);
            ssh.transfer_upload(&local_path, &remote_path, cancel, progress)
                .await
                .map_err(|error| error.to_string())?;
            Ok(TransferPaths {
                local_path,
                remote_path,
            })
        })
    }

    pub fn start_attachment_upload(&self, local_path: String) -> Result<String, HostRuntimeError> {
        let inner = self.inner.clone();
        let generation = current_generation(&inner)?;
        start_transfer(&self.inner, move |ssh, mut cancel, progress| async move {
            let home = crate::remote_ops::normalize_absolute(
                transfer_setup_step(&mut cancel, ssh.remote_home())
                    .await?
                    .trim(),
            )?;
            let upload_directory = join_remote_path(&home, ".whip/uploads")?;
            let _mutation =
                DirectoryMutation::new(inner, generation, vec![upload_directory.clone()], true);
            transfer_setup_step(&mut cancel, ssh.sftp_create_dir_all(&upload_directory)).await?;
            let filename = attachment_filename(&local_path)?;
            let remote_path = join_remote_path(&upload_directory, &filename)?;
            ssh.transfer_upload(&local_path, &remote_path, cancel, progress)
                .await
                .map_err(|error| error.to_string())?;
            Ok(TransferPaths {
                local_path,
                remote_path,
            })
        })
    }

    pub fn start_download(
        &self,
        remote_path: String,
        local_directory: String,
    ) -> Result<String, HostRuntimeError> {
        start_transfer(&self.inner, move |ssh, mut cancel, progress| async move {
            let remote_path =
                transfer_setup_step(&mut cancel, resolved_ssh_path(&ssh, Some(&remote_path)))
                    .await?;
            let filename = remote_filename(&remote_path)?;
            let local_path = std::path::Path::new(&local_directory)
                .join(filename)
                .to_str()
                .ok_or_else(|| "local download path is not UTF-8".to_owned())?
                .to_owned();
            ssh.transfer_download(&remote_path, &local_path, cancel, progress)
                .await
                .map_err(|error| error.to_string())?;
            Ok(TransferPaths {
                local_path,
                remote_path,
            })
        })
    }

    pub fn transfer_progress(&self, transfer_id: String) -> Option<TransferProgress> {
        self.inner
            .operations
            .transfers
            .lock()
            .get(&transfer_id)
            .map(|slot| slot.progress.clone())
    }

    pub async fn await_transfer(
        &self,
        transfer_id: String,
    ) -> Result<TransferResult, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                loop {
                    let pending = {
                        let mut transfers = inner.operations.transfers.lock();
                        let slot = transfers.get(&transfer_id).ok_or_else(|| {
                            HostRuntimeError::TransferFailure(format!(
                                "unknown transfer {transfer_id}"
                            ))
                        })?;
                        if let Some(result) = &slot.result {
                            let result = result.clone();
                            let state = slot.progress.state;
                            transfers.remove(&transfer_id);
                            return match result {
                                Ok(result) => Ok(result),
                                Err(error) if state == TransferState::Cancelled => {
                                    Err(HostRuntimeError::TransferCancelled(error))
                                }
                                Err(error) => Err(HostRuntimeError::TransferFailure(error)),
                            };
                        }
                        let notify = slot.notify.clone();
                        drop(transfers);
                        notify
                    };
                    pending.notified().await;
                }
            })
            .await
            .map_err(|error| {
                HostRuntimeError::TransferFailure(format!("transfer wait task failed: {error}"))
            })?
    }

    pub fn cancel_transfer(&self, transfer_id: String) -> bool {
        let cancelled = self.inner.operations.cancel_transfer(&transfer_id);
        if cancelled && let Some(progress) = self.transfer_progress(transfer_id) {
            emit(HostRuntimeEvent::TransferProgressChanged {
                runtime_id: self.inner.id.clone(),
                progress,
            });
        }
        cancelled
    }

    pub async fn discover_git_repository(
        &self,
        path: String,
    ) -> Result<Option<GitRepository>, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let path = resolved_remote_path(&inner, Some(&path)).await?;
                validate_generation(&inner, generation)?;
                if let Some(repository) =
                    inner
                        .git_discovery
                        .lock()
                        .lookup(generation, &path, std::time::Instant::now())
                {
                    return Ok(repository.into_repository());
                }
                // Serialize misses, then check again so simultaneous requests share
                // one SSH command. Listings never wait on this operation lock.
                let _operation = inner.git_discovery_operation.lock().await;
                validate_generation(&inner, generation)?;
                let revision = {
                    let mut cache = inner.git_discovery.lock();
                    if let Some(repository) =
                        cache.lookup(generation, &path, std::time::Instant::now())
                    {
                        return Ok(repository.into_repository());
                    }
                    cache.revision()
                };
                let output =
                    execute_generation_checked(&inner, &git_repository_command(&path)).await?;
                if output.exit_status != Some(0) {
                    return Err(HostRuntimeError::GitFailure(command_failure(
                        "Git discovery",
                        &output,
                    )));
                }
                if output.stdout_truncated {
                    return Err(HostRuntimeError::GitFailure(
                        "Git repository output exceeded the command limit".to_owned(),
                    ));
                }
                let repository =
                    parse_git_repository(std::str::from_utf8(&output.stdout).map_err(|_| {
                        HostRuntimeError::GitFailure(
                            "Git repository output was not UTF-8".to_owned(),
                        )
                    })?)
                    .map_err(HostRuntimeError::GitFailure)?;
                validate_generation(&inner, generation)?;
                inner.git_discovery.lock().insert(
                    generation,
                    revision,
                    path,
                    repository.clone(),
                    std::time::Instant::now(),
                );
                Ok(repository)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::GitFailure(format!("Git discovery task failed: {error}"))
            })?
    }

    pub async fn git_status(&self, root: String) -> Result<Vec<GitStatusEntry>, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let root = resolved_remote_path(&inner, Some(&root)).await?;
                let output = execute_generation_checked(&inner, &git_status_command(&root)).await?;
                if output.exit_status != Some(0) {
                    return Err(HostRuntimeError::GitFailure(command_failure(
                        "git status",
                        &output,
                    )));
                }
                if output.stdout_truncated {
                    return Err(HostRuntimeError::GitFailure(
                        "Git status exceeded the 8 MiB command limit".to_owned(),
                    ));
                }
                parse_git_status(&output.stdout, &root).map_err(HostRuntimeError::GitFailure)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::GitFailure(format!("Git status task failed: {error}"))
            })?
    }

    pub async fn git_diff(
        &self,
        repository: GitRepository,
        status: GitStatusEntry,
        context: crate::remote_ops::GitDiffContext,
    ) -> Result<GitDiff, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let command = git_diff_command(&repository, &status, context)
                    .map_err(HostRuntimeError::GitFailure)?;
                let output = execute_generation_checked(&inner, &command).await?;
                if output.exit_status.is_some_and(|status| status != 0) {
                    return Err(HostRuntimeError::GitFailure(command_failure(
                        "git diff", &output,
                    )));
                }
                parse_git_diff(&output.stdout).map_err(HostRuntimeError::GitFailure)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::GitFailure(format!("Git diff task failed: {error}"))
            })?
    }

    pub async fn git_diff_review(
        &self,
        repository: GitRepository,
        status: GitStatusEntry,
        context: crate::remote_ops::GitDiffContext,
        expansions: Vec<crate::git_review::GitDiffExpansion>,
    ) -> Result<crate::git_review::GitDiffReview, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let lines = crate::git_review::fetch_context(context, &expansions)
                    .map_err(HostRuntimeError::GitFailure)?;
                let command = crate::remote_ops::git_diff_command_lines(&repository, &status, lines)
                    .map_err(HostRuntimeError::GitFailure)?;
                let output = execute_generation_checked(&inner, &command).await?;
                if output.exit_status.is_some_and(|status| status != 0) {
                    return Err(HostRuntimeError::GitFailure(command_failure("git diff", &output)));
                }
                let review = tokio::task::spawn_blocking(move || {
                    let diff = parse_git_diff(&output.stdout)?;
                    if diff.truncated && !expansions.is_empty() {
                        return Err("Expanded context exceeds the preview limit; choose a context mode instead".to_owned());
                    }
                    Ok(crate::git_review::review(diff, context, &expansions))
                }).await.map_err(|error| HostRuntimeError::GitFailure(error.to_string()))?
                    .map_err(HostRuntimeError::GitFailure)?;
                validate_generation(&inner, generation)?;
                Ok(review)
            })
            .await
            .map_err(|error| HostRuntimeError::GitFailure(format!("Git review task failed: {error}")))?
    }

    pub async fn start_browser_proxy(&self) -> Result<u16, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let ssh = current_ssh(&inner)?;
                let port = ssh.open_browser_proxy().await?;
                if let Err(error) = validate_generation(&inner, generation) {
                    ssh.close_local_forward(port);
                    return Err(error);
                }
                Ok(port)
            })
            .await
            .map_err(|error| HostRuntimeError::PreviewFailure(error.to_string()))?
    }

    pub fn stop_browser_proxy(&self, port: u16) -> Result<(), HostRuntimeError> {
        current_ssh(&self.inner)?.close_local_forward(port);
        Ok(())
    }

    pub async fn start_web_preview(
        &self,
        remote_url: String,
    ) -> Result<PreviewInfo, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                if inner.operations.previews.lock().len() >= MAX_ACTIVE_PREVIEWS {
                    return Err(HostRuntimeError::PreviewFailure(format!(
                        "at most {MAX_ACTIVE_PREVIEWS} previews may be open at once"
                    )));
                }
                let id = inner.operations.next_id("preview");
                let ssh = current_ssh(&inner)?;
                let (info, preview) = crate::remote_preview::start_web_preview(
                    ssh.clone(),
                    id.clone(),
                    generation,
                    &remote_url,
                )
                .await?;
                if let Err(error_preview) = register_preview(&inner, id, generation, preview) {
                    let (error, preview) = *error_preview;
                    crate::remote_preview::stop_preview(&ssh, preview.resource).await;
                    return Err(error);
                }
                Ok(info)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::PreviewFailure(format!("web preview task failed: {error}"))
            })?
    }

    pub async fn start_html_preview(
        &self,
        remote_path: String,
    ) -> Result<PreviewInfo, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(start_path_preview_inner(inner, remote_path, true))
            .await
            .map_err(|error| {
                HostRuntimeError::PreviewFailure(format!("HTML preview task failed: {error}"))
            })?
    }

    pub async fn start_remote_file_preview(
        &self,
        remote_path: String,
    ) -> Result<PreviewInfo, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(start_path_preview_inner(inner, remote_path, false))
            .await
            .map_err(|error| {
                HostRuntimeError::PreviewFailure(format!(
                    "remote file preview task failed: {error}"
                ))
            })?
    }

    pub async fn stop_preview(&self, preview_id: String) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let preview = inner.operations.previews.lock().remove(&preview_id);
                if let Some(preview) = preview {
                    if let Ok(ssh) = current_ssh(&inner) {
                        crate::remote_preview::stop_preview(&ssh, preview.resource).await;
                    }
                    emit(HostRuntimeEvent::PreviewStateChanged {
                        runtime_id: inner.id.clone(),
                        preview_id,
                        state: PreviewState::Stopped,
                        error: None,
                    });
                }
                Ok(())
            })
            .await
            .map_err(|error| {
                HostRuntimeError::PreviewFailure(format!("preview stop task failed: {error}"))
            })?
    }
}
