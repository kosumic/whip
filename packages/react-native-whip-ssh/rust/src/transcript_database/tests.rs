use super::*;
use std::future::Future;
use std::sync::{
    Arc, Barrier,
    atomic::{AtomicBool, Ordering},
};

fn run<T>(future: impl Future<Output = T>) -> T {
    crate::runtime().unwrap().block_on(future)
}

fn identity(namespace: &str, agent: AgentTranscriptKind, session: &str) -> TranscriptIdentity {
    TranscriptIdentity {
        namespace: namespace.into(),
        agent,
        session_id: session.into(),
    }
}

fn fixture() -> (tempfile::TempDir, TranscriptDatabase) {
    let directory = tempfile::tempdir().unwrap();
    let database =
        TranscriptDatabase::open(directory.path().join(DATABASE_NAME), Vec::new()).unwrap();
    (directory, database)
}

#[test]
fn cache_size_counts_database_sidecars_and_partial_copies_without_opening_them() {
    let (directory, database) = fixture();
    let path = directory.path().join(DATABASE_NAME);
    run(async {
        assert_eq!(database.cache_size().await.unwrap(), 0);
        assert!(!path.exists());
        std::fs::write(directory.path().join("whip-app.db"), [0; 512]).unwrap();
        let mut expected = 0;
        for (index, root) in [
            path.clone(),
            database_sidecar(&path, migration::REPLACEMENT_SUFFIX),
        ]
        .iter()
        .enumerate()
        {
            for (part, suffix) in DATABASE_SUFFIXES.iter().enumerate() {
                let length = 31 + index * 100 + part;
                // Intentionally invalid database bytes. Size inspection must
                // never decode, migrate, replace, or remove these files.
                std::fs::write(database_sidecar(root, suffix), vec![0xa5; length]).unwrap();
                expected += length as u64;
            }
        }
        assert_eq!(database.cache_size().await.unwrap(), expected);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 31);
        database.clear_cache().await.unwrap();
        assert_eq!(database.cache_size().await.unwrap(), 0);
        assert!(!path.exists());
        close(database).await;
    });
}

#[test]
fn clearing_cache_removes_saved_chats_and_partial_migrations_but_preserves_authorities() {
    let (directory, database) = fixture();
    let path = directory.path().join(DATABASE_NAME);
    let unrelated = directory.path().join("whip-app.db");
    std::fs::write(&unrelated, b"hosts, keys and preferences").unwrap();
    let first = identity("host", AgentTranscriptKind::Codex, "first");
    let second = identity("other-host", AgentTranscriptKind::Claude, "second");
    let deleted = identity("deleted-host", AgentTranscriptKind::Codex, "deleted");
    database.activate("host".into(), 2);
    run(async {
        save(&database, first.clone(), 2, vec![1; 1024 * 1024])
            .await
            .unwrap();
        save(&database, second.clone(), 1, vec![2]).await.unwrap();
        database
            .delete_host(deleted.namespace.clone())
            .await
            .unwrap();
        let partial = database_sidecar(&path, migration::REPLACEMENT_SUFFIX);
        for suffix in DATABASE_SUFFIXES {
            std::fs::write(database_sidecar(&partial, suffix), b"partial copy").unwrap();
        }
        database.clear_cache().await.unwrap();
        for root in [&path, &partial] {
            for suffix in DATABASE_SUFFIXES {
                assert!(!database_sidecar(root, suffix).exists());
            }
        }
        assert_eq!(
            std::fs::read(unrelated).unwrap(),
            b"hosts, keys and preferences"
        );
        assert!(database.list().await.unwrap().is_empty());
        // Clearing must not weaken the guards for removed hosts or old runtimes.
        assert!(!save(&database, deleted, 1, vec![9]).await.unwrap());
        assert!(!save(&database, first.clone(), 1, vec![9]).await.unwrap());
        assert!(save(&database, first.clone(), 2, vec![3]).await.unwrap());
        assert_eq!(database.load(first.key()).await.unwrap(), Some(vec![3]));
        assert!(database.load(second.key()).await.unwrap().is_none());
        close(database).await;
    });
}

