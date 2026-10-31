use super::journal::{HostEnvelope, HostPending};
use super::storage::{encode, entry, now};
use super::{
    CredentialMaterial, CredentialResult, CredentialSlot, CredentialStorageKey,
    CredentialTransactionError, Result, Workflow,
};
use crate::host_profiles::{DEFAULT_HERDR_COMMAND, DEFAULT_SSH_PORT};
use crate::{HostActionProfilePatch, HostProfileRecord, HostProfileStore};
use std::sync::Arc;

impl Workflow {
    pub(super) async fn draft(&self) -> Result<Arc<HostProfileStore>> {
        if !self.operation.coordinator.state.lock().loaded {
            return Err(CredentialTransactionError::ProfilesUnavailable);
        }
        let draft = HostProfileStore::new();
        draft
            .hydrate(self.read_value(CredentialStorageKey::Hosts).await?)
            .map_err(|_| CredentialTransactionError::MalformedMetadata)?;
        Ok(draft)
    }

    pub(super) async fn canonical_hosts(&self) -> Result<Vec<HostProfileRecord>> {
        let store = HostProfileStore::new();
        store
            .hydrate(self.read_value(CredentialStorageKey::Hosts).await?)
            .map(|view| view.hosts)
            .map_err(|_| CredentialTransactionError::MalformedMetadata)
    }

    fn adopt(&self, store: Arc<HostProfileStore>) {
        let mut state = self.operation.coordinator.state.lock();
        state.store = store;
        state.loaded = true;
        drop(state);
    }

    async fn commit_profiles(
        &self,
        store: Arc<HostProfileStore>,
        journal: bool,
    ) -> Result<Vec<HostProfileRecord>> {
        let view = store
            .view()
            .map_err(|_| CredentialTransactionError::InvalidProfile)?;
        let mut entries = vec![entry(
            CredentialStorageKey::Hosts,
            Some(view.persisted_value),
        )];
        if journal {
            entries.push(self.journal_entry()?);
        }
        self.write_metadata(entries, false).await?;
        self.adopt(store);
        Ok(view.hosts)
    }

    pub(super) async fn load_hosts(
        &mut self,
        _from_storage: bool,
        _hosts: Option<String>,
        _legacy: Option<String>,
    ) -> Result<CredentialResult> {
        // A renderer snapshot can predate a queued mutation or a new adapter.
        // Read the committed values while holding the native transaction queue.
        let values = self
            .read_metadata(vec![
                CredentialStorageKey::Hosts,
                CredentialStorageKey::LegacyProfile,
            ])
            .await?;
        let (hosts, legacy) = (values[0].clone(), values[1].clone());
        let store = HostProfileStore::new();
        if let Some(value) = hosts {
            store
                .hydrate(Some(value))
                .map_err(|_| CredentialTransactionError::MalformedMetadata)?;
        } else if let Some(legacy) = legacy
            && let Some(host) = store
                .migrate_legacy(legacy, now())
                .map_err(|_| CredentialTransactionError::MalformedMetadata)?
        {
            let raw = self.read_secure(CredentialSlot::Legacy).await?;
            let material = raw
                .as_deref()
                .map(parse_host)
                .transpose()?
                .map(|envelope| envelope.material)
                .unwrap_or_default();
            store
                .upsert(host.clone(), now())
                .map_err(|_| CredentialTransactionError::InvalidProfile)?;
            if material.present() {
                let receipt = uuid::Uuid::new_v4().to_string();
                self.journal.hosts.insert(
                    host.id.clone(),
                    HostPending::Write {
                        receipt: receipt.clone(),
                        username: host.username.clone(),
                        legacy: true,
                    },
                );
                self.commit_profiles(store, true).await?;
                let result = self.finish_host_write(&host, material, receipt).await;
                self.publish_repairs();
                result.map_err(|_| CredentialTransactionError::PartialCommit)?;
                return Ok(CredentialResult::Hosts {
                    hosts: self.operation.coordinator.view().hosts,
                });
            }
            self.commit_profiles(store, false).await?;
            self.publish_repairs();
            return Ok(CredentialResult::Hosts {
                hosts: self.operation.coordinator.view().hosts,
            });
        }
        self.adopt(store);
        // Retry only receipt-proven writes/deletions. Unknown writes remain
        // visible as repair IDs; loading metadata never invents a credential.
        for id in self.journal.hosts.clone().into_keys() {
            if self.reconcile_host(&id).await.is_err() {
                self.diagnostic("credential-transaction-repair-required", Some(&id));
            }
        }
        self.publish_repairs();
        Ok(CredentialResult::Hosts {
            hosts: self.operation.coordinator.view().hosts,
        })
    }

