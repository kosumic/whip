use std::io::SeekFrom;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use russh::client;
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::watch;

use super::{
    CommandOutput, ExecDelivery, LengthFormat, NEXT_TEMP_ID, REMOTE_HOME_COMMAND, RemoteForward,
    Session, SftpEntry, SftpFileServer, SftpMetadata, ShellCommand, ShellDelivery,
    SshConnectionConfig, SshFailure, SshSession, SshShellClose, StreamCommand, TransportError,
    UnixSocketDelivery, browser_proxy, close_local_forward_for_key, connect_inner, connect_sftp_on,
    directory_download, disconnect_key, exec_channel_command_for_key, execute_on, latency_on,
    open_exec_channel_with_delivery, open_local_forward_on, open_unix_socket_channel_with_framing,
    request_unix_socket_bytes_on, reverse_forward, sessions, sftp_create_dir_all_on,
    sftp_file_servers, sftp_list_on, sftp_transfer_file_on, shell_command_for_id, shells,
    start_sftp_file_server_on, start_shell_on, unix_socket_channel_command_for_key,
    write_unix_socket_channel_for_key,
};

impl SshSession {
    pub(crate) async fn open_browser_proxy(&self) -> Result<u16, SshFailure> {
        browser_proxy::open(self.resource_key.clone(), self.inner.clone())
            .await
            .map_err(Into::into)
    }
    pub(crate) fn is_alive(&self) -> bool {
        self.inner.is_alive()
    }

    pub(crate) async fn disconnected(&self) -> String {
        self.inner.lifecycle.disconnected().await.reason.clone()
    }

    pub(crate) fn registered(key: &str) -> Result<Arc<Self>, SshFailure> {
        let inner = sessions()
            .read()
            .get(key)
            .cloned()
            .ok_or(TransportError::UnknownClient)?;
        Ok(Arc::new(Self {
            inner,
            resource_key: key.to_owned(),
        }))
    }

    pub(crate) async fn connect(
        config: &SshConnectionConfig,
        jump: Option<&SshSession>,
    ) -> Result<Arc<Self>, SshFailure> {
        let inner = connect_inner(config, jump.map(|session| session.inner.as_ref())).await?;
        Ok(Arc::new(Self {
            inner,
            resource_key: format!(
                "whip-owned-{}",
                NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ),
        }))
    }

    pub(crate) async fn execute(&self, command: &str) -> Result<CommandOutput, SshFailure> {
        execute_on(&self.inner, command).await.map_err(Into::into)
    }

