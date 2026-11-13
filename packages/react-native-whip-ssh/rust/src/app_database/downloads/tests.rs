#![allow(clippy::unwrap_used, reason = "test assertions")]
use super::*;

fn manager() -> Manager {
    Manager {
        ledger: Ledger {
            version: 2,
            jobs: vec![],
        },
        revision: 0,
        checkpoint: Instant::now(),
        owner: Some("bridge".into()),
    }
}
fn start(manager: &mut Manager, host: &str) -> String {
    manager
        .apply(Command::Start {
            host_id: host.into(),
            remote_path: "/archive".into(),
            cache_directory: "/private/cache".into(),
            incarnation: 1,
        })
        .unwrap()
        .0
        .created_id
        .unwrap()
}
fn claim(manager: &mut Manager, id: &str) -> Effect {
    manager
        .apply(Command::Claim {
            owner: "bridge".into(),
        })
        .unwrap()
        .0
        .effects
        .into_iter()
        .find(|effect| effect.id == id)
        .unwrap()
}
fn ack(effect: &Effect) -> Command {
    Command::Ack {
        id: effect.id.clone(),
        effect_id: effect.effect_id.clone(),
        owner: "bridge".into(),
        directory: None,
        permission: None,
        saved: None,
        error: None,
        cancelled: false,
    }
}
fn destination(manager: &mut Manager, id: &str) {
    let effect = claim(manager, id);
    let mut command = ack(&effect);
    if let Command::Ack {
        directory,
        permission,
        ..
    } = &mut command
    {
        *directory = Some(format!("content://folder/{id}"));
        *permission = Some("bookmark".into());
    }
    manager.apply(command).unwrap();
}
fn downloading(manager: &mut Manager, host: &str) -> String {
    let id = start(manager, host);
    destination(manager, &id);
    let effect = claim(manager, &id);
    let (_, actions, _) = manager.apply(ack(&effect)).unwrap();
    assert!(matches!(actions.as_slice(), [Action::Start(_)]));
    manager
        .apply(Command::Bound {
            id: id.clone(),
            generation: 1,
            transfer_id: format!("transfer-{host}"),
        })
        .unwrap();
    id
}
fn saving(manager: &mut Manager, host: &str) -> String {
    let id = downloading(manager, host);
    manager
        .apply(Command::Finished {
            id: id.clone(),
            generation: 1,
            source: Some("/private/cache/archive".into()),
            error: None,
        })
        .unwrap();
    id
}
fn saved() -> Saved {
    Saved {
        uri: "content://file/opaque".into(),
        directory_uri: "content://folder".into(),
        is_directory: false,
    }
}
fn complete(manager: &mut Manager, effect: &Effect) {
    let mut command = ack(effect);
    if let Command::Ack { saved: value, .. } = &mut command {
        *value = Some(saved());
    }
    manager.apply(command).unwrap();
}
fn row<'a>(manager: &'a Manager, id: &str) -> &'a Job {
    manager.ledger.jobs.iter().find(|job| job.id == id).unwrap()
}
fn finish_effect(manager: &mut Manager, id: &str) {
    let effect = claim(manager, id);
    manager.apply(ack(&effect)).unwrap();
}
fn retry(manager: &mut Manager, id: &str) -> Result<(Response, Vec<Action>, bool)> {
    manager.apply(Command::Retry {
        id: id.into(),
        cache_directory: "/private/cache".into(),
        choose_destination: false,
        incarnation: 1,
    })
}

