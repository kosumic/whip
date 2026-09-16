//! SSH transport owned by the Whip Rust core.
//!
//! Control-plane operations and latency-sensitive terminal traffic cross the
//! public boundary through typed UniFFI calls. HostRuntime composes with this
//! module through ordinary typed Rust handles; there is no native callback ABI
//! between the SSH and Herdr implementations.

mod known_hosts;
mod session;

use std::collections::HashMap;
use std::ffi::CStr;
#[cfg(target_os = "android")]
use std::ffi::c_char;
use std::future::Future;
use std::io::SeekFrom;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

use futures::{channel::mpsc as futures_mpsc, future::try_join_all};
use parking_lot::RwLock;
use russh::client;
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader},
};

pub use self::known_hosts::{HostKeyChallenge, KnownHostStoreError, TrustedHostKey};
use self::known_hosts::{HostKeyDecision, KnownHosts};

type Sessions = RwLock<HashMap<String, Arc<Session>>>;
type SftpSessions = RwLock<HashMap<String, Arc<SftpSession>>>;

#[derive(Debug)]
struct GroupedChannels<T>(HashMap<String, HashMap<String, T>>);

impl<T> Default for GroupedChannels<T> {
    fn default() -> Self {
        Self(HashMap::new())
    }
}

impl<T> GroupedChannels<T> {
    fn contains(&self, owner: &str, id: &str) -> bool {
        self.get(owner, id).is_some()
    }

    fn get(&self, owner: &str, id: &str) -> Option<&T> {
        self.0.get(owner)?.get(id)
    }

    fn insert(&mut self, owner: String, id: String, value: T) -> Option<T> {
        self.0.entry(owner).or_default().insert(id, value)
    }

    fn remove(&mut self, owner: &str, id: &str) -> Option<T> {
        let (removed, owner_is_empty) = {
            let channels = self.0.get_mut(owner)?;
            let removed = channels.remove(id);
            (removed, channels.is_empty())
        };
        if owner_is_empty {
            self.0.remove(owner);
        }
        removed
    }

    fn remove_if(&mut self, owner: &str, id: &str, predicate: impl FnOnce(&T) -> bool) {
        let should_remove = self.get(owner, id).is_some_and(predicate);
        if should_remove {
            self.remove(owner, id);
        }
    }

    fn remove_owner(&mut self, owner: &str) -> Option<HashMap<String, T>> {
        self.0.remove(owner)
    }
}

type Shells = RwLock<GroupedChannels<mpsc::Sender<ShellCommand>>>;
type ExecChannels = RwLock<GroupedChannels<mpsc::Sender<StreamCommand>>>;
type UnixSocketChannels = RwLock<GroupedChannels<UnixSocketChannelHandle>>;

const TERMINAL_INBOUND_RUST_FRAME_DELIVERY: &CStr = c"Whip terminal inbound Rust frame delivery";
const TERMINAL_INBOUND_RUST_FRAME_RECEIVED: &CStr = c"Whip terminal inbound Rust frame received";
const EXEC_INBOUND_RUST_CHUNK_DELIVERY: &CStr = c"Whip exec inbound Rust chunk delivery";
const EXEC_INBOUND_RUST_CHUNK_RECEIVED: &CStr = c"Whip exec inbound Rust chunk received";
const HOST_LATENCY_PING_DISPATCH: &CStr = c"Whip SSH latency ping dispatch";
const HOST_LATENCY_PING_POLL: &CStr = c"Whip SSH latency ping future poll";
const HOST_LATENCY_PING_REPLY: &CStr = c"Whip SSH latency ping reply";
const HOST_LATENCY_PING_ERROR: &CStr = c"Whip SSH latency ping error";
const HOST_LATENCY_DISCONNECTED: &CStr = c"Whip SSH latency transport disconnected";
const HOST_LATENCY_TIMEOUT: &CStr = c"Whip SSH latency timeout";

#[cfg(target_os = "android")]
struct AndroidTraceSlice(bool);

#[cfg(target_os = "android")]
impl AndroidTraceSlice {
    fn begin(name: &CStr) -> Self {
        // Checking first avoids CString work and kernel trace writes when the
        // app is not part of an active Perfetto/atrace capture.
        // SAFETY: This Android-only FFI call has no parameters or preconditions.
        let enabled = unsafe { ATrace_isEnabled() };
        if enabled {
            // SAFETY: `name` is a live, NUL-terminated C string for the duration
            // of the synchronous NDK trace call.
            unsafe { ATrace_beginSection(name.as_ptr()) };
        }
        Self(enabled)
    }
}

#[cfg(target_os = "android")]
impl Drop for AndroidTraceSlice {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: `self.0` records a successful begin on this thread, so this
            // call balances that NDK trace section.
            unsafe { ATrace_endSection() };
        }
    }
}

fn trace_instant(name: &'static CStr) {
    let _trace = AndroidTraceSlice::begin(name);
}