    pub(crate) async fn open_direct_tcpip(
        &self,
        host: &str,
        port: u16,
    ) -> Result<russh::ChannelStream<client::Msg>, SshFailure> {
        self.inner
            .handle
            .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0)
            .await
            .map(russh::Channel::into_stream)
            .map_err(TransportError::from)
            .map_err(Into::into)
    }

    pub(crate) async fn remote_home(&self) -> Result<String, SshFailure> {
        self.inner.remote_home().await.map_err(Into::into)
    }

    pub(crate) async fn latency_ms(&self) -> Result<f64, SshFailure> {
        latency_on(&self.inner).await.map_err(Into::into)
    }

    pub(crate) async fn open_local_forward(
        &self,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<u16, SshFailure> {
        open_local_forward_on(
            self.resource_key.clone(),
            self.inner.clone(),
            remote_host.to_owned(),
            remote_port,
        )
        .await
        .map_err(Into::into)
    }

    pub(crate) fn close_local_forward(&self, local_port: u16) {
        close_local_forward_for_key(&self.resource_key, local_port);
    }

    pub(crate) async fn open_remote_forward(
        &self,
        local_port: u16,
    ) -> Result<RemoteForward, SshFailure> {
        self.open_remote_forward_at(local_port, 0).await
    }

    pub(crate) async fn open_remote_forward_at(
        &self,
        local_port: u16,
        remote_port: u16,
    ) -> Result<RemoteForward, SshFailure> {
        reverse_forward::open(self.inner.clone(), local_port, remote_port)
            .await
            .map_err(Into::into)
    }

    async fn ensure_sftp(&self) -> Result<Arc<SftpSession>, SshFailure> {
        connect_sftp_on(&self.inner).await.map_err(Into::into)
    }

    pub(crate) async fn sftp_list(&self, path: &str) -> Result<Vec<SftpEntry>, SshFailure> {
        let sftp = self.ensure_sftp().await?;
        sftp_list_on(&sftp, path).await.map_err(Into::into)
    }

    pub(crate) async fn sftp_stat(&self, path: &str) -> Result<SftpMetadata, SshFailure> {
        let sftp = self.ensure_sftp().await?;
        // STAT follows symlinks; directory listings retain the link's own kind.
        let metadata = sftp.metadata(path).await.map_err(TransportError::from)?;
        Ok(SftpMetadata::from(metadata))
    }

    pub(crate) async fn sftp_read_limited(
        &self,
        path: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, SshFailure> {
        let sftp = self.ensure_sftp().await?;
        let file = sftp.open(path).await.map_err(TransportError::from)?;
        let size = file.metadata().await.map_err(TransportError::from)?.size;
        if size.is_some_and(|size| size > max_bytes) {
            return Err(SshFailure::Transport {
                code: super::SshErrorCode::InvalidRequest,
                message: format!("remote file exceeds the {max_bytes}-byte read limit"),
            });
        }
        let capacity = usize::try_from(size.unwrap_or_default().min(max_bytes)).unwrap_or_default();
        let mut bytes = Vec::with_capacity(capacity);
        file.take(max_bytes.saturating_add(1))
            .read_to_end(&mut bytes)
            .await
            .map_err(TransportError::from)?;
        if bytes.len() as u64 > max_bytes {
            return Err(SshFailure::Transport {
                code: super::SshErrorCode::InvalidRequest,
                message: format!("remote file exceeds the {max_bytes}-byte read limit"),
            });
        }
        Ok(bytes)
    }

    pub(crate) async fn sftp_read_range(
        &self,
        path: &str,
        offset: u64,
        length: u64,
    ) -> Result<(SftpMetadata, Vec<u8>), SshFailure> {
        let sftp = self.ensure_sftp().await?;
        let mut file = sftp.open(path).await.map_err(TransportError::from)?;
        let metadata = file.metadata().await.map_err(TransportError::from)?;
        file.seek(SeekFrom::Start(offset))
            .await
            .map_err(TransportError::from)?;
        let capacity = usize::try_from(length).map_err(|_| {
            TransportError::InvalidRequest("SFTP read range is too large".to_owned())
        })?;
        let mut bytes = Vec::with_capacity(capacity);
        file.take(length)
            .read_to_end(&mut bytes)
            .await
            .map_err(TransportError::from)?;
        Ok((SftpMetadata::from(metadata), bytes))
    }

    pub(crate) async fn sftp_rename(&self, from: &str, to: &str) -> Result<(), SshFailure> {
        let sftp = self.ensure_sftp().await?;
        let invalid = |message: String| SshFailure::from(TransportError::InvalidRequest(message));
        if from == to {
            return Ok(());
        }
        let source = sftp
            .symlink_metadata(from)
            .await
            .map_err(TransportError::from)?;
        if source.file_type().is_dir() {
            let source_path = sftp
                .canonicalize(from)
                .await
                .map_err(TransportError::from)?;
            let parent = crate::remote_ops::remote_parent(to).map_err(invalid)?;
            let parent = sftp
                .canonicalize(parent)
                .await
                .map_err(TransportError::from)?;
            crate::remote_ops::validate_remote_move(&source_path, &parent).map_err(invalid)?;
        }
        match sftp.symlink_metadata(to).await {
            Ok(_) => {
                return Err(invalid(
                    "Destination already exists. Choose another name or directory.".to_owned(),
                ));
            }
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile => {}
            Err(error) => return Err(TransportError::from(error).into()),
        }
        // Standard SFTP RENAME rejects an existing destination, including a race
        // after LSTAT. Never use the overwrite-capable POSIX rename extension.
        sftp.rename(from, to).await.map_err(|error| {
            invalid(format!(
                "Server rejected rename/move (cross-filesystem moves may be unsupported): {error}"
            ))
        })?;
        Ok(())
    }

    pub(crate) async fn sftp_remove(&self, path: &str, directory: bool) -> Result<(), SshFailure> {
        let sftp = self.ensure_sftp().await?;
        if directory {
            sftp.remove_dir(path).await.map_err(TransportError::from)?;
        } else {
            sftp.remove_file(path).await.map_err(TransportError::from)?;
        }
        Ok(())
    }

    pub(crate) async fn sftp_create_dir_all(&self, path: &str) -> Result<(), SshFailure> {
        let sftp = self.ensure_sftp().await?;
        sftp_create_dir_all_on(&sftp, path)
            .await
            .map_err(Into::into)
    }

    pub(crate) async fn transfer_upload(
        &self,
        local_path: &str,
        destination_path: &str,
        cancel: watch::Receiver<bool>,
        progress: Arc<dyn Fn(u64, Option<u64>) + Send + Sync>,
    ) -> Result<String, SshFailure> {
        let sftp = self.ensure_sftp().await?;
        sftp_transfer_file_on(
            sftp,
            local_path.to_owned(),
            destination_path.to_owned(),
            true,
            cancel,
            move |copied, total| progress(copied, total),
        )
        .await
        .map_err(Into::into)
    }

    pub(crate) async fn transfer_download(
        &self,
        remote_path: &str,
        destination_path: &str,
        cancel: watch::Receiver<bool>,
        progress: Arc<dyn Fn(u64, Option<u64>) + Send + Sync>,
    ) -> Result<String, SshFailure> {
        let sftp = self.ensure_sftp().await?;
        let mut metadata = sftp
            .symlink_metadata(remote_path)
            .await
            .map_err(TransportError::from)?;
        // Explicitly opening a file link remains supported by previews. Tree
        // traversal never follows links; a selected link to a directory is refused.
        if metadata.file_type().is_symlink() {
            metadata = sftp
                .metadata(remote_path)
                .await
                .map_err(TransportError::from)?;
            if !metadata.file_type().is_file() {
                return Err(TransportError::InvalidRequest(
                    "Cannot recursively download a directory symlink".to_owned(),
                )
                .into());
            }
        }
        if metadata.file_type().is_dir() {
            return directory_download::download(
                sftp,
                remote_path,
                destination_path,
                cancel,
                progress,
            )
            .await
            .map_err(Into::into);
        }
        if !metadata.file_type().is_file() {
            return Err(TransportError::InvalidRequest(
                "Cannot download a symlink or special file".to_owned(),
            )
            .into());
        }
        sftp_transfer_file_on(
            sftp,
            destination_path.to_owned(),
            remote_path.to_owned(),
            false,
            cancel,
            move |copied, total| progress(copied, total),
        )
        .await
        .map_err(Into::into)
    }

    pub(crate) async fn start_sftp_file_server(
        &self,
        remote_path: &str,
    ) -> Result<SftpFileServer, SshFailure> {
        start_sftp_file_server_on(
            self.resource_key.clone(),
            self.inner.clone(),
            remote_path.to_owned(),
        )
        .await
        .map_err(Into::into)
    }

    pub(crate) fn close_sftp_file_server(&self, local_port: u16) {
        if let Some(cancel) = sftp_file_servers()
            .write()
            .remove(&(self.resource_key.clone(), local_port))
        {
            let _ = cancel.send(true);
        }
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the session wrapper forwards explicit shell geometry and lifecycle callbacks"
    )]
    pub(crate) async fn open_shell(
        &self,
        shell_id: &str,
        pty_type: &str,
        columns: u32,
        rows: u32,
        data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        closed: Arc<dyn Fn(SshShellClose) + Send + Sync>,
        initial_command: Option<&str>,
    ) -> Result<(), SshFailure> {
        start_shell_on(
            self.resource_key.clone(),
            shell_id.to_owned(),
            self.inner.clone(),
            pty_type.to_owned(),
            columns,
            rows,
            ShellDelivery::Rust { data, closed },
            initial_command,
        )
        .await
        .map_err(Into::into)
    }

    pub(crate) fn shell_input(&self, shell_id: &str, bytes: Vec<u8>) -> Result<(), SshFailure> {
        shell_command_for_id(&self.resource_key, shell_id, ShellCommand::Write(bytes))
            .map_err(Into::into)
    }

    pub(crate) fn resize_shell(
        &self,
        shell_id: &str,
        columns: u32,
        rows: u32,
    ) -> Result<(), SshFailure> {
        shell_command_for_id(
            &self.resource_key,
            shell_id,
            ShellCommand::Resize { columns, rows },
        )
        .map_err(Into::into)
    }

    pub(crate) fn close_shell(&self, shell_id: &str) -> Result<(), SshFailure> {
        shell_command_for_id(&self.resource_key, shell_id, ShellCommand::Close).map_err(Into::into)
    }

    pub(crate) fn has_shell(&self, shell_id: &str) -> bool {
        shells().read().contains(&self.resource_key, shell_id)
    }

    pub(crate) async fn request_unix_socket(
        &self,
        socket_path: &str,
        request: &[u8],
        response_terminator: u8,
        timeout_ms: u64,
        max_response_bytes: usize,
    ) -> Result<Vec<u8>, SshFailure> {
        request_unix_socket_bytes_on(
            &self.inner,
            socket_path,
            request,
            response_terminator,
            timeout_ms.clamp(1, 300_000),
            max_response_bytes.clamp(1, 32 * 1024 * 1024),
        )
        .await
        .map_err(Into::into)
    }

    pub(crate) async fn open_unix_socket(
        &self,
        channel_id: &str,
        socket_path: &str,
        max_frame_bytes: usize,
        frame: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        closed: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<(), SshFailure> {
        open_unix_socket_channel_with_framing(
            self.resource_key.clone(),
            channel_id.to_owned(),
            self.inner.clone(),
            socket_path.to_owned(),
            None,
            max_frame_bytes,
            UnixSocketDelivery::Rust { frame, closed },
        )
        .await
        .map_err(Into::into)
    }

    pub(crate) async fn open_length_prefixed_unix_socket(
        &self,
        channel_id: &str,
        socket_path: &str,
        max_frame_bytes: usize,
        frame: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        closed: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<(), SshFailure> {
        open_unix_socket_channel_with_framing(
            self.resource_key.clone(),
            channel_id.to_owned(),
            self.inner.clone(),
            socket_path.to_owned(),
            Some(LengthFormat::U32Le),
            max_frame_bytes,
            UnixSocketDelivery::Rust { frame, closed },
        )
        .await
        .map_err(Into::into)
    }

    pub(crate) fn write_unix_socket(
        &self,
        channel_id: &str,
        bytes: Vec<u8>,
        length_prefixed: bool,
    ) -> Result<(), SshFailure> {
        write_unix_socket_channel_for_key(&self.resource_key, channel_id, bytes, length_prefixed)
            .map_err(Into::into)
    }

    pub(crate) fn close_unix_socket(&self, channel_id: &str) -> Result<(), SshFailure> {
        unix_socket_channel_command_for_key(&self.resource_key, channel_id, StreamCommand::Close)
            .map_err(Into::into)
    }

    pub(crate) async fn open_exec(
        &self,
        channel_id: &str,
        command: &str,
        data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        closed: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<(), SshFailure> {
        open_exec_channel_with_delivery(
            self.resource_key.clone(),
            channel_id.to_owned(),
            self.inner.clone(),
            command.to_owned(),
            ExecDelivery::Rust { data, closed },
        )
        .await
        .map_err(Into::into)
    }

    pub(crate) fn close_exec(&self, channel_id: &str) -> Result<(), SshFailure> {
        exec_channel_command_for_key(&self.resource_key, channel_id, StreamCommand::Close)
            .map_err(Into::into)
    }

    pub(crate) async fn disconnect(&self) {
        reverse_forward::close_routes(&self.inner.reverse_forwards);
        self.inner
            .lifecycle
            .mark_disconnected("SSH session closed by application");
        disconnect_key(self.resource_key.clone()).await;
        let _ = self
            .inner
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
}

impl Session {
    pub(super) async fn remote_home(&self) -> Result<String, TransportError> {
        self.ensure_alive()?;
        // Serialize initialization across all wrappers of this connection.
        // Cancellation or transport failure leaves the cache empty for retries.
        let mut cached = self.remote_home.lock().await;
        self.ensure_alive()?;
        if let Some(home) = cached.as_ref() {
            return Ok(home.clone());
        }
        let output = execute_on(self, REMOTE_HOME_COMMAND).await?;
        self.ensure_alive()?;
        let home = String::from_utf8_lossy(&output.stdout).into_owned();
        if output.exit_status == Some(0)
            && crate::remote_ops::normalize_absolute(home.trim()).is_ok()
        {
            *cached = Some(home.clone());
        }
        drop(cached);
        // Keep returning the command's original output. Path callers perform
        // their existing validation and report their existing path errors.
        Ok(home)
    }
}
