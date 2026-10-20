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

fn search_state(text: &str, tool_output: Option<&str>, diff: bool) -> AgentTranscriptState {
    use crate::agent_transcript::*;
    let mut state = AgentTranscriptState::empty("fixture".into(), AgentTranscriptKind::Codex);
    let mut parts = vec![AgentTranscriptPart::Text {
        id: "text".into(),
        text: text.into(),
        timestamp_ms: None,
    }];
    if let Some(output) = tool_output {
        parts.push(AgentTranscriptPart::Tool {
            id: "tool".into(),
            call_id: "call".into(),
            tool: "shell".into(),
            timestamp_ms: None,
            state: serde_json::from_value(
                serde_json::json!({"status":"Completed","input":[],"output":output}),
            )
            .unwrap(),
        });
    }
    state.messages.push(AgentTranscriptMessage {
        id: "message".into(),
        role: AgentMessageRole::Assistant,
        parts,
        parent_id: None,
        created_at_ms: None,
        completed_at_ms: None,
        error: None,
        diffs: Vec::new(),
        details: None,
    });
    state.turns.push(AgentTranscriptTurn {
        id: "turn".into(),
        user_message_id: None,
        assistant_message_ids: vec!["message".into()],
        message_ids: Vec::new(),
        status: AgentTurnStatus::Idle,
        started_at_ms: None,
        completed_at_ms: None,
        details: None,
        diffs: if diff {
            vec![AgentFileDiff {
                file: "src/needle.rs".into(),
                patch: Some("+needle".into()),
                before: None,
                after: None,
                additions: 1,
                deletions: 0,
            }]
        } else {
            Vec::new()
        },
    });
    state
}

async fn index_fixture(
    database: &TranscriptDatabase,
    identity: TranscriptIdentity,
    state: AgentTranscriptState,
    workspace: Option<&str>,
) {
    let workspace = workspace.map(str::to_owned);
    database
        .request(move |worker| {
            worker.with_store(|store| {
                store.save(&identity, b"opaque fixture")?;
                let projection = super::search::projection(&identity, &state);
                store.runtime.block_on(async {
                    let tx = store.connection.transaction().await?;
                    super::search::write_projection(&tx, &identity, &projection).await?;
                    tx.execute(
                        "UPDATE conversation_search SET workspace_id=?2 WHERE conversation_id=?1",
                        (identity.key(), workspace.as_deref()),
                    )
                    .await?;
                    tx.commit().await?;
                    Ok(())
                })
            })
        })
        .await
        .unwrap();
}

#[test]
fn global_search_ranks_messages_above_metadata_tools_and_diffs_and_groups_excerpts() {
    use crate::chat_search::ChatSearchContentKind;
    let (_directory, database) = fixture();
    run(async {
        index_fixture(
            &database,
            identity("host", AgentTranscriptKind::Codex, "tools"),
            search_state("unrelated", Some("needle in output"), true),
            None,
        )
        .await;
        let mut metadata = search_state("unrelated", None, false);
        metadata.info.as_mut().unwrap().title = Some("needle title".into());
        index_fixture(
            &database,
            identity("host", AgentTranscriptKind::Codex, "metadata"),
            metadata,
            None,
        )
        .await;
        index_fixture(
            &database,
            identity("host", AgentTranscriptKind::Codex, "messages"),
            search_state("needle in response", Some("needle in output"), true),
            None,
        )
        .await;
        let results = database
            .search_conversations("needle".into(), None, None, 0, Vec::new())
            .await
            .unwrap();
        assert_eq!(
            results
                .conversations
                .iter()
                .map(|hit| hit.session_id.as_str())
                .collect::<Vec<_>>(),
            ["messages", "metadata", "tools"]
        );
        assert_eq!(
            results.conversations[0]
                .matches
                .iter()
                .map(|hit| hit.kind)
                .collect::<Vec<_>>(),
            [
                ChatSearchContentKind::Message,
                ChatSearchContentKind::Tool,
                ChatSearchContentKind::Diff
            ]
        );
        let diff = &results.conversations[0].matches[2].excerpt;
        assert_eq!(
            diff.reveal,
            [
                r#"["turn","changes"]"#,
                r#"["turn","diff","src/needle.rs","0"]"#
            ]
        );
        close(database).await;
    });
}

#[test]
fn global_search_preserves_literal_unicode_substrings_and_applies_host_and_workspace_filters() {
    let (_directory, database) = fixture();
    run(async {
        let text = "😀 İSTANBUL CAFÉ 中文 src/main.rs a.b 100% needle";
        for (host, workspace) in [("a", "space-a"), ("a", "space-b"), ("b", "space-a")] {
            index_fixture(
                &database,
                identity(host, AgentTranscriptKind::Codex, workspace),
                search_state(text, None, false),
                Some(workspace),
            )
            .await;
        }
        for query in [
            "i",
            "İST",
            "café",
            "中文",
            "文 s",
            "src/main.rs",
            "a.b",
            "%",
        ] {
            let results = database
                .search_conversations(
                    query.into(),
                    Some("a".into()),
                    Some("space-a".into()),
                    0,
                    Vec::new(),
                )
                .await
                .unwrap();
            assert_eq!(results.conversations.len(), 1, "query {query}");
            assert_eq!(results.conversations[0].namespace, "a");
            assert_eq!(
                results.conversations[0].workspace_id.as_deref(),
                Some("space-a")
            );
        }
        assert!(
            database
                .search_conversations("' OR 1=1 --".into(), None, None, 0, Vec::new())
                .await
                .unwrap()
                .conversations
                .is_empty()
        );
        close(database).await;
    });
}