async fn trace_polled<F>(name: &'static CStr, future: F) -> F::Output
where
    F: Future,
{
    tokio::pin!(future);
    std::future::poll_fn(|context| {
        let _trace = AndroidTraceSlice::begin(name);
        future.as_mut().poll(context)
    })
    .await
}

#[cfg(target_os = "android")]
#[link(name = "android")]
unsafe extern "C" {
    fn ATrace_isEnabled() -> bool;
    fn ATrace_beginSection(section_name: *const c_char);
    fn ATrace_endSection();
}

#[cfg(not(target_os = "android"))]
struct AndroidTraceSlice;

#[cfg(not(target_os = "android"))]
impl AndroidTraceSlice {
    fn begin(_name: &CStr) -> Self {
        Self
    }
}
type Forwards = RwLock<HashMap<(String, u16), watch::Sender<bool>>>;
type SftpFileServers = RwLock<HashMap<(String, u16), watch::Sender<bool>>>;
type Transfers = RwLock<HashMap<(String, &'static str), watch::Sender<bool>>>;

static SESSIONS: OnceLock<Sessions> = OnceLock::new();
static KNOWN_HOSTS: OnceLock<RwLock<KnownHosts>> = OnceLock::new();
static UNIFFI_EVENT_SINK: OnceLock<RwLock<Option<Arc<dyn WhipSshEventSink>>>> = OnceLock::new();
static SHELLS: OnceLock<Shells> = OnceLock::new();
static SFTP_SESSIONS: OnceLock<SftpSessions> = OnceLock::new();
static EXEC_CHANNELS: OnceLock<ExecChannels> = OnceLock::new();
static UNIX_SOCKET_CHANNELS: OnceLock<UnixSocketChannels> = OnceLock::new();
static FORWARDS: OnceLock<Forwards> = OnceLock::new();
static SFTP_FILE_SERVERS: OnceLock<SftpFileServers> = OnceLock::new();
static TRANSFERS: OnceLock<Transfers> = OnceLock::new();
static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);
static LIFECYCLE_EPOCH: AtomicU64 = AtomicU64::new(1);

const CONTROL_QUEUE_CAPACITY: usize = 256;
const INBOUND_DELIVERY_QUEUE_CAPACITY: usize = 64;
const INBOUND_DELIVERY_BYTE_CAPACITY: usize = 8 * 1024 * 1024;
const HOST_LATENCY_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DISCONNECT_REASON_CHARS: usize = 256;
const EXECUTE_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const SFTP_HTTP_HEADER_LIMIT: usize = 16 * 1024;
const SFTP_HTTP_PIPELINE_DEPTH: usize = 8;
const SFTP_HTTP_READ_SIZE: u64 = 256 * 1024;
const SFTP_HTTP_SERVER_LIFETIME: Duration = Duration::from_hours(1);
const REMOTE_HOME_COMMAND: &str = r#"printf %s "$HOME""#;
const COMPATIBILITY_SHELL_ID: &str = "default";

#[derive(Debug, thiserror::Error)]
enum TransportError {
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("unknown client")]
    UnknownClient,
    #[error("authentication failed")]
    AuthenticationFailed,
    #[error("{0}")]
    ChannelUnavailable(String),
    #[error("{0}")]
    HostUnreachable(String),
    #[error("unknown SSH host key")]
    HostKeyUnknown(known_hosts::HostKeyChallenge),
    #[error("SSH host key changed")]
    HostKeyChanged(known_hosts::HostKeyChallenge),
    #[error("SSH host certificates are not supported")]
    UnsupportedHostCertificate,
    #[error("SSH transport disconnected: {0}")]
    SessionClosed(String),
    #[error("{0}")]
    Ssh(#[from] russh::Error),
    #[error("{0}")]
    Key(#[from] russh::keys::Error),
    #[error("{0}")]
    SshKey(#[from] russh::keys::ssh_key::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Sftp(#[from] russh_sftp::client::error::Error),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, uniffi::Enum)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SshErrorCode {
    AuthenticationFailed,
    HostKeyUnknown,
    HostKeyChanged,
    UnsupportedHostCertificate,
    ConnectionRefused,
    ConnectionTimeout,
    HostUnreachable,
    ChannelUnavailable,
    SessionClosed,
    InvalidPrivateKey,
    SftpFailure,
    InvalidRequest,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum SshAuthentication {
    Password {
        password: String,
    },
    Key {
        private_key: String,
        passphrase: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct SshKeyDetails {
    pub key_type: String,
    pub key_size: u32,
    pub fingerprint: String,
    pub public_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct SshGeneratedKeyPair {
    pub private_key: String,
    pub public_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct LegacySftpEntry {
    pub filename: String,
    pub is_directory: bool,
    pub modification_date: String,
    pub last_access: String,
    pub file_size: u64,
    pub owner_user_id: u32,
    pub owner_group_id: u32,
    pub permissions: String,
    pub flags: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct LegacySftpFileServer {
    pub local_port: u16,
    pub token: String,
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum SshError {
    #[error("{0}")]
    AuthenticationFailed(String),
    #[error("unknown SSH host key")]
    HostKeyUnknown(HostKeyChallenge),
    #[error("SSH host key changed")]
    HostKeyChanged(HostKeyChallenge),
    #[error("SSH host certificates are not supported")]
    UnsupportedHostCertificate,
    #[error("{0}")]
    ConnectionRefused(String),
    #[error("{0}")]
    ConnectionTimeout(String),
    #[error("{0}")]
    HostUnreachable(String),
    #[error("{0}")]
    ChannelUnavailable(String),
    #[error("{0}")]
    SessionClosed(String),
    #[error("{0}")]
    InvalidPrivateKey(String),
    #[error("{0}")]
    SftpFailure(String),
    #[error("{0}")]
    InvalidRequest(String),
    #[error("{0}")]
    Unknown(String),
}

impl From<TransportError> for SshError {
    fn from(error: TransportError) -> Self {
        let code = transport_error_code(&error);
        match error {
            TransportError::HostKeyUnknown(challenge) => Self::HostKeyUnknown(challenge),
            TransportError::HostKeyChanged(challenge) => Self::HostKeyChanged(challenge),
            TransportError::UnsupportedHostCertificate => Self::UnsupportedHostCertificate,
            error => {
                let message = error.to_string();
                match code {
                    SshErrorCode::AuthenticationFailed => Self::AuthenticationFailed(message),
                    SshErrorCode::ConnectionRefused => Self::ConnectionRefused(message),
                    SshErrorCode::ConnectionTimeout => Self::ConnectionTimeout(message),
                    SshErrorCode::HostUnreachable => Self::HostUnreachable(message),
                    SshErrorCode::ChannelUnavailable => Self::ChannelUnavailable(message),
                    SshErrorCode::SessionClosed => Self::SessionClosed(message),
                    SshErrorCode::InvalidPrivateKey => Self::InvalidPrivateKey(message),
                    SshErrorCode::SftpFailure => Self::SftpFailure(message),
                    SshErrorCode::InvalidRequest => Self::InvalidRequest(message),
                    SshErrorCode::Unknown
                    | SshErrorCode::HostKeyUnknown
                    | SshErrorCode::HostKeyChanged
                    | SshErrorCode::UnsupportedHostCertificate => Self::Unknown(message),
                }
            }
        }
    }
}

fn transport_error_code(error: &TransportError) -> SshErrorCode {
    match error {
        TransportError::InvalidRequest(_) => SshErrorCode::InvalidRequest,
        TransportError::UnknownClient | TransportError::SessionClosed(_) => {
            SshErrorCode::SessionClosed
        }
        TransportError::AuthenticationFailed => SshErrorCode::AuthenticationFailed,
        TransportError::ChannelUnavailable(_) => SshErrorCode::ChannelUnavailable,
        TransportError::HostUnreachable(_) => SshErrorCode::HostUnreachable,
        TransportError::HostKeyUnknown(_) => SshErrorCode::HostKeyUnknown,
        TransportError::HostKeyChanged(_) => SshErrorCode::HostKeyChanged,
        TransportError::UnsupportedHostCertificate => SshErrorCode::UnsupportedHostCertificate,
        TransportError::Ssh(error) => match error {
            russh::Error::WrongChannel | russh::Error::ChannelOpenFailure(_) => {
                SshErrorCode::ChannelUnavailable
            }
            russh::Error::Disconnect
            | russh::Error::HUP
            | russh::Error::SendError
            | russh::Error::RecvError => SshErrorCode::SessionClosed,
            russh::Error::ConnectionTimeout
            | russh::Error::KeepaliveTimeout
            | russh::Error::InactivityTimeout
            | russh::Error::Elapsed(_) => SshErrorCode::ConnectionTimeout,
            russh::Error::IO(error) => io_error_code(error),
            _ => SshErrorCode::Unknown,
        },
        TransportError::Key(_) | TransportError::SshKey(_) => SshErrorCode::InvalidPrivateKey,
        TransportError::Io(error) => io_error_code(error),
        TransportError::Sftp(_) => SshErrorCode::SftpFailure,
    }
}

fn io_error_code(error: &std::io::Error) -> SshErrorCode {
    match error.kind() {
        std::io::ErrorKind::ConnectionRefused => SshErrorCode::ConnectionRefused,
        std::io::ErrorKind::TimedOut => SshErrorCode::ConnectionTimeout,
        std::io::ErrorKind::NotConnected
        | std::io::ErrorKind::ConnectionReset
        | std::io::ErrorKind::ConnectionAborted
        | std::io::ErrorKind::BrokenPipe
        | std::io::ErrorKind::UnexpectedEof
        | std::io::ErrorKind::AddrNotAvailable
        | std::io::ErrorKind::NetworkUnreachable
        | std::io::ErrorKind::HostUnreachable => SshErrorCode::HostUnreachable,
        _ => SshErrorCode::Unknown,
    }
}

fn classify_direct_connect_error(error: TransportError) -> TransportError {
    match error {
        TransportError::Ssh(russh::Error::IO(source))
            if io_error_code(&source) == SshErrorCode::Unknown =>
        {
            TransportError::HostUnreachable(source.to_string())
        }
        error => error,
    }
}

#[uniffi::export(with_foreign)]
pub trait WhipSshEventSink: Send + Sync {
    fn emit(&self, event_json: String);
    fn unix_socket_channel_data(&self, key: String, channel_id: String, bytes: Vec<u8>);
    fn exec_channel_data(&self, key: String, channel_id: String, bytes: Vec<u8>);
}

struct Session {
    handle: client::Handle<RusshHandler>,
    agent: Arc<AgentState>,
    lifecycle: Arc<ConnectionLifecycle>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ConnectionDisconnect {
    reason: String,
}

struct ConnectionLifecycle {
    alive: AtomicBool,
    disconnected: watch::Sender<Option<Arc<ConnectionDisconnect>>>,
}

impl Default for ConnectionLifecycle {
    fn default() -> Self {
        let (disconnected, _) = watch::channel(None);
        Self {
            alive: AtomicBool::new(true),
            disconnected,
        }
    }
}

impl ConnectionLifecycle {
    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    fn mark_disconnected(&self, reason: impl Into<String>) -> bool {
        if self
            .alive
            .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        self.disconnected
            .send_replace(Some(Arc::new(ConnectionDisconnect {
                reason: reason.into(),
            })));
        true
    }

    async fn disconnected(&self) -> Arc<ConnectionDisconnect> {
        let mut receiver = self.disconnected.subscribe();
        loop {
            if let Some(disconnect) = receiver.borrow().clone() {
                return disconnect;
            }
            if receiver.changed().await.is_err() {
                return Arc::new(ConnectionDisconnect {
                    reason: "SSH transport disconnected".to_owned(),
                });
            }
        }
    }
}

fn concise_disconnect_reason(reason: &str) -> String {
    let mut characters = reason.chars();
    let mut concise = characters
        .by_ref()
        .take(MAX_DISCONNECT_REASON_CHARS)
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    if characters.next().is_some() {
        concise.push('…');
    }
    concise
}

impl Session {
    fn is_alive(&self) -> bool {
        self.lifecycle.is_alive() && !self.handle.is_closed()
    }

    fn ensure_alive(&self) -> Result<(), TransportError> {
        if self.is_alive() {
            Ok(())
        } else {
            Err(TransportError::SessionClosed(
                self.lifecycle.disconnected.borrow().as_ref().map_or_else(
                    || "session is closed".to_owned(),
                    |event| event.reason.clone(),
                ),
            ))
        }
    }
}

/// Authenticated SSH session owned directly by a Whip host runtime.
///
/// `resource_key` scopes shell/channel compatibility registries; connection
/// lookup never goes through the process-wide React Native session map.
pub(crate) struct SshSession {
    inner: Arc<Session>,
    resource_key: String,
}

#[derive(Clone, Debug)]
pub(crate) enum SshCredential {
    Password(String),
    Key {
        private_key: String,
        passphrase: Option<String>,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct SshConnectionConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub credential: SshCredential,
    pub forward_agent: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SshFailure {
    Authentication(String),
    HostKeyUnknown(Box<HostKeyChallenge>),
    HostKeyChanged(Box<HostKeyChallenge>),
    UnsupportedHostCertificate,
    Transport { code: SshErrorCode, message: String },
}

impl std::fmt::Display for SshFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Authentication(message) | Self::Transport { message, .. } => {
                formatter.write_str(message)
            }
            Self::HostKeyUnknown(_) => formatter.write_str("unknown SSH host key"),
            Self::HostKeyChanged(_) => formatter.write_str("SSH host key changed"),
            Self::UnsupportedHostCertificate => {
                formatter.write_str("SSH host certificates are not supported")
            }
        }
    }
}

impl std::error::Error for SshFailure {}

impl From<TransportError> for SshFailure {
    fn from(error: TransportError) -> Self {
        let code = transport_error_code(&error);
        match error {
            TransportError::HostKeyUnknown(challenge) => Self::HostKeyUnknown(Box::new(challenge)),
            TransportError::HostKeyChanged(challenge) => Self::HostKeyChanged(Box::new(challenge)),
            TransportError::UnsupportedHostCertificate => Self::UnsupportedHostCertificate,
            error if code == SshErrorCode::AuthenticationFailed => {
                Self::Authentication(error.to_string())
            }
            error => Self::Transport {
                code,
                message: error.to_string(),
            },
        }
    }
}

trait AgentIo: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Sync + Unpin {}
impl<T> AgentIo for T where T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Sync + Unpin {}
type AgentSender = futures_mpsc::UnboundedSender<std::io::Result<Box<dyn AgentIo>>>;

#[derive(Default)]
struct AgentState {
    enabled: AtomicBool,
    sender: RwLock<Option<AgentSender>>,
}

#[derive(Clone)]
struct RestrictedAgent {
    allow_initial_add: Arc<AtomicBool>,
}

impl russh::keys::agent::server::Agent for RestrictedAgent {
    fn confirm_request(
        &self,
        message: russh::keys::agent::server::MessageType,
    ) -> impl Future<Output = bool> + Send {
        std::future::ready(match message {
            russh::keys::agent::server::MessageType::RequestKeys
            | russh::keys::agent::server::MessageType::Sign => true,
            russh::keys::agent::server::MessageType::AddKeys => {
                self.allow_initial_add.swap(false, Ordering::Relaxed)
            }
            _ => false,
        })
    }
}

enum ShellCommand {
    Write(Vec<u8>),
    Resize { columns: u32, rows: u32 },
    Close,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SshShellClose {
    TransportDisconnected(String),
    ChannelClosed(String),
}

impl SshShellClose {
    pub(crate) fn reason(&self) -> &str {
        match self {
            Self::TransportDisconnected(reason) | Self::ChannelClosed(reason) => reason,
        }
    }
}

#[derive(Clone)]
enum ShellDelivery {
    ReactNative,
    Rust {
        data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        closed: Arc<dyn Fn(SshShellClose) + Send + Sync>,
    },
}

enum StreamCommand {
    Write(Vec<u8>),
    Close,
}

#[derive(Clone)]
struct UnixSocketChannelHandle {
    sender: mpsc::Sender<StreamCommand>,
    framing: Option<LengthFormat>,
}

struct OwnedInboundFrame {
    bytes: Vec<u8>,
    _byte_permit: OwnedSemaphorePermit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LengthFormat {
    U8,
    U16Le,
    U16Be,
    U32Le,
    U32Be,
}

/// Delivery target for an owned Unix-socket channel.
#[derive(Clone)]
enum UnixSocketDelivery {
    ReactNative,
    Rust {
        frame: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        closed: Arc<dyn Fn(String) + Send + Sync>,
    },
}

/// Product-neutral delivery target for an owned exec channel.
#[derive(Clone)]
enum ExecDelivery {
    ReactNative,
    Rust {
        data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        closed: Arc<dyn Fn(String) + Send + Sync>,
    },
}

#[derive(Clone)]
struct RusshHandler {
    host: String,
    port: u16,
    agent: Arc<AgentState>,
    lifecycle: Arc<ConnectionLifecycle>,
}

impl RusshHandler {
    fn verify_server_key(
        &self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, TransportError> {
        let PublicKeyOrCertificate::PublicKey {
            key: server_public_key,
            ..
        } = server_public_key
        else {
            return Err(TransportError::UnsupportedHostCertificate);
        };
        let decision = known_hosts()
            .read()
            .check(&self.host, self.port, server_public_key);
        match decision {
            HostKeyDecision::Trusted => Ok(true),
            HostKeyDecision::Unknown(challenge) => Err(TransportError::HostKeyUnknown(challenge)),
            HostKeyDecision::Changed(challenge) => Err(TransportError::HostKeyChanged(challenge)),
        }
    }
}

impl client::Handler for RusshHandler {
    type Error = TransportError;

    fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        std::future::ready(self.verify_server_key(server_public_key))
    }

    fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        let lifecycle = self.lifecycle.clone();
        async move {
            match reason {
                client::DisconnectReason::ReceivedDisconnect(info) => {
                    let message = concise_disconnect_reason(info.message.trim());
                    let reason = if message.is_empty() {
                        format!("remote SSH disconnect ({:?})", info.reason_code)
                    } else {
                        format!("remote SSH disconnect ({:?}): {message}", info.reason_code)
                    };
                    lifecycle.mark_disconnected(reason);
                    Ok(())
                }
                client::DisconnectReason::Error(error) => {
                    lifecycle.mark_disconnected(concise_disconnect_reason(&error.to_string()));
                    Err(error)
                }
            }
        }
    }

    fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let enabled = self.agent.enabled.load(Ordering::Relaxed);
        let sender = self.agent.sender.read().clone();
        async move {
            let Some(sender) = sender.filter(|_| enabled) else {
                return Ok(());
            };
            reply.accept().await;
            sender
                .unbounded_send(Ok(Box::new(channel.into_stream())))
                .map_err(|_| {
                    TransportError::InvalidRequest("forwarded SSH agent is closed".to_owned())
                })?;
            Ok(())
        }
    }
}

fn runtime() -> Result<&'static tokio::runtime::Runtime, String> {
    crate::runtime()
}

fn sessions() -> &'static Sessions {
    SESSIONS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn known_hosts() -> &'static RwLock<KnownHosts> {
    KNOWN_HOSTS.get_or_init(|| RwLock::new(KnownHosts::default()))
}

#[uniffi::export]
pub fn set_trusted_host_keys(entries: Vec<TrustedHostKey>) -> Result<(), KnownHostStoreError> {
    let parsed = KnownHosts::from_trusted(entries)?;
    *known_hosts().write() = parsed;
    Ok(())
}

fn shells() -> &'static Shells {
    SHELLS.get_or_init(|| RwLock::new(GroupedChannels::default()))
}

fn uniffi_event_sink() -> &'static RwLock<Option<Arc<dyn WhipSshEventSink>>> {
    UNIFFI_EVENT_SINK.get_or_init(|| RwLock::new(None))
}
fn sftp_sessions() -> &'static SftpSessions {
    SFTP_SESSIONS.get_or_init(|| RwLock::new(HashMap::new()))
}
fn exec_channels() -> &'static ExecChannels {
    EXEC_CHANNELS.get_or_init(|| RwLock::new(GroupedChannels::default()))
}
fn unix_socket_channels() -> &'static UnixSocketChannels {
    UNIX_SOCKET_CHANNELS.get_or_init(|| RwLock::new(GroupedChannels::default()))
}
fn forwards() -> &'static Forwards {
    FORWARDS.get_or_init(|| RwLock::new(HashMap::new()))
}
fn sftp_file_servers() -> &'static SftpFileServers {
    SFTP_FILE_SERVERS.get_or_init(|| RwLock::new(HashMap::new()))
}
fn transfers() -> &'static Transfers {
    TRANSFERS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn emit_event(value: Value) {
    let Ok(json) = serde_json::to_string(&value) else {
        return;
    };
    let sink = uniffi_event_sink().read().clone();
    if let Some(sink) = sink {
        sink.emit(json);
    }
}

fn key_details(
    private_key: &str,
    passphrase: Option<&str>,
) -> Result<SshKeyDetails, TransportError> {
    let key = russh::keys::decode_secret_key(private_key, passphrase)?;
    let public_key = key.public_key();
    let key_size = match public_key.algorithm() {
        russh::keys::Algorithm::Ed25519 => 256,
        russh::keys::Algorithm::Ecdsa { curve } => match curve {
            russh::keys::EcdsaCurve::NistP256 => 256,
            russh::keys::EcdsaCurve::NistP384 => 384,
            russh::keys::EcdsaCurve::NistP521 => 521,
        },
        russh::keys::Algorithm::Rsa { .. } => public_key
            .key_data()
            .rsa()
            .map(ssh_key::public::RsaPublicKey::key_size)
            .unwrap_or_default(),
        _ => 0,
    };
    Ok(SshKeyDetails {
        key_type: public_key.algorithm().as_str().to_owned(),
        key_size,
        fingerprint: public_key
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string(),
        public_key: public_key.to_openssh()?,
    })
}

fn generate_key_pair(
    key_type: &str,
    passphrase: &str,
    comment: &str,
) -> Result<SshGeneratedKeyPair, TransportError> {
    if key_type != "ed25519" && key_type != "ssh-ed25519" {
        return Err(TransportError::InvalidRequest(
            "the iOS Rust preview currently generates Ed25519 keys only".to_owned(),
        ));
    }
    let mut rng =
        russh::keys::ssh_key::rand_core::UnwrapErr(russh::keys::ssh_key::getrandom::SysRng);
    let mut private_key =
        russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519)?;
    private_key.set_comment(comment);
    let public_key = private_key.public_key().to_openssh()?;
    if !passphrase.is_empty() {
        private_key =
            private_key.encrypt(&mut russh::keys::ssh_key::getrandom::SysRng, passphrase)?;
    }
    let private_key = private_key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)?
        .to_string();
    Ok(SshGeneratedKeyPair {
        private_key,
        public_key,
    })
}

