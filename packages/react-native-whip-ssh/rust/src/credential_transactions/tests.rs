use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::Notify;

use super::{
    CredentialCommand, CredentialCoordinator, CredentialEffect, CredentialEffectPermit,
    CredentialEffectResult, CredentialMaterial, CredentialPlatform, CredentialPlatformError,
    CredentialProfileView, CredentialRecoveryState, CredentialResult, CredentialSlot,
    CredentialStorageEntry, CredentialStorageKey, CredentialTransactionError, GlobalKeyInput,
};
use crate::{HostActionProfilePatch, HostAuthMode, HostProfileRecord};

type TestResult = Result<(), Box<dyn Error>>;
type TransactionResult = Result<CredentialResult, CredentialTransactionError>;
static TEST_LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
enum Phase {
    ReadMetadata,
    WriteMetadata(CredentialStorageKey),
    ReadSecure,
    WriteSecure,
    ClearSecure,
    Encrypt,
    Decrypt,
    Unlock,
    Other,
}
struct Failure {
    phase: Phase,
    commit: bool,
}
#[derive(Default)]
struct Store {
    metadata: HashMap<String, String>,
    secure: HashMap<String, String>,
    ciphertext: HashMap<String, String>,
    failures: VecDeque<Failure>,
    calls: Vec<Phase>,
    views: Vec<CredentialProfileView>,
    hold: Option<Phase>,
    permits: Vec<Arc<CredentialEffectPermit>>,
    vault: bool,
    recovery_key: bool,
}
#[derive(Default)]
struct Platform {
    state: Mutex<Store>,
    release: Notify,
}
fn key(key: CredentialStorageKey) -> String {
    format!("{key:?}")
}
fn slot(slot: &CredentialSlot) -> String {
    match slot {
        CredentialSlot::Host { id } => id.clone(),
        CredentialSlot::Legacy => "legacy".into(),
        CredentialSlot::Global => "global".into(),
    }
}

impl Platform {
    fn metadata(&self, key_value: CredentialStorageKey) -> Option<String> {
        self.state.lock().metadata.get(&key(key_value)).cloned()
    }
    fn put(&self, key_value: CredentialStorageKey, value: String) {
        self.state.lock().metadata.insert(key(key_value), value);
    }
    fn fail(&self, phase: Phase, commit: bool) {
        self.state
            .lock()
            .failures
            .push_back(Failure { phase, commit });
    }
    fn resume(&self) {
        self.state.lock().hold = None;
        self.release.notify_waiters();
    }
    fn count(&self, phase: &Phase) -> usize {
        self.state
            .lock()
            .calls
            .iter()
            .filter(|value| *value == phase)
            .count()
    }
    fn assert_no_plaintext(&self) {
        for value in self.state.lock().metadata.values() {
            assert!(!value.contains("PRIVATE-MATERIAL"));
            assert!(!value.contains("PRIVATE-PASSPHRASE"));
            assert!(!value.contains("privkey:"));
        }
    }
}

