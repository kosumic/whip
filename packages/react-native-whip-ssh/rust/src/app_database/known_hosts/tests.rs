use super::*;
use std::sync::mpsc;
use std::time::Duration;

struct Fixture {
    repository: Arc<KnownHostRepository>,
    database: AppDatabase,
    _directory: tempfile::TempDir,
}

impl Fixture {
    fn new(value: Option<String>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let database = AppDatabase::open(directory.path().join("app.db")).unwrap();
        let entries = value
            .into_iter()
            .map(|value| AppStorageEntry {
                key: KNOWN_HOSTS_STORAGE_KEY.into(),
                value: Some(value),
            })
            .collect();
        crate::runtime()
            .unwrap()
            .block_on(database.request(move |store| store.write(entries, true)))
            .unwrap();
        let repository =
            KnownHostRepository::attach(Arc::new(Core::default()), Some(database.clone()));
        Self {
            repository,
            database,
            _directory: directory,
        }
    }

    fn run(&self, command: KnownHostCommand) -> Result<KnownHostRepositoryView> {
        crate::runtime()
            .unwrap()
            .block_on(self.repository.begin(command).result())
    }

    fn persisted(&self) -> Option<String> {
        crate::runtime()
            .unwrap()
            .block_on(self.database.request(|store| {
                Ok(store
                    .read(vec![KNOWN_HOSTS_STORAGE_KEY.into()])?
                    .remove(0)
                    .value)
            }))
            .unwrap()
    }

    fn sql(&self, sql: &'static str) {
        crate::runtime()
            .unwrap()
            .block_on(self.database.request(move |store| {
                store
                    .runtime
                    .block_on(store.connection.execute_batch(sql))
                    .map_err(Into::into)
            }))
            .unwrap();
    }

    fn write(&self, value: String) {
        crate::runtime()
            .unwrap()
            .block_on(self.database.request(move |store| {
                store.write(
                    vec![AppStorageEntry {
                        key: KNOWN_HOSTS_STORAGE_KEY.into(),
                        value: Some(value),
                    }],
                    false,
                )
            }))
            .unwrap();
    }

    fn block_worker(&self) -> mpsc::Sender<()> {
        let (started, wait) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        self.database
            .sender
            .send(Box::new(move |_| {
                started.send(()).unwrap();
                blocked.recv_timeout(Duration::from_secs(10)).unwrap();
            }))
            .unwrap();
        wait.recv_timeout(Duration::from_secs(10)).unwrap();
        release
    }
}

fn challenge(host: &str) -> HostKeyChallenge {
    let mut rng =
        russh::keys::ssh_key::rand_core::UnwrapErr(russh::keys::ssh_key::getrandom::SysRng);
    let key = russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519).unwrap();
    HostKeyChallenge {
        host: host.into(),
        port: 2222,
        key_type: "ssh-ed25519".into(),
        public_key: key.public_key().to_openssh().unwrap(),
        fingerprint: key
            .public_key()
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string(),
    }
}

fn trust(host: &str) -> KnownHostCommand {
    KnownHostCommand::Trust {
        challenge: challenge(host),
    }
}

#[test]
fn migration_and_successful_loading_are_required_before_mutations() {
    let fixture = Fixture::new(None);
    assert_eq!(
        fixture.repository.view().unwrap().status,
        KnownHostRepositoryStatus::Loading
    );
    assert_eq!(
        fixture.run(trust("before-load")),
        Err(KnownHostRepositoryError::NotLoaded)
    );
    let empty = fixture.run(KnownHostCommand::Load).unwrap();
    assert_eq!(empty.status, KnownHostRepositoryStatus::Loaded);
    assert!(empty.hosts.is_empty());
    let committed = fixture.run(trust("first.example")).unwrap();
    assert_eq!(committed.hosts.len(), 1);
    assert!(committed.revision > empty.revision);
    assert_eq!(
        serde_json::from_str::<Vec<KnownHostRecord>>(&fixture.persisted().unwrap()).unwrap(),
        committed.hosts
    );
    assert_eq!(committed.hosts[0].port, 2222);
    assert!(committed.hosts[0].id.starts_with("known-host-"));
}

#[test]
fn existing_openssh_records_and_nondefault_ports_survive_restart() {
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let value = challenge("MiNi.Example");
    let first = fixture
        .run(KnownHostCommand::Trust {
            challenge: value.clone(),
        })
        .unwrap();
    assert_eq!(first.hosts[0].public_key, value.public_key);
    let replacement =
        KnownHostRepository::attach(Arc::new(Core::default()), Some(fixture.database));
    let restored = crate::runtime()
        .unwrap()
        .block_on(replacement.begin(KnownHostCommand::Load).result())
        .unwrap();
    assert_eq!(restored.hosts, first.hosts);
    assert_eq!(restored.hosts[0].host, "MiNi.Example");
    assert_eq!(restored.hosts[0].port, 2222);
}