async fn initialize_agent(
    private_key: Arc<russh::keys::PrivateKey>,
    state: Arc<AgentState>,
) -> Result<(), TransportError> {
    let (sender, receiver) = futures_mpsc::unbounded::<std::io::Result<Box<dyn AgentIo>>>();
    let agent_policy = RestrictedAgent {
        allow_initial_add: Arc::new(AtomicBool::new(true)),
    };
    tokio::spawn(async move {
        let _ = russh::keys::agent::server::serve(receiver, agent_policy).await;
    });

    // Seed the private key into the in-process agent over the same protocol
    // used by forwarded clients. The remote side can list and sign with it,
    // but RestrictedAgent rejects add/remove/lock requests.
    let (client_stream, server_stream) = tokio::io::duplex(256 * 1024);
    sender
        .unbounded_send(Ok(Box::new(server_stream)))
        .map_err(|_| TransportError::InvalidRequest("could not start SSH agent".to_owned()))?;
    let mut agent = russh::keys::agent::client::AgentClient::connect(client_stream);
    agent.add_identity(&private_key, &[]).await?;
    *state.sender.write() = Some(sender);
    Ok(())
}

async fn connect_compatibility_session(
    host: String,
    port: u16,
    username: String,
    authentication: SshAuthentication,
    key: String,
    jump_key: Option<String>,
) -> Result<(), TransportError> {
    let credential = match authentication {
        SshAuthentication::Password { password } => SshCredential::Password(password),
        SshAuthentication::Key {
            private_key,
            passphrase,
        } => SshCredential::Key {
            private_key,
            passphrase,
        },
    };
    let config = SshConnectionConfig {
        host,
        port,
        username,
        credential,
        forward_agent: false,
    };
    let jump = jump_key
        .as_deref()
        .map(|jump_key| {
            sessions().read().get(jump_key).cloned().ok_or_else(|| {
                TransportError::InvalidRequest("jump host SSH connection is not active".to_owned())
            })
        })
        .transpose()?;
    let session = connect_inner(&config, jump.as_deref()).await?;
    let previous = sessions().write().insert(key, session);
    // Install an authenticated replacement first, then retire the old handle.
    if let Some(previous) = previous {
        let _ = previous
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    Ok(())
}

async fn connect_inner(
    connection: &SshConnectionConfig,
    jump: Option<&Session>,
) -> Result<Arc<Session>, TransportError> {
    let host = connection.host.trim().to_owned();
    let port = connection.port;
    let username = connection.username.trim().to_owned();
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });
    let agent = Arc::new(AgentState::default());
    let lifecycle = Arc::new(ConnectionLifecycle::default());
    let handler = RusshHandler {
        host: host.clone(),
        port,
        agent: agent.clone(),
        lifecycle: lifecycle.clone(),
    };
    let mut handle = if let Some(jump) = jump {
        let channel = jump
            .handle
            .channel_open_direct_tcpip(host.clone(), u32::from(port), "127.0.0.1", 0)
            .await?;
        client::connect_stream(config, channel.into_stream(), handler).await?
    } else {
        client::connect(config, (host.as_str(), port), handler)
            .await
            .map_err(classify_direct_connect_error)?
    };

    let mut forwarding_key = None;
    let authenticated = match &connection.credential {
        SshCredential::Password(password) => {
            authenticate_password(&mut handle, &username, password).await?
        }
        SshCredential::Key {
            private_key,
            passphrase,
        } => {
            let key_pair = Arc::new(russh::keys::decode_secret_key(
                private_key,
                passphrase.as_deref(),
            )?);
            let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
            let auth_key = PrivateKeyWithHashAlg::new(key_pair.clone(), hash_alg);
            let result = handle
                .authenticate_publickey(&username, auth_key)
                .await?
                .success();
            if result {
                forwarding_key = Some(key_pair);
            }
            result
        }
    };
    if !authenticated {
        return Err(TransportError::AuthenticationFailed);
    }
    if let Some(private_key) = forwarding_key {
        initialize_agent(private_key, agent.clone()).await?;
    }
    let session = Arc::new(Session {
        handle,
        agent,
        lifecycle,
    });
    if connection.forward_agent {
        session.agent.enabled.store(true, Ordering::Relaxed);
    }
    Ok(session)
}

async fn authenticate_password(
    handle: &mut client::Handle<RusshHandler>,
    username: &str,
    password: &str,
) -> Result<bool, TransportError> {
    if handle
        .authenticate_password(username, password)
        .await?
        .success()
    {
        return Ok(true);
    }

    // macOS and other PAM-backed SSH servers commonly present a password
    // through keyboard-interactive authentication. OpenSSH clients fall back
    // automatically, so mirror that behavior without answering unknown MFA
    // or challenge prompts.
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await?;
    for _ in 0..3 {
        match response {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(true),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let Some(responses) =
                    keyboard_interactive_password_responses(&prompts, username, password)
                else {
                    return Ok(false);
                };
                response = handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await?;
            }
        }
    }
    Ok(false)
}

fn keyboard_interactive_password_responses(
    prompts: &[client::Prompt],
    username: &str,
    password: &str,
) -> Option<Vec<String>> {
    prompts
        .iter()
        .map(|prompt| {
            let label = prompt.prompt.to_ascii_lowercase();
            if prompt.echo && (label.contains("user") || label.contains("login")) {
                Some(username.to_owned())
            } else if !prompt.echo && (label.contains("password") || prompts.len() == 1) {
                Some(password.to_owned())
            } else {
                None
            }
        })
        .collect()
}

async fn request_agent_forwarding(
    session: &Session,
    channel: &russh::Channel<client::Msg>,
) -> Result<(), TransportError> {
    if session.agent.enabled.load(Ordering::Relaxed) {
        channel.agent_forward(true).await?;
    }
    Ok(())
}

fn append_capped(destination: &mut Vec<u8>, source: &[u8]) -> bool {
    let remaining = EXECUTE_OUTPUT_LIMIT.saturating_sub(destination.len());
    destination.extend_from_slice(&source[..source.len().min(remaining)]);
    source.len() > remaining
}

pub(crate) struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: Option<u32>,
    pub stdout_truncated: bool,
}

async fn execute_on(session: &Session, command: &str) -> Result<CommandOutput, TransportError> {
    session.ensure_alive()?;
    let mut channel = session.handle.channel_open_session().await?;
    request_agent_forwarding(session, &channel).await?;
    channel.exec(true, command).await?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let mut exit_status = None;
    while let Some(message) = channel.wait().await {
        match message {
            russh::ChannelMsg::Data { data } => {
                stdout_truncated |= append_capped(&mut stdout, &data);
            }
            russh::ChannelMsg::ExtendedData { data, ext: 1 } => {
                stderr_truncated |= append_capped(&mut stderr, &data);
            }
            russh::ChannelMsg::ExitStatus {
                exit_status: status,
            } => exit_status = Some(status),
            _ => {}
        }
    }
    if stdout_truncated {
        stdout.extend_from_slice(b"\n[whip-ssh: stdout truncated at 8 MiB]\n");
    }
    if stderr_truncated {
        stderr.extend_from_slice(b"\n[whip-ssh: stderr truncated at 8 MiB]\n");
    }
    Ok(CommandOutput {
        stdout,
        stderr,
        exit_status,
        stdout_truncated,
    })
}

async fn latency_on(session: &Session) -> Result<f64, TransportError> {
    latency_probe(
        &session.lifecycle,
        session.handle.is_closed(),
        session.handle.send_ping(),
    )
    .await
}

async fn latency_probe<F>(
    lifecycle: &ConnectionLifecycle,
    handle_is_closed: bool,
    ping: F,
) -> Result<f64, TransportError>
where
    F: Future<Output = Result<(), russh::Error>>,
{
    if handle_is_closed || !lifecycle.is_alive() {
        return Err(TransportError::SessionClosed(
            lifecycle.disconnected.borrow().as_ref().map_or_else(
                || "session is closed".to_owned(),
                |event| event.reason.clone(),
            ),
        ));
    }
    let start = Instant::now();
    trace_instant(HOST_LATENCY_PING_DISPATCH);
    let ping = trace_polled(HOST_LATENCY_PING_POLL, ping);
    tokio::select! {
        biased;
        disconnect = lifecycle.disconnected() => {
            trace_instant(HOST_LATENCY_DISCONNECTED);
            return Err(TransportError::SessionClosed(disconnect.reason.clone()));
        }
        result = ping => match result {
            Ok(()) => trace_instant(HOST_LATENCY_PING_REPLY),
            Err(error) => {
                trace_instant(HOST_LATENCY_PING_ERROR);
                return Err(error.into());
            }
        },
        _ = tokio::time::sleep(HOST_LATENCY_PROBE_TIMEOUT) => {
            trace_instant(HOST_LATENCY_TIMEOUT);
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "SSH latency probe timed out",
            ).into());
        }
    }
    if !lifecycle.is_alive() {
        return Err(TransportError::SessionClosed(
            "session closed during SSH latency probe".to_owned(),
        ));
    }
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}

async fn select_channel_loops<T, R, W, D, F>(
    read_loop: R,
    write_loop: W,
    disconnect: D,
    disconnected: F,
) -> T
where
    R: Future<Output = T>,
    W: Future<Output = T>,
    D: Future<Output = String>,
    F: FnOnce(String) -> T,
{
    tokio::select! {
        biased;
        reason = disconnect => disconnected(reason),
        reason = read_loop => reason,
        reason = write_loop => reason,
    }
}

fn shell_write_failure(action: &str, error: &russh::Error) -> String {
    format!("SSH {action} failed: {error}")
}