#[test]
fn clearing_an_unopened_bloated_cache_never_opens_or_migrates_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(DATABASE_NAME);
    std::fs::File::create(&path)
        .unwrap()
        .set_len(64 * 1024 * 1024)
        .unwrap();
    std::fs::write(database_sidecar(&path, WAL_SUFFIX), b"unreadable old WAL").unwrap();
    let database = TranscriptDatabase::open(path.clone(), Vec::new()).unwrap();
    run(async {
        database.clear_cache().await.unwrap();
        // Opening a replacement database would recreate the main file. The
        // recovery action must work without space for a copy or schema migration.
        assert!(!path.exists());
        assert!(!database_sidecar(&path, WAL_SUFFIX).exists());
        close(database).await;
    });
}

#[test]
fn large_checkpoint_truncates_the_recovery_log_and_preserves_reopened_data() {
    let (directory, database) = fixture();
    let id = identity("large-cache", AgentTranscriptKind::Codex, "session");
    let path = directory.path().join(DATABASE_NAME);
    let bytes = vec![0xa5; usize::try_from(MAX_WAL_BYTES * 2).unwrap()];
    run(async {
        assert!(save(&database, id.clone(), 1, bytes.clone()).await.unwrap());
        let wal_bytes = std::fs::metadata(database_sidecar(&path, WAL_SUFFIX))
            .map(|metadata| metadata.len())
            .unwrap_or_default();
        assert!(
            wal_bytes < MAX_WAL_BYTES,
            "recovery log retained {wal_bytes} bytes"
        );
        assert_eq!(
            database.load(id.key()).await.unwrap().as_deref(),
            Some(bytes.as_slice())
        );
        close(database).await;
        let reopened = TranscriptDatabase::open(path, Vec::new()).unwrap();
        assert_eq!(reopened.load(id.key()).await.unwrap(), Some(bytes));
        close(reopened).await;
    });
}

async fn save(
    database: &TranscriptDatabase,
    identity: TranscriptIdentity,
    incarnation: u64,
    blob: Vec<u8>,
) -> Result<bool, AgentSessionError> {
    let (sender, receiver) = oneshot::channel();
    database.save(identity, incarnation, blob, move |result| {
        let _ = sender.send(result);
    })?;
    receiver.await.unwrap()
}

async fn close(database: TranscriptDatabase) {
    database
        .request(|worker| {
            worker.store = None;
            Ok(())
        })
        .await
        .unwrap();
    drop(database);
}

#[test]
fn chat_search_restores_a_saved_checkpoint_without_a_host_or_javascript_documents() {
    use crate::agent_transcript::CodexSessionCore;
    let (_directory, database) = fixture();
    let saved_identity = identity(
        "offline-host",
        AgentTranscriptKind::Codex,
        "offline-session",
    );
    let mut core = CodexSessionCore::new("offline-session");
    let lines = b"{\"type\":\"session_meta\",\"payload\":{}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"saved needle\"}}\n";
    let source = core.bind_source("/rollout".into(), "1:2".into(), lines.len() as u64);
    core.ingest(source.source_generation, lines).unwrap();
    run(async {
        save(
            &database,
            saved_identity.clone(),
            1,
            core.cache_blob().unwrap(),
        )
        .await
        .unwrap();
        let index = crate::ChatSearchIndex::for_checkpoint(database.clone(), saved_identity);
        let results = index.clone().search("NEEDLE".into(), None).await.unwrap();
        assert_eq!(results.matches.len(), 1);
        assert_eq!(results.matches[0].matched, "needle");
        assert_eq!(results.matches[0].before, "saved ");
        assert_eq!(
            results.matches[0].reveal,
            [results.matches[0].document_id.clone()]
        );
        let missing = crate::ChatSearchIndex::for_checkpoint(
            database.clone(),
            identity("other-host", AgentTranscriptKind::Codex, "offline-session"),
        );
        assert!(matches!(
            missing.search("needle".into(), None).await,
            Err(AgentSessionError::SessionClosed(_))
        ));
        close(database).await;
    });
}

#[test]
fn creation_round_trip_and_reopening_preserve_opaque_bytes() {
    let (directory, database) = fixture();
    let identity = identity("host", AgentTranscriptKind::Codex, "session");
    let key = identity.key();
    let bytes = vec![0, 1, 2, 255];
    run(async {
        assert!(database.list().await.unwrap().is_empty());
        assert!(save(&database, identity, 1, bytes.clone()).await.unwrap());
        assert_eq!(
            database.load(key.clone()).await.unwrap(),
            Some(bytes.clone())
        );
        close(database).await;
        let reopened =
            TranscriptDatabase::open(directory.path().join(DATABASE_NAME), Vec::new()).unwrap();
        assert_eq!(reopened.load(key).await.unwrap(), Some(bytes));
        close(reopened).await;
    });
}