    pub(super) async fn save_host(
        &mut self,
        profile: HostProfileRecord,
        credential: CredentialMaterial,
    ) -> Result<CredentialResult> {
        let next = self.draft().await?;
        if self.journal.deleted.contains(&profile.id) {
            return Err(CredentialTransactionError::StaleProfile);
        }
        if next
            .view()
            .map_err(|_| CredentialTransactionError::MalformedMetadata)?
            .hosts
            .iter()
            .any(|host| host.id == profile.id && host.updated_at != profile.updated_at)
        {
            return Err(CredentialTransactionError::StaleProfile);
        }
        let host = next
            .normalize_profile(profile, None, next_timestamp(&next)?)
            .map_err(|_| CredentialTransactionError::InvalidProfile)?;
        // A new explicit save can repair an interrupted save of this same ID.
        self.journal.hosts.remove(&host.id);
        let saved = self.read_host(&host, true).await?;
        let credential = Self::prepare_identity(&host, credential, &saved)?;
        next.upsert(host.clone(), host.updated_at.clone())
            .map_err(|_| CredentialTransactionError::InvalidProfile)?;
        let host = next
            .view()
            .map_err(|_| CredentialTransactionError::InvalidProfile)?
            .hosts
            .into_iter()
            .find(|value| value.id == host.id)
            .ok_or(CredentialTransactionError::InvalidProfile)?;
        let receipt = uuid::Uuid::new_v4().to_string();
        self.journal.hosts.insert(
            host.id.clone(),
            if credential.present() {
                HostPending::Write {
                    receipt: receipt.clone(),
                    username: host.username.clone(),
                    legacy: false,
                }
            } else {
                HostPending::Clear
            },
        );
        let hosts = self.commit_profiles(next, true).await?;
        let result = if credential.present() {
            self.finish_host_write(&host, credential, receipt).await
        } else {
            self.finish_host_clear(&host.id).await
        };
        self.publish_repairs();
        result.map_err(|_| CredentialTransactionError::PartialCommit)?;
        Ok(CredentialResult::Saved { hosts, host })
    }

    pub(super) async fn save_metadata(
        &mut self,
        id: String,
        patch: HostActionProfilePatch,
        source: Option<String>,
    ) -> Result<CredentialResult> {
        let next = self.draft().await?;
        if self.journal.deleted.contains(&id) {
            return Err(CredentialTransactionError::StaleProfile);
        }
        let previous = next
            .view()
            .map_err(|_| CredentialTransactionError::MalformedMetadata)?
            .hosts
            .into_iter()
            .find(|host| host.id == id);
        let timestamp = next_timestamp(&next)?;
        let mut host = previous.clone().unwrap_or(HostProfileRecord {
            id: id.clone(),
            name: String::new(),
            host: String::new(),
            port: DEFAULT_SSH_PORT.into(),
            username: String::new(),
            jump_host_id: None,
            forward_agent: false,
            tailcat_enabled: false,
            tailcat_ssh_server: false,
            auth_mode: crate::HostAuthMode::Password,
            herdr_enabled: true,
            herdr_command: DEFAULT_HERDR_COMMAND.into(),
            herdr_socket_path: String::new(),
            session_name: String::new(),
            agent_instructions: String::new(),
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
            last_connected_at: None,
        });
        macro_rules! apply { ($($field:ident),*) => { $(if let Some(value) = patch.$field { host.$field = value; })* }; }
        apply!(
            name,
            host,
            port,
            username,
            auth_mode,
            herdr_command,
            herdr_socket_path,
            session_name,
            forward_agent
        );
        if patch.jump_host_changed {
            host.jump_host_id = patch.jump_host_id;
        }
        let host = next
            .normalize_profile(
                host,
                previous.as_ref().map(|host| host.created_at.clone()),
                timestamp.clone(),
            )
            .map_err(|_| CredentialTransactionError::InvalidProfile)?;
        let material = if let Some(source) = source {
            let source = next
                .view()
                .map_err(|_| CredentialTransactionError::MalformedMetadata)?
                .hosts
                .into_iter()
                .find(|host| host.id == source)
                .ok_or(CredentialTransactionError::InvalidProfile)?;
            if source.auth_mode != host.auth_mode {
                return Err(CredentialTransactionError::InvalidProfile);
            }
            let mut credential = self.read_host(&source, true).await?;
            if credential.secret.is_empty() {
                return Err(CredentialTransactionError::MalformedCredential);
            }
            let target = if let Some(previous) = &previous {
                self.read_host(previous, true).await?
            } else {
                CredentialMaterial::default()
            };
            credential.tailcat_address = target.tailcat_address;
            credential.tailcat_private_key = target.tailcat_private_key;
            credential.tailcat_public_key = target.tailcat_public_key;
            Some(credential)
        } else {
            if previous
                .as_ref()
                .is_some_and(|previous| previous.auth_mode != host.auth_mode)
            {
                return Err(CredentialTransactionError::InvalidProfile);
            }
            None
        };
        next.upsert(host.clone(), timestamp)
            .map_err(|_| CredentialTransactionError::InvalidProfile)?;
        let receipt = uuid::Uuid::new_v4().to_string();
        if material.is_some() {
            self.journal.deleted.remove(&id);
            self.journal.hosts.insert(
                id,
                HostPending::Write {
                    receipt: receipt.clone(),
                    username: host.username.clone(),
                    legacy: false,
                },
            );
        }
        self.commit_profiles(next, material.is_some()).await?;
        let result = if let Some(material) = material {
            self.finish_host_write(&host, material, receipt).await
        } else {
            Ok(())
        };
        self.publish_repairs();
        result.map_err(|_| CredentialTransactionError::PartialCommit)?;
        Ok(CredentialResult::Host { host })
    }