fn shell_eof_reason(close_reason: &str) -> String {
    if close_reason == "remote shell closed" {
        "remote shell EOF".to_owned()
    } else {
        close_reason.to_owned()
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "shell identity, geometry, transport, and delivery are independent protocol inputs"
)]
async fn start_shell_on(
    key: String,
    shell_id: String,
    session: Arc<Session>,
    pty_type: String,
    columns: u32,
    rows: u32,
    delivery: ShellDelivery,
) -> Result<(), TransportError> {
    session.ensure_alive()?;
    if shells().read().contains(&key, &shell_id) {
        return Err(TransportError::InvalidRequest(format!(
            "shell '{shell_id}' is already open"
        )));
    }
    let channel = session.handle.channel_open_session().await?;
    channel
        .request_pty(false, &pty_type, columns, rows, 0, 0, &[])
        .await?;
    request_agent_forwarding(&session, &channel).await?;
    channel.request_shell(true).await?;
    let (sender, mut receiver) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    {
        let mut shells = shells().write();
        if shells.contains(&key, &shell_id) {
            return Err(TransportError::InvalidRequest(format!(
                "shell '{shell_id}' is already open"
            )));
        }
        shells.insert(key.clone(), shell_id.clone(), sender.clone());
    }
    let lifecycle = session.lifecycle.clone();
    let (mut reader, writer) = channel.split();
    tokio::spawn(async move {
        let read_delivery = delivery.clone();
        let read_key = key.clone();
        let read_loop = async move {
            let mut close_reason = "remote shell closed".to_owned();
            loop {
                match reader.wait().await {
                    Some(
                        russh::ChannelMsg::Data { data }
                        | russh::ChannelMsg::ExtendedData { data, .. },
                    ) => match &read_delivery {
                        ShellDelivery::ReactNative => emit_event(json!({
                            "name": "Shell",
                            "key": read_key,
                            "value": String::from_utf8_lossy(&data),
                        })),
                        ShellDelivery::Rust { data: deliver, .. } => deliver(data.to_vec()),
                    },
                    Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                        close_reason = format!("remote shell exited with status {exit_status}");
                    }
                    Some(russh::ChannelMsg::Eof) => {
                        close_reason = shell_eof_reason(&close_reason);
                        break;
                    }
                    Some(russh::ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            SshShellClose::ChannelClosed(close_reason)
        };
        let write_loop = async {
            loop {
                match receiver.recv().await {
                    Some(ShellCommand::Write(data)) => {
                        if let Err(error) = writer.data_bytes(data).await {
                            break SshShellClose::ChannelClosed(shell_write_failure(
                                "channel write",
                                &error,
                            ));
                        }
                    }
                    Some(ShellCommand::Resize { columns, rows }) => {
                        if let Err(error) = writer.window_change(columns, rows, 0, 0).await {
                            break SshShellClose::ChannelClosed(shell_write_failure(
                                "resize", &error,
                            ));
                        }
                    }
                    Some(ShellCommand::Close) | None => {
                        let _ = writer.eof().await;
                        let _ = writer.close().await;
                        break SshShellClose::ChannelClosed(
                            "shell closed by application".to_owned(),
                        );
                    }
                }
            }
        };
        let close_reason = select_channel_loops(
            read_loop,
            write_loop,
            async move { lifecycle.disconnected().await.reason.clone() },
            |reason| {
                SshShellClose::TransportDisconnected(format!(
                    "SSH transport disconnected: {reason}"
                ))
            },
        )
        .await;
        let _ = writer.eof().await;
        let _ = writer.close().await;
        shells()
            .write()
            .remove_if(&key, &shell_id, |current| current.same_channel(&sender));
        match delivery {
            ShellDelivery::ReactNative => emit_event(json!({ "name": "ShellClosed", "key": key })),
            ShellDelivery::Rust { closed, .. } => closed(close_reason),
        }
    });
    Ok(())
}

fn shell_command_for_key(key: &str, command: ShellCommand) -> Result<(), TransportError> {
    shell_command_for_id(key, COMPATIBILITY_SHELL_ID, command)
}

fn shell_command_for_id(
    key: &str,
    shell_id: &str,
    command: ShellCommand,
) -> Result<(), TransportError> {
    let sender = shells()
        .read()
        .get(key, shell_id)
        .cloned()
        .ok_or(TransportError::UnknownClient)?;
    sender.try_send(command).map_err(|error| {
        TransportError::ChannelUnavailable(format!("shell control queue rejected input: {error}"))
    })?;
    Ok(())
}

async fn connect_sftp_on(key: &str, session: &Session) -> Result<(), TransportError> {
    session.ensure_alive()?;
    if sftp_sessions().read().contains_key(key) {
        return Ok(());
    }
    let channel = session.handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(channel.into_stream()).await?;
    sftp_sessions()
        .write()
        .insert(key.to_owned(), Arc::new(sftp));
    Ok(())
}

fn sftp_for_key(key: &str) -> Result<Arc<SftpSession>, TransportError> {
    let sftp = sftp_sessions()
        .read()
        .get(key)
        .cloned()
        .ok_or_else(|| TransportError::InvalidRequest("SFTP is not connected".to_owned()))?;
    Ok(sftp)
}

pub(crate) struct SftpEntry {
    pub filename: String,
    pub is_directory: bool,
    pub metadata: SftpMetadata,
}

#[derive(Clone, Debug)]
pub(crate) struct SftpMetadata {
    pub is_directory: bool,
    pub is_regular: bool,
    pub is_symlink: bool,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
    pub accessed_at: Option<u64>,
    pub owner_user_id: Option<u32>,
    pub owner_group_id: Option<u32>,
    pub permissions: Option<u32>,
}

impl From<russh_sftp::protocol::FileAttributes> for SftpMetadata {
    fn from(metadata: russh_sftp::protocol::FileAttributes) -> Self {
        Self {
            is_directory: metadata.is_dir(),
            is_regular: metadata.is_regular(),
            is_symlink: metadata.is_symlink(),
            size: metadata.size,
            modified_at: metadata.mtime.map(u64::from),
            accessed_at: metadata.atime.map(u64::from),
            owner_user_id: metadata.uid,
            owner_group_id: metadata.gid,
            permissions: metadata.permissions,
        }
    }
}

async fn sftp_list_on(sftp: &SftpSession, path: &str) -> Result<Vec<SftpEntry>, TransportError> {
    let entries = sftp
        .read_dir(path)
        .await?
        .map(|entry| {
            let metadata = entry.metadata();
            let mut filename = entry.file_name();
            let metadata = SftpMetadata::from(metadata);
            let is_directory = metadata.is_directory;
            if is_directory {
                filename.push('/');
            }
            SftpEntry {
                filename,
                is_directory,
                metadata,
            }
        })
        .collect::<Vec<_>>();
    Ok(entries)
}

enum SftpMutation {
    CreateDirectory,
    RemoveFile,
    RemoveDirectory,
    Chmod(u32),
}

async fn sftp_mutation(
    key: &str,
    path: String,
    mutation: SftpMutation,
) -> Result<(), TransportError> {
    let sftp = sftp_for_key(key)?;
    match mutation {
        SftpMutation::CreateDirectory => sftp.create_dir(path).await?,
        SftpMutation::RemoveFile => sftp.remove_file(path).await?,
        SftpMutation::RemoveDirectory => sftp.remove_dir(path).await?,
        SftpMutation::Chmod(requested) => {
            let mut metadata = sftp.metadata(path.clone()).await?;
            let file_type = metadata.permissions.unwrap_or_default() & !0o7777;
            metadata.permissions = Some(file_type | (requested & 0o7777));
            sftp.set_metadata(path, metadata).await?;
        }
    }
    Ok(())
}

async fn sftp_create_dir_all_on(
    sftp: &SftpSession,
    remote_path: &str,
) -> Result<(), TransportError> {
    if remote_path.is_empty() {
        return Err(TransportError::InvalidRequest(
            "remote directory path must not be empty".to_owned(),
        ));
    }

    let mut current = if remote_path.starts_with('/') {
        "/".to_owned()
    } else {
        String::new()
    };
    for component in remote_path
        .split('/')
        .filter(|component| !component.is_empty())
    {
        if component == "." {
            continue;
        }
        if !current.is_empty() && current != "/" {
            current.push('/');
        }
        current.push_str(component);

        match sftp.metadata(current.clone()).await {
            Ok(metadata) if metadata.is_dir() => continue,
            Ok(_) => {
                return Err(TransportError::InvalidRequest(format!(
                    "remote path component '{current}' is not a directory"
                )));
            }
            Err(_) => {}
        }

        if let Err(create_error) = sftp.create_dir(current.clone()).await {
            // Another client may have created the directory after metadata.
            // Treat that race as success, but do not hide file collisions or
            // the original server error.
            match sftp.metadata(current.clone()).await {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    return Err(TransportError::InvalidRequest(format!(
                        "remote path component '{current}' is not a directory"
                    )));
                }
                Err(_) => return Err(create_error.into()),
            }
        }
    }

    if current.is_empty() {
        return Err(TransportError::InvalidRequest(
            "remote directory path must contain a directory".to_owned(),
        ));
    }
    Ok(())
}

fn transfer_cancelled(direction: &str) -> TransportError {
    TransportError::InvalidRequest(format!("SFTP {direction} cancelled"))
}

async fn wait_for_transfer_cancel(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

async fn cancellable_transfer_io<T, E, F>(
    cancel: &mut watch::Receiver<bool>,
    direction: &str,
    future: F,
) -> Result<T, TransportError>
where
    F: Future<Output = Result<T, E>>,
    TransportError: From<E>,
{
    tokio::select! {
        biased;
        _ = wait_for_transfer_cancel(cancel) => Err(transfer_cancelled(direction)),
        result = future => result.map_err(TransportError::from),
    }
}

async fn copy_sftp_stream(
    mut source: impl tokio::io::AsyncRead + Unpin + Send,
    mut destination: impl tokio::io::AsyncWrite + Unpin + Send,
    total: Option<u64>,
    direction: &str,
    cancel: &mut watch::Receiver<bool>,
    progress: &mut (impl FnMut(u64, Option<u64>) + Send),
) -> Result<(), TransportError> {
    let mut copied = 0u64;
    let mut last_reported_bytes = 0u64;
    let mut last_report = Instant::now();
    let mut buffer = vec![0u8; 64 * 1024];
    progress(0, total);
    loop {
        let count = cancellable_transfer_io(cancel, direction, source.read(&mut buffer)).await?;
        if count == 0 {
            break;
        }
        cancellable_transfer_io(cancel, direction, destination.write_all(&buffer[..count])).await?;
        copied = copied.saturating_add(count as u64);
        if copied.saturating_sub(last_reported_bytes) >= 256 * 1024
            || last_report.elapsed() >= Duration::from_millis(100)
        {
            progress(copied, total);
            last_reported_bytes = copied;
            last_report = Instant::now();
        }
    }
    cancellable_transfer_io(cancel, direction, destination.shutdown()).await?;
    progress(copied, total);
    Ok(())
}

// Both the owned session and compatibility API use exact file paths here.
// This engine owns copying, cancellation, temporary files, and publication.
async fn sftp_transfer_file_on(
    sftp: Arc<SftpSession>,
    local_path: String,
    remote_path: String,
    upload: bool,
    mut cancel: watch::Receiver<bool>,
    mut progress: impl FnMut(u64, Option<u64>) + Send,
) -> Result<String, TransportError> {
    let direction = if upload { "upload" } else { "download" };
    if *cancel.borrow() {
        return Err(transfer_cancelled(direction));
    }
    if upload {
        let source = fs::File::open(&local_path).await?;
        let total = Some(source.metadata().await?.len());
        let transfer_id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let temp_path = format!("{remote_path}.whip-upload-{transfer_id}");
        let destination = sftp.create(temp_path.clone()).await?;
        let copied = copy_sftp_stream(
            source,
            destination,
            total,
            direction,
            &mut cancel,
            &mut progress,
        )
        .await;
        if let Err(error) = copied {
            let _ = sftp.remove_file(temp_path).await;
            return Err(error);
        }
        if *cancel.borrow() {
            let _ = sftp.remove_file(temp_path).await;
            return Err(transfer_cancelled(direction));
        }
        let backup_path = format!("{remote_path}.whip-backup-{transfer_id}");
        let prior_metadata = sftp.metadata(remote_path.clone()).await.ok();
        if *cancel.borrow() {
            let _ = sftp.remove_file(temp_path).await;
            return Err(transfer_cancelled(direction));
        }
        if prior_metadata
            .as_ref()
            .is_some_and(russh_sftp::protocol::FileAttributes::is_dir)
        {
            let _ = sftp.remove_file(temp_path).await;
            return Err(TransportError::InvalidRequest(
                "upload destination is a directory".to_owned(),
            ));
        }
        let had_prior_file = prior_metadata.is_some();
        if let Some(permissions) = prior_metadata.and_then(|metadata| metadata.permissions) {
            let metadata = russh_sftp::protocol::FileAttributes {
                permissions: Some(permissions),
                ..Default::default()
            };
            if let Err(error) = sftp.set_metadata(temp_path.clone(), metadata).await {
                let _ = sftp.remove_file(temp_path).await;
                return Err(error.into());
            }
        }
        if had_prior_file {
            // Standard SFTP rename may not replace an existing file. Keep the
            // old destination until publication succeeds so it can be restored.
            if let Err(error) = sftp.rename(remote_path.clone(), backup_path.clone()).await {
                let _ = sftp.remove_file(temp_path).await;
                return Err(error.into());
            }
        }
        if *cancel.borrow() {
            if had_prior_file {
                let _ = sftp.rename(backup_path, remote_path).await;
            }
            let _ = sftp.remove_file(temp_path).await;
            return Err(transfer_cancelled(direction));
        }
        if let Err(error) = sftp.rename(temp_path.clone(), remote_path.clone()).await {
            let _ = sftp.remove_file(temp_path).await;
            if had_prior_file {
                let _ = sftp.rename(backup_path, remote_path).await;
            }
            return Err(error.into());
        }
        if *cancel.borrow() {
            let _ = sftp.remove_file(remote_path.clone()).await;
            if had_prior_file {
                let _ = sftp.rename(backup_path, remote_path).await;
            }
            return Err(transfer_cancelled(direction));
        }
        if had_prior_file {
            let _ = sftp.remove_file(backup_path).await;
        }
        Ok(remote_path)
    } else {
        let source = sftp.open(&remote_path).await?;
        let total = source.metadata().await?.size;
        let temp_path = format!(
            "{local_path}.whip-download-{}",
            NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
        );
        let destination = fs::File::create(&temp_path).await?;
        let copied = copy_sftp_stream(
            source,
            destination,
            total,
            direction,
            &mut cancel,
            &mut progress,
        )
        .await;
        if let Err(error) = copied {
            let _ = fs::remove_file(temp_path).await;
            return Err(error);
        }
        if *cancel.borrow() {
            let _ = fs::remove_file(temp_path).await;
            return Err(transfer_cancelled(direction));
        }
        if let Err(error) = fs::rename(&temp_path, &local_path).await {
            let _ = fs::remove_file(temp_path).await;
            return Err(error.into());
        }
        // Local rename atomically commits the download. After this point the
        // previous destination is gone; keep the committed file on late cancellation.
        Ok(local_path)
    }
}

fn transfer_destination(
    directory: &str,
    source: &str,
    side: &str,
) -> Result<String, TransportError> {
    let filename = std::path::Path::new(source)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| TransportError::InvalidRequest(format!("{side} path has no filename")))?;
    Ok(format!("{}/{filename}", directory.trim_end_matches('/')))
}

async fn sftp_transfer_on(
    key: String,
    sftp: Arc<SftpSession>,
    local: String,
    remote_path: String,
    upload: bool,
    upload_to_exact_path: bool,
) -> Result<String, TransportError> {
    let direction = if upload { "upload" } else { "download" };
    let event = if upload {
        "UploadProgress"
    } else {
        "DownloadProgress"
    };
    let (cancel_sender, cancel) = watch::channel(false);
    {
        let mut active = transfers().write();
        if active.contains_key(&(key.clone(), direction)) {
            return Err(TransportError::InvalidRequest(format!(
                "an SFTP {direction} is already active for this connection"
            )));
        }
        active.insert((key.clone(), direction), cancel_sender);
    }
    let result = async {
        let (local_path, remote_path) = if upload {
            let destination = if upload_to_exact_path {
                if remote_path.is_empty() || remote_path.ends_with('/') {
                    return Err(TransportError::InvalidRequest(
                        "exact remote upload path must end with a filename".to_owned(),
                    ));
                }
                remote_path
            } else {
                transfer_destination(&remote_path, &local, "local")?
            };
            (local, destination)
        } else {
            let destination = transfer_destination(&local, &remote_path, "remote")?;
            (destination, remote_path)
        };
        let mut last_percent = None;
        let destination = sftp_transfer_file_on(
            sftp,
            local_path,
            remote_path,
            upload,
            cancel,
            |copied, total| {
                let percent = copied
                    .saturating_mul(100)
                    .checked_div(total.unwrap_or_default())
                    .unwrap_or(100);
                if last_percent != Some(percent) {
                    emit_event(json!({ "name": event, "key": key, "value": percent.to_string() }));
                    last_percent = Some(percent);
                }
            },
        )
        .await?;
        if last_percent != Some(100) {
            emit_event(json!({ "name": event, "key": key, "value": "100" }));
        }
        Ok(if upload { String::new() } else { destination })
    }
    .await;
    transfers().write().remove(&(key, direction));
    result
}

async fn request_unix_socket_bytes_on(
    session: &Session,
    socket_path: &str,
    request: &[u8],
    response_terminator: u8,
    timeout_ms: u64,
    max_response_bytes: usize,
) -> Result<Vec<u8>, TransportError> {
    session.ensure_alive()?;
    let channel = session
        .handle
        .channel_open_direct_streamlocal(socket_path)
        .await?;
    let mut stream = BufReader::new(channel.into_stream());
    stream.write_all(request).await?;
    let mut reader = stream.take(max_response_bytes as u64 + 1);
    let mut response = Vec::new();
    tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        reader.read_until(response_terminator, &mut response),
    )
    .await
    .map_err(|_| {
        TransportError::InvalidRequest("timed out waiting for Unix-socket response".to_owned())
    })??;
    if response.len() > max_response_bytes {
        return Err(TransportError::InvalidRequest(format!(
            "Unix-socket response exceeds {max_response_bytes} bytes"
        )));
    }
    if response.last() != Some(&response_terminator) {
        return Err(TransportError::InvalidRequest(
            "Unix-socket response ended before its terminator".to_owned(),
        ));
    }
    response.pop();
    Ok(response)
}

