use super::*;
use crate::{AgentQuestion, AgentQuestionOption, AgentToolState, AgentToolStatus};

fn source(host: &str, pane: &str, agent: AgentTranscriptKind) -> Source {
    Source {
        id: SourceId {
            host_id: host.into(),
            runtime_incarnation: 1,
            transcript_key: pane.into(),
            terminal_id: pane.into(),
            pane_id: pane.into(),
            binding_token: format!("{host}/{pane}"),
            binding_generation: 1,
        },
        agent,
        authority: AutomaticSpeechSource::unavailable_for_test(),
    }
}
fn observer(scope: Scope) -> Subscription {
    Subscription(Arc::new(Mutex::new(Observer {
        scope,
        sources: HashMap::new(),
        pending: VecDeque::new(),
        pending_bytes: 0,
        remaining: MAX_CALL_BYTES,
        dropped: false,
        last_batch: Instant::now()
            .checked_sub(BATCH_INTERVAL)
            .unwrap_or_else(Instant::now),
    })))
}
fn message(id: &str, text: &str, complete: bool) -> AgentTranscriptMessage {
    AgentTranscriptMessage {
        id: id.into(),
        role: AgentMessageRole::Assistant,
        parent_id: None,
        created_at_ms: None,
        completed_at_ms: complete.then_some(1),
        error: None,
        diffs: vec![],
        details: None,
        parts: vec![AgentTranscriptPart::Text {
            id: "prose".into(),
            text: text.into(),
            timestamp_ms: None,
        }],
    }
}
fn tool(id: &str, output: &str) -> AgentTranscriptPart {
    AgentTranscriptPart::Tool {
        id: id.into(),
        call_id: format!("{id}-call"),
        tool: "shell".into(),
        timestamp_ms: None,
        state: AgentToolState {
            status: AgentToolStatus::Running,
            input: vec![],
            input_json: Some("private_arguments".into()),
            output: Some(output.into()),
            error: None,
            title: None,
            started_at_ms: None,
            completed_at_ms: None,
            exit_code: None,
            duration_ms: None,
            files: vec![],
            diagnostics: vec![],
            loaded: vec![],
            questions: vec![],
        },
    }
}
fn update(
    observer: &Subscription,
    source: &Source,
    epoch: u64,
    revision: u64,
    messages: &[AgentTranscriptMessage],
    reset: bool,
    enabled: bool,
) {
    observer.0.lock().accept(
        source,
        epoch,
        AgentTranscriptStatus::Live,
        &Window::from(AgentTranscriptView {
            revision,
            messages,
            turns: &[],
            provider_turns: false,
        }),
        messages.iter(),
        reset,
        enabled,
    );
}
fn take(observer: &Subscription) -> Batch {
    let now = observer.0.lock().last_batch.max(Instant::now()) + BATCH_INTERVAL;
    observer.take(true, now)
}
fn records(batch: &Batch) -> Vec<serde_json::Value> {
    batch
        .context
        .as_deref()
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

#[test]
fn global_and_pinned_calls_baseline_and_attribute_independent_agents_with_identical_message_ids() {
    let one = source("one", "pane", AgentTranscriptKind::Codex);
    let two = source("two", "pane", AgentTranscriptKind::Codex);
    let global = observer(Scope::Global);
    let pinned = observer(Scope::Pinned(one.id.clone()));
    for call in [&global, &pinned] {
        for source in [&one, &two] {
            update(
                call,
                source,
                1,
                1,
                &[message("old", "Old answer.", true)],
                true,
                true,
            );
        }
        assert!(take(call).context.is_none());
        for source in [&one, &two] {
            update(
                call,
                source,
                1,
                2,
                &[
                    message("old", "Old answer.", true),
                    message("same-id", "New answer.", true),
                ],
                false,
                true,
            );
        }
    }
    let all = records(&take(&global));
    assert_eq!(all.len(), 2);
    assert_eq!(all[0]["source"]["host_id"], "one");
    assert_eq!(all[1]["source"]["host_id"], "two");
    let bound = records(&take(&pinned));
    assert_eq!(bound.len(), 1);
    assert_eq!(bound[0]["source"]["host_id"], "one");
}

#[test]
fn preexisting_work_streams_only_new_stable_prose_and_rewrites_do_not_replay() {
    for agent in [
        AgentTranscriptKind::Claude,
        AgentTranscriptKind::Codex,
        AgentTranscriptKind::OpenCode,
        AgentTranscriptKind::Pi,
    ] {
        let source = source("host", "pane", agent);
        let call = observer(Scope::Pinned(source.id.clone()));
        update(
            &call,
            &source,
            1,
            1,
            &[message("work", "Already running. ", false)],
            true,
            true,
        );
        update(
            &call,
            &source,
            1,
            2,
            &[message(
                "work",
                "Already running. New sentence. Tail",
                false,
            )],
            false,
            true,
        );
        let first = records(&take(&call));
        assert_eq!(first.len(), 1);
        assert!(
            first[0]["text"]
                .as_str()
                .unwrap_or_default()
                .starts_with("New sentence.")
        );
        update(
            &call,
            &source,
            1,
            3,
            &[message(
                "work",
                "Already running. New sentence. Tail done.",
                true,
            )],
            false,
            true,
        );
        let tail = records(&take(&call));
        assert_eq!(tail.len(), 1);
        assert!(
            !tail[0]["text"]
                .as_str()
                .unwrap_or_default()
                .contains("New sentence.")
        );
        update(
            &call,
            &source,
            1,
            4,
            &[message("work", "Rewritten response.", true)],
            false,
            true,
        );
        assert!(take(&call).context.is_none());
    }
}

#[test]
fn shared_projection_includes_structured_questions_but_never_users_tools_or_reasoning() {
    let source = source(
        &"host".repeat(50),
        &"pane".repeat(50),
        AgentTranscriptKind::Codex,
    );
    let call = observer(Scope::Pinned(source.id.clone()));
    update(&call, &source, 1, 1, &[], true, true);
    let mut assistant = message(
        "answer",
        "**Public** [prose](https://example.com).\n```sh\nprivate_code\n```",
        true,
    );
    assistant.parts.push(AgentTranscriptPart::Reasoning {
        id: "private".into(),
        text: "private_reasoning".into(),
        timestamp_ms: None,
    });
    let question = AgentQuestion {
        header: Some("Approach".into()),
        question: "Which?".into(),
        multiple: true,
        options: vec![AgentQuestionOption {
            label: "Fast".into(),
            description: Some("Quickest".into()),
        }],
    };
    assistant.parts.push(AgentTranscriptPart::Notice {
        id: "ask".into(),
        level: crate::AgentNoticeLevel::Info,
        text: "not spoken".into(),
        timestamp_ms: None,
        questions: vec![question],
    });
    assistant.parts.push(tool("tool", "private_output"));
    let mut user = message("user", "private_user_prompt", true);
    user.role = AgentMessageRole::User;
    update(
        &call,
        &source,
        1,
        2,
        &[user, assistant.clone()],
        false,
        true,
    );
    let batch = take(&call);
    let context = batch.context.as_deref().unwrap_or_default();
    assert!(context.contains("Public prose."));
    assert!(context.contains("Approach. Which? Choose one or more. Fast: Quickest."));
    for private in [
        "private_code",
        "private_reasoning",
        "private_arguments",
        "private_output",
        "private_user_prompt",
    ] {
        assert!(!context.contains(private));
    }
    assert_eq!(batch.events.len(), 1);
    let (owner, _commands) = crate::realtime_voice::playback_owner_with_commands()
        .unwrap_or_else(|error| panic!("{error}"));
    owner.agent_events(&batch.events);
    assert_eq!(
        owner
            .output
            .lock()
            .transcript
            .saved_captions()
            .iter()
            .filter(|caption| caption.event.is_some())
            .count(),
        1
    );
    owner.output.lock().live_transcript =
        Some(crate::realtime_voice::live::captions::Transcript::default());
    owner.agent_events(&batch.events);
    assert_eq!(
        owner
            .output
            .lock()
            .live_transcript
            .as_ref()
            .map(|transcript| transcript
                .saved_captions()
                .iter()
                .filter(|fragment| fragment.event.is_some())
                .count()),
        Some(1)
    );
    assert_eq!(
        batch.events[0]
            .event
            .as_ref()
            .and_then(|event| event.output.as_deref()),
        Some("private_output")
    );
    update(&call, &source, 1, 3, &[assistant.clone()], false, true);
    assert!(take(&call).events.is_empty());
    // Exhausting model-context capacity must still retain local tool outcomes.
    call.0.lock().sources.get_mut(&source.id).unwrap().exhausted = true;
    if let Some(AgentTranscriptPart::Tool { state, .. }) = assistant.parts.last_mut() {
        state.status = AgentToolStatus::Completed;
    }
    update(&call, &source, 1, 4, &[assistant], false, true);
    let finished = take(&call);
    assert!(finished.context.is_none());
    assert_eq!(
        finished.events[0]
            .event
            .as_ref()
            .map(|event| event.status.as_str()),
        Some("completed")
    );
}

#[test]
fn global_tool_traffic_never_enters_call_history_or_displaces_speakable_context() {
    for agent in [
        AgentTranscriptKind::Claude,
        AgentTranscriptKind::Codex,
        AgentTranscriptKind::OpenCode,
        AgentTranscriptKind::Pi,
    ] {
        for enabled in [false, true] {
            let one = source("one", "pane", agent);
            let two = source("two", "pane", agent);
            let global = observer(Scope::Global);
            let pinned = observer(Scope::Pinned(one.id.clone()));
            let mut busy = message("work", "", true);
            for id in 0..64 {
                busy.parts
                    .push(tool(&format!("tool-{id}"), &"private_output".repeat(1024)));
            }
            for call in [&global, &pinned] {
                for source in [&one, &two] {
                    update(call, source, 1, 1, &[], true, enabled);
                    update(call, source, 1, 2, &[busy.clone()], false, enabled);
                }
                update(
                    call,
                    &one,
                    1,
                    3,
                    &[busy.clone(), message("answer", "Useful update.", true)],
                    false,
                    enabled,
                );
            }
            let batch = global.take(enabled, Instant::now() + BATCH_INTERVAL);
            assert!(batch.events.is_empty());
            if enabled {
                let content = records(&batch);
                assert_eq!(content.len(), 1);
                assert_eq!(content[0]["text"], "Useful update.");
                let text = batch.context.as_deref().unwrap();
                assert!(!text.contains("private_output"));
                assert!(!text.contains("private_arguments"));
                assert!(!text.contains("dropped or truncated"));
            } else {
                assert!(batch.context.is_none());
            }
            // Agent-bound calls retain their pinned agent's tool history,
            // independently of the announcements preference and context budget.
            assert!(!pinned.take_events().is_empty());
            assert!(global.take_events().is_empty());
        }
    }
}

#[test]
fn source_epoch_resets_preference_boundaries_and_call_replacement_never_replay() {
    let source = source("host", "pane", AgentTranscriptKind::Codex);
    let call = observer(Scope::Global);
    update(&call, &source, 1, 1, &[], true, true);
    update(
        &call,
        &source,
        1,
        2,
        &[message("queued", "Before reset.", true)],
        false,
        true,
    );
    update(
        &call,
        &source,
        2,
        1,
        &[message("catchup", "Catchup history.", true)],
        true,
        true,
    );
    update(
        &call,
        &source,
        1,
        3,
        &[message("late", "Old callback.", true)],
        false,
        true,
    );
    assert!(take(&call).context.is_none());
    update(
        &call,
        &source,
        2,
        2,
        &[
            message("catchup", "Catchup history.", true),
            message("muted", "Disabled announcements.", true),
        ],
        false,
        false,
    );
    update(
        &call,
        &source,
        2,
        3,
        &[
            message("muted", "Disabled announcements.", true),
            message("fresh", "Fresh output.", true),
        ],
        false,
        true,
    );
    let text = take(&call).context.unwrap_or_default();
    assert!(text.contains("Fresh output."));
    assert!(!text.contains("Disabled announcements."));
    let replacement = observer(Scope::Global);
    update(
        &replacement,
        &source,
        2,
        3,
        &[message("fresh", "Fresh output.", true)],
        true,
        true,
    );
    assert!(take(&replacement).context.is_none());
    let original = source.id.clone();
    let mut rebound = source;
    rebound.id.binding_generation += 1;
    rebound.id.binding_token.push_str("new");
    let pinned = observer(Scope::Pinned(original));
    update(&pinned, &rebound, 3, 1, &[], true, true);
    update(
        &pinned,
        &rebound,
        3,
        2,
        &[message("other", "Wrong binding.", true)],
        false,
        true,
    );
    assert!(take(&pinned).context.is_none());
}

#[test]
fn provider_backpressure_batches_bounds_expires_and_never_retries_dropped_content() {
    let source = source("host", "pane", AgentTranscriptKind::Codex);
    let call = observer(Scope::Global);
    update(&call, &source, 1, 1, &[], true, true);
    let mut history = Vec::new();
    for revision in 2..400 {
        history.push(message(&format!("m{revision}"), &"語".repeat(200), true));
        update(&call, &source, 1, revision, &history, false, true);
    }
    let mut bytes = 0;
    for _ in 0..MAX_PENDING {
        let batch = take(&call);
        if let Some(context) = batch.context {
            assert!(context.len() <= MAX_BATCH_BYTES + GUIDANCE.len() + 256);
            bytes += context.len();
        }
    }
    assert!(bytes < MAX_PENDING_BYTES + GUIDANCE.len() * MAX_PENDING);
    assert!(take(&call).context.is_none());
    // A separate call has budget available, but old waiting updates still expire.
    let expiring = observer(Scope::Global);
    update(&expiring, &source, 1, 1, &[], true, true);
    update(
        &expiring,
        &source,
        1,
        2,
        &[message("stale", "Stale queued update.", true)],
        false,
        true,
    );
    assert!(
        expiring
            .take(true, Instant::now() + MAX_AGE + BATCH_INTERVAL)
            .context
            .is_none()
    );
    assert!(take(&expiring).context.is_none());
}

#[test]
fn chunks_preserve_utf16_source_offsets_and_quoted_untrusted_content() {
    let source = source("host", "pane", AgentTranscriptKind::Codex);
    let call = observer(Scope::Global);
    update(&call, &source, 1, 1, &[], true, true);
    let text = "Hello 你好 👋 world. ".repeat(40);
    update(
        &call,
        &source,
        1,
        2,
        &[message("unicode", &text, true)],
        false,
        true,
    );
    let mut count = 0;
    for _ in 0..20 {
        for record in records(&take(&call)) {
            let start = usize::try_from(record["start_utf16"].as_u64().unwrap_or_default())
                .unwrap_or_else(|error| panic!("{error}"));
            let chunk = record["text"].as_str().unwrap_or_default();
            let original = String::from_utf16(
                &text
                    .encode_utf16()
                    .skip(start)
                    .take(chunk.encode_utf16().count())
                    .collect::<Vec<_>>(),
            );
            assert_eq!(original.ok().as_deref(), Some(chunk));
            count += 1;
        }
    }
    assert!(count > 1);
}

#[test]
fn a_long_preexisting_progress_part_does_not_hide_a_new_final_answer() {
    let source = source("host", "pane", AgentTranscriptKind::Codex);
    let call = observer(Scope::Pinned(source.id.clone()));
    let mut running = message("work", &"Old progress. ".repeat(1000), false);
    update(&call, &source, 1, 1, &[running.clone()], true, true);
    running.parts.push(AgentTranscriptPart::Text {
        id: "final".into(),
        text: "The final answer is ready.".into(),
        timestamp_ms: None,
    });
    running.completed_at_ms = Some(1);
    update(&call, &source, 1, 2, &[running], false, true);
    let batch = take(&call);
    let records = records(&batch);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["part_id"], "final");
    assert_eq!(records[0]["text"], "The final answer is ready.");
}