#[async_trait::async_trait]
impl CredentialPlatform for Platform {
    async fn effect(
        &self,
        permit: Arc<CredentialEffectPermit>,
        effect: CredentialEffect,
    ) -> Result<CredentialEffectResult, CredentialPlatformError> {
        permit
            .check_active()
            .map_err(|_| CredentialPlatformError::Cancelled)?;
        let phase = match &effect {
            CredentialEffect::ReadMetadata { .. } => Phase::ReadMetadata,
            CredentialEffect::WriteMetadata { entries } => Phase::WriteMetadata(entries[0].key),
            CredentialEffect::ReadSecure { .. } => Phase::ReadSecure,
            CredentialEffect::WriteSecure { .. } => Phase::WriteSecure,
            CredentialEffect::ClearSecure { .. } => Phase::ClearSecure,
            CredentialEffect::Encrypt { .. } => Phase::Encrypt,
            CredentialEffect::Decrypt { .. } => Phase::Decrypt,
            CredentialEffect::UnlockRecoveryKey | CredentialEffect::AuthenticateGlobal => {
                Phase::Unlock
            }
            _ => Phase::Other,
        };
        let released = self.release.notified();
        tokio::pin!(released);
        released.as_mut().enable();
        let hold = {
            let mut state = self.state.lock();
            state.calls.push(phase.clone());
            state.permits.push(permit);
            state.hold.as_ref() == Some(&phase)
        };
        if hold {
            released.await;
        }
        let mut state = self.state.lock();
        let failure = if state
            .failures
            .front()
            .is_some_and(|failure| failure.phase == phase)
        {
            state.failures.pop_front()
        } else {
            None
        };
        let failure_error = if matches!(phase, Phase::ReadMetadata | Phase::WriteMetadata(_)) {
            CredentialPlatformError::MetadataStorage
        } else {
            CredentialPlatformError::SecureStorage
        };
        if failure.as_ref().is_some_and(|failure| !failure.commit) {
            return Err(failure_error);
        }
        let result = match effect {
            CredentialEffect::ReadMetadata { keys } => CredentialEffectResult::Metadata {
                entries: keys
                    .into_iter()
                    .map(|key_value| CredentialStorageEntry {
                        key: key_value,
                        value: state.metadata.get(&key(key_value)).cloned(),
                    })
                    .collect(),
            },
            CredentialEffect::WriteMetadata { entries } => {
                for entry in entries {
                    if let Some(value) = entry.value {
                        state.metadata.insert(key(entry.key), value);
                    } else {
                        state.metadata.remove(&key(entry.key));
                    }
                }
                CredentialEffectResult::Done
            }
            CredentialEffect::ReadSecure { slot: target } => CredentialEffectResult::Text {
                value: state.secure.get(&slot(&target)).cloned(),
            },
            CredentialEffect::WriteSecure {
                slot: target,
                value,
                ..
            } => {
                state.secure.insert(slot(&target), value);
                CredentialEffectResult::Done
            }
            CredentialEffect::ClearSecure { slot: target } => {
                state.secure.remove(&slot(&target));
                CredentialEffectResult::Done
            }
            CredentialEffect::Encrypt { plaintext, .. } => {
                let ciphertext = format!("encrypted-{}", state.ciphertext.len());
                state.ciphertext.insert(ciphertext.clone(), plaintext);
                CredentialEffectResult::Text {
                    value: Some(ciphertext),
                }
            }
            CredentialEffect::Decrypt { ciphertext, .. } => CredentialEffectResult::Text {
                value: state.ciphertext.get(&ciphertext).cloned(),
            },
            CredentialEffect::VaultAvailable => {
                CredentialEffectResult::Boolean { value: state.vault }
            }
            CredentialEffect::HasRecoveryKey => CredentialEffectResult::Boolean {
                value: state.recovery_key,
            },
            CredentialEffect::UnlockRecoveryKey => {
                state.recovery_key = true;
                CredentialEffectResult::Boolean { value: true }
            }
            CredentialEffect::AuthenticateGlobal => CredentialEffectResult::Boolean { value: true },
            CredentialEffect::ClearRecoveryKey => {
                state.recovery_key = false;
                CredentialEffectResult::Done
            }
        };
        drop(state);
        if failure.is_some() {
            Err(failure_error)
        } else {
            Ok(result)
        }
    }
    fn profiles_changed(&self, view: CredentialProfileView) {
        self.state.lock().views.push(view);
    }
    fn diagnostic(&self, _event: String, _host_id: Option<String>) {}
}