fn emit_unix_socket_channel_data(key: &str, channel_id: &str, bytes: Vec<u8>) {
    let sink = uniffi_event_sink().read().clone();
    if let Some(sink) = sink {
        sink.unix_socket_channel_data(key.to_owned(), channel_id.to_owned(), bytes);
    }
}

impl LengthFormat {
    fn parse(value: &str) -> Result<Self, TransportError> {
        match value {
            "u8" => Ok(Self::U8),
            "u16le" => Ok(Self::U16Le),
            "u16be" => Ok(Self::U16Be),
            "u32le" => Ok(Self::U32Le),
            "u32be" => Ok(Self::U32Be),
            _ => Err(TransportError::InvalidRequest(format!(
                "unsupported length format '{value}'"
            ))),
        }
    }

    fn prefix(self, length: usize) -> Result<Vec<u8>, TransportError> {
        let overflow = || {
            TransportError::InvalidRequest(format!(
                "frame length {length} cannot be represented by this length format"
            ))
        };
        match self {
            Self::U8 => Ok(vec![u8::try_from(length).map_err(|_| overflow())?]),
            Self::U16Le => Ok(u16::try_from(length)
                .map_err(|_| overflow())?
                .to_le_bytes()
                .to_vec()),
            Self::U16Be => Ok(u16::try_from(length)
                .map_err(|_| overflow())?
                .to_be_bytes()
                .to_vec()),
            Self::U32Le => Ok(u32::try_from(length)
                .map_err(|_| overflow())?
                .to_le_bytes()
                .to_vec()),
            Self::U32Be => Ok(u32::try_from(length)
                .map_err(|_| overflow())?
                .to_be_bytes()
                .to_vec()),
        }
    }

    fn width(self) -> usize {
        match self {
            Self::U8 => 1,
            Self::U16Le | Self::U16Be => 2,
            Self::U32Le | Self::U32Be => 4,
        }
    }

    fn decode_length(self, prefix: &[u8]) -> usize {
        match self {
            Self::U8 => prefix[0] as usize,
            Self::U16Le => u16::from_le_bytes([prefix[0], prefix[1]]) as usize,
            Self::U16Be => u16::from_be_bytes([prefix[0], prefix[1]]) as usize,
            Self::U32Le => {
                u32::from_le_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize
            }
            Self::U32Be => {
                u32::from_be_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize
            }
        }
    }
}

struct LengthPrefixedFrameReader {
    format: LengthFormat,
    max_frame_bytes: usize,
    prefix: [u8; 4],
    prefix_read: usize,
    payload: Option<Vec<u8>>,
    payload_read: usize,
}

impl LengthPrefixedFrameReader {
    fn new(format: LengthFormat, max_frame_bytes: usize) -> Self {
        Self {
            format,
            max_frame_bytes,
            prefix: [0; 4],
            prefix_read: 0,
            payload: None,
            payload_read: 0,
        }
    }

    async fn read_frame<R>(&mut self, reader: &mut R) -> Result<Option<Vec<u8>>, TransportError>
    where
        R: tokio::io::AsyncRead + Unpin,
    {
        loop {
            if self.payload.is_none() {
                let prefix_width = self.format.width();
                if self.prefix_read < prefix_width {
                    let count = reader
                        .read(&mut self.prefix[self.prefix_read..prefix_width])
                        .await?;
                    if count == 0 {
                        if self.prefix_read == 0 {
                            return Ok(None);
                        }
                        return Err(TransportError::InvalidRequest(
                            "Unix-socket channel ended during a length prefix".to_owned(),
                        ));
                    }
                    self.prefix_read += count;
                    continue;
                }

                let length = self.format.decode_length(&self.prefix[..prefix_width]);
                if length > self.max_frame_bytes {
                    return Err(TransportError::InvalidRequest(format!(
                        "Unix-socket frame exceeds {} bytes: {length}",
                        self.max_frame_bytes
                    )));
                }
                self.payload = Some(vec![0; length]);
                self.payload_read = 0;
                if length == 0 {
                    self.prefix_read = 0;
                    return Ok(self.payload.take());
                }
            }

            let Some(payload) = self.payload.as_mut() else {
                continue;
            };
            let count = reader.read(&mut payload[self.payload_read..]).await?;
            if count == 0 {
                return Err(TransportError::InvalidRequest(
                    "Unix-socket channel ended during a length-prefixed frame".to_owned(),
                ));
            }
            self.payload_read += count;
            if self.payload_read == payload.len() {
                self.prefix_read = 0;
                self.payload_read = 0;
                return Ok(self.payload.take());
            }
        }
    }
}

async fn enqueue_unix_socket_frame(
    sender: &mpsc::Sender<OwnedInboundFrame>,
    byte_budget: &Arc<Semaphore>,
    bytes: Vec<u8>,
) -> Result<(), TransportError> {
    // A frame larger than the byte budget reserves the whole budget. This
    // permits the configured maximum frame size while ensuring that no other
    // completed frame can queue behind it.
    let byte_permits =
        u32::try_from(bytes.len().clamp(1, INBOUND_DELIVERY_BYTE_CAPACITY)).unwrap_or(u32::MAX);
    let byte_permit = byte_budget
        .clone()
        .acquire_many_owned(byte_permits)
        .await
        .map_err(|_| {
            TransportError::ChannelUnavailable(
                "Unix-socket inbound delivery queue closed".to_owned(),
            )
        })?;
    sender
        .send(OwnedInboundFrame {
            bytes,
            _byte_permit: byte_permit,
        })
        .await
        .map_err(|_| {
            TransportError::ChannelUnavailable(
                "Unix-socket inbound delivery worker stopped".to_owned(),
            )
        })
}

async fn read_unix_socket_frames<R>(
    mut socket_reader: R,
    framing: Option<LengthFormat>,
    max_frame_bytes: usize,
    sender: mpsc::Sender<OwnedInboundFrame>,
    byte_budget: Arc<Semaphore>,
) -> (String, bool)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = vec![0u8; 32 * 1024];
    let mut framed_reader =
        framing.map(|format| LengthPrefixedFrameReader::new(format, max_frame_bytes));
    loop {
        let read = match &mut framed_reader {
            Some(frame_reader) => frame_reader.read_frame(&mut socket_reader).await,
            None => match socket_reader.read(&mut buffer).await {
                Ok(0) => Ok(None),
                Ok(count) => Ok(Some(buffer[..count].to_vec())),
                Err(error) => Err(error.into()),
            },
        };
        match read {
            Ok(None) => return ("remote Unix socket reached EOF".to_owned(), false),
            Err(error) => {
                return (format!("remote Unix-socket read failed: {error}"), false);
            }
            Ok(Some(bytes)) => {
                // A synchronous ATrace slice must not cross the queue's await:
                // Tokio may resume this task on another OS thread.
                {
                    let _trace = AndroidTraceSlice::begin(TERMINAL_INBOUND_RUST_FRAME_RECEIVED);
                }
                if let Err(error) = enqueue_unix_socket_frame(&sender, &byte_budget, bytes).await {
                    return (
                        format!("remote Unix-socket delivery failed: {error}"),
                        false,
                    );
                }
            }
        }
    }
}

async fn write_unix_socket_commands<W>(
    mut writer: W,
    mut receiver: mpsc::Receiver<StreamCommand>,
) -> (String, bool)
where
    W: tokio::io::AsyncWrite + Unpin,
{
    loop {
        match receiver.recv().await {
            Some(StreamCommand::Write(data)) => {
                if let Err(error) = writer.write_all(&data).await {
                    return (format!("remote Unix-socket write failed: {error}"), false);
                }
            }
            Some(StreamCommand::Close) => {
                return ("Unix-socket channel closed by client".to_owned(), true);
            }
            None => {
                return ("Unix-socket channel control queue closed".to_owned(), true);
            }
        }
    }
}