#[test]
fn disabled_announcements_keep_only_explicitly_correlated_delegation_content_on_the_shared_path() {
    let source = source("host", "pane", AgentTranscriptKind::Codex);
    let call = observer(Scope::Pinned(source.id.clone()));
    update(&call, &source, 1, 1, &[], true, false);
    let messages = [
        message("independent", "Independent task output.", true),
        message("answer", "Delegated task answer.", true),
    ];
    let turn = |id: &str, assistant: &str| crate::AgentTranscriptTurn {
        id: id.into(),
        user_message_id: None,
        assistant_message_ids: vec![assistant.into()],
        message_ids: vec![assistant.into()],
        status: crate::AgentTurnStatus::Working,
        started_at_ms: None,
        completed_at_ms: None,
        diffs: vec![],
        details: None,
    };
    let turns = [turn("outside", "independent"), turn("submitted", "answer")];
    let window = Window::from(AgentTranscriptView {
        revision: 2,
        messages: &messages,
        turns: &turns,
        provider_turns: true,
    });
    call.0.lock().accept(
        &source,
        1,
        AgentTranscriptStatus::Live,
        &window,
        messages.iter(),
        false,
        false,
    );
    // Transcript delivery can beat remote acceptance. Hold briefly rather than
    // either guessing correlation or losing a fast delegated answer.
    assert!(
        call.take_for_call(false, Instant::now(), |_, _, _, _| DeliveryDecision::Wait)
            .context
            .is_none()
    );
    let batch = call.take_for_call(false, Instant::now() + BATCH_INTERVAL, |id, turn, _, _| {
        if *id == source.id && turn == Some("submitted") {
            DeliveryDecision::Allow
        } else {
            DeliveryDecision::Ignore
        }
    });
    let records = records(&batch);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["text"], "Delegated task answer.");
    assert!(
        call.take_for_call(true, Instant::now() + BATCH_INTERVAL * 2, |_, _, _, _| {
            DeliveryDecision::Allow
        })
        .context
        .is_none()
    );
}