#[test]
fn concurrent_saves_are_serialized_and_the_last_admitted_checkpoint_wins() {
    let (_directory, database) = fixture();
    let identity = identity("host", AgentTranscriptKind::Codex, "session");
    let mut threads = Vec::new();
    for index in 0..16_u8 {
        let database = database.clone();
        let identity = identity.clone();
        threads.push(std::thread::spawn(move || {
            run(save(&database, identity, 1, vec![index])).unwrap()
        }));
    }
    for thread in threads {
        assert!(thread.join().unwrap());
    }
    run(async {
        assert!(
            save(&database, identity.clone(), 1, vec![99])
                .await
                .unwrap()
        );
        assert_eq!(database.load(identity.key()).await.unwrap(), Some(vec![99]));
        close(database).await;
    });
}

#[test]
fn completion_waits_for_commit_and_is_visible_to_another_connection() {
    let (_directory, database) = fixture();
    let identity = identity("host", AgentTranscriptKind::Claude, "session");
    let key = identity.key();
    let gate = Arc::new(Barrier::new(2));
    let worker_gate = gate.clone();
    database
        .enqueue(move |_| {
            worker_gate.wait();
        })
        .unwrap();
    let committed = Arc::new(AtomicBool::new(false));
    let confirmation = committed.clone();
    let (sender, receiver) = oneshot::channel();
    database
        .save(identity, 1, vec![42], move |result| {
            assert!(result.unwrap());
            confirmation.store(true, Ordering::SeqCst);
            sender.send(()).unwrap();
        })
        .unwrap();
    assert!(!committed.load(Ordering::SeqCst));
    gate.wait();
    run(async {
        receiver.await.unwrap();
        let observed = database
            .request(move |worker| {
                worker.with_store(|store| {
                    let observer = store.database.connect()?;
                    store.runtime.block_on(async {
                        let mut rows = observer
                            .query(
                            "SELECT checkpoint FROM transcript_checkpoints WHERE conversation_id = ?1",
                                [key.as_str()],
                            )
                            .await?;
                        Ok(rows.next().await?.unwrap().get::<Vec<u8>>(0)?)
                    })
                })
            })
            .await
            .unwrap();
        assert_eq!(observed, vec![42]);
        close(database).await;
    });
}

#[test]
fn failed_transactions_roll_back_and_never_report_success() {
    let (_directory, database) = fixture();
    let identity = identity("host", AgentTranscriptKind::Codex, "session");
    run(async {
        // An ordinary SQL failure must not destroy an existing cache.
        save(&database, identity.clone(), 1, vec![1]).await.unwrap();
        let result = database
            .request(|worker| {
                worker.with_store(|store| {
                    store.runtime.block_on(async {
                        let tx = store.connection.transaction().await?;
                        tx.execute("DELETE FROM conversations", ()).await?;
                        tx.execute("INSERT INTO missing_table VALUES (1)", ())
                            .await?;
                        tx.commit().await?;
                        Ok(())
                    })
                })
            })
            .await;
        assert!(result.is_err());
        assert_eq!(database.load(identity.key()).await.unwrap(), Some(vec![1]));
        save(&database, identity.clone(), 1, vec![2]).await.unwrap();
        assert_eq!(database.load(identity.key()).await.unwrap(), Some(vec![2]));
        close(database).await;
    });
}

#[test]
fn retention_is_host_isolated_and_rejects_delayed_writes_and_older_authorities() {
    let (_directory, database) = fixture();
    let first = identity("host-a", AgentTranscriptKind::Codex, "same-session");
    let second = identity("host-b", AgentTranscriptKind::Codex, "same-session");
    let unopened = identity("host-a", AgentTranscriptKind::OpenCode, "ses_unopened");
    database.activate("host-a".into(), 2);
    run(async {
        save(&database, first.clone(), 2, vec![1]).await.unwrap();
        save(&database, second.clone(), 1, vec![2]).await.unwrap();
        save(&database, unopened.clone(), 2, vec![3]).await.unwrap();
        database.retain("host-a".into(), 2, 10, HashSet::from([unopened.key()]));
        assert!(!save(&database, first.clone(), 2, vec![9]).await.unwrap());
        database.retain("host-a".into(), 1, 99, HashSet::from([first.key()]));
        database.retain("host-a".into(), 2, 9, HashSet::from([first.key()]));
        assert!(database.load(first.key()).await.unwrap().is_none());
        assert_eq!(database.load(second.key()).await.unwrap(), Some(vec![2]));
        assert_eq!(database.load(unopened.key()).await.unwrap(), Some(vec![3]));
        database.retain("host-a".into(), 2, 11, HashSet::from([first.key()]));
        assert!(save(&database, first.clone(), 2, vec![4]).await.unwrap());
        assert!(!save(&database, first.clone(), 1, vec![0]).await.unwrap());
        database.delete_host("host-a".into()).await.unwrap();
        assert!(!save(&database, first.clone(), 2, vec![5]).await.unwrap());
        database.activate("host-a".into(), 2);
        database.retain("host-a".into(), 2, 12, HashSet::from([first.key()]));
        assert!(!save(&database, first.clone(), 2, vec![5]).await.unwrap());
        assert_eq!(database.list().await.unwrap().len(), 1);
        close(database).await;
    });
}

