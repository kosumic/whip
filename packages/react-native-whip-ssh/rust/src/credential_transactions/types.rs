use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::CredentialEffectPermit;
use crate::{HostActionProfilePatch, HostProfileRecord};

/// Ephemeral secure-store payload. Never included in a published projection,
/// a transaction journal, diagnostics, or a Debug implementation.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMaterial {
    pub secret: String,
    #[serde(default)]
    pub passphrase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tailcat_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tailcat_private_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tailcat_public_key: Option<String>,
}

impl CredentialMaterial {
    pub(super) fn present(&self) -> bool {
        !self.secret.is_empty()
            || self
                .tailcat_address
                .as_ref()
                .is_some_and(|value| !value.is_empty())
            || self
                .tailcat_private_key
                .as_ref()
                .is_some_and(|value| !value.is_empty())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct GlobalKeyMetadata {
    pub id: String,
    pub name: String,
    pub fingerprint: String,
    pub key_type: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, uniffi::Record)]
pub struct GlobalKeyMaterial {
    pub metadata: GlobalKeyMetadata,
    pub secret: String,
    pub passphrase: String,
}

#[derive(Clone, uniffi::Record)]
pub struct GlobalKeyInput {
    pub name: String,
    pub fingerprint: String,
    pub key_type: String,
    pub secret: String,
    pub passphrase: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct CredentialProfileView {
    pub loaded: bool,
    pub revision: u64,
    pub hosts: Vec<HostProfileRecord>,
    pub repair_host_ids: Vec<String>,
}

#[derive(Clone, uniffi::Enum)]
pub enum CredentialCommand {
    LoadHosts {
        from_storage: bool,
        hosts: Option<String>,
        legacy: Option<String>,
    },
    SaveHost {
        profile: HostProfileRecord,
        credential: CredentialMaterial,
    },
    SaveMetadata {
        id: String,
        patch: HostActionProfilePatch,
        source: Option<String>,
    },
    DeleteHost {
        id: String,
    },
    MarkDisconnected {
        id: String,
    },
    ReadHost {
        host: HostProfileRecord,
        strict: bool,
    },
    EnsureIdentity {
        host: HostProfileRecord,
        credential: CredentialMaterial,
    },
    Backup {
        id: String,
        credential: CredentialMaterial,
        only_missing: bool,
    },
    HasBackup {
        id: String,
    },
    RemoveBackup {
        id: String,
    },
    RecoveryStatus,
    RestoreBackups {
        host_ids: Vec<String>,
    },
    RecoverHost {
        host: HostProfileRecord,
    },
    MigrateBackups,
    LoadGlobalKeys,
    UnlockGlobalKeys,
    SaveGlobalKey {
        input: GlobalKeyInput,
    },
    DeleteGlobalKey {
        id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum CredentialRecoveryState {
    None,
    Ready,
    Locked,
    Unavailable,
}

#[derive(Clone, uniffi::Enum)]
pub enum CredentialResult {
    Hosts {
        hosts: Vec<HostProfileRecord>,
    },
    Saved {
        hosts: Vec<HostProfileRecord>,
        host: HostProfileRecord,
    },
    Host {
        host: HostProfileRecord,
    },
    Material {
        credential: CredentialMaterial,
    },
    Recovered {
        credential: Option<CredentialMaterial>,
    },
    Boolean {
        value: bool,
    },
    Done,
    RecoveryStatus {
        state: CredentialRecoveryState,
        count: u32,
    },
    Restored {
        restored: u32,
        failed: u32,
    },
    GlobalKeys {
        keys: Vec<GlobalKeyMetadata>,
    },
    GlobalMaterials {
        keys: Vec<GlobalKeyMaterial>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum CredentialStorageKey {
    Hosts,
    LegacyProfile,
    GlobalKeys,
    Backups,
    BackupMigration,
    Transactions,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct CredentialStorageEntry {
    pub key: CredentialStorageKey,
    pub value: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum CredentialSlot {
    Host { id: String },
    Legacy,
    Global,
}

/// Platform primitives only; all sequencing and recovery policy stays in Rust.
#[derive(Clone, uniffi::Enum)]
pub enum CredentialEffect {
    ReadMetadata {
        keys: Vec<CredentialStorageKey>,
    },
    WriteMetadata {
        entries: Vec<CredentialStorageEntry>,
    },
    ReadSecure {
        slot: CredentialSlot,
    },
    WriteSecure {
        slot: CredentialSlot,
        username: String,
        value: String,
    },
    ClearSecure {
        slot: CredentialSlot,
    },
    Encrypt {
        id: String,
        plaintext: String,
    },
    Decrypt {
        id: String,
        ciphertext: String,
    },
    VaultAvailable,
    HasRecoveryKey,
    UnlockRecoveryKey,
    ClearRecoveryKey,
    AuthenticateGlobal,
}

#[derive(Clone, uniffi::Enum)]
pub enum CredentialEffectResult {
    Metadata {
        entries: Vec<CredentialStorageEntry>,
    },
    Text {
        value: Option<String>,
    },
    Boolean {
        value: bool,
    },
    Done,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum CredentialPlatformError {
    #[error("Credential operation cancelled")]
    Cancelled,
    #[error("Credential authentication was not approved")]
    Denied,
    #[error("Secure storage is unavailable")]
    SecureStorage,
    #[error("Application storage is unavailable")]
    MetadataStorage,
    #[error("Credential recovery is unavailable on this device")]
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum CredentialTransactionError {
    #[error("Credential operation cancelled")]
    Cancelled,
    #[error("Host profiles must be loaded successfully before they can be changed")]
    ProfilesUnavailable,
    #[error("Stored credential metadata is malformed; existing data was preserved")]
    MalformedMetadata,
    #[error("Stored credential material is malformed; existing data was preserved")]
    MalformedCredential,
    #[error("The host profile or credential source is invalid")]
    InvalidProfile,
    #[error("The host changed while it was being edited; reload it before saving")]
    StaleProfile,
    #[error("Could not persist application metadata")]
    MetadataStorage,
    #[error("Could not read or update secure credential storage")]
    SecureStorage,
    #[error("Credential authentication was not approved")]
    Denied,
    #[error("Metadata was committed but credential work is incomplete; retry the operation")]
    PartialCommit,
    #[error(
        "A previous credential update needs repair; unlock the keychain or save/delete the affected host again"
    )]
    RepairRequired,
    #[error(
        "Global key metadata and secure material are inconsistent; existing data was preserved"
    )]
    InconsistentGlobalKeys,
    #[error("Restore the saved host credentials before creating a Tailcat identity")]
    RecoveryRequired,
    #[error("Stored Tailcat identity is incomplete")]
    IncompleteIdentity,
    #[error("Credential recovery is unavailable on this device")]
    Unsupported,
    #[error("Invalid credential platform result")]
    InvalidResult,
}

impl From<CredentialPlatformError> for CredentialTransactionError {
    fn from(value: CredentialPlatformError) -> Self {
        match value {
            CredentialPlatformError::Cancelled => Self::Cancelled,
            CredentialPlatformError::Denied => Self::Denied,
            CredentialPlatformError::SecureStorage => Self::SecureStorage,
            CredentialPlatformError::MetadataStorage => Self::MetadataStorage,
            CredentialPlatformError::Unsupported => Self::Unsupported,
        }
    }
}

#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait CredentialPlatform: Send + Sync {
    async fn effect(
        &self,
        permit: Arc<CredentialEffectPermit>,
        effect: CredentialEffect,
    ) -> Result<CredentialEffectResult, CredentialPlatformError>;
    fn profiles_changed(&self, view: CredentialProfileView);
    fn diagnostic(&self, event: String, host_id: Option<String>);
}