#[test]
fn real_write_failure_preserves_committed_trust_and_is_retryable() {
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let first = fixture.run(trust("first.example")).unwrap();
    fixture.sql("PRAGMA query_only = 1");
    assert_eq!(
        fixture.run(KnownHostCommand::Revoke {
            id: first.hosts[0].id.clone()
        }),
        Err(KnownHostRepositoryError::StorageWrite)
    );
    let preserved = fixture.repository.view().unwrap();
    assert_eq!(preserved.hosts, first.hosts);
    assert_eq!(preserved.status, KnownHostRepositoryStatus::Loaded);
    assert_eq!(
        serde_json::from_str::<Vec<KnownHostRecord>>(&fixture.persisted().unwrap()).unwrap(),
        first.hosts
    );
    fixture.sql("PRAGMA query_only = 0");
    let recovered = fixture.run(trust("second.example")).unwrap();
    assert_eq!(recovered.hosts.len(), 2);
}

#[test]
fn read_failure_preserves_trust_blocks_writes_and_recovers_without_defaulting_to_empty() {
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let first = fixture.run(trust("first.example")).unwrap();
    fixture.sql("ALTER TABLE app_values RENAME TO unavailable_values");
    assert_eq!(
        fixture.run(KnownHostCommand::Load),
        Err(KnownHostRepositoryError::StorageRead)
    );
    let failed = fixture.repository.view().unwrap();
    assert_eq!(failed.status, KnownHostRepositoryStatus::ReadFailed);
    assert_eq!(failed.hosts, first.hosts);
    assert_eq!(
        fixture.run(trust("should-not-be-added")),
        Err(KnownHostRepositoryError::NotLoaded)
    );
    fixture.sql("ALTER TABLE unavailable_values RENAME TO app_values");
    assert_eq!(
        fixture.run(KnownHostCommand::Load).unwrap().hosts,
        first.hosts
    );
}

#[test]
fn malformed_persistence_fails_closed_and_errors_never_echo_key_material() {
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let first = fixture.run(trust("first.example")).unwrap();
    for malformed in ["{SensitiveKeyMaterial", "{}", "[{}]"] {
        fixture.write(malformed.into());
        let error = fixture.run(KnownHostCommand::Load).unwrap_err();
        assert_eq!(error, KnownHostRepositoryError::InvalidData);
        assert!(!error.to_string().contains("SensitiveKeyMaterial"));
        let view = fixture.repository.view().unwrap();
        assert_eq!(view.status, KnownHostRepositoryStatus::InvalidData);
        assert_eq!(view.hosts, first.hosts);
        assert_eq!(
            fixture.run(trust("no-default-write")),
            Err(KnownHostRepositoryError::NotLoaded)
        );
        assert_eq!(fixture.persisted().as_deref(), Some(malformed));
    }
}

#[test]
fn invalid_trust_is_rejected_without_a_durable_write() {
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let mut value = challenge("bad.example");
    value.public_key = "SensitiveInvalidKey".into();
    let error = fixture
        .run(KnownHostCommand::Trust { challenge: value })
        .unwrap_err();
    assert_eq!(error, KnownHostRepositoryError::InvalidKey);
    assert!(!error.to_string().contains("SensitiveInvalidKey"));
    assert!(fixture.persisted().is_none());
    assert!(fixture.repository.view().unwrap().hosts.is_empty());
}

#[test]
fn duplicate_trust_and_missing_revocation_do_not_write() {
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let value = challenge("mini.example");
    let first = fixture
        .run(KnownHostCommand::Trust {
            challenge: value.clone(),
        })
        .unwrap();
    fixture.sql("PRAGMA query_only = 1");
    let duplicate = fixture
        .run(KnownHostCommand::Trust {
            challenge: HostKeyChallenge {
                host: "MINI.EXAMPLE".into(),
                ..value
            },
        })
        .unwrap();
    assert_eq!(duplicate.hosts, first.hosts);
    assert_eq!(duplicate.revision, first.revision);
    assert_eq!(
        fixture
            .run(KnownHostCommand::Revoke {
                id: "missing".into()
            })
            .unwrap(),
        duplicate
    );
}

#[test]
fn overlapping_operations_commit_in_admission_order_without_lost_updates_or_resurrection() {
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let first = fixture.run(trust("first.example")).unwrap();
    let release = fixture.block_worker();
    let b = fixture.repository.begin(trust("b.example"));
    let c = fixture.repository.begin(trust("c.example"));
    let revoke = fixture.repository.begin(KnownHostCommand::Revoke {
        id: first.hosts[0].id.clone(),
    });
    assert_eq!(fixture.repository.view().unwrap().hosts, first.hosts);
    release.send(()).unwrap();
    crate::runtime().unwrap().block_on(async {
        // Consume results backwards: admission order is independent of callers.
        let last = revoke.result().await.unwrap();
        assert_eq!(
            last.hosts
                .iter()
                .map(|host| host.host.as_str())
                .collect::<Vec<_>>(),
            ["b.example", "c.example"]
        );
        let middle = c.result().await.unwrap();
        let earliest = b.result().await.unwrap();
        assert!(earliest.revision < middle.revision && middle.revision < last.revision);
        assert_eq!(fixture.repository.view().unwrap(), last);
    });
}