#[test]
fn failed_checkpoint_insert_rolls_back_metadata_and_never_confirms_save() {
    let (_directory, database) = fixture();
    let identity = identity("host", AgentTranscriptKind::Codex, "session");
    run(async {
        database.list().await.unwrap();
        database.request(|worker| worker.with_store(|store| {
            // A real database constraint injects failure after catalog upsert,
            // exercising the same save transaction and completion as production.
            store.runtime.block_on(store.connection.execute_batch(
                "DROP TABLE transcript_checkpoints;
                 CREATE TABLE transcript_checkpoints (
                    conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    checkpoint BLOB NOT NULL CHECK(length(checkpoint) < 2)
                 );"
            ))?;
            Ok(())
        })).await.unwrap();
        assert!(save(&database, identity.clone(), 1, vec![1]).await.unwrap());
        assert!(
            save(&database, identity.clone(), 1, vec![2, 3])
                .await
                .is_err()
        );
        let list = database.list().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].cache_bytes, 1);
        assert_eq!(database.load(identity.key()).await.unwrap(), Some(vec![1]));
        close(database).await;
    });
}

#[test]
fn listing_returns_metadata_in_chronological_order_without_decoding_checkpoints() {
    let (_directory, database) = fixture();
    let first = identity("host", AgentTranscriptKind::Claude, "older");
    let second = identity("host", AgentTranscriptKind::OpenCode, "newer");
    run(async {
        save(&database, first.clone(), 1, vec![1, 2]).await.unwrap();
        save(&database, second.clone(), 1, vec![3]).await.unwrap();
        let older = first.key();
        database
            .request(move |worker| {
                worker.with_store(|store| {
                    store.runtime.block_on(store.connection.execute(
                        "UPDATE conversations SET updated_at = 1 WHERE id = ?1",
                        [older.as_str()],
                    ))?;
                    Ok(())
                })
            })
            .await
            .unwrap();
        let list = database.list().await.unwrap();
        assert_eq!(
            list.iter()
                .map(|item| item.key.as_str())
                .collect::<Vec<_>>(),
            vec![second.key(), first.key()]
        );
        assert_eq!(list[0].agent, AgentTranscriptKind::OpenCode);
        assert_eq!(list[1].cache_bytes, 2);
        assert_eq!(list[0].namespace, "host");
        close(database).await;
    });
}

#[test]
fn corrupt_and_incompatible_databases_are_recreated() {
    for incompatible in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(DATABASE_NAME);
        if incompatible {
            let store = Store::open(&path, crate::runtime().unwrap()).unwrap();
            store
                .runtime
                .block_on(store.connection.execute("PRAGMA user_version = 999", ()))
                .unwrap();
            drop(store);
        } else {
            std::fs::write(&path, b"not a database").unwrap();
        }
        let database = TranscriptDatabase::open(path, Vec::new()).unwrap();
        run(async {
            assert!(database.list().await.unwrap().is_empty());
            let identity = identity("host", AgentTranscriptKind::Codex, "session");
            save(&database, identity.clone(), 1, vec![7]).await.unwrap();
            assert_eq!(database.load(identity.key()).await.unwrap(), Some(vec![7]));
            close(database).await;
        });
    }
}