async fn fixture() -> (
    tokio::sync::OwnedMutexGuard<()>,
    Arc<Platform>,
    Arc<CredentialCoordinator>,
) {
    let lock = TEST_LOCK
        .get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
        .lock_owned()
        .await;
    let platform = Arc::new(Platform::default());
    let coordinator = CredentialCoordinator::new(platform.clone());
    (lock, platform, coordinator)
}
async fn run(
    coordinator: &Arc<CredentialCoordinator>,
    command: CredentialCommand,
) -> TransactionResult {
    coordinator.begin(command, None).result().await
}
async fn load(
    platform: &Platform,
    coordinator: &Arc<CredentialCoordinator>,
    hosts: Vec<HostProfileRecord>,
) -> TransactionResult {
    platform.put(
        CredentialStorageKey::Hosts,
        serde_json::to_string(&hosts).map_err(|_| CredentialTransactionError::InvalidProfile)?,
    );
    run(
        coordinator,
        CredentialCommand::LoadHosts {
            from_storage: true,
            hosts: Some(
                serde_json::to_string(&hosts)
                    .map_err(|_| CredentialTransactionError::InvalidProfile)?,
            ),
            legacy: None,
        },
    )
    .await
}
fn host(id: &str) -> HostProfileRecord {
    HostProfileRecord {
        id: id.into(),
        name: id.into(),
        host: "host.example".into(),
        port: "22".into(),
        username: "user".into(),
        jump_host_id: None,
        forward_agent: false,
        tailcat_enabled: false,
        tailcat_ssh_server: false,
        auth_mode: HostAuthMode::Key,
        herdr_enabled: true,
        herdr_command: "herdr".into(),
        herdr_socket_path: String::new(),
        session_name: String::new(),
        agent_instructions: "User instructions".into(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: "2026-01-01T00:00:00.000Z".into(),
        last_connected_at: None,
    }
}
fn material() -> CredentialMaterial {
    CredentialMaterial {
        secret: "PRIVATE-MATERIAL".into(),
        passphrase: "PRIVATE-PASSPHRASE".into(),
        ..CredentialMaterial::default()
    }
}
fn global_input(name: &str) -> GlobalKeyInput {
    GlobalKeyInput {
        name: name.into(),
        fingerprint: "SHA256:public".into(),
        key_type: "ssh-ed25519".into(),
        secret: "PRIVATE-MATERIAL".into(),
        passphrase: "PRIVATE-PASSPHRASE".into(),
    }
}
async fn until(mut check: impl FnMut() -> bool) -> TestResult {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await?;
    Ok(())
}
fn error(result: TransactionResult) -> Option<CredentialTransactionError> {
    result.err()
}

#[test]
fn metadata_failure_does_not_publish_or_write_credentials_and_later_save_can_retry() -> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        load(&platform, &coordinator, vec![]).await?;
        platform.fail(Phase::WriteMetadata(CredentialStorageKey::Hosts), false);
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::SaveHost {
                        profile: host("a"),
                        credential: material()
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::MetadataStorage)
        );
        assert!(coordinator.view().hosts.is_empty());
        assert_eq!(platform.count(&Phase::WriteSecure), 0);
        run(
            &coordinator,
            CredentialCommand::SaveHost {
                profile: host("b"),
                credential: material(),
            },
        )
        .await?;
        assert_eq!(coordinator.view().hosts[0].id, "b");
        platform.assert_no_plaintext();
        coordinator.close();
        Ok(())
    })
}

#[test]
fn credential_failure_reports_partial_commit_and_retains_repair_state_across_restart() -> TestResult
{
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        load(&platform, &coordinator, vec![]).await?;
        platform.fail(Phase::WriteSecure, false);
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::SaveHost {
                        profile: host("a"),
                        credential: material()
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::PartialCommit)
        );
        assert_eq!(coordinator.view().hosts[0].id, "a");
        assert_eq!(coordinator.view().repair_host_ids, ["a"]);
        coordinator.close();
        let restarted = CredentialCoordinator::new(platform.clone());
        run(
            &restarted,
            CredentialCommand::LoadHosts {
                from_storage: false,
                hosts: None,
                legacy: None,
            },
        )
        .await?;
        assert_eq!(
            error(
                run(
                    &restarted,
                    CredentialCommand::ReadHost {
                        host: host("a"),
                        strict: false
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::RepairRequired)
        );
        let current = restarted.view().hosts[0].clone();
        run(
            &restarted,
            CredentialCommand::SaveHost {
                profile: current,
                credential: material(),
            },
        )
        .await?;
        assert!(restarted.view().repair_host_ids.is_empty());
        platform.assert_no_plaintext();
        restarted.close();
        Ok(())
    })
}

