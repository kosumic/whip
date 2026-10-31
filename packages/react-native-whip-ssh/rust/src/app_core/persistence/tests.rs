#![allow(
    clippy::unwrap_used,
    reason = "Tests stop immediately on unexpected setup or operation failure"
)]
use super::*;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

fn run(work: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(work);
}
#[derive(Default)]
struct Memory {
    values: Mutex<HashMap<String, String>>,
    writes: Mutex<Vec<Vec<AppStorageEntry>>>,
    fail: AtomicBool,
    blocked: Mutex<Option<Arc<tokio::sync::Notify>>>,
    started: tokio::sync::Notify,
}
#[async_trait]
impl Storage for Memory {
    async fn read(&self, keys: Vec<String>) -> Result<Vec<AppStorageEntry>> {
        Ok(keys
            .into_iter()
            .map(|key| entry(key.clone(), self.values.lock().get(&key).cloned()))
            .collect())
    }
    async fn write(&self, entries: Vec<AppStorageEntry>) -> Result<()> {
        self.writes.lock().push(entries.clone());
        let gate = self.blocked.lock().take();
        self.started.notify_one();
        if let Some(gate) = gate {
            gate.notified().await;
        }
        if self.fail.swap(false, Ordering::SeqCst) {
            return Err(failure("write unavailable"));
        }
        for entry in entries {
            if let Some(value) = entry.value {
                self.values.lock().insert(entry.key, value);
            } else {
                self.values.lock().remove(&entry.key);
            }
        }
        Ok(())
    }
}
#[derive(Default)]
struct Platform {
    failures: AtomicUsize,
}
#[async_trait]
impl SessionPersistencePlatform for Platform {
    async fn prepare(&self) -> Result<()> {
        Ok(())
    }
    fn write_failed(&self, _: String, _: String) {
        self.failures.fetch_add(1, Ordering::SeqCst);
    }
}
struct Source {
    incarnation: u64,
    revision: AtomicU64,
    exports: Mutex<Vec<Option<u64>>>,
}
#[async_trait]
impl SnapshotSource for Source {
    fn incarnation(&self) -> u64 {
        self.incarnation
    }
    async fn export(&self, revision: Option<u64>) -> Result<Option<crate::HostOfflineCache>> {
        self.exports.lock().push(revision);
        let latest = self.revision.load(Ordering::SeqCst);
        Ok((revision != Some(latest)).then(|| crate::HostOfflineCache {
            revision: latest,
            blob: format!("snapshot-{latest}"),
        }))
    }
}
fn fixture() -> (Arc<SessionPersistence>, Arc<Memory>, Arc<Platform>) {
    let storage = Arc::new(Memory::default());
    let platform = Arc::new(Platform::default());
    let (jobs, receiver) = mpsc::unbounded_channel();
    tokio::spawn(
        Worker {
            storage: storage.clone(),
            platform: platform.clone(),
            pending: HashMap::new(),
            cursors: HashMap::new(),
            terminals: HashMap::new(),
            observed: HashMap::new(),
            membership: None,
        }
        .run(receiver),
    );
    (Arc::new(SessionPersistence { jobs }), storage, platform)
}
fn source(incarnation: u64) -> Arc<Source> {
    Arc::new(Source {
        incarnation,
        revision: AtomicU64::new(1),
        exports: Mutex::new(Vec::new()),
    })
}

#[test]
fn debounces_native_exports_and_commits_only_the_latest_state() {
    run(async {
        tokio::time::pause();
        let (owner, storage, _) = fixture();
        let source = source(1);
        for revision in 1..=10 {
            source.revision.store(revision, Ordering::SeqCst);
            owner
                .submit(Command::Schedule("host".into(), source.clone()))
                .unwrap()
                .wait()
                .await
                .unwrap();
        }
        assert!(source.exports.lock().is_empty());
        tokio::time::advance(WRITE_DELAY).await;
        storage.started.notified().await;
        assert_eq!(
            storage
                .values
                .lock()
                .get("herdr.host.snapshot.v1.host")
                .map(String::as_str),
            Some("snapshot-10")
        );
        assert_eq!(*source.exports.lock(), vec![None]);
        owner
            .submit(Command::Schedule("host".into(), source.clone()))
            .unwrap();
        owner.flush(None).unwrap().wait().await.unwrap();
        assert_eq!(*source.exports.lock(), vec![None, Some(10)]);
        assert_eq!(storage.writes.lock().len(), 1);
    });
}