    pub(super) async fn delete_host(&mut self, id: String) -> Result<CredentialResult> {
        let next = self.draft().await?;
        next.remove(id.clone(), next_timestamp(&next)?)
            .map_err(|_| CredentialTransactionError::InvalidProfile)?;
        self.journal.deleted.insert(id.clone());
        self.journal.hosts.insert(id.clone(), HostPending::Clear);
        let hosts = self.commit_profiles(next, true).await?;
        let result = self.finish_host_clear(&id).await;
        self.publish_repairs();
        result.map_err(|_| CredentialTransactionError::PartialCommit)?;
        Ok(CredentialResult::Hosts { hosts })
    }

    pub(super) async fn mark_disconnected(&mut self, id: String) -> Result<CredentialResult> {
        let next = self.draft().await?;
        next.mark_disconnected(id, next_timestamp(&next)?)
            .map_err(|_| CredentialTransactionError::InvalidProfile)?;
        let hosts = self.commit_profiles(next, false).await?;
        self.publish_repairs();
        Ok(CredentialResult::Hosts { hosts })
    }

    pub(super) async fn finish_host_write(
        &mut self,
        host: &HostProfileRecord,
        material: CredentialMaterial,
        receipt: String,
    ) -> Result<()> {
        let envelope = HostEnvelope {
            material,
            receipt: Some(receipt),
        };
        self.write_secure(
            CredentialSlot::Host {
                id: host.id.clone(),
            },
            if host.username.is_empty() {
                host.id.clone()
            } else {
                host.username.clone()
            },
            Some(encode(&envelope)?),
            false,
        )
        .await?;
        self.operation.check()?;
        self.backup(&host.id, &envelope.material, false).await?;
        self.clear_host_pending(&host.id, true).await
    }

    async fn finish_host_clear(&mut self, id: &str) -> Result<()> {
        self.write_secure(
            CredentialSlot::Host { id: id.into() },
            String::new(),
            None,
            false,
        )
        .await?;
        self.operation.check()?;
        self.remove_backup(id).await?;
        self.clear_host_pending(id, true).await
    }

    pub(super) async fn read_host(
        &mut self,
        host: &HostProfileRecord,
        strict: bool,
    ) -> Result<CredentialMaterial> {
        if self.journal.deleted.contains(&host.id) {
            return Err(CredentialTransactionError::InvalidProfile);
        }
        self.reconcile_host(&host.id).await?;
        let raw = self
            .read_secure(CredentialSlot::Host {
                id: host.id.clone(),
            })
            .await;
        let mut invalid = false;
        let primary = match raw {
            Ok(Some(raw)) => match parse_host(&raw) {
                Ok(envelope) if envelope.material.present() => Some(envelope.material),
                _ => {
                    invalid = true;
                    self.diagnostic("keychain-credential-parse-failed", Some(&host.id));
                    None
                }
            },
            Ok(None) => None,
            Err(error) if strict => return Err(error),
            Err(_) => {
                self.diagnostic("keychain-credential-read-failed", Some(&host.id));
                None
            }
        };
        if let Some(primary) = primary {
            return Ok(primary);
        }
        if let Some(recovered) = self.recover_host(host).await? {
            return Ok(recovered);
        }
        if strict && host.tailcat_enabled && self.backups().await?.contains_key(&host.id) {
            return Err(CredentialTransactionError::RecoveryRequired);
        }
        if strict && invalid {
            return Err(CredentialTransactionError::MalformedCredential);
        }
        Ok(CredentialMaterial::default())
    }

