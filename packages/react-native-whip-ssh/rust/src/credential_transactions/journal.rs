use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::storage::{encode, entry};
use super::{
    CredentialMaterial, CredentialSlot, CredentialStorageEntry, CredentialStorageKey,
    CredentialTransactionError, GlobalKeyMetadata, Result, Workflow,
};

const VERSION: u32 = 1;

/// Only receipts, IDs and public metadata cross this durable boundary.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Journal {
    version: u32,
    pub hosts: BTreeMap<String, HostPending>,
    pub deleted: BTreeSet<String>,
    pub global: Option<GlobalPending>,
}
impl Default for Journal {
    fn default() -> Self {
        Self {
            version: VERSION,
            hosts: BTreeMap::new(),
            deleted: BTreeSet::new(),
            global: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum HostPending {
    Write {
        receipt: String,
        username: String,
        #[serde(default)]
        legacy: bool,
    },
    Clear,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct GlobalPending {
    pub receipt: String,
    pub before_receipt: Option<String>,
    pub before: Vec<GlobalKeyMetadata>,
    pub after: Vec<GlobalKeyMetadata>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HostEnvelope {
    #[serde(flatten)]
    pub material: CredentialMaterial,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<String>,
}

impl Workflow {
    pub(super) async fn load_journal(&self) -> Result<Journal> {
        let Some(value) = self.read_value(CredentialStorageKey::Transactions).await? else {
            return Ok(Journal::default());
        };
        let journal: Journal = serde_json::from_str(&value)
            .map_err(|_| CredentialTransactionError::MalformedMetadata)?;
        if journal.version != VERSION {
            return Err(CredentialTransactionError::MalformedMetadata);
        }
        Ok(journal)
    }
    pub(super) fn journal_entry(&self) -> Result<CredentialStorageEntry> {
        Ok(entry(
            CredentialStorageKey::Transactions,
            Some(encode(&self.journal)?),
        ))
    }
    pub(super) async fn persist_journal(&self, cleanup: bool) -> Result<()> {
        self.write_metadata(vec![self.journal_entry()?], cleanup)
            .await
    }
    pub(super) async fn clear_host_pending(&mut self, id: &str, cleanup: bool) -> Result<()> {
        let previous = self.journal.hosts.remove(id);
        if let Err(error) = self.persist_journal(cleanup).await {
            if let Some(previous) = previous {
                self.journal.hosts.insert(id.into(), previous);
            }
            return Err(error);
        }
        Ok(())
    }
    pub(super) fn publish_repairs(&self) {
        let mut state = self.operation.coordinator.state.lock();
        state.repairs = self.journal.hosts.keys().cloned().collect();
        state.revision = state.revision.wrapping_add(1);
        drop(state);
        self.operation
            .coordinator
            .platform
            .profiles_changed(self.operation.coordinator.view());
    }

    pub(super) async fn reconcile_host(&mut self, id: &str) -> Result<()> {
        let Some(pending) = self.journal.hosts.get(id).cloned() else {
            return Ok(());
        };
        match pending {
            HostPending::Clear => {
                self.write_secure(
                    CredentialSlot::Host { id: id.into() },
                    String::new(),
                    None,
                    false,
                )
                .await?;
                self.remove_backup(id).await?;
            }
            HostPending::Write {
                receipt,
                username,
                legacy,
            } => {
                let raw = self
                    .read_secure(CredentialSlot::Host { id: id.into() })
                    .await?;
                let envelope = raw
                    .and_then(|value| serde_json::from_str::<HostEnvelope>(&value).ok())
                    .filter(|envelope| {
                        envelope.receipt.as_ref() == Some(&receipt) && envelope.material.present()
                    });
                let envelope = if let Some(envelope) = envelope {
                    envelope
                } else if legacy {
                    let raw = self
                        .read_secure(CredentialSlot::Legacy)
                        .await?
                        .ok_or(CredentialTransactionError::RepairRequired)?;
                    let mut envelope: HostEnvelope = serde_json::from_str(&raw)
                        .map_err(|_| CredentialTransactionError::RepairRequired)?;
                    if !envelope.material.present() {
                        return Err(CredentialTransactionError::RepairRequired);
                    }
                    envelope.receipt = Some(receipt);
                    self.write_secure(
                        CredentialSlot::Host { id: id.into() },
                        username,
                        Some(encode(&envelope)?),
                        false,
                    )
                    .await?;
                    envelope
                } else {
                    return Err(CredentialTransactionError::RepairRequired);
                };
                self.backup(id, &envelope.material, false).await?;
            }
        }
        self.clear_host_pending(id, false).await?;
        self.publish_repairs();
        Ok(())
    }
}
