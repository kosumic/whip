//! Remote path resolution, preview ownership, transfer progress, and Git execution.

use super::*;
use std::time::Duration;

use crate::remote_ops::{
    GitDiff, GitRepository, GitStatusEntry, MAX_ACTIVE_PREVIEWS, PreviewInfo, PreviewState,
    REMOTE_TEXT_MAX_BYTES, RemoteDirectoryListing, RemoteFileEntry, RemoteFileKind,
    TransferProgress, TransferResult, TransferState, attachment_filename, git_diff_command,
    git_repository_command, git_status_command, join_remote_path, normalize_remote_path,
    parse_git_diff, parse_git_repository, parse_git_status, remote_filename,
};

pub(super) async fn resolved_remote_path(
    inner: &RuntimeInner,
    path: Option<&str>,
) -> Result<String, HostRuntimeError> {
    let generation = current_generation(inner)?;
    let home = current_ssh(inner)?.remote_home().await?;
    validate_generation(inner, generation)?;
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
    F: std::future::Future<Output = Result<T, E>>,
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
                let entries = current_ssh(&inner)?.sftp_list(&path).await?;
                validate_generation(&inner, generation)?;
                let mut entries = entries
                    .into_iter()
                    .filter_map(|entry| {
                        let name = entry.filename.trim_end_matches('/').to_owned();
                        if name.is_empty() || matches!(name.as_str(), "." | "..") {
                            return None;
                        }
                        let entry_path = join_remote_path(&path, &name).ok()?;
                        let kind = if entry.metadata.is_directory {
                            RemoteFileKind::Directory
                        } else if entry.metadata.is_regular {
                            RemoteFileKind::File
                        } else if entry.metadata.is_symlink {
                            RemoteFileKind::Symlink
                        } else {
                            RemoteFileKind::Other
                        };
                        Some(RemoteFileEntry {
                            name,
                            path: entry_path,
                            kind,
                            size: entry.metadata.size,
                            modified_at: entry.metadata.modified_at,
                            permissions: entry.metadata.permissions,
                        })
                    })
                    .collect::<Vec<_>>();
                entries.sort_by(|left, right| {
                    let left_directory = left.kind == RemoteFileKind::Directory;
                    let right_directory = right.kind == RemoteFileKind::Directory;
                    right_directory.cmp(&left_directory).then_with(|| {
                        left.name
                            .to_lowercase()
                            .cmp(&right.name.to_lowercase())
                            .then(left.name.cmp(&right.name))
                    })
                });
                Ok(RemoteDirectoryListing { path, entries })
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!(
                    "remote directory task failed: {error}"
                ))
            })?
    }

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
                let kind = if metadata.is_directory {
                    RemoteFileKind::Directory
                } else if metadata.is_regular {
                    RemoteFileKind::File
                } else if metadata.is_symlink {
                    RemoteFileKind::Symlink
                } else {
                    RemoteFileKind::Other
                };
                Ok(RemoteFileEntry {
                    name,
                    path,
                    kind,
                    size: metadata.size,
                    modified_at: metadata.modified_at,
                    permissions: metadata.permissions,
                })
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
        let generation = current_generation(&self.inner)?;
        let ssh = current_ssh(&self.inner)?;
        let (transfer_id, mut cancel, _) = self
            .inner
            .operations
            .begin_transfer(generation)
            .map_err(HostRuntimeError::TransferFailure)?;
        let id = transfer_id.clone();
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let result = async {
                    let filename = std::path::Path::new(&local_path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .ok_or_else(|| "local upload path has no UTF-8 filename".to_owned())?;
                    let home = transfer_setup_step(&mut cancel, ssh.remote_home()).await?;
                    let directory = normalize_remote_path(Some(&remote_directory), home.trim())?;
                    let remote_path = join_remote_path(&directory, filename)?;
                    let progress_inner = inner.clone();
                    let progress_id = id.clone();
                    let progress = Arc::new(move |bytes, total| {
                        update_transfer_progress(&progress_inner, &progress_id, bytes, total);
                    });
                    ssh.transfer_upload(&local_path, &remote_path, cancel, progress)
                        .await
                        .map_err(|error| error.to_string())?;
                    Ok(TransferResult {
                        transfer_id: id.clone(),
                        local_path: Some(local_path),
                        remote_path: Some(remote_path),
                    })
                }
                .await;
                finish_transfer(&inner, &id, generation, result);
            });
        Ok(transfer_id)
    }

    pub fn start_attachment_upload(&self, local_path: String) -> Result<String, HostRuntimeError> {
        let generation = current_generation(&self.inner)?;
        let ssh = current_ssh(&self.inner)?;
        let (transfer_id, mut cancel, _) = self
            .inner
            .operations
            .begin_transfer(generation)
            .map_err(HostRuntimeError::TransferFailure)?;
        let id = transfer_id.clone();
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let result = async {
                    let home = crate::remote_ops::normalize_absolute(
                        transfer_setup_step(&mut cancel, ssh.remote_home())
                            .await?
                            .trim(),
                    )?;
                    let upload_directory = join_remote_path(&home, ".whip/uploads")?;
                    transfer_setup_step(&mut cancel, ssh.sftp_create_dir_all(&upload_directory))
                        .await?;
                    let filename = attachment_filename(&local_path)?;
                    let remote_path = join_remote_path(&upload_directory, &filename)?;
                    let progress_inner = inner.clone();
                    let progress_id = id.clone();
                    let progress = Arc::new(move |bytes, total| {
                        update_transfer_progress(&progress_inner, &progress_id, bytes, total);
                    });
                    ssh.transfer_upload(&local_path, &remote_path, cancel, progress)
                        .await
                        .map_err(|error| error.to_string())?;
                    Ok(TransferResult {
                        transfer_id: id.clone(),
                        local_path: Some(local_path),
                        remote_path: Some(remote_path),
                    })
                }
                .await;
                finish_transfer(&inner, &id, generation, result);
            });
        Ok(transfer_id)
    }

    pub fn start_download(
        &self,
        remote_path: String,
        local_directory: String,
    ) -> Result<String, HostRuntimeError> {
        let generation = current_generation(&self.inner)?;
        let ssh = current_ssh(&self.inner)?;
        let (transfer_id, mut cancel, _) = self
            .inner
            .operations
            .begin_transfer(generation)
            .map_err(HostRuntimeError::TransferFailure)?;
        let id = transfer_id.clone();
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let result = async {
                    let home = transfer_setup_step(&mut cancel, ssh.remote_home()).await?;
                    let remote_path = normalize_remote_path(Some(&remote_path), home.trim())?;
                    let filename = remote_filename(&remote_path)?;
                    let local_path = std::path::Path::new(&local_directory)
                        .join(filename)
                        .to_str()
                        .ok_or_else(|| "local download path is not UTF-8".to_owned())?
                        .to_owned();
                    let progress_inner = inner.clone();
                    let progress_id = id.clone();
                    let progress = Arc::new(move |bytes, total| {
                        update_transfer_progress(&progress_inner, &progress_id, bytes, total);
                    });
                    ssh.transfer_download(&remote_path, &local_path, cancel, progress)
                        .await
                        .map_err(|error| error.to_string())?;
                    Ok(TransferResult {
                        transfer_id: id.clone(),
                        local_path: Some(local_path),
                        remote_path: Some(remote_path),
                    })
                }
                .await;
                finish_transfer(&inner, &id, generation, result);
            });
        Ok(transfer_id)
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
                let path = resolved_remote_path(&inner, Some(&path)).await?;
                let output =
                    execute_generation_checked(&inner, &git_repository_command(&path)).await?;
                if output.stdout_truncated {
                    return Err(HostRuntimeError::GitFailure(
                        "Git repository output exceeded the command limit".to_owned(),
                    ));
                }
                parse_git_repository(std::str::from_utf8(&output.stdout).map_err(|_| {
                    HostRuntimeError::GitFailure("Git repository output was not UTF-8".to_owned())
                })?)
                .map_err(HostRuntimeError::GitFailure)
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