    pub(super) async fn read_bound_host(
        &mut self,
        host: &HostProfileRecord,
        strict: bool,
    ) -> Result<CredentialMaterial> {
        let current = self
            .canonical_hosts()
            .await?
            .into_iter()
            .find(|current| current.id == host.id)
            .ok_or(CredentialTransactionError::StaleProfile)?;
        if current.created_at != host.created_at
            || current.host != host.host
            || current.port != host.port
            || current.username != host.username
            || current.auth_mode != host.auth_mode
            || current.jump_host_id != host.jump_host_id
            || current.forward_agent != host.forward_agent
            || current.tailcat_enabled != host.tailcat_enabled
            || current.tailcat_ssh_server != host.tailcat_ssh_server
        {
            return Err(CredentialTransactionError::StaleProfile);
        }
        self.read_host(host, strict).await
    }

    fn prepare_identity(
        host: &HostProfileRecord,
        mut credential: CredentialMaterial,
        saved: &CredentialMaterial,
    ) -> Result<CredentialMaterial> {
        let existing = if saved.tailcat_private_key.is_some() || saved.tailcat_public_key.is_some()
        {
            saved
        } else {
            &credential
        };
        match (&existing.tailcat_private_key, &existing.tailcat_public_key) {
            (Some(private), Some(public)) if !private.is_empty() && !public.is_empty() => {
                let (private, public) = (private.clone(), public.clone());
                credential.tailcat_private_key = Some(private);
                credential.tailcat_public_key = Some(public);
            }
            (None, None) if host.tailcat_enabled => {
                let identity = crate::generate_tailcat_identity()
                    .map_err(|_| CredentialTransactionError::SecureStorage)?;
                credential.tailcat_private_key = Some(identity.private_key);
                credential.tailcat_public_key = Some(identity.public_key);
            }
            (None, None) => {}
            _ => return Err(CredentialTransactionError::IncompleteIdentity),
        }
        Ok(credential)
    }

    pub(super) async fn ensure_identity(
        &mut self,
        host: HostProfileRecord,
        credential: CredentialMaterial,
    ) -> Result<CredentialResult> {
        if !host.tailcat_enabled {
            return Ok(CredentialResult::Material { credential });
        }
        let saved = self.read_host(&host, true).await?;
        let prepared = Self::prepare_identity(&host, credential, &saved)?;
        if saved.tailcat_private_key != prepared.tailcat_private_key
            || saved.tailcat_public_key != prepared.tailcat_public_key
        {
            let receipt = uuid::Uuid::new_v4().to_string();
            self.journal.hosts.insert(
                host.id.clone(),
                HostPending::Write {
                    receipt: receipt.clone(),
                    username: host.username.clone(),
                    legacy: false,
                },
            );
            self.persist_journal(false).await?;
            let material = CredentialMaterial {
                tailcat_private_key: prepared.tailcat_private_key.clone(),
                tailcat_public_key: prepared.tailcat_public_key.clone(),
                ..saved
            };
            let result = self.finish_host_write(&host, material, receipt).await;
            self.publish_repairs();
            result.map_err(|_| CredentialTransactionError::PartialCommit)?;
        }
        Ok(CredentialResult::Material {
            credential: prepared,
        })
    }
}

pub(super) fn parse_host(value: &str) -> Result<HostEnvelope> {
    serde_json::from_str(value).map_err(|_| CredentialTransactionError::MalformedCredential)
}

fn next_timestamp(store: &HostProfileStore) -> Result<String> {
    let mut millis = chrono::Utc::now().timestamp_millis();
    for host in store
        .view()
        .map_err(|_| CredentialTransactionError::MalformedMetadata)?
        .hosts
    {
        if let Ok(previous) = chrono::DateTime::parse_from_rfc3339(&host.updated_at) {
            millis = millis.max(previous.timestamp_millis().saturating_add(1));
        }
    }
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or(CredentialTransactionError::InvalidProfile)
}
