use std::collections::BTreeMap;

use super::journal::HostEnvelope;
use super::profiles::parse_host;
use super::storage::{encode, entry};
use super::{
    CredentialEffect, CredentialEffectResult, CredentialMaterial, CredentialRecoveryState,
    CredentialResult, CredentialSlot, CredentialStorageKey, CredentialTransactionError, Result,
    Workflow,
};
use crate::HostProfileRecord;

const BACKUP_MIGRATION_VERSION: &str = "1";

impl Workflow {
    /// The caller has already committed or receipt-verified the primary secret.
    /// Optional backup work must never keep that secret behind a repair marker.
    pub(super) async fn backup_committed_host(
        &self,
        id: &str,
        credential: &CredentialMaterial,
    ) -> Result<()> {
        match self.backup(id, credential, false).await {
            Err(CredentialTransactionError::Cancelled) => {
                return Err(CredentialTransactionError::Cancelled);
            }
            Err(_) => self.diagnostic("credential-backup-failed-local-credential-saved", None),
            Ok(false) => self.diagnostic("credential-backup-unavailable", None),
            Ok(true) => {}
        }
        self.operation.check()
    }

    pub(super) async fn backups(&self) -> Result<BTreeMap<String, String>> {
        let Some(value) = self.read_value(CredentialStorageKey::Backups).await? else {
            return Ok(BTreeMap::new());
        };
        let backups: BTreeMap<String, String> = serde_json::from_str(&value)
            .map_err(|_| CredentialTransactionError::MalformedMetadata)?;
        if backups
            .iter()
            .any(|(id, value)| id.is_empty() || value.is_empty())
        {
            return Err(CredentialTransactionError::MalformedMetadata);
        }
        Ok(backups)
    }

    pub(super) async fn backup(
        &self,
        id: &str,
        credential: &CredentialMaterial,
        only_missing: bool,
    ) -> Result<bool> {
        if self.journal.deleted.contains(id) {
            return Err(CredentialTransactionError::InvalidProfile);
        }
        if !credential.present() || !self.boolean(CredentialEffect::VaultAvailable).await? {
            return Ok(false);
        }
        let mut backups = self.backups().await?;
        if only_missing && backups.contains_key(id) {
            return Ok(true);
        }
        // A restored ciphertext needs its original recovery key. Never replace
        // that key (and orphan other backups) while it is still locked.
        if !backups.is_empty() && !self.boolean(CredentialEffect::HasRecoveryKey).await? {
            self.diagnostic("credential-backup-recovery-key-locked", None);
            return Ok(false);
        }
        let encrypted = match self
            .effect(
                CredentialEffect::Encrypt {
                    id: id.into(),
                    plaintext: encode(credential)?,
                },
                false,
            )
            .await
        {
            Err(CredentialTransactionError::Unsupported) => return Ok(false),
            result => result?,
        };
        let CredentialEffectResult::Text {
            value: Some(ciphertext),
        } = encrypted
        else {
            return Err(CredentialTransactionError::InvalidResult);
        };
        if ciphertext.is_empty() {
            return Err(CredentialTransactionError::InvalidResult);
        }
        backups.insert(id.into(), ciphertext);
        self.write_metadata(
            vec![entry(
                CredentialStorageKey::Backups,
                Some(encode(&backups)?),
            )],
            false,
        )
        .await?;
        Ok(true)
    }

    pub(super) async fn remove_backup(&self, id: &str) -> Result<()> {
        let mut backups = self.backups().await?;
        backups.remove(id);
        self.write_metadata(
            vec![entry(
                CredentialStorageKey::Backups,
                Some(encode(&backups)?),
            )],
            false,
        )
        .await?;
        if backups.is_empty()
            && self.boolean(CredentialEffect::VaultAvailable).await?
            && self
                .effect(CredentialEffect::ClearRecoveryKey, false)
                .await
                .is_err()
        {
            self.diagnostic("credential-recovery-key-clear-failed", Some(id));
        }
        Ok(())
    }

    pub(super) async fn recovery_status(&self) -> Result<CredentialResult> {
        let count = u32::try_from(self.backups().await?.len())
            .map_err(|_| CredentialTransactionError::MalformedMetadata)?;
        let state = if !self.boolean(CredentialEffect::VaultAvailable).await? {
            CredentialRecoveryState::Unavailable
        } else if count == 0 {
            CredentialRecoveryState::None
        } else {
            match self.boolean(CredentialEffect::HasRecoveryKey).await {
                Ok(true) => CredentialRecoveryState::Ready,
                Ok(false) => CredentialRecoveryState::Locked,
                Err(_) => CredentialRecoveryState::Unavailable,
            }
        };
        Ok(CredentialResult::RecoveryStatus { state, count })
    }

    async fn decrypt(&self, id: &str, ciphertext: String) -> Result<CredentialMaterial> {
        let CredentialEffectResult::Text {
            value: Some(plaintext),
        } = self
            .effect(
                CredentialEffect::Decrypt {
                    id: id.into(),
                    ciphertext,
                },
                false,
            )
            .await?
        else {
            return Err(CredentialTransactionError::InvalidResult);
        };
        let material = parse_host(&plaintext)?.material;
        if !material.present() {
            return Err(CredentialTransactionError::MalformedCredential);
        }
        Ok(material)
    }

