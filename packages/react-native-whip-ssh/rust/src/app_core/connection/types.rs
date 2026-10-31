use std::sync::Arc;

use super::SessionConnectionPermit;
use crate::ssh::HostKeyChallenge;
use crate::{CredentialMaterial, HostProfileRecord, HostRuntime, SessionConnectionAttempt};

/// Ephemeral connection input; never persisted or included in diagnostics.
#[derive(Clone, uniffi::Record)]
pub struct SessionConnectionProfile {
    pub host: HostProfileRecord,
    pub credential: CredentialMaterial,
}

#[derive(Clone, uniffi::Record)]
pub struct SessionConnectionRequest {
    pub host: HostProfileRecord,
    pub credential: Option<CredentialMaterial>,
    pub saved: bool,
    pub persist_profile: bool,
    pub navigate: bool,
    pub activate: bool,
    pub reuse_placeholder: bool,
    pub biometric_verified: bool,
    pub protect_keys: bool,
    pub prompt_for_trust: bool,
    pub existing_host: Option<HostProfileRecord>,
    pub ssh_shell_title: String,
    pub attempt: Option<Arc<SessionConnectionAttempt>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum SessionConnectionPhase {
    Admission,
    Credentials,
    JumpCredentials,
    Biometric,
    Persistence,
    Transport,
    Trust,
    Attach,
    TerminalRestore,
    Ready,
    Cleanup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum SessionConnectionFailureKind {
    Credential,
    Authentication,
    ConnectionRefused,
    HerdrUnavailable,
    HostKey,
    IncompatibleProtocol,
    InvalidKey,
    Timeout,
    UnsupportedHostCertificate,
    Unreachable,
    StaleProfile,
    Platform,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct SessionConnectionFailure {
    pub phase: SessionConnectionPhase,
    pub kind: SessionConnectionFailureKind,
    pub host_id: String,
    pub host: String,
    pub expected_protocol: Option<String>,
    pub received_protocol: Option<String>,
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error)]
pub enum SessionConnectionPlatformError {
    #[error("Connection effect canceled")]
    Cancelled,
    #[error("SSH host key requires approval")]
    UnknownHostKey { challenge: HostKeyChallenge },
    #[error("SSH host key changed")]
    ChangedHostKey { challenge: HostKeyChallenge },
    #[error("Connection effect failed")]
    Failed {
        kind: SessionConnectionFailureKind,
        expected_protocol: Option<String>,
        received_protocol: Option<String>,
    },
}
impl From<uniffi::UnexpectedUniFFICallbackError> for SessionConnectionPlatformError {
    fn from(_: uniffi::UnexpectedUniFFICallbackError) -> Self {
        Self::Failed {
            kind: SessionConnectionFailureKind::Platform,
            expected_protocol: None,
            received_protocol: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum SessionConnectionOutcome {
    Ready,
    Selected,
    Busy,
    Cancelled,
    Failed { failure: SessionConnectionFailure },
    CleanupFailed { failure: SessionConnectionFailure },
}

#[derive(Clone, uniffi::Enum)]
pub enum SessionConnectionPresentation {
    Started {
        host: HostProfileRecord,
        show_placeholder: bool,
        replace_runtime: bool,
    },
    Prepared {
        host: HostProfileRecord,
    },
    Selected {
        session_id: String,
        terminal: bool,
        refresh: bool,
    },
    Ready {
        session_id: String,
        terminal: bool,
        navigate: bool,
    },
    Failed {
        navigate: bool,
        failure: SessionConnectionFailure,
    },
}

/// Foreign callbacks are individual UI/OS/transport effects. Sequencing, retries,
/// admission, binding and compensation belong to the native workflow.
#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait SessionConnectionPlatform: Send + Sync {
    async fn load_profile(
        &self,
        permit: Arc<SessionConnectionPermit>,
        host: HostProfileRecord,
        interactive: bool,
    ) -> Result<Option<SessionConnectionProfile>, SessionConnectionPlatformError>;
    async fn verify_keys(
        &self,
        permit: Arc<SessionConnectionPermit>,
    ) -> Result<bool, SessionConnectionPlatformError>;
    async fn wait_for_cleanup(
        &self,
        permit: Arc<SessionConnectionPermit>,
        host_id: String,
    ) -> Result<(), SessionConnectionPlatformError>;
    async fn connect_runtime(
        &self,
        permit: Arc<SessionConnectionPermit>,
        profile: SessionConnectionProfile,
        jumps: Vec<SessionConnectionProfile>,
    ) -> Result<Arc<HostRuntime>, SessionConnectionPlatformError>;
    async fn confirm_trust(
        &self,
        permit: Arc<SessionConnectionPermit>,
        challenge: HostKeyChallenge,
    ) -> Result<bool, SessionConnectionPlatformError>;
    async fn record_trust(
        &self,
        permit: Arc<SessionConnectionPermit>,
        challenge: HostKeyChallenge,
    ) -> Result<(), SessionConnectionPlatformError>;
    async fn restore_terminals(
        &self,
        permit: Arc<SessionConnectionPermit>,
        host_id: String,
    ) -> Result<bool, SessionConnectionPlatformError>;
    async fn cleanup(
        &self,
        permit: Arc<SessionConnectionPermit>,
        host_id: String,
        retain_transport: bool,
    ) -> Result<(), SessionConnectionPlatformError>;
    fn present(
        &self,
        permit: Arc<SessionConnectionPermit>,
        presentation: SessionConnectionPresentation,
    );
    fn failure_message(&self, failure: SessionConnectionFailure) -> String;
    fn state_changed(&self);
    fn connecting_changed(&self, host_ids: Vec<String>);
    fn diagnostic(
        &self,
        host_id: String,
        phase: SessionConnectionPhase,
        elapsed_ms: u64,
        failed: bool,
    );
}