#[test]
fn acknowledged_receipt_repairs_a_lost_secure_store_reply_without_losing_the_credential()
-> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        load(&platform, &coordinator, vec![]).await?;
        platform.fail(Phase::WriteSecure, true);
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::SaveHost {
                        profile: host("a"),
                        credential: material()
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::PartialCommit)
        );
        coordinator.close();
        let restarted = CredentialCoordinator::new(platform.clone());
        run(
            &restarted,
            CredentialCommand::LoadHosts {
                from_storage: false,
                hosts: None,
                legacy: None,
            },
        )
        .await?;
        assert!(restarted.view().repair_host_ids.is_empty());
        let result = run(
            &restarted,
            CredentialCommand::ReadHost {
                host: host("a"),
                strict: true,
            },
        )
        .await?;
        assert!(
            matches!(result, CredentialResult::Material { credential } if credential == material())
        );
        platform.assert_no_plaintext();
        restarted.close();
        Ok(())
    })
}

#[test]
fn cancelled_inflight_write_drains_before_delete_and_cannot_complete_over_the_deletion()
-> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        load(&platform, &coordinator, vec![]).await?;
        platform.state.lock().hold = Some(Phase::WriteSecure);
        let save = coordinator.begin(
            CredentialCommand::SaveHost {
                profile: host("a"),
                credential: material(),
            },
            None,
        );
        until(|| platform.count(&Phase::WriteSecure) == 1).await?;
        save.cancel();
        let delete = coordinator.begin(CredentialCommand::DeleteHost { id: "a".into() }, None);
        tokio::task::yield_now().await;
        assert_eq!(platform.count(&Phase::ClearSecure), 0);
        platform.resume();
        assert_eq!(
            error(save.result().await),
            Some(CredentialTransactionError::PartialCommit)
        );
        delete.result().await?;
        assert!(coordinator.view().hosts.is_empty());
        assert!(!platform.state.lock().secure.contains_key("a"));
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::SaveHost {
                        profile: host("a"),
                        credential: material()
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::StaleProfile)
        );
        assert!(
            platform
                .state
                .lock()
                .permits
                .iter()
                .all(|permit| permit.check_active().is_err())
        );
        coordinator.close();
        Ok(())
    })
}

#[test]
fn dropped_callers_and_replaced_adapters_do_not_release_started_writes_early() -> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        load(&platform, &coordinator, vec![]).await?;
        platform.state.lock().hold = Some(Phase::WriteSecure);
        let save = coordinator.begin(
            CredentialCommand::SaveHost {
                profile: host("a"),
                credential: material(),
            },
            None,
        );
        until(|| platform.count(&Phase::WriteSecure) == 1).await?;
        drop(save);
        coordinator.close();
        let restarted = CredentialCoordinator::new(platform.clone());
        let read = restarted.begin(
            CredentialCommand::LoadHosts {
                from_storage: false,
                hosts: None,
                legacy: None,
            },
            None,
        );
        assert_eq!(platform.count(&Phase::ReadSecure), 1);
        platform.resume();
        read.result().await?;
        assert!(restarted.view().repair_host_ids.is_empty());
        restarted.close();
        Ok(())
    })
}

#[test]
fn stale_edits_and_restore_selections_cannot_resurrect_deleted_hosts() -> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        load(&platform, &coordinator, vec![host("a")]).await?;
        let old = host("a");
        let mut renamed = old.clone();
        renamed.name = "Renamed".into();
        run(
            &coordinator,
            CredentialCommand::SaveHost {
                profile: renamed,
                credential: material(),
            },
        )
        .await?;
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::SaveHost {
                        profile: old.clone(),
                        credential: material()
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::StaleProfile)
        );
        run(
            &coordinator,
            CredentialCommand::DeleteHost { id: "a".into() },
        )
        .await?;
        platform.state.lock().vault = true;
        platform.put(
            CredentialStorageKey::Backups,
            "{\"a\":\"old-ciphertext\"}".into(),
        );
        let result = run(
            &coordinator,
            CredentialCommand::RestoreBackups {
                host_ids: vec!["a".into()],
            },
        )
        .await?;
        assert!(matches!(
            result,
            CredentialResult::Restored {
                restored: 0,
                failed: 0
            }
        ));
        assert!(!platform.state.lock().secure.contains_key("a"));
        coordinator.close();
        Ok(())
    })
}