#[test]
fn runtime_replacement_uses_a_new_revision_cursor() {
    run(async {
        let (owner, storage, _) = fixture();
        let first = source(1);
        let second = source(2);
        for source in [first.clone(), second.clone()] {
            owner
                .submit(Command::Schedule("host".into(), source))
                .unwrap();
            owner.flush(None).unwrap().wait().await.unwrap();
        }
        assert_eq!(*first.exports.lock(), vec![None]);
        assert_eq!(*second.exports.lock(), vec![None]);
        assert_eq!(storage.writes.lock().len(), 2);
    });
}

#[test]
fn failed_snapshot_writes_keep_the_revision_retryable() {
    run(async {
        let (owner, storage, _) = fixture();
        let source = source(1);
        storage.fail.store(true, Ordering::SeqCst);
        owner
            .submit(Command::Schedule("host".into(), source.clone()))
            .unwrap();
        assert!(owner.flush(None).unwrap().wait().await.is_err());
        owner.flush(None).unwrap().wait().await.unwrap();
        assert_eq!(*source.exports.lock(), vec![None, None]);
        assert_eq!(storage.writes.lock().len(), 2);
    });
}

#[test]
fn deletion_cancels_pending_exports_and_cannot_resurrect_after_a_write() {
    run(async {
        let (owner, _storage, _) = fixture();
        let source = source(1);
        owner
            .submit(Command::Schedule("host".into(), source.clone()))
            .unwrap();
        owner
            .delete_snapshot("host".into())
            .unwrap()
            .wait()
            .await
            .unwrap();
        owner.flush(None).unwrap().wait().await.unwrap();
        assert!(source.exports.lock().is_empty());
        let (owner, storage, _) = fixture();
        let gate = Arc::new(tokio::sync::Notify::new());
        *storage.blocked.lock() = Some(gate.clone());
        owner
            .submit(Command::Schedule("host".into(), source.clone()))
            .unwrap();
        let writing = owner.flush(None).unwrap();
        storage.started.notified().await;
        let removal = owner.delete_snapshot("host".into()).unwrap();
        gate.notify_one();
        writing.wait().await.unwrap();
        removal.wait().await.unwrap();
        assert!(
            !storage
                .values
                .lock()
                .contains_key("herdr.host.snapshot.v1.host")
        );
        owner.flush(None).unwrap().wait().await.unwrap();
        assert!(
            !storage
                .values
                .lock()
                .contains_key("herdr.host.snapshot.v1.host")
        );
    });
}

#[test]
fn updates_during_a_write_are_exported_after_its_committed_cursor() {
    run(async {
        let (owner, storage, _) = fixture();
        let source = source(1);
        let gate = Arc::new(tokio::sync::Notify::new());
        *storage.blocked.lock() = Some(gate.clone());
        owner
            .submit(Command::Schedule("host".into(), source.clone()))
            .unwrap();
        let first = owner.flush(None).unwrap();
        storage.started.notified().await;
        source.revision.store(2, Ordering::SeqCst);
        owner
            .submit(Command::Schedule("host".into(), source.clone()))
            .unwrap();
        let second = owner.flush(None).unwrap();
        gate.notify_one();
        second.wait().await.unwrap();
        first.wait().await.unwrap();
        assert_eq!(*source.exports.lock(), vec![None, Some(1)]);
        assert_eq!(
            storage
                .values
                .lock()
                .get("herdr.host.snapshot.v1.host")
                .map(String::as_str),
            Some("snapshot-2")
        );
    });
}

fn fonts(size: f64) -> Vec<TerminalFontPreference> {
    vec![TerminalFontPreference {
        terminal_id: "term".into(),
        size,
    }]
}
#[test]
fn terminal_resume_and_fonts_commit_atomically_and_skip_unchanged_values() {
    run(async {
        let (owner, storage, _) = fixture();
        assert!(
            owner
                .save_terminals(
                    "session".into(),
                    "host".into(),
                    "resume".into(),
                    fonts(11.0)
                )
                .unwrap()
                .wait()
                .await
                .unwrap()
        );
        assert_eq!(storage.writes.lock()[0].len(), 2);
        assert!(
            !owner
                .save_terminals(
                    "session".into(),
                    "host".into(),
                    "resume".into(),
                    fonts(11.0)
                )
                .unwrap()
                .wait()
                .await
                .unwrap()
        );
        owner
            .save_terminals(
                "session".into(),
                "host".into(),
                "resume".into(),
                fonts(12.0),
            )
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(storage.writes.lock()[1].len(), 1);
        assert_eq!(
            storage.writes.lock()[1][0].key,
            "herdr.terminal.font-sizes.v1.host"
        );
    });
}