#[test]
fn cap_and_picker_are_global_across_hosts_and_duplicate_sources_get_unique_ids() {
    let mut manager = manager();
    let first = start(&mut manager, "a");
    assert!(
        manager
            .apply(Command::Start {
                host_id: "b".into(),
                remote_path: "/archive".into(),
                cache_directory: "/cache".into(),
                incarnation: 1
            })
            .is_err()
    );
    destination(&mut manager, &first);
    let second = start(&mut manager, "b");
    destination(&mut manager, &second);
    let third = start(&mut manager, "a");
    destination(&mut manager, &third);
    assert_ne!(first, third);
    assert!(manager.admit(false).is_err());
}
#[test]
fn picker_cancellation_holds_capacity_and_removal_until_actual_acknowledgement() {
    let mut manager = manager();
    let id = start(&mut manager, "a");
    let effect = claim(&mut manager, &id);
    manager
        .apply(Command::Remove {
            id: id.clone(),
            delete_local: false,
        })
        .unwrap();
    assert!(row(&manager, &id).busy());
    assert!(retry(&mut manager, &id).is_err());
    let mut command = ack(&effect);
    if let Command::Ack {
        directory,
        permission,
        ..
    } = &mut command
    {
        *directory = Some("content://picked".into());
        *permission = Some("grant".into());
    }
    manager.apply(command).unwrap();
    assert_eq!(row(&manager, &id).phase, Phase::Cancelled);
    assert_eq!(
        row(&manager, &id).destination_directory.as_deref(),
        Some("content://picked")
    );
    finish_effect(&mut manager, &id);
    assert!(manager.ledger.jobs.is_empty());
}
#[test]
fn transfer_success_requires_a_separate_verified_destination_ack() {
    let mut manager = manager();
    let id = saving(&mut manager, "a");
    assert_eq!(row(&manager, &id).phase, Phase::Saving);
    assert!(row(&manager, &id).saved.is_none());
    let effect = claim(&mut manager, &id);
    assert!(manager.clone().apply(ack(&effect)).is_err());
    complete(&mut manager, &effect);
    assert_eq!(row(&manager, &id).phase, Phase::Completed);
    finish_effect(&mut manager, &id);
    assert!(!row(&manager, &id).busy());
}
#[test]
fn cancel_during_copy_never_completes_and_deletes_only_the_acknowledged_uri() {
    let mut manager = manager();
    let id = saving(&mut manager, "a");
    let effect = claim(&mut manager, &id);
    manager.apply(Command::Cancel { id: id.clone() }).unwrap();
    complete(&mut manager, &effect);
    assert_eq!(row(&manager, &id).phase, Phase::Cancelled);
    assert_eq!(row(&manager, &id).saved, Some(saved()));
    assert!(retry(&mut manager, &id).is_err());
    finish_effect(&mut manager, &id); // release execution/scope before deleting
    let deletion = claim(&mut manager, &id);
    assert_eq!(deletion.kind, Step::Delete);
    assert_eq!(deletion.job.saved, Some(saved()));
    manager.apply(ack(&deletion)).unwrap();
    assert!(!row(&manager, &id).busy());
    assert!(row(&manager, &id).saved.is_none());
}
#[test]
fn failed_delete_preserves_exact_uri_and_history_for_explicit_recovery() {
    let mut manager = manager();
    let id = saving(&mut manager, "a");
    let effect = claim(&mut manager, &id);
    complete(&mut manager, &effect);
    finish_effect(&mut manager, &id);
    manager
        .apply(Command::Remove {
            id: id.clone(),
            delete_local: true,
        })
        .unwrap();
    let deletion = claim(&mut manager, &id);
    let mut command = ack(&deletion);
    if let Command::Ack { error, .. } = &mut command {
        *error = Some("SAF permission expired".into());
    }
    manager.apply(command).unwrap();
    assert_eq!(row(&manager, &id).saved, Some(saved()));
    assert!(!row(&manager, &id).busy());
    assert!(row(&manager, &id).error.as_deref().unwrap().contains("SAF"));
    manager
        .apply(Command::Remove {
            id: id.clone(),
            delete_local: false,
        })
        .unwrap();
    assert!(manager.ledger.jobs.is_empty());
}
#[test]
fn retry_fences_old_transfer_completion_and_os_receipts_by_generation() {
    let mut manager = manager();
    let id = downloading(&mut manager, "a");
    let old_execution = row(&manager, &id).operation.execution_id.clone();
    manager.apply(Command::Pause { id: id.clone() }).unwrap();
    assert!(retry(&mut manager, &id).is_err());
    manager
        .apply(Command::Finished {
            id: id.clone(),
            generation: 1,
            source: None,
            error: Some("cancelled".into()),
        })
        .unwrap();
    finish_effect(&mut manager, &id);
    retry(&mut manager, &id).unwrap();
    assert!(
        !manager
            .apply(Command::Finished {
                id: id.clone(),
                generation: 1,
                source: Some("old".into()),
                error: None
            })
            .unwrap()
            .0
            .accepted
    );
    assert!(
        !manager
            .apply(Command::Expire {
                execution_id: old_execution,
                cancelled: true
            })
            .unwrap()
            .0
            .accepted
    );
    assert_eq!(row(&manager, &id).phase, Phase::Selecting);
    assert!(!row(&manager, &id).cancel_requested);
}
#[test]
fn expiry_before_transfer_binding_cancels_that_attempt_without_touching_other_hosts() {
    let mut manager = manager();
    let first = downloading(&mut manager, "a");
    let second = downloading(&mut manager, "b");
    let execution_id = row(&manager, &first).operation.execution_id.clone();
    manager
        .apply(Command::Expire {
            execution_id,
            cancelled: true,
        })
        .unwrap();
    assert_eq!(row(&manager, &first).phase, Phase::Cancelled);
    assert_eq!(row(&manager, &second).phase, Phase::Downloading);
    assert!(
        !manager
            .apply(Command::Bound {
                id: first,
                generation: 1,
                transfer_id: "late-binding".into()
            })
            .unwrap()
            .0
            .accepted
    );
}
#[test]
fn bridge_restart_adopts_native_transfer_but_never_replays_an_uncertain_copy() {
    let mut manager = manager();
    let id = saving(&mut manager, "a");
    let effect = claim(&mut manager, &id);
    let other = downloading(&mut manager, "b");
    manager
        .apply(Command::Attach {
            owner: "new-bridge".into(),
        })
        .unwrap();
    assert_eq!(row(&manager, &id).phase, Phase::Failed);
    assert!(
        row(&manager, &id)
            .error
            .as_deref()
            .unwrap()
            .contains("incomplete copy")
    );
    assert_eq!(row(&manager, &other).phase, Phase::Downloading);
    assert!(!manager.apply(ack(&effect)).unwrap().0.accepted);
    assert!(
        manager
            .apply(Command::Claim {
                owner: "bridge".into()
            })
            .is_err()
    );
    let effects = manager
        .apply(Command::Claim {
            owner: "new-bridge".into(),
        })
        .unwrap()
        .0
        .effects;
    assert!(effects.iter().all(|effect| effect.kind != Step::Save));
}
#[test]
fn each_effect_is_claimed_once_and_stale_acknowledgements_are_idempotently_rejected() {
    let mut manager = manager();
    let id = start(&mut manager, "a");
    let effect = claim(&mut manager, &id);
    assert!(
        manager
            .apply(Command::Claim {
                owner: "bridge".into()
            })
            .unwrap()
            .0
            .effects
            .is_empty()
    );
    let mut command = ack(&effect);
    if let Command::Ack { cancelled, .. } = &mut command {
        *cancelled = true;
    }
    manager.apply(command.clone()).unwrap();
    assert!(!manager.apply(command).unwrap().0.accepted);
    assert_eq!(row(&manager, &id).phase, Phase::Cancelled);
}
fn store(path: &std::path::Path) -> Store {
    let mut store = Store::open(path, crate::runtime().unwrap()).unwrap();
    store.write(vec![], true).unwrap();
    store
}
#[test]
fn legacy_migration_preserves_completed_paths_bookmarks_and_retains_its_source() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = store(&directory.path().join("db"));
    let legacy = r#"[{"id":"old","hostId":"host","remotePath":"/archive","name":"archive","createdAt":1,"phase":"completed","bytesTransferred":134217728,"destinationDirectory":"file:///picked","permission":"bookmark","saved":{"uri":"file:///picked/archive","directoryUri":"file:///picked","isDirectory":false}}]"#;
    store
        .write(
            vec![AppStorageEntry {
                key: LEGACY_KEY.into(),
                value: Some(legacy.into()),
            }],
            false,
        )
        .unwrap();
    let mut manager = Manager::load(&store).unwrap();
    manager.save(&mut store).unwrap();
    let job = row(&manager, "old");
    assert_eq!(job.phase, Phase::Completed);
    assert_eq!(job.permission.as_deref(), Some("bookmark"));
    assert_eq!(job.saved.as_ref().unwrap().uri, "file:///picked/archive");
    assert_eq!(
        store.read(vec![LEGACY_KEY.into()]).unwrap()[0]
            .value
            .as_deref(),
        Some(legacy)
    );
    manager.ledger.jobs.clear();
    manager.save(&mut store).unwrap();
    assert!(Manager::load(&store).unwrap().ledger.jobs.is_empty());
}
#[test]
fn native_process_restart_preserves_cancellation_and_never_completes_an_incomplete_copy() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db");
    let mut store = store(&path);
    let mut manager = manager();
    let save = saving(&mut manager, "a");
    let transfer = downloading(&mut manager, "b");
    manager
        .apply(Command::Cancel {
            id: transfer.clone(),
        })
        .unwrap();
    manager.save(&mut store).unwrap();
    drop(store);
    let reopened = Store::open(&path, crate::runtime().unwrap()).unwrap();
    let recovered = Manager::load(&reopened).unwrap();
    assert_eq!(row(&recovered, &save).phase, Phase::Failed);
    assert_eq!(row(&recovered, &save).failed_phase, Some(Phase::Saving));
    assert_eq!(row(&recovered, &transfer).phase, Phase::Cancelled);
    assert!(row(&recovered, &transfer).cancel_requested);
}
#[test]
fn malformed_legacy_history_is_preserved_without_installing_a_migration_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = store(&directory.path().join("db"));
    store
        .write(
            vec![AppStorageEntry {
                key: LEGACY_KEY.into(),
                value: Some("not-json".into()),
            }],
            false,
        )
        .unwrap();
    assert!(Manager::load(&store).is_err());
    assert!(store.read(vec![KEY.into()]).unwrap()[0].value.is_none());
    assert_eq!(
        store.read(vec![LEGACY_KEY.into()]).unwrap()[0]
            .value
            .as_deref(),
        Some("not-json")
    );
}
#[test]
fn a_failed_checkpoint_does_not_publish_state_or_start_native_work() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = store(&directory.path().join("db"));
    store.downloads = Some(manager());
    // Revoke migration to force a real persistence failure, not a fake test of
    // the JSON implementation. The committed manager remains authoritative.
    store
        .runtime
        .block_on(
            store
                .connection
                .execute("DELETE FROM storage_migrations", ()),
        )
        .unwrap();
    assert!(
        transact(
            &mut store,
            Command::Start {
                host_id: "a".into(),
                remote_path: "/archive".into(),
                cache_directory: "/cache".into(),
                incarnation: 1
            }
        )
        .is_err()
    );
    assert!(store.downloads.as_ref().unwrap().ledger.jobs.is_empty());
}