#[test]
fn delete_failure_keeps_metadata_deleted_and_retries_credential_cleanup_after_restart() -> TestResult
{
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        load(&platform, &coordinator, vec![host("a")]).await?;
        platform
            .state
            .lock()
            .secure
            .insert("a".into(), serde_json::to_string(&material())?);
        platform.fail(Phase::ClearSecure, false);
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::DeleteHost { id: "a".into() }
                )
                .await
            ),
            Some(CredentialTransactionError::PartialCommit)
        );
        assert!(coordinator.view().hosts.is_empty());
        coordinator.close();
        let restarted = CredentialCoordinator::new(platform.clone());
        run(
            &restarted,
            CredentialCommand::LoadHosts {
                from_storage: false,
                hosts: None,
                legacy: None,
            },
        )
        .await?;
        assert!(restarted.view().hosts.is_empty());
        assert!(!platform.state.lock().secure.contains_key("a"));
        restarted.close();
        Ok(())
    })
}

#[test]
fn global_metadata_failure_compensates_using_authoritative_keychain_contents() -> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        run(
            &coordinator,
            CredentialCommand::SaveGlobalKey {
                input: global_input("first"),
            },
        )
        .await?;
        let previous = platform.state.lock().secure.get("global").cloned();
        platform.fail(
            Phase::WriteMetadata(CredentialStorageKey::GlobalKeys),
            false,
        );
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::SaveGlobalKey {
                        input: global_input("second")
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::MetadataStorage)
        );
        assert_eq!(
            platform.state.lock().secure.get("global").cloned(),
            previous
        );
        let result = run(&coordinator, CredentialCommand::UnlockGlobalKeys).await?;
        assert!(matches!(result, CredentialResult::GlobalMaterials { keys } if keys.len() == 1));
        platform.assert_no_plaintext();
        coordinator.close();
        Ok(())
    })
}

#[test]
fn failed_global_compensation_is_reconciled_from_a_receipt_after_restart() -> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        run(
            &coordinator,
            CredentialCommand::SaveGlobalKey {
                input: global_input("first"),
            },
        )
        .await?;
        platform.fail(
            Phase::WriteMetadata(CredentialStorageKey::GlobalKeys),
            false,
        );
        platform.fail(Phase::WriteSecure, false);
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::SaveGlobalKey {
                        input: global_input("second")
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::PartialCommit)
        );
        coordinator.close();
        let restarted = CredentialCoordinator::new(platform.clone());
        assert_eq!(
            error(run(&restarted, CredentialCommand::LoadGlobalKeys).await),
            Some(CredentialTransactionError::RepairRequired)
        );
        let result = run(&restarted, CredentialCommand::UnlockGlobalKeys).await?;
        assert!(matches!(result, CredentialResult::GlobalMaterials { keys } if keys.len() == 2));
        platform.assert_no_plaintext();
        restarted.close();
        Ok(())
    })
}

#[test]
fn concurrent_global_saves_merge_fresh_material_and_delete_the_final_key() -> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        let first = coordinator.begin(
            CredentialCommand::SaveGlobalKey {
                input: global_input("first"),
            },
            None,
        );
        let second = coordinator.begin(
            CredentialCommand::SaveGlobalKey {
                input: global_input("second"),
            },
            None,
        );
        first.result().await?;
        let CredentialResult::GlobalMaterials { keys } = second.result().await? else {
            return Err("missing global keys".into());
        };
        assert_eq!(keys.len(), 2);
        for key in keys {
            run(
                &coordinator,
                CredentialCommand::DeleteGlobalKey {
                    id: key.metadata.id,
                },
            )
            .await?;
        }
        assert!(!platform.state.lock().secure.contains_key("global"));
        assert_eq!(
            platform
                .metadata(CredentialStorageKey::GlobalKeys)
                .as_deref(),
            Some("[]")
        );
        platform.assert_no_plaintext();
        coordinator.close();
        Ok(())
    })
}