async fn deliver_unix_socket_frames(
    key: Arc<str>,
    channel_id: Arc<str>,
    delivery: UnixSocketDelivery,
    mut receiver: mpsc::Receiver<OwnedInboundFrame>,
) -> Result<(), String> {
    while let Some(frame) = receiver.recv().await {
        let OwnedInboundFrame {
            bytes,
            _byte_permit: byte_permit,
        } = frame;
        let key = Arc::clone(&key);
        let channel_id = Arc::clone(&channel_id);
        let delivery = delivery.clone();
        tokio::task::spawn_blocking(move || {
            // The owned frame and its byte-budget permit remain alive until
            // invokeBlocking has returned, preserving RustBuffer lifetime.
            let _byte_permit = byte_permit;
            let _trace = AndroidTraceSlice::begin(TERMINAL_INBOUND_RUST_FRAME_DELIVERY);
            match delivery {
                UnixSocketDelivery::ReactNative => {
                    emit_unix_socket_channel_data(&key, &channel_id, bytes);
                }
                UnixSocketDelivery::Rust { frame, .. } => frame(bytes),
            }
        })
        .await
        .map_err(|error| format!("Unix-socket inbound delivery worker failed: {error}"))?;
    }
    Ok(())
}

async fn open_unix_socket_channel_with_framing(
    key: String,
    channel_id: String,
    session: Arc<Session>,
    socket_path: String,
    framing: Option<LengthFormat>,
    max_frame_bytes: usize,
    delivery: UnixSocketDelivery,
) -> Result<(), TransportError> {
    session.ensure_alive()?;
    if channel_id.is_empty() || channel_id.len() > 128 || channel_id.chars().any(char::is_control) {
        return Err(TransportError::InvalidRequest(
            "channelId must contain 1 through 128 printable characters".to_owned(),
        ));
    }
    if unix_socket_channels().read().contains(&key, &channel_id) {
        return Err(TransportError::InvalidRequest(format!(
            "Unix-socket channel '{channel_id}' is already open"
        )));
    }

    let channel = session
        .handle
        .channel_open_direct_streamlocal(socket_path)
        .await?;
    let (sender, receiver) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    {
        let mut channels = unix_socket_channels().write();
        if channels.contains(&key, &channel_id) {
            return Err(TransportError::InvalidRequest(format!(
                "Unix-socket channel '{channel_id}' is already open"
            )));
        }
        channels.insert(
            key.clone(),
            channel_id.clone(),
            UnixSocketChannelHandle {
                sender: sender.clone(),
                framing,
            },
        );
    }

    tokio::spawn(async move {
        let (socket_reader, socket_writer) = tokio::io::split(channel.into_stream());
        let (delivery_sender, delivery_receiver) = mpsc::channel(INBOUND_DELIVERY_QUEUE_CAPACITY);
        let delivery_byte_budget = Arc::new(Semaphore::new(INBOUND_DELIVERY_BYTE_CAPACITY));
        let mut read_task = tokio::spawn(read_unix_socket_frames(
            socket_reader,
            framing,
            max_frame_bytes,
            delivery_sender,
            delivery_byte_budget,
        ));
        let mut write_task = tokio::spawn(write_unix_socket_commands(socket_writer, receiver));
        let delivery_task = tokio::spawn(deliver_unix_socket_frames(
            Arc::<str>::from(key.as_str()),
            Arc::<str>::from(channel_id.as_str()),
            delivery.clone(),
            delivery_receiver,
        ));

        // A blocked JS callback can stop only delivery. Reads backpressure at
        // the bounded queue, while control writes continue on their own task.
        let (reason, closed_by_client) = tokio::select! {
            result = &mut read_task => {
                write_task.abort();
                let _ = write_task.await;
                match result {
                    Ok(outcome) => outcome,
                    Err(error) => (format!("Unix-socket reader task failed: {error}"), false),
                }
            },
            result = &mut write_task => {
                read_task.abort();
                let _ = read_task.await;
                match result {
                    Ok(outcome) => outcome,
                    Err(error) => (format!("Unix-socket writer task failed: {error}"), false),
                }
            },
        };
        unix_socket_channels()
            .write()
            .remove_if(&key, &channel_id, |current| {
                current.sender.same_channel(&sender)
            });
        // Dropping/aborting the reader closes delivery_sender. Drain all owned
        // frames before reporting closure so data and close ordering is stable.
        let delivery_reason = match delivery_task.await {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(error) => Some(format!("Unix-socket delivery task failed: {error}")),
        };
        let reason = delivery_reason.unwrap_or(reason);
        match delivery {
            UnixSocketDelivery::ReactNative => emit_event(json!({
                "name": "UnixSocketChannel",
                "key": key,
                "value": {
                    "type": "closed",
                    "channelId": channel_id,
                    "reason": reason,
                    "closedByClient": closed_by_client,
                },
            })),
            UnixSocketDelivery::Rust { closed, .. } => closed(reason),
        }
    });

    Ok(())
}

fn unix_socket_channel_command_for_key(
    key: &str,
    channel_id: &str,
    command: StreamCommand,
) -> Result<(), TransportError> {
    let handle = unix_socket_channels()
        .read()
        .get(key, channel_id)
        .cloned()
        .ok_or_else(|| {
            TransportError::ChannelUnavailable(format!(
                "Unix-socket channel '{channel_id}' is not open"
            ))
        })?;
    handle.sender.try_send(command).map_err(|error| {
        TransportError::ChannelUnavailable(format!(
            "Unix-socket channel '{channel_id}' rejected input: {error}"
        ))
    })?;
    Ok(())
}

fn write_unix_socket_channel_for_key(
    key: &str,
    channel_id: &str,
    bytes: Vec<u8>,
    framed: bool,
) -> Result<(), TransportError> {
    let handle = unix_socket_channels()
        .read()
        .get(key, channel_id)
        .cloned()
        .ok_or_else(|| {
            TransportError::ChannelUnavailable(format!(
                "Unix-socket channel '{channel_id}' is not open"
            ))
        })?;
    let data = match (handle.framing, framed) {
        (None, false) => bytes,
        (Some(format), true) => {
            let mut framed_bytes = format.prefix(bytes.len())?;
            framed_bytes.extend_from_slice(&bytes);
            framed_bytes
        }
        (Some(_), false) => {
            return Err(TransportError::InvalidRequest(format!(
                "Unix-socket channel '{channel_id}' requires framed writes"
            )));
        }
        (None, true) => {
            return Err(TransportError::InvalidRequest(format!(
                "Unix-socket channel '{channel_id}' is not length-prefixed"
            )));
        }
    };
    handle
        .sender
        .try_send(StreamCommand::Write(data))
        .map_err(|error| {
            TransportError::ChannelUnavailable(format!(
                "Unix-socket channel '{channel_id}' rejected input: {error}"
            ))
        })
}

async fn open_local_forward_on(
    key: String,
    session: Arc<Session>,
    remote_host: String,
    remote_port: u16,
) -> Result<u16, TransportError> {
    session.ensure_alive()?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    forwards()
        .write()
        .insert((key.clone(), local_port), cancel_tx.clone());
    tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = cancel_rx.changed() => {
                    if changed.is_err() || *cancel_rx.borrow() { break; }
                },
                accepted = listener.accept() => {
                    let Ok((mut local, _)) = accepted else { break };
                    let Ok(channel) = session.handle.channel_open_direct_tcpip(remote_host.clone(), u32::from(remote_port), "127.0.0.1", u32::from(local_port)).await else { continue };
                    let mut tunnel_cancel = cancel_rx.clone();
                    tokio::spawn(async move {
                        let mut remote = channel.into_stream();
                        tokio::select! {
                            _ = tunnel_cancel.changed() => {},
                            _ = tokio::io::copy_bidirectional(&mut local, &mut remote) => {},
                        }
                    });
                }
            }
        }
        let map_key = (key, local_port);
        let should_remove = forwards()
            .read()
            .get(&map_key)
            .is_some_and(|current| current.same_channel(&cancel_tx));
        if should_remove {
            forwards().write().remove(&map_key);
        }
    });
    Ok(local_port)
}

fn close_local_forward_for_key(key: &str, local_port: u16) {
    if let Some(cancel) = forwards().write().remove(&(key.to_owned(), local_port)) {
        let _ = cancel.send(true);
    }
}

#[derive(Debug, PartialEq, Eq)]
struct SftpHttpRequest {
    head: bool,
    path: String,
    range: Option<String>,
}

fn parse_sftp_http_request(bytes: &[u8]) -> Result<SftpHttpRequest, TransportError> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        TransportError::InvalidRequest("file preview request was not valid HTTP".to_owned())
    })?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let version = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || !matches!(method, "GET" | "HEAD")
        || !version.starts_with("HTTP/1.")
        || !path.starts_with('/')
    {
        return Err(TransportError::InvalidRequest(
            "file preview request was not a supported HTTP GET or HEAD".to_owned(),
        ));
    }
    let range = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("range")
            .then(|| value.trim().to_owned())
    });
    Ok(SftpHttpRequest {
        head: method == "HEAD",
        path: path.to_owned(),
        range,
    })
}

fn parse_sftp_http_range(value: Option<&str>, size: u64) -> Result<(u64, u64, bool), ()> {
    let Some(value) = value else {
        return Ok((0, size.saturating_sub(1), false));
    };
    let range = value.strip_prefix("bytes=").ok_or(())?;
    if size == 0 || range.contains(',') {
        return Err(());
    }
    let (start, end) = range.split_once('-').ok_or(())?;
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = start.parse::<u64>().map_err(|_| ())?;
        let end = if end.is_empty() {
            size - 1
        } else {
            end.parse::<u64>().map_err(|_| ())?.min(size - 1)
        };
        (start, end)
    };
    if start >= size || end < start {
        return Err(());
    }
    Ok((start, end, true))
}

fn sftp_http_content_type(remote_path: &str) -> &'static str {
    let extension = remote_path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "3gp" => "video/3gpp",
        "aac" => "audio/aac",
        "avi" => "video/x-msvideo",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "m4v" | "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "oga" | "ogg" | "opus" => "audio/ogg",
        "pdf" => "application/pdf",
        "wav" => "audio/wav",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

async fn write_sftp_http_error(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    extra_headers: &str,
) -> Result<(), TransportError> {
    let body = format!("{status}\n");
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n{extra_headers}\r\n{body}",
        body.len(),
    );
    stream.write_all(response.as_bytes()).await?;
    Ok(())
}

async fn stream_sftp_http_range(
    stream: &mut tokio::net::TcpStream,
    sftp: Arc<SftpSession>,
    remote_path: &str,
    start: u64,
    end: u64,
) -> Result<(), TransportError> {
    let total_chunks = (end - start + SFTP_HTTP_READ_SIZE) / SFTP_HTTP_READ_SIZE;
    let parallelism = usize::try_from(total_chunks)
        .unwrap_or(SFTP_HTTP_PIPELINE_DEPTH)
        .clamp(1, SFTP_HTTP_PIPELINE_DEPTH);
    let opens = (0..parallelism).map(|_| sftp.open(remote_path.to_owned()));
    let mut files = try_join_all(opens).await?;
    let mut offset = start;
    while offset <= end {
        let specs = (0..parallelism)
            .scan(offset, |next, _| {
                if *next > end {
                    return None;
                }
                let length = (end - *next + 1).min(SFTP_HTTP_READ_SIZE);
                let spec = (*next, length);
                *next += length;
                Some(spec)
            })
            .collect::<Vec<_>>();
        let reads =
            files
                .iter_mut()
                .zip(specs.iter())
                .map(|(file, (position, length))| async move {
                    file.seek(SeekFrom::Start(*position)).await?;
                    let length = usize::try_from(*length)
                        .map_err(|_| std::io::Error::other("SFTP read chunk is too large"))?;
                    let mut bytes = vec![0u8; length];
                    file.read_exact(&mut bytes).await?;
                    Ok::<Vec<u8>, std::io::Error>(bytes)
                });
        let chunks = try_join_all(reads).await?;
        for chunk in chunks {
            stream.write_all(&chunk).await?;
        }
        offset += specs.iter().map(|(_, length)| length).sum::<u64>();
    }
    for file in &mut files {
        let _ = file.shutdown().await;
    }
    Ok(())
}

async fn serve_sftp_http_connection(
    mut stream: tokio::net::TcpStream,
    sftp: Arc<SftpSession>,
    remote_path: String,
    token: String,
    size: u64,
) -> Result<(), TransportError> {
    let mut request_bytes = Vec::with_capacity(1024);
    loop {
        let mut bytes = [0u8; 1024];
        let count = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut bytes))
            .await
            .map_err(|_| {
                TransportError::InvalidRequest("timed out reading file preview request".to_owned())
            })??;
        if count == 0 {
            return Ok(());
        }
        request_bytes.extend_from_slice(&bytes[..count]);
        if request_bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if request_bytes.len() > SFTP_HTTP_HEADER_LIMIT {
            write_sftp_http_error(&mut stream, "431 Request Header Fields Too Large", "").await?;
            return Ok(());
        }
    }

    let Ok(request) = parse_sftp_http_request(&request_bytes) else {
        write_sftp_http_error(&mut stream, "400 Bad Request", "").await?;
        return Ok(());
    };
    if !request.path.starts_with(&format!("/{token}/")) {
        write_sftp_http_error(&mut stream, "404 Not Found", "").await?;
        return Ok(());
    }
    let Ok((start, end, partial)) = parse_sftp_http_range(request.range.as_deref(), size) else {
        write_sftp_http_error(
            &mut stream,
            "416 Range Not Satisfiable",
            &format!("Content-Range: bytes */{size}\r\n"),
        )
        .await?;
        return Ok(());
    };
    let content_length = if size == 0 { 0 } else { end - start + 1 };
    let range_header = if partial {
        format!("Content-Range: bytes {start}-{end}/{size}\r\n")
    } else {
        String::new()
    };
    let status = if partial {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {content_length}\r\nAccept-Ranges: bytes\r\n{range_header}Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        sftp_http_content_type(&remote_path),
    );
    stream.write_all(headers.as_bytes()).await?;
    if !request.head && content_length > 0 {
        stream_sftp_http_range(&mut stream, sftp, &remote_path, start, end).await?;
    }
    Ok(())
}