#[test]
fn offline_restoration_for_all_agents_uses_rust_owned_checkpoint_formats() {
    use crate::agent_transcript::{
        AgentTranscriptStatus, ClaudeSessionCore, CodexSessionCore, OpenCodeSessionCore,
    };
    let (_directory, database) = fixture();
    let session = "11111111-1111-4111-8111-111111111111";
    let mut claude = ClaudeSessionCore::new(session);
    let bytes = include_bytes!("../../test-fixtures/claude/main.jsonl");
    let source = claude.bind_source("/claude".into(), "1:2".into(), bytes.len() as u64);
    claude.ingest(source.source_generation, bytes).unwrap();
    let mut codex = CodexSessionCore::new(session);
    let bytes = include_bytes!("../../test-fixtures/codex/paginated-rollout.jsonl");
    let source = codex.bind_source("/codex".into(), "1:2".into(), bytes.len() as u64);
    codex.ingest(source.source_generation, bytes).unwrap();
    let mut opencode = OpenCodeSessionCore::new("ses_offline");
    opencode.bootstrap(1, &serde_json::json!({"info":{"id":"ses_offline"}, "messages":[{"info":{"id":"user", "role":"user"}, "parts":[{"id":"part", "type":"text", "text":"offline"}]}]}).to_string()).unwrap();
    run(async {
        for (agent, session, blob) in [
            (
                AgentTranscriptKind::Claude,
                session,
                claude.cache_blob().unwrap(),
            ),
            (
                AgentTranscriptKind::Codex,
                session,
                codex.cache_blob().unwrap(),
            ),
            (
                AgentTranscriptKind::OpenCode,
                "ses_offline",
                opencode.cache_blob().unwrap(),
            ),
        ] {
            let identity = identity("offline-host", agent, session);
            save(&database, identity.clone(), 1, blob).await.unwrap();
            let blob = database.load(identity.key()).await.unwrap().unwrap();
            let restored =
                crate::agent_sessions::decode_cached_agent_transcript(agent, session.into(), blob)
                    .unwrap();
            assert_eq!(restored.status, AgentTranscriptStatus::Stale);
            assert!(!restored.messages.is_empty());
            assert_eq!(restored.agent, agent);
        }
        assert!(database.load("missing".into()).await.unwrap().is_none());
        close(database).await;
    });
}

#[test]
fn legacy_cleanup_only_removes_the_named_database_and_sidecars() {
    let directory = tempfile::tempdir().unwrap();
    let legacy = directory.path().join(LEGACY_DATABASE_NAME);
    for suffix in ["", "-wal", "-shm", "-journal"] {
        std::fs::write(format!("{}{suffix}", legacy.display()), b"old cache").unwrap();
    }
    let unrelated = directory.path().join("other.db");
    std::fs::write(&unrelated, b"keep").unwrap();
    let database =
        TranscriptDatabase::open(directory.path().join(DATABASE_NAME), vec![legacy.clone()])
            .unwrap();
    run(async {
        database.list().await.unwrap();
        assert!(!legacy.exists());
        assert!(
            !legacy
                .with_file_name(format!("{LEGACY_DATABASE_NAME}-wal"))
                .exists()
        );
        assert!(unrelated.exists());
        close(database).await;
    });
}

const RETIRED_SEARCH_SCHEMA: &str = "
CREATE TABLE conversation_search (
    conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    title TEXT NOT NULL, directory TEXT NOT NULL, workspace_id TEXT, version TEXT NOT NULL
);
CREATE TABLE conversation_search_documents (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL, ordinal INTEGER NOT NULL, priority INTEGER NOT NULL,
    text TEXT NOT NULL, folded TEXT NOT NULL, reveal TEXT NOT NULL,
    PRIMARY KEY(conversation_id, document_id)
);
CREATE TABLE conversation_search_grams (
    gram TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL, PRIMARY KEY(gram, conversation_id, document_id)
);
CREATE INDEX conversation_search_grams_document ON conversation_search_grams(conversation_id, document_id);
CREATE INDEX conversation_search_workspace ON conversation_search(workspace_id, conversation_id);";