#[test]
fn malformed_backup_metadata_is_preserved_and_empty_decryption_never_clears_a_primary() -> TestResult
{
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        platform.state.lock().vault = true;
        platform.put(CredentialStorageKey::Backups, "{broken".into());
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::Backup {
                        id: "a".into(),
                        credential: material(),
                        only_missing: false
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::MalformedMetadata)
        );
        assert_eq!(platform.count(&Phase::Encrypt), 0);
        assert_eq!(
            platform.metadata(CredentialStorageKey::Backups).as_deref(),
            Some("{broken")
        );
        platform.put(CredentialStorageKey::Backups, "{\"a\":\"cipher\"}".into());
        platform.state.lock().recovery_key = true;
        platform.state.lock().ciphertext.insert(
            "cipher".into(),
            "{\"secret\":\"\",\"passphrase\":\"\"}".into(),
        );
        let result = run(
            &coordinator,
            CredentialCommand::RecoverHost { host: host("a") },
        )
        .await?;
        assert!(matches!(
            result,
            CredentialResult::Recovered { credential: None }
        ));
        assert_eq!(platform.count(&Phase::WriteSecure), 0);
        coordinator.close();
        Ok(())
    })
}

#[test]
fn backups_are_ciphertext_only_and_bulk_restore_uses_canonical_profiles() -> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        platform.state.lock().vault = true;
        load(&platform, &coordinator, vec![host("a")]).await?;
        run(
            &coordinator,
            CredentialCommand::Backup {
                id: "a".into(),
                credential: material(),
                only_missing: false,
            },
        )
        .await?;
        run(
            &coordinator,
            CredentialCommand::Backup {
                id: "a".into(),
                credential: material(),
                only_missing: true,
            },
        )
        .await?;
        assert_eq!(platform.count(&Phase::Encrypt), 1);
        let status = run(&coordinator, CredentialCommand::RecoveryStatus).await?;
        assert!(matches!(
            status,
            CredentialResult::RecoveryStatus {
                state: CredentialRecoveryState::Locked,
                count: 1
            }
        ));
        let result = run(
            &coordinator,
            CredentialCommand::RestoreBackups {
                host_ids: vec!["a".into(), "deleted".into()],
            },
        )
        .await?;
        assert!(matches!(
            result,
            CredentialResult::Restored {
                restored: 1,
                failed: 0
            }
        ));
        assert_eq!(platform.count(&Phase::Decrypt), 1);
        assert!(platform.state.lock().secure.contains_key("a"));
        platform.assert_no_plaintext();
        coordinator.close();
        Ok(())
    })
}

#[test]
fn tailcat_identity_is_stable_and_locked_or_incomplete_recovery_never_rotates_it() -> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        let mut profile = host("a");
        profile.tailcat_enabled = true;
        let first = coordinator.begin(
            CredentialCommand::EnsureIdentity {
                host: profile.clone(),
                credential: material(),
            },
            None,
        );
        let second = coordinator.begin(
            CredentialCommand::EnsureIdentity {
                host: profile.clone(),
                credential: material(),
            },
            None,
        );
        let CredentialResult::Material { credential: a } = first.result().await? else {
            return Err("missing identity".into());
        };
        let CredentialResult::Material { credential: b } = second.result().await? else {
            return Err("missing identity".into());
        };
        assert!(a.tailcat_private_key.is_some());
        assert!(a == b);
        platform.state.lock().secure.remove("a");
        platform.state.lock().vault = true;
        platform.put(
            CredentialStorageKey::Backups,
            "{\"a\":\"locked-ciphertext\"}".into(),
        );
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::EnsureIdentity {
                        host: profile.clone(),
                        credential: material()
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::RecoveryRequired)
        );
        platform.state.lock().secure.insert(
            "a".into(),
            "{\"secret\":\"old\",\"tailcatPrivateKey\":\"privkey:partial\"}".into(),
        );
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::EnsureIdentity {
                        host: profile,
                        credential: material()
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::IncompleteIdentity)
        );
        platform.assert_no_plaintext();
        coordinator.close();
        Ok(())
    })
}