pub(crate) struct SftpFileServer {
    pub local_port: u16,
    pub token: String,
}

async fn start_sftp_file_server_on(
    key: String,
    session: Arc<Session>,
    remote_path: String,
) -> Result<SftpFileServer, TransportError> {
    session.ensure_alive()?;
    let channel = session.handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = Arc::new(SftpSession::new(channel.into_stream()).await?);
    let metadata = sftp.metadata(remote_path.clone()).await?;
    if metadata.is_dir() {
        return Err(TransportError::InvalidRequest(
            "cannot stream a remote directory".to_owned(),
        ));
    }
    let size = metadata.size.unwrap_or_default();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let mut token_bytes = [0u8; 16];
    russh::keys::ssh_key::getrandom::fill(&mut token_bytes).map_err(|error| {
        TransportError::InvalidRequest(format!("could not secure file preview: {error}"))
    })?;
    let token = crate::lower_hex(&token_bytes);
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    sftp_file_servers()
        .write()
        .insert((key.clone(), local_port), cancel_tx.clone());
    let returned_token = token.clone();
    tokio::spawn(async move {
        let lifetime = tokio::time::sleep(SFTP_HTTP_SERVER_LIFETIME);
        tokio::pin!(lifetime);
        loop {
            tokio::select! {
                changed = cancel_rx.changed() => {
                    if changed.is_err() || *cancel_rx.borrow() { break; }
                },
                _ = &mut lifetime => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break };
                    let mut connection_cancel = cancel_rx.clone();
                    let connection_sftp = sftp.clone();
                    let connection_path = remote_path.clone();
                    let connection_token = token.clone();
                    tokio::spawn(async move {
                        tokio::select! {
                            _ = connection_cancel.changed() => {},
                            _ = serve_sftp_http_connection(
                                stream,
                                connection_sftp,
                                connection_path,
                                connection_token,
                                size,
                            ) => {},
                        }
                    });
                }
            }
        }
        let _ = sftp.close().await;
        let map_key = (key, local_port);
        let should_remove = sftp_file_servers()
            .read()
            .get(&map_key)
            .is_some_and(|current| current.same_channel(&cancel_tx));
        if should_remove {
            sftp_file_servers().write().remove(&map_key);
        }
    });
    Ok(SftpFileServer {
        local_port,
        token: returned_token,
    })
}

fn emit_exec_channel_data(key: &str, channel_id: &str, bytes: Vec<u8>, delivery: &ExecDelivery) {
    match delivery {
        ExecDelivery::Rust { data, .. } => {
            data(bytes);
            return;
        }
        ExecDelivery::ReactNative => {}
    }
    let sink = uniffi_event_sink().read().clone();
    if let Some(sink) = sink {
        let _trace = AndroidTraceSlice::begin(EXEC_INBOUND_RUST_CHUNK_DELIVERY);
        sink.exec_channel_data(key.to_owned(), channel_id.to_owned(), bytes);
    }
}

async fn open_exec_channel_with_delivery(
    key: String,
    channel_id: String,
    session: Arc<Session>,
    command: String,
    delivery: ExecDelivery,
) -> Result<(), TransportError> {
    session.ensure_alive()?;
    if channel_id.is_empty() || channel_id.len() > 128 || channel_id.chars().any(char::is_control) {
        return Err(TransportError::InvalidRequest(
            "channelId must contain 1 through 128 printable characters".to_owned(),
        ));
    }
    if exec_channels().read().contains(&key, &channel_id) {
        return Err(TransportError::InvalidRequest(format!(
            "exec channel '{channel_id}' is already open"
        )));
    }
    let channel = session.handle.channel_open_session().await?;
    request_agent_forwarding(&session, &channel).await?;
    channel.exec(true, command).await?;
    let (sender, mut receiver) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    {
        let mut channels = exec_channels().write();
        if channels.contains(&key, &channel_id) {
            return Err(TransportError::InvalidRequest(format!(
                "exec channel '{channel_id}' is already open"
            )));
        }
        channels.insert(key.clone(), channel_id.clone(), sender.clone());
    }
    tokio::spawn(async move {
        let (mut reader, writer) = channel.split();
        let lifecycle = session.lifecycle.clone();
        let read_delivery = delivery.clone();
        let read_key = key.clone();
        let read_channel_id = channel_id.clone();
        let read_loop = async move {
            let mut stderr = Vec::new();
            let mut exit_status = None;
            loop {
                match reader.wait().await {
                    Some(russh::ChannelMsg::Data { data }) => {
                        {
                            let _trace = AndroidTraceSlice::begin(EXEC_INBOUND_RUST_CHUNK_RECEIVED);
                        }
                        emit_exec_channel_data(
                            &read_key,
                            &read_channel_id,
                            data.to_vec(),
                            &read_delivery,
                        );
                    }
                    Some(russh::ChannelMsg::ExtendedData { data, ext: 1 }) => {
                        const MAX_EXEC_STDERR_BYTES: usize = 4 * 1024;
                        let remaining = MAX_EXEC_STDERR_BYTES.saturating_sub(stderr.len());
                        stderr.extend_from_slice(&data[..data.len().min(remaining)]);
                    }
                    Some(russh::ChannelMsg::ExitStatus {
                        exit_status: status,
                    }) => {
                        exit_status = Some(status);
                    }
                    Some(russh::ChannelMsg::ExitSignal { error_message, .. }) => {
                        if stderr.is_empty() {
                            stderr.extend_from_slice(error_message.as_bytes());
                        }
                    }
                    Some(russh::ChannelMsg::Close) | None => {
                        break (exec_channel_close_reason(exit_status, &stderr), false);
                    }
                    Some(_) => {}
                }
            }
        };
        let write_loop = async {
            loop {
                match receiver.recv().await {
                    Some(StreamCommand::Write(data)) => {
                        if let Err(error) = writer.data_bytes(data).await {
                            break (format!("remote exec-channel write failed: {error}"), false);
                        }
                    }
                    Some(StreamCommand::Close) => {
                        let _ = writer.close().await;
                        break ("exec channel closed by client".to_owned(), true);
                    }
                    None => break ("exec-channel control queue closed".to_owned(), true),
                }
            }
        };
        let (reason, closed_by_client) = select_channel_loops(
            read_loop,
            write_loop,
            async move { lifecycle.disconnected().await.reason.clone() },
            |reason| (format!("SSH transport disconnected: {reason}"), false),
        )
        .await;
        let _ = writer.close().await;
        exec_channels()
            .write()
            .remove_if(&key, &channel_id, |current| current.same_channel(&sender));
        match delivery {
            ExecDelivery::ReactNative => emit_event(json!({
                "name": "ExecChannel",
                "key": key,
                "value": {
                    "type": "closed",
                    "channelId": channel_id,
                    "reason": reason,
                    "closedByClient": closed_by_client,
                },
            })),
            ExecDelivery::Rust { closed, .. } => closed(reason),
        }
    });
    Ok(())
}

fn exec_channel_close_reason(exit_status: Option<u32>, stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim().replace(['\r', '\n'], " ");
    match (exit_status, stderr.is_empty()) {
        (Some(0) | None, true) => "remote exec channel reached EOF".to_owned(),
        (Some(status), true) => format!("remote exec channel exited with status {status}"),
        (Some(status), false) => {
            format!("remote exec channel exited with status {status}: {stderr}")
        }
        (None, false) => format!("remote exec channel closed: {stderr}"),
    }
}

fn exec_channel_command_for_key(
    key: &str,
    channel_id: &str,
    command: StreamCommand,
) -> Result<(), TransportError> {
    let sender = exec_channels()
        .read()
        .get(key, channel_id)
        .cloned()
        .ok_or_else(|| {
            TransportError::ChannelUnavailable(format!("exec channel '{channel_id}' is not open"))
        })?;
    sender.try_send(command).map_err(|error| {
        TransportError::ChannelUnavailable(format!(
            "exec channel '{channel_id}' rejected input: {error}"
        ))
    })
}

async fn disconnect_key(key: String) {
    let unix_channels = unix_socket_channels().write().remove_owner(&key);
    for handle in unix_channels.into_iter().flat_map(HashMap::into_values) {
        let _ = handle.sender.try_send(StreamCommand::Close);
    }
    let exec_channels = exec_channels().write().remove_owner(&key);
    for sender in exec_channels.into_iter().flat_map(HashMap::into_values) {
        let _ = sender.try_send(StreamCommand::Close);
    }
    if let Some(cancel) = transfers().write().remove(&(key.clone(), "upload")) {
        let _ = cancel.send(true);
    }
    if let Some(cancel) = transfers().write().remove(&(key.clone(), "download")) {
        let _ = cancel.send(true);
    }
    let shells = shells().write().remove_owner(&key);
    for sender in shells.into_iter().flat_map(HashMap::into_values) {
        let _ = sender.try_send(ShellCommand::Close);
    }
    let file_server_ports = sftp_file_servers()
        .read()
        .keys()
        .filter_map(|(owner, port)| (owner == &key).then_some(*port))
        .collect::<Vec<_>>();
    for port in file_server_ports {
        if let Some(cancel) = sftp_file_servers().write().remove(&(key.clone(), port)) {
            let _ = cancel.send(true);
        }
    }
    let removed_sftp = { sftp_sessions().write().remove(&key) };
    if let Some(sftp) = removed_sftp {
        let _ = sftp.close().await;
    }
    let ports = forwards()
        .read()
        .keys()
        .filter_map(|(owner, port)| (owner == &key).then_some(*port))
        .collect::<Vec<_>>();
    for port in ports {
        if let Some(cancel) = forwards().write().remove(&(key.clone(), port)) {
            let _ = cancel.send(true);
        }
    }
    let removed_session = { sessions().write().remove(&key) };
    if let Some(session) = removed_session {
        session
            .lifecycle
            .mark_disconnected("SSH session closed by application");
        let _ = session
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
}

async fn shutdown_all() {
    let keys = sessions().read().keys().cloned().collect::<Vec<_>>();
    for key in keys {
        disconnect_key(key).await;
    }
    *known_hosts().write() = KnownHosts::default();
}

async fn run_ssh_task<T, F>(key: Option<String>, future: F) -> Result<T, SshError>
where
    T: Send + 'static,
    F: Future<Output = Result<T, TransportError>> + Send + 'static,
{
    let lifecycle_epoch = LIFECYCLE_EPOCH.load(Ordering::Acquire);
    let task = match runtime() {
        Ok(runtime) => runtime.spawn(async move {
            let result = future.await;
            if LIFECYCLE_EPOCH.load(Ordering::Acquire) != lifecycle_epoch {
                if let Some(key) = key {
                    disconnect_key(key).await;
                }
                return Err(SshError::SessionClosed(
                    "Rust SSH bridge was invalidated".to_owned(),
                ));
            }
            result.map_err(SshError::from)
        }),
        Err(error) => {
            return Err(SshError::Unknown(format!(
                "failed to initialize SSH runtime: {error}"
            )));
        }
    };
    match task.await {
        Ok(response) => response,
        Err(error) => Err(SshError::Unknown(format!(
            "SSH runtime task failed: {error}"
        ))),
    }
}

fn session_for_key(key: &str) -> Result<Arc<Session>, TransportError> {
    sessions()
        .read()
        .get(key)
        .cloned()
        .ok_or(TransportError::UnknownClient)
}

#[uniffi::export]
pub fn set_known_hosts(contents: String) {
    *known_hosts().write() = KnownHosts::parse(&contents);
}

#[uniffi::export]
pub fn get_ssh_key_details(
    private_key: String,
    passphrase: Option<String>,
) -> Result<SshKeyDetails, SshError> {
    key_details(&private_key, passphrase.as_deref()).map_err(SshError::from)
}

#[uniffi::export]
pub fn generate_ssh_key_pair(
    key_type: String,
    passphrase: String,
    key_size: u32,
    comment: String,
) -> Result<SshGeneratedKeyPair, SshError> {
    let _ = key_size;
    generate_key_pair(&key_type, &passphrase, &comment).map_err(SshError::from)
}

#[uniffi::export]
pub async fn connect_ssh(
    host: String,
    port: u16,
    username: String,
    authentication: SshAuthentication,
    key: String,
    jump_key: Option<String>,
) -> Result<(), SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        connect_compatibility_session(host, port, username, authentication, key, jump_key).await
    })
    .await
}

