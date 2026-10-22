use super::*;

fn assert_info_update(adapter: &mut CodexTranscriptAdapter, value: &Value, changed: bool) {
    let before = adapter.info();
    let update = adapter.accept_incremental(value);
    assert_eq!(adapter.info() != before, changed);
    let expected = changed.then(|| AgentTranscriptDelta::InfoChanged {
        info: Some(adapter.info()),
    });
    let mut deltas = update
        .deltas
        .iter()
        .filter(|delta| matches!(delta, AgentTranscriptDelta::InfoChanged { .. }));
    assert_eq!(deltas.next(), expected.as_ref());
    assert!(deltas.next().is_none());
}

fn with_prompt(mode: CodexHistoryMode) -> CodexTranscriptAdapter {
    let mut adapter = CodexTranscriptAdapter::new("thread");
    let mut bytes = tests::history_header(Some(serde_json::json!(mode)));
    bytes.extend(tests::history_turn(0, mode));
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        adapter.accept(&serde_json::from_slice(line).unwrap());
    }
    assert_eq!(adapter.title(), Some("question 0"));
    adapter
}

#[test]
fn identity_and_directory_updates_publish_only_effective_changes() {
    for mode in [CodexHistoryMode::Legacy, CodexHistoryMode::Paginated] {
        let mut adapter = CodexTranscriptAdapter::new("requested");
        assert_info_update(
            &mut adapter,
            &serde_json::json!({
                "type":"session_meta", "payload":{"history_mode":mode, "id":"thread", "cwd":"/repo"}
            }),
            true,
        );
        for (value, changed) in [
            (
                serde_json::json!({"type":"session_meta", "payload":{"id":"fork", "cwd":"/fork"}}),
                false,
            ),
            (
                serde_json::json!({"type":"turn_context", "payload":{"cwd":"/repo", "model":"new-model"}}),
                false,
            ),
            (
                serde_json::json!({"type":"turn_context", "payload":{"cwd":""}}),
                false,
            ),
            (
                serde_json::json!({"type":"turn_context", "payload":{}}),
                false,
            ),
            (
                serde_json::json!({"type":"turn_context", "payload":{"cwd":"/next"}}),
                true,
            ),
            (
                serde_json::json!({"type":"turn_context", "payload":{"cwd":"/next"}}),
                false,
            ),
        ] {
            assert_info_update(&mut adapter, &value, changed);
        }
        assert_eq!(adapter.session_id, "thread");
        assert_eq!(adapter.directory.as_deref(), Some("/next"));

        let legacy = mode == CodexHistoryMode::Legacy;
        for value in [
            serde_json::json!({"type":"thread.started", "thread_id":"direct"}),
            serde_json::json!({"type":"thread.started", "thread":{"id":"nested"}}),
        ] {
            assert_info_update(&mut adapter, &value, legacy);
            assert_info_update(&mut adapter, &value, false);
        }
        assert_info_update(
            &mut adapter,
            &serde_json::json!({
                "type":"thread.started", "thread_id":""
            }),
            false,
        );
        assert_eq!(adapter.session_id, if legacy { "nested" } else { "thread" });
    }
}

#[test]
fn rollback_refreshes_prompt_titles_under_native_name_overrides() {
    for mode in [CodexHistoryMode::Legacy, CodexHistoryMode::Paginated] {
        for native in [None, Some("Native name")] {
            let mut adapter = with_prompt(mode);
            adapter.native_title = native.map(str::to_owned);
            assert_info_update(
                &mut adapter,
                &serde_json::json!({
                    "type":"event_msg", "payload":{"type":"thread_rolled_back", "num_turns":0}
                }),
                false,
            );
            assert_info_update(
                &mut adapter,
                &serde_json::json!({
                    "type":"event_msg", "payload":{"type":"thread_rolled_back", "num_turns":1}
                }),
                native.is_none(),
            );
            assert!(adapter.prompt_title.is_none());
            assert!(adapter.projected_messages().is_empty());

            let mut info_changes = 0;
            let bytes = tests::history_turn(1, mode);
            for line in bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
            {
                let update = adapter.accept_incremental(&serde_json::from_slice(line).unwrap());
                info_changes += update
                    .deltas
                    .iter()
                    .filter(|delta| matches!(delta, AgentTranscriptDelta::InfoChanged { .. }))
                    .count();
            }
            assert_eq!(info_changes, usize::from(native.is_none()));
            assert_eq!(adapter.prompt_title.as_deref(), Some("question 1"));
            assert_eq!(adapter.title(), native.or(Some("question 1")));
        }
    }
}

#[test]
fn metadata_neutral_records_allocate_nothing_after_prompt_discovery() {
    for mode in [CodexHistoryMode::Legacy, CodexHistoryMode::Paginated] {
        let mut adapter = with_prompt(mode);
        let before = adapter.info();
        let value = serde_json::json!({"type":"realtime_item"});
        let (update, _, allocations, bytes, peak) =
            crate::test_allocations::measured_with_peak(|| adapter.accept_incremental(&value));
        assert_eq!(allocations, 0, "{mode:?}");
        assert_eq!(bytes, 0, "{mode:?}");
        assert_eq!(peak, 0, "{mode:?}");
        assert!(!update.handled);
        assert!(!update.reset);
        assert!(update.deltas.is_empty());
        assert_eq!(adapter.info(), before);
    }
}