#[test]
fn interrupted_legacy_migration_retains_its_source_and_receipt_retries_exactly_that_host()
-> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        let legacy = "{\"host\":\"legacy.example\",\"username\":\"user\",\"authMode\":\"key\"}";
        platform.put(CredentialStorageKey::LegacyProfile, legacy.into());
        platform
            .state
            .lock()
            .secure
            .insert("legacy".into(), serde_json::to_string(&material())?);
        platform.fail(Phase::WriteSecure, false);
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::LoadHosts {
                        from_storage: false,
                        hosts: None,
                        legacy: None
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::PartialCommit)
        );
        coordinator.close();
        let restarted = CredentialCoordinator::new(platform.clone());
        run(
            &restarted,
            CredentialCommand::LoadHosts {
                from_storage: false,
                hosts: None,
                legacy: None,
            },
        )
        .await?;
        assert_eq!(restarted.view().hosts[0].id, "host-legacy-default");
        assert!(restarted.view().repair_host_ids.is_empty());
        assert!(platform.state.lock().secure.contains_key("legacy"));
        assert!(
            platform
                .state
                .lock()
                .secure
                .contains_key("host-legacy-default")
        );
        platform.assert_no_plaintext();
        restarted.close();
        Ok(())
    })
}

#[test]
fn metadata_edits_preserve_instructions_and_authentication_mode_and_deletion_repairs_jump_links()
-> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        let bastion = host("bastion");
        let mut target = host("a");
        target.jump_host_id = Some(bastion.id.clone());
        load(&platform, &coordinator, vec![bastion, target]).await?;
        let patch: HostActionProfilePatch =
            serde_json::from_value(serde_json::json!({"name":"renamed"}))?;
        run(
            &coordinator,
            CredentialCommand::SaveMetadata {
                id: "a".into(),
                patch,
                source: None,
            },
        )
        .await?;
        assert_eq!(
            coordinator
                .view()
                .hosts
                .iter()
                .find(|host| host.id == "a")
                .ok_or("missing host")?
                .agent_instructions,
            "User instructions"
        );
        run(
            &coordinator,
            CredentialCommand::DeleteHost {
                id: "bastion".into(),
            },
        )
        .await?;
        assert!(coordinator.view().hosts[0].jump_host_id.is_none());
        coordinator.close();
        Ok(())
    })
}

#[test]
fn a_second_coordinator_reads_committed_profiles_instead_of_overwriting_from_its_old_cache()
-> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, first) = fixture().await;
        load(&platform, &first, vec![host("a")]).await?;
        let second = CredentialCoordinator::new(platform.clone());
        run(
            &second,
            CredentialCommand::LoadHosts {
                from_storage: false,
                hosts: None,
                legacy: None,
            },
        )
        .await?;
        let mut updated = host("a");
        updated.name = "Newest".into();
        run(
            &first,
            CredentialCommand::SaveHost {
                profile: updated,
                credential: material(),
            },
        )
        .await?;
        let patch: HostActionProfilePatch =
            serde_json::from_value(serde_json::json!({"host":"second.example","username":"user"}))?;
        run(
            &second,
            CredentialCommand::SaveMetadata {
                id: "b".into(),
                patch,
                source: None,
            },
        )
        .await?;
        run(
            &first,
            CredentialCommand::MarkDisconnected { id: "a".into() },
        )
        .await?;
        assert_eq!(first.view().hosts.len(), 2);
        assert_eq!(
            first
                .view()
                .hosts
                .iter()
                .find(|host| host.id == "a")
                .ok_or("missing host")?
                .name,
            "Newest"
        );
        first.close();
        second.close();
        Ok(())
    })
}