#[test]
fn global_search_replaces_changed_documents_prunes_removed_branches_and_cascades_host_deletion() {
    let (_directory, database) = fixture();
    run(async {
        let id = identity("host", AgentTranscriptKind::Codex, "session");
        index_fixture(
            &database,
            id.clone(),
            search_state("old branch", Some("needle"), true),
            None,
        )
        .await;
        index_fixture(
            &database,
            id.clone(),
            search_state("new branch", None, false),
            None,
        )
        .await;
        assert!(
            database
                .search_conversations("needle".into(), None, None, 0, Vec::new())
                .await
                .unwrap()
                .conversations
                .is_empty()
        );
        assert_eq!(
            database
                .search_conversations("new branch".into(), None, None, 0, Vec::new())
                .await
                .unwrap()
                .conversations
                .len(),
            1
        );
        database.delete_host("host".into()).await.unwrap();
        assert!(
            database
                .search_conversations("new".into(), None, None, 0, Vec::new())
                .await
                .unwrap()
                .conversations
                .is_empty()
        );
        let grams = database
            .request(|worker| {
                worker.with_store(|store| {
                    store.runtime.block_on(async {
                        let mut rows = store
                            .connection
                            .query("SELECT COUNT(*) FROM conversation_search_grams", ())
                            .await?;
                        Ok(rows.next().await?.unwrap().get::<i64>(0)?)
                    })
                })
            })
            .await
            .unwrap();
        assert_eq!(grams, 0);
        close(database).await;
    });
}

#[test]
fn global_search_pages_conversations_without_duplicate_rows() {
    let (_directory, database) = fixture();
    run(async {
        for index in 0..27 {
            index_fixture(
                &database,
                identity(
                    "host",
                    AgentTranscriptKind::Codex,
                    &format!("session-{index:02}"),
                ),
                search_state("shared response", Some("shared tool"), true),
                None,
            )
            .await;
        }
        let first = database
            .search_conversations("shared".into(), None, None, 0, Vec::new())
            .await
            .unwrap();
        assert_eq!(first.conversations.len(), 20);
        let second = database
            .search_conversations(
                "shared".into(),
                None,
                None,
                first.next_offset.unwrap(),
                Vec::new(),
            )
            .await
            .unwrap();
        assert_eq!(second.conversations.len(), 7);
        assert!(second.next_offset.is_none());
        let ids: HashSet<_> = first
            .conversations
            .iter()
            .chain(&second.conversations)
            .map(|hit| &hit.key)
            .collect();
        assert_eq!(ids.len(), 27);
        close(database).await;
    });
}

#[test]
fn global_search_migrates_v1_in_place_and_backfills_without_changing_checkpoints() {
    use crate::agent_transcript::CodexSessionCore;
    let (directory, database) = fixture();
    let id = identity(
        "migration-host",
        AgentTranscriptKind::Codex,
        "migration-session",
    );
    let mut core = CodexSessionCore::new("migration-session");
    let lines = b"{\"type\":\"session_meta\",\"payload\":{}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"legacy needle\"}}\n";
    let source = core.bind_source("/rollout".into(), "1:2".into(), lines.len() as u64);
    core.ingest(source.source_generation, lines).unwrap();
    let blob = core.cache_blob().unwrap();
    run(async {
        save(&database, id.clone(), 1, blob.clone()).await.unwrap();
        database.request(|worker| worker.with_store(|store| store.runtime.block_on(async {
            store.connection.execute_batch("DROP TABLE conversation_search_grams; DROP TABLE conversation_search_documents; DROP TABLE conversation_search; PRAGMA user_version = 1;").await?;
            Ok(())
        }))).await.unwrap();
        close(database).await;
        let reopened =
            TranscriptDatabase::open(directory.path().join(DATABASE_NAME), Vec::new()).unwrap();
        assert_eq!(reopened.load(id.key()).await.unwrap(), Some(blob));
        reopened
            .request(|worker| {
                worker.with_store(|store| {
                    while store.backfill_search_one()? {}
                    Ok(())
                })
            })
            .await
            .unwrap();
        let results = reopened
            .search_conversations("needle".into(), None, None, 0, Vec::new())
            .await
            .unwrap();
        assert_eq!(results.conversations.len(), 1);
        assert_eq!(results.conversations[0].key, id.key());
        close(reopened).await;
    });
}

#[test]
fn global_search_queries_a_large_saved_corpus_without_decoding_checkpoint_blobs() {
    let (_directory, database) = fixture();
    run(async {
        let output = "cargo compiling dependency and running tests\n".repeat(1_500);
        for index in 0..64 {
            let text = if index == 42 {
                "unique needle answer"
            } else {
                "ordinary assistant response"
            };
            index_fixture(
                &database,
                identity(
                    "corpus",
                    AgentTranscriptKind::Codex,
                    &format!("session-{index}"),
                ),
                search_state(text, Some(&output), false),
                None,
            )
            .await;
        }
        let start = std::time::Instant::now();
        let results = database
            .search_conversations("unique needle".into(), None, None, 0, Vec::new())
            .await
            .unwrap();
        eprintln!(
            "global substring search over 64 conversations / 4 MB tool output: {:?}",
            start.elapsed()
        );
        assert_eq!(results.conversations.len(), 1);
        assert_eq!(results.conversations[0].session_id, "session-42");
        // These fixture checkpoint blobs are deliberately not decodable. The
        // query must read only indexed content and bounded result excerpts.
        assert!(
            database
                .read_transcript(identity("corpus", AgentTranscriptKind::Codex, "session-42"))
                .await
                .is_err()
        );
        close(database).await;
    });
}