#[test]
fn queued_cancellation_never_writes_or_publishes_trust() {
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let release = fixture.block_worker();
    let operation = fixture.repository.begin(trust("cancelled.example"));
    assert!(operation.cancel());
    release.send(()).unwrap();
    assert_eq!(
        crate::runtime().unwrap().block_on(operation.result()),
        Err(KnownHostRepositoryError::Cancelled)
    );
    assert!(fixture.persisted().is_none());
    assert!(fixture.repository.view().unwrap().hosts.is_empty());
}

#[test]
fn dropping_a_queued_caller_cancels_its_admitted_operation() {
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let release = fixture.block_worker();
    drop(fixture.repository.begin(trust("dropped.example")));
    release.send(()).unwrap();
    // The subsequent read is a barrier behind the cancelled worker job.
    assert!(fixture.persisted().is_none());
}

#[test]
fn a_new_load_fences_older_queued_trust_and_load_results() {
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let release = fixture.block_worker();
    let mutation = fixture.repository.begin(trust("stale.example"));
    let old_load = fixture.repository.begin(KnownHostCommand::Load);
    let new_load = fixture.repository.begin(KnownHostCommand::Load);
    release.send(()).unwrap();
    crate::runtime().unwrap().block_on(async {
        assert_eq!(
            mutation.result().await,
            Err(KnownHostRepositoryError::Cancelled)
        );
        assert_eq!(
            old_load.result().await,
            Err(KnownHostRepositoryError::Cancelled)
        );
        let latest = new_load.result().await.unwrap();
        assert_eq!(latest.status, KnownHostRepositoryStatus::Loaded);
        assert!(latest.hosts.is_empty());
        assert_eq!(fixture.repository.view().unwrap(), latest);
    });
}

#[test]
fn replacing_or_closing_an_owner_fences_its_pending_operations() {
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let release = fixture.block_worker();
    let old = fixture.repository.begin(trust("old.example"));
    let replacement = KnownHostRepository::attach(
        fixture.repository.core.clone(),
        Some(fixture.database.clone()),
    );
    let load = replacement.begin(KnownHostCommand::Load);
    release.send(()).unwrap();
    crate::runtime().unwrap().block_on(async {
        assert_eq!(old.result().await, Err(KnownHostRepositoryError::Cancelled));
        assert!(load.result().await.unwrap().hosts.is_empty());
    });
    assert_eq!(
        fixture.repository.view(),
        Err(KnownHostRepositoryError::Cancelled)
    );
    replacement.close();
    assert_eq!(
        crate::runtime()
            .unwrap()
            .block_on(replacement.begin(trust("closed.example")).result()),
        Err(KnownHostRepositoryError::Cancelled)
    );
    assert!(fixture.persisted().is_none());
}

#[test]
fn completed_operations_cannot_be_cancelled_or_consumed_twice() {
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let operation = fixture.repository.begin(trust("durable.example"));
    let committed = crate::runtime()
        .unwrap()
        .block_on(operation.result())
        .unwrap();
    assert_eq!(committed.hosts.len(), 1);
    assert!(!operation.cancel());
    assert_eq!(
        crate::runtime().unwrap().block_on(operation.result()),
        Err(KnownHostRepositoryError::ResultConsumed)
    );
}

#[test]
fn a_second_result_consumer_does_not_cancel_the_first() {
    use std::future::Future;
    let fixture = Fixture::new(None);
    fixture.run(KnownHostCommand::Load).unwrap();
    let release = fixture.block_worker();
    let operation = fixture.repository.begin(trust("one-consumer.example"));
    let mut first = Box::pin(operation.result());
    let waker = futures::task::noop_waker();
    let mut context = std::task::Context::from_waker(&waker);
    assert!(first.as_mut().poll(&mut context).is_pending());
    assert_eq!(
        crate::runtime().unwrap().block_on(operation.result()),
        Err(KnownHostRepositoryError::ResultConsumed)
    );
    release.send(()).unwrap();
    assert_eq!(
        crate::runtime()
            .unwrap()
            .block_on(first)
            .unwrap()
            .hosts
            .len(),
        1
    );
}

#[test]
fn an_unfinished_legacy_import_is_not_an_authoritative_empty_store() {
    let fixture = Fixture::new(None);
    fixture.sql("DELETE FROM storage_migrations");
    assert_eq!(
        fixture.run(KnownHostCommand::Load),
        Err(KnownHostRepositoryError::StorageRead)
    );
    assert_eq!(
        fixture.repository.view().unwrap().status,
        KnownHostRepositoryStatus::ReadFailed
    );
    assert_eq!(
        fixture.run(trust("no-default-trust.example")),
        Err(KnownHostRepositoryError::NotLoaded)
    );
}