#[test]
fn stale_startup_snapshots_and_connection_targets_do_not_replace_current_repository_data()
-> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        let mut current = host("a");
        current.host = "new.example".into();
        platform.put(
            CredentialStorageKey::Hosts,
            serde_json::to_string(&vec![current.clone()])?,
        );
        run(
            &coordinator,
            CredentialCommand::LoadHosts {
                from_storage: true,
                hosts: Some(serde_json::to_string(&vec![host("a")])?),
                legacy: None,
            },
        )
        .await?;
        assert_eq!(coordinator.view().hosts[0].host, "new.example");
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::ReadHost {
                        host: host("a"),
                        strict: false
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::StaleProfile)
        );
        assert_eq!(platform.count(&Phase::ReadSecure), 0);
        coordinator.close();
        Ok(())
    })
}

#[test]
fn failure_to_clear_a_completed_intent_still_reports_repair_and_is_safe_to_retry() -> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        load(&platform, &coordinator, vec![]).await?;
        platform.fail(
            Phase::WriteMetadata(CredentialStorageKey::Transactions),
            false,
        );
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::SaveHost {
                        profile: host("a"),
                        credential: material()
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::PartialCommit)
        );
        assert_eq!(coordinator.view().repair_host_ids, ["a"]);
        coordinator.close();
        let restarted = CredentialCoordinator::new(platform.clone());
        run(
            &restarted,
            CredentialCommand::LoadHosts {
                from_storage: false,
                hosts: None,
                legacy: None,
            },
        )
        .await?;
        assert!(restarted.view().repair_host_ids.is_empty());
        platform.assert_no_plaintext();
        restarted.close();
        Ok(())
    })
}

#[test]
fn backup_failure_retains_the_committed_primary_and_retries_without_rotating_it() -> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        load(&platform, &coordinator, vec![]).await?;
        platform.state.lock().vault = true;
        platform.fail(Phase::Encrypt, false);
        assert_eq!(
            error(
                run(
                    &coordinator,
                    CredentialCommand::SaveHost {
                        profile: host("a"),
                        credential: material()
                    }
                )
                .await
            ),
            Some(CredentialTransactionError::PartialCommit)
        );
        let primary = platform.state.lock().secure.get("a").cloned();
        coordinator.close();
        let restarted = CredentialCoordinator::new(platform.clone());
        run(
            &restarted,
            CredentialCommand::LoadHosts {
                from_storage: false,
                hosts: None,
                legacy: None,
            },
        )
        .await?;
        assert_eq!(platform.state.lock().secure.get("a").cloned(), primary);
        assert!(restarted.view().repair_host_ids.is_empty());
        assert!(platform.metadata(CredentialStorageKey::Backups).is_some());
        platform.assert_no_plaintext();
        restarted.close();
        Ok(())
    })
}

#[test]
fn backup_migration_records_completion_only_after_all_items_succeed() -> TestResult {
    crate::runtime()?.block_on(async {
        let (_lock, platform, coordinator) = fixture().await;
        load(&platform, &coordinator, vec![host("a")]).await?;
        platform.state.lock().vault = true;
        platform
            .state
            .lock()
            .secure
            .insert("a".into(), serde_json::to_string(&material())?);
        platform.fail(Phase::ReadSecure, false);
        run(&coordinator, CredentialCommand::MigrateBackups).await?;
        assert!(
            platform
                .metadata(CredentialStorageKey::BackupMigration)
                .is_none()
        );
        run(&coordinator, CredentialCommand::MigrateBackups).await?;
        assert_eq!(
            platform
                .metadata(CredentialStorageKey::BackupMigration)
                .as_deref(),
            Some("1")
        );
        let reads = platform.count(&Phase::ReadSecure);
        run(&coordinator, CredentialCommand::MigrateBackups).await?;
        assert_eq!(platform.count(&Phase::ReadSecure), reads);
        platform.assert_no_plaintext();
        coordinator.close();
        Ok(())
    })
}