#[test]
fn terminal_transactions_follow_admission_order_even_when_waited_in_reverse() {
    run(async {
        let (owner, storage, _) = fixture();
        let first = owner
            .save_terminals("session".into(), "host".into(), "first".into(), fonts(10.0))
            .unwrap();
        let second = owner
            .save_terminals(
                "session".into(),
                "host".into(),
                "latest".into(),
                fonts(10.0),
            )
            .unwrap();
        second.wait().await.unwrap();
        first.wait().await.unwrap();
        assert_eq!(
            storage
                .values
                .lock()
                .get("herdr.terminal.sessions.v1.host")
                .map(String::as_str),
            Some("latest")
        );
    });
}

#[test]
fn failed_terminal_transactions_retry_the_same_atomic_batch() {
    run(async {
        let (owner, storage, _) = fixture();
        storage.fail.store(true, Ordering::SeqCst);
        assert!(
            owner
                .save_terminals(
                    "session".into(),
                    "host".into(),
                    "resume".into(),
                    fonts(10.0)
                )
                .unwrap()
                .wait()
                .await
                .is_err()
        );
        owner
            .save_terminals(
                "session".into(),
                "host".into(),
                "resume".into(),
                fonts(10.0),
            )
            .unwrap()
            .wait()
            .await
            .unwrap();
        let writes = storage.writes.lock().clone();
        assert_eq!(writes[0], writes[1]);
    });
}

#[test]
fn font_migration_preserves_native_resume_and_validates_only_presentation_values() {
    let legacy = r#"{"activeTerminalId":"term","sessions":[{"terminalId":"term","fontSize":10},{"terminalId":"large","fontSize":100},null]}"#;
    let state = read_fonts(Some(legacy.into()), None);
    assert_eq!(state.resume_blob.as_deref(), Some(legacy));
    assert!(!state.invalid_fonts);
    assert_eq!(
        state.font_sizes,
        vec![
            TerminalFontPreference {
                terminal_id: "term".into(),
                size: 10.0
            },
            TerminalFontPreference {
                terminal_id: "large".into(),
                size: 24.0
            }
        ]
    );
    let invalid = read_fonts(Some(legacy.into()), Some("{invalid".into()));
    assert!(invalid.invalid_fonts);
    assert_eq!(invalid.resume_blob.as_deref(), Some(legacy));
}

#[test]
fn raw_snapshot_reads_preserve_malformed_data_for_native_validation() {
    run(async {
        let (owner, storage, _) = fixture();
        storage
            .values
            .lock()
            .insert("herdr.host.snapshot.v1.host".into(), "{invalid".into());
        assert_eq!(
            owner
                .read_snapshot("host".into())
                .unwrap()
                .snapshot()
                .await
                .unwrap()
                .as_deref(),
            Some("{invalid")
        );
    });
}

#[test]
fn failed_fresh_export_preserves_durable_offline_reads_and_can_retry() {
    run(async {
        let (owner, storage, platform) = fixture();
        storage.values.lock().insert(
            "herdr.host.snapshot.v1.host".into(),
            "last durable snapshot".into(),
        );
        storage.fail.store(true, Ordering::SeqCst);
        owner
            .submit(Command::Schedule("host".into(), source(1)))
            .unwrap();
        assert_eq!(
            owner
                .read_snapshot("host".into())
                .unwrap()
                .snapshot()
                .await
                .unwrap()
                .as_deref(),
            Some("last durable snapshot")
        );
        assert_eq!(platform.failures.load(Ordering::SeqCst), 1);
        owner.flush(None).unwrap().wait().await.unwrap();
        assert_eq!(
            storage
                .values
                .lock()
                .get("herdr.host.snapshot.v1.host")
                .map(String::as_str),
            Some("snapshot-1")
        );
    });
}

#[test]
fn separate_sessions_cannot_skip_a_needed_write_to_the_same_host() {
    run(async {
        let (owner, storage, _) = fixture();
        for (session, resume) in [("first", "one"), ("second", "two"), ("first", "one")] {
            owner
                .save_terminals(session.into(), "host".into(), resume.into(), fonts(10.0))
                .unwrap()
                .wait()
                .await
                .unwrap();
        }
        assert_eq!(
            storage
                .values
                .lock()
                .get("herdr.terminal.sessions.v1.host")
                .map(String::as_str),
            Some("one")
        );
    });
}

#[test]
fn membership_write_failures_are_reported_and_the_same_value_remains_retryable() {
    run(async {
        let (owner, storage, platform) = fixture();
        storage.fail.store(true, Ordering::SeqCst);
        owner
            .save_live_hosts(vec!["host".into()], Some("host".into()))
            .unwrap();
        owner.flush(None).unwrap().wait().await.unwrap();
        assert_eq!(platform.failures.load(Ordering::SeqCst), 1);
        owner
            .save_live_hosts(vec!["host".into()], Some("host".into()))
            .unwrap();
        owner.flush(None).unwrap().wait().await.unwrap();
        assert_eq!(storage.writes.lock().len(), 2);
    });
}
