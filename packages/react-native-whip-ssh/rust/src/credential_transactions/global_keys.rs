use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::journal::GlobalPending;
use super::storage::{encode, entry, now};
use super::{
    CredentialEffect, CredentialResult, CredentialSlot, CredentialStorageKey,
    CredentialTransactionError, GlobalKeyInput, GlobalKeyMaterial, GlobalKeyMetadata, Result,
    Workflow,
};

const GLOBAL_USERNAME: &str = "global-ssh-keychain";

#[derive(Clone, Serialize, Deserialize)]
struct Material {
    id: String,
    secret: String,
    passphrase: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Envelope {
    receipt: Option<String>,
    keys: Vec<Material>,
}

fn parse_material(value: Option<&str>) -> Result<Envelope> {
    let Some(value) = value else {
        return Ok(Envelope {
            receipt: None,
            keys: vec![],
        });
    };
    // Array payloads are retained as a supported, receipt-less legacy format.
    let parsed: serde_json::Value =
        serde_json::from_str(value).map_err(|_| CredentialTransactionError::MalformedCredential)?;
    let envelope: Envelope = if parsed.is_array() {
        Envelope {
            receipt: None,
            keys: serde_json::from_value(parsed)
                .map_err(|_| CredentialTransactionError::MalformedCredential)?,
        }
    } else {
        serde_json::from_value(parsed)
            .map_err(|_| CredentialTransactionError::MalformedCredential)?
    };
    let ids = envelope
        .keys
        .iter()
        .map(|key| key.id.as_str())
        .collect::<BTreeSet<_>>();
    if ids.len() != envelope.keys.len()
        || envelope
            .keys
            .iter()
            .any(|key| key.id.is_empty() || key.secret.is_empty())
    {
        return Err(CredentialTransactionError::MalformedCredential);
    }
    Ok(envelope)
}
fn matches(keys: &[GlobalKeyMetadata], materials: &[Material]) -> bool {
    keys.iter().map(|key| &key.id).collect::<BTreeSet<_>>()
        == materials.iter().map(|key| &key.id).collect::<BTreeSet<_>>()
}
fn metadata(keys: &[GlobalKeyMaterial]) -> Vec<GlobalKeyMetadata> {
    keys.iter().map(|key| key.metadata.clone()).collect()
}

impl Workflow {
    pub(super) async fn authenticate_global(&self) -> Result<()> {
        if self.boolean(CredentialEffect::AuthenticateGlobal).await? {
            Ok(())
        } else {
            Err(CredentialTransactionError::Denied)
        }
    }

    async fn reconcile_global(&mut self) -> Result<()> {
        let Some(pending) = self.journal.global.clone() else {
            return Ok(());
        };
        let raw = self.read_secure(CredentialSlot::Global).await?;
        let materials = parse_material(raw.as_deref())?;
        let committed = materials.receipt.as_ref() == Some(&pending.receipt)
            && matches(&pending.after, &materials.keys)
            || raw.is_none() && pending.after.is_empty();
        let keys = if committed {
            pending.after
        } else if materials.receipt == pending.before_receipt
            && matches(&pending.before, &materials.keys)
        {
            pending.before
        } else {
            return Err(CredentialTransactionError::InconsistentGlobalKeys);
        };
        self.journal.global = None;
        self.write_metadata(
            vec![
                entry(CredentialStorageKey::GlobalKeys, Some(encode(&keys)?)),
                self.journal_entry()?,
            ],
            true,
        )
        .await
    }

    pub(super) async fn global_metadata(&mut self) -> Result<Vec<GlobalKeyMetadata>> {
        if self.journal.global.is_some() {
            return Err(CredentialTransactionError::RepairRequired);
        }
        let Some(value) = self.read_value(CredentialStorageKey::GlobalKeys).await? else {
            return Ok(vec![]);
        };
        let mut keys: Vec<GlobalKeyMetadata> = serde_json::from_str(&value)
            .map_err(|_| CredentialTransactionError::MalformedMetadata)?;
        if keys.iter().any(|key| {
            key.id.is_empty()
                || key.name.is_empty()
                || key.fingerprint.is_empty()
                || key.key_type.is_empty()
        }) || keys
            .iter()
            .map(|key| &key.id)
            .collect::<BTreeSet<_>>()
            .len()
            != keys.len()
        {
            return Err(CredentialTransactionError::MalformedMetadata);
        }
        keys.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(keys)
    }

