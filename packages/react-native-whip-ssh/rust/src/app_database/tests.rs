#![allow(clippy::unwrap_used, reason = "test assertions")]
use super::*;

fn entry(key: &str, value: Option<&str>) -> AppStorageEntry {
    AppStorageEntry {
        key: key.into(),
        value: value.map(str::to_owned),
    }
}
fn store(path: &Path) -> Store {
    Store::open(path, crate::runtime().unwrap()).unwrap()
}
const TRUST: &str = "herdr.known-hosts.v1";
const DRAFT: &str = "whip.terminal.composers.v1.host";

#[test]
fn creation_import_reopen_and_committed_observer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.db");
    let mut db = store(&path);
    assert!(!db.migrated().unwrap());
    assert!(matches!(
        db.read(vec![TRUST.into()]),
        Err(AppStorageError::MigrationRequired)
    ));
    assert!(matches!(
        db.write(vec![entry(TRUST, Some("[]"))], false),
        Err(AppStorageError::MigrationRequired)
    ));
    let imported = vec![
        entry(TRUST, Some("[{\"publicKey\":\"original-trust\"}]")),
        entry(DRAFT, Some("{\"text\":\"draft\"}")),
    ];
    db.write(imported.clone(), true).unwrap();
    // A separate handle sees the receipt and every value after acknowledgement.
    let observer = store(&path);
    assert!(observer.migrated().unwrap());
    assert_eq!(
        observer.read(vec![TRUST.into(), DRAFT.into()]).unwrap(),
        imported
    );
    drop(observer);
    drop(db);
    let reopened = store(&path);
    assert!(reopened.migrated().unwrap());
    assert_eq!(
        reopened.read(vec![TRUST.into(), DRAFT.into()]).unwrap(),
        imported
    );
}

#[test]
fn lost_import_ack_never_overwrites_changes_or_resurrects_deletions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.db");
    let mut db = store(&path);
    let old = vec![entry(TRUST, Some("old")), entry(DRAFT, Some("old draft"))];
    db.write(old.clone(), true).unwrap();
    db.write(vec![entry(TRUST, Some("new")), entry(DRAFT, None)], false)
        .unwrap();
    drop(db);
    let mut reopened = store(&path);
    reopened.write(old, true).unwrap();
    assert_eq!(
        reopened.read(vec![TRUST.into(), DRAFT.into()]).unwrap(),
        vec![entry(TRUST, Some("new")), entry(DRAFT, None)]
    );
}

#[test]
fn failed_import_rolls_back_values_and_receipt_and_can_retry() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = store(&dir.path().join("app.db"));
    // Inject an actual SQL constraint failure after the first admitted row.
    db.runtime.block_on(db.connection.execute_batch("DROP TABLE app_values;
        CREATE TABLE app_values (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL CHECK(value != 'fail'), updated_at INTEGER NOT NULL);")).unwrap();
    assert!(
        db.write(
            vec![entry(TRUST, Some("trust")), entry(DRAFT, Some("fail"))],
            true
        )
        .is_err()
    );
    assert!(!db.migrated().unwrap());
    let count: i64 = db.runtime.block_on(async {
        db.connection
            .query("SELECT count(*) FROM app_values", ())
            .await
            .unwrap()
            .next()
            .await
            .unwrap()
            .unwrap()
            .get(0)
            .unwrap()
    });
    assert_eq!(count, 0);
    db.write(
        vec![entry(TRUST, Some("trust")), entry(DRAFT, Some("draft"))],
        true,
    )
    .unwrap();
    assert!(
        db.write(
            vec![entry(TRUST, Some("changed")), entry(DRAFT, Some("fail"))],
            false
        )
        .is_err()
    );
    assert_eq!(
        db.read(vec![TRUST.into()]).unwrap(),
        vec![entry(TRUST, Some("trust"))]
    );
}

#[test]
fn corrupt_and_future_databases_are_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("corrupt.db");
    let contents = b"not a database, retain it for recovery";
    std::fs::write(&path, contents).unwrap();
    assert!(Store::open(&path, crate::runtime().unwrap()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), contents);
    let path = dir.path().join("future.db");
    let mut db = store(&path);
    db.write(vec![entry(TRUST, Some("trust"))], true).unwrap();
    db.runtime
        .block_on(db.connection.execute("PRAGMA user_version = 99", ()))
        .unwrap();
    drop(db);
    assert!(matches!(
        Store::open(&path, crate::runtime().unwrap()),
        Err(AppStorageError::Incompatible)
    ));
    // An older binary must not wipe a newer version's trust database.
    let runtime = crate::runtime().unwrap();
    runtime.block_on(async {
        let db = turso::Builder::new_local(path.to_str().unwrap())
            .build()
            .await
            .unwrap();
        let conn = db.connect().unwrap();
        let mut rows = conn
            .query("SELECT value FROM app_values WHERE key = ?1", [TRUST])
            .await
            .unwrap();
        assert_eq!(
            rows.next()
                .await
                .unwrap()
                .unwrap()
                .get::<String>(0)
                .unwrap(),
            "trust"
        );
        drop(rows);
        drop(conn);
        drop(db);
    });
}