#[test]
fn committed_save_stays_completed_if_process_dies_before_os_execution_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = store(&directory.path().join("db"));
    let mut manager = manager();
    let id = saving(&mut manager, "a");
    let effect = claim(&mut manager, &id);
    complete(&mut manager, &effect);
    assert_eq!(row(&manager, &id).operation.step, Step::End);
    manager.save(&mut store).unwrap();
    let recovered = Manager::load(&store).unwrap();
    assert_eq!(row(&recovered, &id).phase, Phase::Completed);
    assert_eq!(row(&recovered, &id).saved, Some(saved()));
    assert!(!row(&recovered, &id).busy());
}

#[test]
fn expiry_during_copy_cleans_acknowledged_output_before_allowing_safe_retry() {
    let mut manager = manager();
    let id = saving(&mut manager, "a");
    let effect = claim(&mut manager, &id);
    let execution_id = row(&manager, &id).operation.execution_id.clone();
    manager
        .apply(Command::Expire {
            execution_id,
            cancelled: false,
        })
        .unwrap();
    complete(&mut manager, &effect);
    assert_eq!(row(&manager, &id).phase, Phase::Paused);
    finish_effect(&mut manager, &id);
    assert_eq!(row(&manager, &id).operation.step, Step::Delete);
    finish_effect(&mut manager, &id);
    retry(&mut manager, &id).unwrap();
    assert!(row(&manager, &id).saved.is_none());
}