    // Recovery persists an intent before the secure write, then acknowledges it
    // without re-encrypting the existing backup or marking backup migration done.
    // Ordinary writes use finish_host_write to create/update their backup first.
    async fn install_recovered(
        &mut self,
        host: &HostProfileRecord,
        material: CredentialMaterial,
    ) -> Result<CredentialMaterial> {
        if self.journal.deleted.contains(&host.id) {
            return Err(CredentialTransactionError::InvalidProfile);
        }
        let receipt = self.stage_host_write(&host.id, &host.username, false);
        self.persist_journal(false).await?;
        let envelope = HostEnvelope {
            material,
            receipt: Some(receipt),
        };
        self.write_secure(
            CredentialSlot::Host {
                id: host.id.clone(),
            },
            host.username.clone(),
            Some(encode(&envelope)?),
            false,
        )
        .await?;
        self.operation.check()?;
        self.clear_host_pending(&host.id, true).await?;
        self.publish_repairs();
        Ok(envelope.material)
    }

    pub(super) async fn recover_host(
        &mut self,
        host: &HostProfileRecord,
    ) -> Result<Option<CredentialMaterial>> {
        if self.journal.deleted.contains(&host.id) {
            return Ok(None);
        }
        let result = async {
            if !self.boolean(CredentialEffect::HasRecoveryKey).await? {
                return Ok(None);
            }
            let Some(ciphertext) = self.backups().await?.remove(&host.id) else {
                return Ok(None);
            };
            let material = self.decrypt(&host.id, ciphertext).await?;
            self.install_recovered(host, material).await.map(Some)
        }
        .await;
        match result {
            Err(CredentialTransactionError::Cancelled) => {
                Err(CredentialTransactionError::Cancelled)
            }
            Err(_) => {
                self.diagnostic("credential-recovery-failed", Some(&host.id));
                Ok(None)
            }
            Ok(material) => Ok(material),
        }
    }

    pub(super) async fn restore_backups(
        &mut self,
        host_ids: Vec<String>,
    ) -> Result<CredentialResult> {
        if !self.boolean(CredentialEffect::HasRecoveryKey).await?
            && !self.boolean(CredentialEffect::VaultAvailable).await?
        {
            return Err(CredentialTransactionError::Unsupported);
        }
        let backups = self.backups().await?;
        if backups.is_empty() {
            return Ok(CredentialResult::Restored {
                restored: 0,
                failed: 0,
            });
        }
        if !self.boolean(CredentialEffect::UnlockRecoveryKey).await? {
            return Err(CredentialTransactionError::Denied);
        }
        // The supplied IDs express selection only. Resolve current metadata
        // inside the native queue so stale screens cannot restore deleted hosts.
        let hosts = self.canonical_hosts().await?;
        let mut restored = 0;
        let mut failed = 0;
        for host in hosts {
            if !host_ids.contains(&host.id) || self.journal.deleted.contains(&host.id) {
                continue;
            }
            let Some(ciphertext) = backups.get(&host.id) else {
                continue;
            };
            self.operation.check()?;
            let result = match self.decrypt(&host.id, ciphertext.clone()).await {
                Ok(material) => self.install_recovered(&host, material).await,
                Err(error) => Err(error),
            };
            match result {
                Ok(_) => restored += 1,
                Err(CredentialTransactionError::Cancelled) => {
                    return Err(CredentialTransactionError::Cancelled);
                }
                Err(_) => {
                    failed += 1;
                    self.diagnostic("credential-backup-restore-host-failed", Some(&host.id));
                }
            }
        }
        Ok(CredentialResult::Restored { restored, failed })
    }

    pub(super) async fn migrate_backups(&self) -> Result<()> {
        if self
            .read_value(CredentialStorageKey::BackupMigration)
            .await?
            .as_deref()
            == Some(BACKUP_MIGRATION_VERSION)
        {
            return Ok(());
        }
        let mut complete = true;
        for host in self.canonical_hosts().await? {
            if self.journal.deleted.contains(&host.id) || self.journal.hosts.contains_key(&host.id)
            {
                complete = false;
                continue;
            }
            let result = async {
                let Some(raw) = self
                    .read_secure(CredentialSlot::Host {
                        id: host.id.clone(),
                    })
                    .await?
                else {
                    return Ok(true);
                };
                let material = parse_host(&raw)?.material;
                if !material.present() {
                    return Err(CredentialTransactionError::MalformedCredential);
                }
                self.backup(&host.id, &material, true).await
            }
            .await;
            if result != Ok(true) {
                complete = false;
                self.diagnostic("credential-backup-migration-item-failed", Some(&host.id));
            }
        }
        if complete {
            self.write_metadata(
                vec![entry(
                    CredentialStorageKey::BackupMigration,
                    Some(BACKUP_MIGRATION_VERSION.into()),
                )],
                false,
            )
            .await?;
        }
        Ok(())
    }
}
