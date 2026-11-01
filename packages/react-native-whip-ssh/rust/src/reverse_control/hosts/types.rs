use std::sync::Arc;

use serde::Deserialize;

use super::HostActionPermit;
use crate::app_core::AppConnectionStatus;
use crate::host_profiles::{HostAuthMode, HostProfileRecord};

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostActionConnection {
    pub host_id: String,
    pub status: AppConnectionStatus,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct HostActionContext {
    pub ready: bool,
    pub locked: bool,
    pub biometric_for_keys: bool,
    pub global_instructions: String,
    pub hosts: Vec<HostProfileRecord>,
    pub connections: Vec<HostActionConnection>,
}

impl Default for HostActionContext {
    fn default() -> Self {
        Self {
            ready: false,
            locked: true,
            biometric_for_keys: true,
            global_instructions: String::new(),
            hosts: Vec::new(),
            connections: Vec::new(),
        }
    }
}

/// Secret-free metadata intent; the explicit flag preserves absent versus null
/// jumpHostId without asking JavaScript to interpret a host tool's arguments.
#[derive(Clone, Debug, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct HostActionProfilePatch {
    pub name: Option<String>,
    pub host: Option<String>,
    pub port: Option<String>,
    pub username: Option<String>,
    pub auth_mode: Option<HostAuthMode>,
    pub herdr_command: Option<String>,
    pub herdr_backend: Option<crate::HostHerdrBackend>,
    pub herdr_socket_path: Option<String>,
    pub session_name: Option<String>,
    pub forward_agent: Option<bool>,
    pub jump_host_id: Option<String>,
    #[serde(skip)]
    pub jump_host_changed: bool,
}

/// Ephemeral platform credential. Never serialize this into tool results,
/// metadata, diagnostics or the coordinator's published context.
#[derive(Clone, uniffi::Record)]
pub struct HostActionCredential {
    pub secret: String,
    pub passphrase: String,
    pub tailcat_address: Option<String>,
    pub tailcat_private_key: Option<String>,
    pub tailcat_public_key: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum HostActionPermitError {
    #[error("Host action cancelled")]
    Cancelled,
    #[error("Reverse Control session is no longer authorized")]
    Unauthorized,
    #[error("Unlock Whip before managing hosts")]
    Locked,
    #[error("Wait for Whip host profiles and preferences to load")]
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum HostActionPlatformError {
    #[error("Credential use was not authorized")]
    PermissionDenied,
    #[error("Save an SSH credential for this host in Whip first")]
    CredentialMissing,
    #[error("Host action failed; check the saved host and connection in Whip")]
    Unavailable,
}

/// Platform effects have no tool dispatch, host-selection or admission policy.
/// Every permit was minted for an authenticated native request, never by JS.
#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait HostActionPlatform: Send + Sync {
    async fn authenticate(
        &self,
        permit: Arc<HostActionPermit>,
    ) -> Result<bool, HostActionPlatformError>;
    async fn save_metadata(
        &self,
        permit: Arc<HostActionPermit>,
        host_id: String,
        patch: HostActionProfilePatch,
        credential_source_id: Option<String>,
    ) -> Result<HostProfileRecord, HostActionPlatformError>;
    async fn read_credential(
        &self,
        permit: Arc<HostActionPermit>,
        host: HostProfileRecord,
    ) -> Result<HostActionCredential, HostActionPlatformError>;
    async fn connect(
        &self,
        permit: Arc<HostActionPermit>,
        host: HostProfileRecord,
        credential: HostActionCredential,
    ) -> Result<bool, HostActionPlatformError>;
    async fn delete_transcripts(
        &self,
        permit: Arc<HostActionPermit>,
        host_id: String,
    ) -> Result<(), HostActionPlatformError>;
    async fn delete_snapshot(
        &self,
        permit: Arc<HostActionPermit>,
        host_id: String,
    ) -> Result<(), HostActionPlatformError>;
    async fn delete_profile(
        &self,
        permit: Arc<HostActionPermit>,
        host_id: String,
    ) -> Result<(), HostActionPlatformError>;
    async fn disconnect(
        &self,
        permit: Arc<HostActionPermit>,
        host_id: String,
        record_disconnect: bool,
    ) -> Result<(), HostActionPlatformError>;
    fn cancel(&self, operation_id: String);
}