    pub(super) async fn global_materials(&mut self) -> Result<Vec<GlobalKeyMaterial>> {
        self.reconcile_global().await?;
        let keys = self.global_metadata().await?;
        let raw = self.read_secure(CredentialSlot::Global).await?;
        let materials = parse_material(raw.as_deref())?;
        if !matches(&keys, &materials.keys) {
            return Err(CredentialTransactionError::InconsistentGlobalKeys);
        }
        keys.into_iter()
            .map(|metadata| {
                let material = materials
                    .keys
                    .iter()
                    .find(|key| key.id == metadata.id)
                    .ok_or(CredentialTransactionError::InconsistentGlobalKeys)?;
                Ok(GlobalKeyMaterial {
                    metadata,
                    secret: material.secret.clone(),
                    passphrase: material.passphrase.clone(),
                })
            })
            .collect()
    }

    pub(super) async fn save_global(&mut self, input: GlobalKeyInput) -> Result<CredentialResult> {
        if input.name.trim().is_empty()
            || input.secret.is_empty()
            || input.fingerprint.is_empty()
            || input.key_type.is_empty()
        {
            return Err(CredentialTransactionError::MalformedCredential);
        }
        let mut keys = self.global_materials().await?;
        let timestamp = now();
        keys.push(GlobalKeyMaterial {
            metadata: GlobalKeyMetadata {
                id: format!("key-{}", uuid::Uuid::new_v4()),
                name: input.name.trim().into(),
                fingerprint: input.fingerprint,
                key_type: input.key_type,
                created_at: timestamp.clone(),
                updated_at: timestamp,
            },
            secret: input.secret,
            passphrase: input.passphrase,
        });
        keys.sort_by(|left, right| left.metadata.name.cmp(&right.metadata.name));
        self.replace_global(keys).await
    }

    pub(super) async fn delete_global(&mut self, id: &str) -> Result<CredentialResult> {
        let mut keys = self.global_materials().await?;
        keys.retain(|key| key.metadata.id != id);
        self.replace_global(keys).await
    }

    async fn replace_global(&mut self, keys: Vec<GlobalKeyMaterial>) -> Result<CredentialResult> {
        let previous_raw = self.read_secure(CredentialSlot::Global).await?;
        let previous_material = parse_material(previous_raw.as_deref())?;
        let before = self.global_metadata().await?;
        let previous_metadata = encode(&before)?;
        let receipt = uuid::Uuid::new_v4().to_string();
        let after = metadata(&keys);
        self.journal.global = Some(GlobalPending {
            receipt: receipt.clone(),
            before_receipt: previous_material.receipt,
            before,
            after: after.clone(),
        });
        // Commit the secret-free intent before touching Keychain. Caller arrays
        // never replace the authoritative previous keys used for compensation.
        self.persist_journal(false).await?;
        let envelope = Envelope {
            receipt: Some(receipt),
            keys: keys
                .iter()
                .map(|key| Material {
                    id: key.metadata.id.clone(),
                    secret: key.secret.clone(),
                    passphrase: key.passphrase.clone(),
                })
                .collect(),
        };
        let value = if keys.is_empty() {
            None
        } else {
            Some(encode(&envelope)?)
        };
        let write = self
            .write_secure(CredentialSlot::Global, GLOBAL_USERNAME.into(), value, false)
            .await;
        if let Err(error) = write {
            return Err(
                if matches!(
                    error,
                    CredentialTransactionError::Cancelled | CredentialTransactionError::Denied
                ) {
                    error
                } else {
                    CredentialTransactionError::PartialCommit
                },
            );
        }
        let commit = async {
            self.operation.check()?;
            self.write_metadata(
                vec![entry(
                    CredentialStorageKey::GlobalKeys,
                    Some(encode(&after)?),
                )],
                false,
            )
            .await
        }
        .await;
        if commit.is_err() {
            // This compensation remains serialized even after caller cancellation.
            // Failed compensation keeps the durable intent for next-launch repair.
            if self
                .write_secure(
                    CredentialSlot::Global,
                    GLOBAL_USERNAME.into(),
                    previous_raw,
                    true,
                )
                .await
                .is_err()
            {
                self.diagnostic("global-ssh-key-material-rollback-failed", None);
                return Err(CredentialTransactionError::PartialCommit);
            }
            self.journal.global = None;
            if self
                .write_metadata(
                    vec![
                        entry(CredentialStorageKey::GlobalKeys, Some(previous_metadata)),
                        self.journal_entry()?,
                    ],
                    true,
                )
                .await
                .is_err()
            {
                return Err(CredentialTransactionError::PartialCommit);
            }
            return Err(commit
                .err()
                .unwrap_or(CredentialTransactionError::MetadataStorage));
        }
        self.journal.global = None;
        if self.persist_journal(true).await.is_err() {
            return Err(CredentialTransactionError::PartialCommit);
        }
        Ok(CredentialResult::GlobalMaterials { keys })
    }
}