#[uniffi::export]
pub fn set_ssh_agent_forwarding(key: String, enabled: bool) -> Result<(), SshError> {
    let session = session_for_key(&key).map_err(SshError::from)?;
    if enabled && session.agent.sender.read().is_none() {
        return Err(SshError::InvalidRequest(
            "agent forwarding requires a private-key-authenticated SSH session".to_owned(),
        ));
    }
    session.agent.enabled.store(enabled, Ordering::Relaxed);
    Ok(())
}

#[uniffi::export]
pub async fn execute_ssh_command(key: String, command: String) -> Result<String, SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let session = session_for_key(&key)?;
        let output = execute_on(&session, &command).await?;
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    })
    .await
}

#[uniffi::export]
pub async fn start_ssh_shell(key: String, pty_type: String) -> Result<(), SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let session = session_for_key(&key)?;
        start_shell_on(
            key,
            COMPATIBILITY_SHELL_ID.to_owned(),
            session,
            pty_type,
            80,
            24,
            ShellDelivery::ReactNative,
        )
        .await
    })
    .await
}

#[uniffi::export]
pub fn close_ssh_shell(key: String) -> Result<(), SshError> {
    shell_command_for_key(&key, ShellCommand::Close).map_err(SshError::from)
}

#[uniffi::export]
pub async fn measure_ssh_host_latency(key: String) -> Result<f64, SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let session = session_for_key(&key)?;
        latency_on(&session).await
    })
    .await
}

#[uniffi::export]
pub async fn get_ssh_remote_home(key: String) -> Result<String, SshError> {
    execute_ssh_command(key, REMOTE_HOME_COMMAND.to_owned()).await
}

#[uniffi::export]
pub async fn disconnect_ssh(key: String) -> Result<(), SshError> {
    run_ssh_task(None, async move {
        disconnect_key(key).await;
        Ok(())
    })
    .await
}

#[uniffi::export]
pub async fn connect_ssh_sftp(key: String) -> Result<(), SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let session = session_for_key(&key)?;
        connect_sftp_on(&key, &session).await
    })
    .await
}

#[uniffi::export]
pub async fn disconnect_ssh_sftp(key: String) -> Result<(), SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let removed = { sftp_sessions().write().remove(&key) };
        if let Some(sftp) = removed {
            sftp.close().await?;
        }
        Ok(())
    })
    .await
}

#[uniffi::export]
pub async fn list_ssh_sftp_directory(
    key: String,
    path: String,
) -> Result<Vec<LegacySftpEntry>, SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let sftp = sftp_for_key(&key)?;
        Ok(sftp_list_on(&sftp, &path)
            .await?
            .into_iter()
            .map(|entry| LegacySftpEntry {
                filename: entry.filename,
                is_directory: entry.is_directory,
                modification_date: entry.metadata.modified_at.unwrap_or_default().to_string(),
                last_access: entry.metadata.accessed_at.unwrap_or_default().to_string(),
                file_size: entry.metadata.size.unwrap_or_default(),
                owner_user_id: entry.metadata.owner_user_id.unwrap_or_default(),
                owner_group_id: entry.metadata.owner_group_id.unwrap_or_default(),
                permissions: entry.metadata.permissions.unwrap_or_default().to_string(),
                flags: 0,
            })
            .collect())
    })
    .await
}

async fn mutate_ssh_sftp_path(
    key: String,
    path: String,
    mutation: SftpMutation,
) -> Result<(), SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        sftp_mutation(&key, path, mutation).await
    })
    .await
}

#[uniffi::export]
pub async fn create_ssh_sftp_directory(key: String, path: String) -> Result<(), SshError> {
    mutate_ssh_sftp_path(key, path, SftpMutation::CreateDirectory).await
}

#[uniffi::export]
pub async fn create_ssh_sftp_directory_all(key: String, path: String) -> Result<(), SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let sftp = sftp_for_key(&key)?;
        sftp_create_dir_all_on(&sftp, &path).await
    })
    .await
}

#[uniffi::export]
pub async fn remove_ssh_sftp_file(key: String, path: String) -> Result<(), SshError> {
    mutate_ssh_sftp_path(key, path, SftpMutation::RemoveFile).await
}

#[uniffi::export]
pub async fn remove_ssh_sftp_directory(key: String, path: String) -> Result<(), SshError> {
    mutate_ssh_sftp_path(key, path, SftpMutation::RemoveDirectory).await
}

#[uniffi::export]
pub async fn rename_ssh_sftp_path(
    key: String,
    old_path: String,
    new_path: String,
) -> Result<(), SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        sftp_for_key(&key)?.rename(old_path, new_path).await?;
        Ok(())
    })
    .await
}

#[uniffi::export]
pub async fn chmod_ssh_sftp_path(
    key: String,
    path: String,
    permissions: u32,
) -> Result<(), SshError> {
    mutate_ssh_sftp_path(key, path, SftpMutation::Chmod(permissions)).await
}

async fn transfer_ssh_sftp(
    key: String,
    local_path: String,
    remote_path: String,
    upload: bool,
    exact_path: bool,
) -> Result<String, SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let sftp = sftp_for_key(&key)?;
        sftp_transfer_on(key, sftp, local_path, remote_path, upload, exact_path).await
    })
    .await
}

#[uniffi::export]
pub async fn upload_ssh_sftp(
    key: String,
    local_path: String,
    remote_directory_path: String,
) -> Result<String, SshError> {
    transfer_ssh_sftp(key, local_path, remote_directory_path, true, false).await
}

#[uniffi::export]
pub async fn upload_ssh_sftp_to_path(
    key: String,
    local_path: String,
    remote_path: String,
) -> Result<String, SshError> {
    transfer_ssh_sftp(key, local_path, remote_path, true, true).await
}

#[uniffi::export]
pub async fn download_ssh_sftp(
    key: String,
    remote_path: String,
    local_directory_path: String,
) -> Result<String, SshError> {
    transfer_ssh_sftp(key, local_directory_path, remote_path, false, false).await
}

#[uniffi::export]
pub fn cancel_ssh_sftp_upload(key: String) -> bool {
    transfers()
        .read()
        .get(&(key, "upload"))
        .is_some_and(|cancel| cancel.send(true).is_ok())
}

#[uniffi::export]
pub fn cancel_ssh_sftp_download(key: String) -> bool {
    transfers()
        .read()
        .get(&(key, "download"))
        .is_some_and(|cancel| cancel.send(true).is_ok())
}

#[uniffi::export]
pub async fn start_ssh_sftp_file_server(
    key: String,
    remote_path: String,
) -> Result<LegacySftpFileServer, SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let session = session_for_key(&key)?;
        let server = start_sftp_file_server_on(key, session, remote_path).await?;
        Ok(LegacySftpFileServer {
            local_port: server.local_port,
            token: server.token,
        })
    })
    .await
}

#[uniffi::export]
pub fn close_ssh_sftp_file_server(key: String, local_port: u16) {
    if let Some(cancel) = sftp_file_servers().write().remove(&(key, local_port)) {
        let _ = cancel.send(true);
    }
}

#[uniffi::export]
pub async fn open_ssh_local_forward(
    key: String,
    remote_host: String,
    remote_port: u16,
) -> Result<u16, SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let session = session_for_key(&key)?;
        open_local_forward_on(key, session, remote_host, remote_port).await
    })
    .await
}

#[uniffi::export]
pub fn close_ssh_local_forward(key: String, local_port: u16) {
    if let Some(cancel) = forwards().write().remove(&(key, local_port)) {
        let _ = cancel.send(true);
    }
}

#[uniffi::export]
pub async fn open_ssh_unix_socket_channel(
    key: String,
    socket_path: String,
    channel_id: String,
) -> Result<(), SshError> {
    open_ssh_unix_socket_channel_inner(key, socket_path, channel_id, None, 32 * 1024 * 1024).await
}

#[uniffi::export]
pub async fn open_length_prefixed_ssh_unix_socket_channel(
    key: String,
    socket_path: String,
    channel_id: String,
    length_format: String,
    max_frame_bytes: u32,
) -> Result<(), SshError> {
    let framing = LengthFormat::parse(&length_format).map_err(SshError::from)?;
    open_ssh_unix_socket_channel_inner(
        key,
        socket_path,
        channel_id,
        Some(framing),
        max_frame_bytes.clamp(1, 128 * 1024 * 1024) as usize,
    )
    .await
}

async fn open_ssh_unix_socket_channel_inner(
    key: String,
    socket_path: String,
    channel_id: String,
    framing: Option<LengthFormat>,
    max_frame_bytes: usize,
) -> Result<(), SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let session = session_for_key(&key)?;
        open_unix_socket_channel_with_framing(
            key,
            channel_id,
            session,
            socket_path,
            framing,
            max_frame_bytes,
            UnixSocketDelivery::ReactNative,
        )
        .await
    })
    .await
}

#[uniffi::export]
pub fn close_ssh_unix_socket_channel(key: String, channel_id: String) -> Result<(), SshError> {
    unix_socket_channel_command_for_key(&key, &channel_id, StreamCommand::Close)
        .map_err(SshError::from)
}

#[uniffi::export]
pub async fn request_ssh_unix_socket(
    key: String,
    socket_path: String,
    request: String,
    response_terminator: String,
    timeout_ms: u32,
    max_response_bytes: u32,
) -> Result<String, SshError> {
    let terminator = response_terminator.as_bytes();
    if terminator.len() != 1 {
        return Err(SshError::InvalidRequest(
            "responseTerminator must encode to exactly one byte".to_owned(),
        ));
    }
    let terminator = terminator[0];
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let session = session_for_key(&key)?;
        let response = request_unix_socket_bytes_on(
            &session,
            &socket_path,
            request.as_bytes(),
            terminator,
            u64::from(timeout_ms.clamp(1, 300_000)),
            max_response_bytes.clamp(1, 32 * 1024 * 1024) as usize,
        )
        .await?;
        Ok(String::from_utf8_lossy(&response).into_owned())
    })
    .await
}

#[uniffi::export]
pub async fn open_ssh_exec_channel(
    key: String,
    command: String,
    channel_id: String,
) -> Result<(), SshError> {
    let task_key = key.clone();
    run_ssh_task(Some(task_key), async move {
        let session = session_for_key(&key)?;
        open_exec_channel_with_delivery(
            key,
            channel_id,
            session,
            command,
            ExecDelivery::ReactNative,
        )
        .await
    })
    .await
}

#[uniffi::export]
pub fn close_ssh_exec_channel(key: String, channel_id: String) -> Result<(), SshError> {
    exec_channel_command_for_key(&key, &channel_id, StreamCommand::Close).map_err(SshError::from)
}

#[uniffi::export]
pub fn write_shell_input(key: String, data: String) -> Result<(), SshError> {
    shell_command_for_key(&key, ShellCommand::Write(data.into_bytes())).map_err(SshError::from)
}

#[uniffi::export]
pub fn resize_shell_fast(key: String, columns: u32, rows: u32) -> Result<(), SshError> {
    shell_command_for_key(&key, ShellCommand::Resize { columns, rows }).map_err(SshError::from)
}

#[uniffi::export]
pub fn write_unix_socket_channel(
    key: String,
    channel_id: String,
    bytes: Vec<u8>,
) -> Result<(), SshError> {
    write_unix_socket_channel_for_key(&key, &channel_id, bytes, false).map_err(SshError::from)
}

#[uniffi::export]
pub fn write_length_prefixed_unix_socket_channel(
    key: String,
    channel_id: String,
    bytes: Vec<u8>,
) -> Result<(), SshError> {
    write_unix_socket_channel_for_key(&key, &channel_id, bytes, true).map_err(SshError::from)
}

#[uniffi::export]
pub fn write_exec_channel(key: String, channel_id: String, bytes: Vec<u8>) -> Result<(), SshError> {
    exec_channel_command_for_key(&key, &channel_id, StreamCommand::Write(bytes))
        .map_err(SshError::from)
}

#[uniffi::export]
pub fn set_event_sink(sink: Arc<dyn WhipSshEventSink>) {
    *uniffi_event_sink().write() = Some(sink);
}

#[uniffi::export]
pub fn clear_event_sink() {
    *uniffi_event_sink().write() = None;
}
fn shutdown_transport() {
    *uniffi_event_sink().write() = None;
    LIFECYCLE_EPOCH.fetch_add(1, Ordering::AcqRel);
    if let Ok(runtime) = runtime() {
        runtime.spawn(shutdown_all());
    }
}

#[uniffi::export]
pub fn shutdown() {
    shutdown_transport();
}

#[cfg(test)]
mod tests;