#[test]
fn legacy_interrupted_rows_can_retry_without_a_native_staging_path() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = store(&directory.path().join("db"));
    let legacy = r#"[{"id":"old","hostId":"a","remotePath":"/archive","name":"archive","createdAt":1,"phase":"downloading","bytesTransferred":42,"destinationDirectory":"content://picked/","permission":"grant"}]"#;
    store
        .write(
            vec![AppStorageEntry {
                key: LEGACY_KEY.into(),
                value: Some(legacy.into()),
            }],
            false,
        )
        .unwrap();
    let mut manager = Manager::load(&store).unwrap();
    retry(&mut manager, "old").unwrap();
    assert_eq!(row(&manager, "old").phase, Phase::Selecting);
    assert_eq!(
        row(&manager, "old").destination_directory.as_deref(),
        Some("content://picked/")
    );
    assert!(
        row(&manager, "old")
            .operation
            .staging
            .as_deref()
            .unwrap()
            .starts_with("/private/cache/whip-job-old-")
    );
}

#[test]
fn async_storage_upgrade_imports_download_history_and_section_preferences_together() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(&directory.path().join("db"), crate::runtime().unwrap()).unwrap();
    let keys = super::super::select_legacy_app_data_keys(vec![
        LEGACY_KEY.into(),
        "whip.downloads.expanded.v1".into(),
        "unrelated-library".into(),
    ]);
    assert_eq!(keys, [LEGACY_KEY, "whip.downloads.expanded.v1"]);
    store
        .write(
            vec![
                AppStorageEntry {
                    key: LEGACY_KEY.into(),
                    value: Some("[]".into()),
                },
                AppStorageEntry {
                    key: "whip.downloads.expanded.v1".into(),
                    value: Some("true".into()),
                },
            ],
            true,
        )
        .unwrap();
    assert!(Manager::load(&store).unwrap().ledger.jobs.is_empty());
    assert_eq!(
        store
            .read(vec!["whip.downloads.expanded.v1".into()])
            .unwrap()[0]
            .value
            .as_deref(),
        Some("true")
    );
}

#[test]
fn foreground_recovery_remembers_busy_paused_jobs_and_explicit_cancel_revokes_recovery() {
    let mut manager = manager();
    let id = downloading(&mut manager, "recovery-host");
    manager.apply(Command::Pause { id: id.clone() }).unwrap();
    manager
        .apply(Command::Resume {
            host_id: Some("recovery-host".into()),
            cache_directory: "/private/cache".into(),
        })
        .unwrap();
    assert!(row(&manager, &id).busy());
    assert_eq!(
        row(&manager, &id).operation.resume_cache.as_deref(),
        Some("/private/cache")
    );
    manager.apply(Command::Cancel { id: id.clone() }).unwrap();
    manager
        .apply(Command::Finished {
            id: id.clone(),
            generation: 1,
            source: Some("late-result".into()),
            error: None,
        })
        .unwrap();
    finish_effect(&mut manager, &id);
    assert_eq!(row(&manager, &id).phase, Phase::Cancelled);
    assert!(row(&manager, &id).operation.resume_cache.is_none());
}