#[test]
fn upgrading_old_caches_preserves_checkpoints_and_reclaims_search_storage_with_bounded_memory() {
    const MIN_INDEX_BYTES: u64 = 32 * 1024 * 1024;
    for version in [1, SEARCH_SCHEMA_VERSION] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("conversation's cache.db");
        let mut store = Store::open(&path, crate::runtime().unwrap()).unwrap();
        let saved = identity("host", AgentTranscriptKind::Codex, "session");
        let other = identity("other-host", AgentTranscriptKind::Claude, "other-session");
        // Opaque bytes prove migration neither decodes nor reserializes data.
        let bytes = vec![0xa5; 256 * 1024];
        store.save(&saved, &bytes).unwrap();
        store.save(&other, &[0, 1, 2, 255]).unwrap();
        if version == SEARCH_SCHEMA_VERSION {
            store.runtime.block_on(async {
                store.connection.execute_batch(RETIRED_SEARCH_SCHEMA).await.unwrap();
                store.connection.execute(
                    "WITH RECURSIVE corpus(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM corpus WHERE n<32768)
                     INSERT INTO conversation_search_grams (gram, conversation_id, document_id)
                     SELECT CAST(n AS TEXT), ?1, ?2 FROM corpus",
                    (saved.key(), "document".repeat(64)),
                ).await.unwrap();
            });
        }
        store
            .runtime
            .block_on(
                store
                    .connection
                    .execute(format!("PRAGMA user_version = {version}"), ()),
            )
            .unwrap();
        let before: Vec<_> = store
            .list()
            .unwrap()
            .into_iter()
            .map(|row| (row.key, row.updated_at, row.cache_bytes))
            .collect();
        store.checkpoint().unwrap();
        let original_bytes = std::fs::metadata(&path).unwrap().len();
        drop(store);
        if version == SEARCH_SCHEMA_VERSION {
            assert!(original_bytes > MIN_INDEX_BYTES);
            // A killed migration may leave an incomplete destination. It must
            // be discarded while the source remains authoritative.
            std::fs::write(
                database_sidecar(&path, migration::REPLACEMENT_SUFFIX),
                b"interrupted copy",
            )
            .unwrap();
        }
        let (result, peak) = crate::test_allocations::peak_allocated_bytes(|| {
            Store::open(&path, crate::runtime().unwrap())
        });
        let mut migrated = result.unwrap();
        assert!(
            peak < MIN_INDEX_BYTES,
            "migration loaded the retired index: {peak} bytes"
        );
        assert_eq!(migrated.load(&saved.key()).unwrap(), Some(bytes.clone()));
        assert_eq!(
            migrated.load(&other.key()).unwrap(),
            Some(vec![0, 1, 2, 255])
        );
        let after: Vec<_> = migrated
            .list()
            .unwrap()
            .into_iter()
            .map(|row| (row.key, row.updated_at, row.cache_bytes))
            .collect();
        assert_eq!(after, before);
        migrated.runtime.block_on(async {
            let mut rows = migrated
                .connection
                .query(
                    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
                    (),
                )
                .await
                .unwrap();
            let mut tables = Vec::new();
            while let Some(row) = rows.next().await.unwrap() {
                tables.push(row.get::<String>(0).unwrap());
            }
            assert_eq!(tables, ["conversations", "transcript_checkpoints"]);
            let mut rows = migrated
                .connection
                .query("PRAGMA user_version", ())
                .await
                .unwrap();
            assert_eq!(
                rows.next().await.unwrap().unwrap().get::<i64>(0).unwrap(),
                SCHEMA_VERSION
            );
        });
        migrated.save(&saved, &bytes).unwrap();
        migrated.checkpoint().unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() < MIN_INDEX_BYTES);
        // Authoritative pruning still works after replacing the database.
        migrated.retain("host", &HashSet::new()).unwrap();
        assert!(migrated.load(&saved.key()).unwrap().is_none());
        assert!(migrated.load(&other.key()).unwrap().is_some());
        drop(migrated);
        let mut reopened = Store::open(&path, crate::runtime().unwrap()).unwrap();
        assert_eq!(
            reopened.load(&other.key()).unwrap(),
            Some(vec![0, 1, 2, 255])
        );
    }
}

#[test]
fn failed_search_removal_preserves_the_original_cache_and_can_retry() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(DATABASE_NAME);
    let mut store = Store::open(&path, crate::runtime().unwrap()).unwrap();
    let saved = identity("host", AgentTranscriptKind::Codex, "session");
    let bytes = vec![0, 255, 1];
    store.save(&saved, &bytes).unwrap();
    store
        .runtime
        .block_on(store.connection.execute("PRAGMA user_version = 2", ()))
        .unwrap();
    store.checkpoint().unwrap();
    drop(store);
    let replacement_path = database_sidecar(&path, migration::REPLACEMENT_SUFFIX);
    std::fs::create_dir(&replacement_path).unwrap();
    let database = TranscriptDatabase::open(path, Vec::new()).unwrap();
    run(async {
        assert!(database.load(saved.key()).await.is_err());
        std::fs::remove_dir(replacement_path).unwrap();
        assert_eq!(database.load(saved.key()).await.unwrap(), Some(bytes));
        close(database).await;
    });
}
