use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use super::{
    CredentialEffect, CredentialEffectPermit, CredentialEffectResult, CredentialSlot,
    CredentialStorageEntry, CredentialStorageKey, CredentialTransactionError, EffectGuard, Result,
    Workflow,
};

impl Workflow {
    pub(super) async fn effect(
        &self,
        effect: CredentialEffect,
        cleanup: bool,
    ) -> Result<CredentialEffectResult> {
        let read = matches!(
            effect,
            CredentialEffect::ReadMetadata { .. }
                | CredentialEffect::ReadSecure { .. }
                | CredentialEffect::Decrypt { .. }
                | CredentialEffect::HasRecoveryKey
                | CredentialEffect::AuthenticateGlobal
                | CredentialEffect::UnlockRecoveryKey
        );
        let permit = Arc::new(CredentialEffectPermit {
            operation: Arc::downgrade(&self.operation),
            active: AtomicBool::new(true),
            cleanup,
        });
        let _guard = EffectGuard(permit.clone());
        permit.check_active()?;
        // Never race a started write against cancellation. Its worker retains
        // FIFO ownership until the OS acknowledges it and Rust records its state.
        let result = self
            .operation
            .coordinator
            .platform
            .effect(permit, effect)
            .await;
        if read && !cleanup {
            self.operation.check()?;
        }
        result.map_err(Into::into)
    }

    pub(super) async fn read_metadata(
        &self,
        keys: Vec<CredentialStorageKey>,
    ) -> Result<Vec<Option<String>>> {
        let CredentialEffectResult::Metadata { entries } = self
            .effect(CredentialEffect::ReadMetadata { keys: keys.clone() }, false)
            .await?
        else {
            return Err(CredentialTransactionError::InvalidResult);
        };
        if entries.len() != keys.len()
            || entries
                .iter()
                .zip(&keys)
                .any(|(entry, key)| entry.key != *key)
        {
            return Err(CredentialTransactionError::InvalidResult);
        }
        Ok(entries.into_iter().map(|entry| entry.value).collect())
    }

    pub(super) async fn read_value(&self, key: CredentialStorageKey) -> Result<Option<String>> {
        self.read_metadata(vec![key])
            .await?
            .pop()
            .ok_or(CredentialTransactionError::InvalidResult)
    }

    pub(super) async fn write_metadata(
        &self,
        entries: Vec<CredentialStorageEntry>,
        cleanup: bool,
    ) -> Result<()> {
        match self
            .effect(CredentialEffect::WriteMetadata { entries }, cleanup)
            .await?
        {
            CredentialEffectResult::Done => Ok(()),
            _ => Err(CredentialTransactionError::InvalidResult),
        }
    }

    pub(super) async fn read_secure(&self, slot: CredentialSlot) -> Result<Option<String>> {
        match self
            .effect(CredentialEffect::ReadSecure { slot }, false)
            .await?
        {
            CredentialEffectResult::Text { value } => Ok(value),
            _ => Err(CredentialTransactionError::InvalidResult),
        }
    }

    pub(super) async fn write_secure(
        &self,
        slot: CredentialSlot,
        username: String,
        value: Option<String>,
        cleanup: bool,
    ) -> Result<()> {
        let effect = match value {
            Some(value) => CredentialEffect::WriteSecure {
                slot,
                username,
                value,
            },
            None => CredentialEffect::ClearSecure { slot },
        };
        match self.effect(effect, cleanup).await? {
            CredentialEffectResult::Done => Ok(()),
            _ => Err(CredentialTransactionError::InvalidResult),
        }
    }

    pub(super) async fn boolean(&self, effect: CredentialEffect) -> Result<bool> {
        match self.effect(effect, false).await? {
            CredentialEffectResult::Boolean { value } => Ok(value),
            _ => Err(CredentialTransactionError::InvalidResult),
        }
    }
}

pub(super) fn entry(key: CredentialStorageKey, value: Option<String>) -> CredentialStorageEntry {
    CredentialStorageEntry { key, value }
}
pub(super) fn encode(value: &impl serde::Serialize) -> Result<String> {
    serde_json::to_string(value).map_err(|_| CredentialTransactionError::InvalidResult)
}
pub(super) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