#[test]
fn direct_old_version_import_and_metadata_credential_guard() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = store(&dir.path().join("app.db"));
    let old = vec![
        entry(
            "herdr.connection.v1",
            Some(r#"{"host":"old.example","username":"me","rememberCredentials":true}"#),
        ),
        entry(
            "herdr.device.preferences.v1",
            Some(r#"{"alertsEnabled":false}"#),
        ),
        entry(
            "herdr.credential.backups.v1",
            Some(r#"{"host":"v1.iv.ciphertext"}"#),
        ),
        entry(
            "whip.remote-content-progress.v1:host:%2Fvideo",
            Some("snapshot"),
        ),
    ];
    db.write(old.clone(), true).unwrap();
    assert_eq!(
        db.read(old.iter().map(|e| e.key.clone()).collect())
            .unwrap(),
        old
    );
    assert!(
        db.write(
            vec![entry(
                "herdr.hosts.v2",
                Some(r#"[{"secret":"plaintext private key"}]"#)
            )],
            false
        )
        .is_err()
    );
    assert!(
        db.write(
            vec![entry(
                "herdr.global-ssh-keys.v1",
                Some(r#"[{"passphrase":"plaintext"}]"#)
            )],
            false
        )
        .is_err()
    );
    assert_eq!(
        select_legacy_app_data_keys(vec![TRUST.into(), "unrelated.library".into(), DRAFT.into()]),
        vec![TRUST, DRAFT]
    );
    drop(db);
}

#[test]
fn concurrent_worker_transactions_are_atomic_and_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.db");
    let database = AppDatabase::open(path.clone()).unwrap();
    let runtime = crate::runtime().unwrap();
    runtime
        .block_on(database.request(|db| db.write(Vec::new(), true)))
        .unwrap();
    let threads: Vec<_> = (0..16)
        .map(|n| {
            let database = database.clone();
            std::thread::spawn(move || {
                runtime
                    .block_on(database.request(move |db| {
                        db.write(
                            vec![
                                entry(
                                    &format!("whip.agent.preferences.v1.host{n}"),
                                    Some(&n.to_string()),
                                ),
                                entry(TRUST, Some(&n.to_string())),
                                entry(DRAFT, Some(&n.to_string())),
                            ],
                            false,
                        )
                    }))
                    .unwrap();
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    runtime
        .block_on(database.request(|db| {
            let pair = db.read(vec![TRUST.into(), DRAFT.into()])?;
            assert_eq!(pair[0].value, pair[1].value);
            Ok(())
        }))
        .unwrap();
    // Release handles on the owner before opening a new connection.
    let (done, drained) = std::sync::mpsc::channel();
    database
        .sender
        .send(Box::new(move |worker| {
            worker.store = None;
            done.send(()).unwrap();
        }))
        .unwrap();
    drained.recv().unwrap();
    drop(database);
    let reopened = store(&path);
    for n in 0..16 {
        let key = format!("whip.agent.preferences.v1.host{n}");
        assert_eq!(
            reopened.read(vec![key.clone()]).unwrap(),
            vec![entry(&key, Some(&n.to_string()))]
        );
    }
}
