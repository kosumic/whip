use super::transcript::documents;
use crate::agent_transcript::*;

fn text(id: &str, text: &str) -> AgentTranscriptPart {
    AgentTranscriptPart::Text {
        id: id.into(),
        text: text.into(),
        timestamp_ms: None,
    }
}

fn message(
    id: &str,
    role: AgentMessageRole,
    parts: Vec<AgentTranscriptPart>,
) -> AgentTranscriptMessage {
    AgentTranscriptMessage {
        id: id.into(),
        role,
        parts,
        diffs: Vec::new(),
        parent_id: None,
        created_at_ms: None,
        completed_at_ms: None,
        error: None,
        details: None,
    }
}

fn snapshot(parts: Vec<AgentTranscriptPart>) -> AgentTranscriptState {
    let mut state = AgentTranscriptState::empty("session".into(), AgentTranscriptKind::Codex);
    state.messages = vec![
        message(
            "user",
            AgentMessageRole::User,
            vec![text("prompt", "Find the regression")],
        ),
        message("assistant", AgentMessageRole::Assistant, parts),
    ];
    state.turns = vec![AgentTranscriptTurn {
        id: "private-turn-id".into(),
        user_message_id: Some("user".into()),
        assistant_message_ids: vec!["assistant".into()],
        message_ids: Vec::new(),
        status: AgentTurnStatus::Idle,
        started_at_ms: None,
        completed_at_ms: None,
        diffs: Vec::new(),
        details: None,
    }];
    state
}

fn tool(name: &str) -> AgentTranscriptPart {
    AgentTranscriptPart::Tool {
        id: "command".into(), call_id: "private-call-id".into(), tool: name.into(), timestamp_ms: None,
        state: serde_json::from_value(serde_json::json!({
            "status": "Completed", "title": "Run tests",
            "input": [
                {"key":"command","value":{"String":{"value":"cargo test"}}},
                {"key":"count","value":{"Number":{"value":2}}},
                {"key":"enabled","value":{"Boolean":{"value":true}}}
            ],
            "input_json": "private raw input",
            "output": "deep output needle", "error": "tool error",
            "loaded": ["src/main.rs"],
            "files": [{"file":"tool.rs","patch":"+added line","before":"old tool","after":"new tool"}],
            "diagnostics": [{"file":"src/lib.rs","message":"mismatch","severity":"Error"}]
        })).unwrap(),
    }
}

#[test]
fn projects_content_once_with_the_list_row_ids_for_each_agent_tool() {
    for name in ["shell", "Bash", "exec_command"] {
        let mut state = snapshot(vec![
            AgentTranscriptPart::Reasoning {
                id: "reason".into(),
                text: "Inspect the failing path".into(),
                timestamp_ms: None,
            },
            tool(name),
            text("answer", "Fixed the regression"),
            AgentTranscriptPart::Plan {
                id: "plan".into(),
                text: "Verify the fix".into(),
                timestamp_ms: None,
            },
            AgentTranscriptPart::Notice {
                id: "notice".into(),
                level: AgentNoticeLevel::Warning,
                text: "Interrupted".into(),
                timestamp_ms: None,
                questions: Vec::new(),
            },
        ]);
        state.messages[1].error = Some("Provider disconnected".into());
        let docs = documents(&state);
        assert_eq!(
            docs.iter().map(|doc| doc.id.as_str()).collect::<Vec<_>>(),
            vec![
                r#"["private-turn-id","user","user"]"#,
                r#"["private-turn-id","part","assistant","reason"]"#,
                r#"["private-turn-id","part","assistant","command"]"#,
                r#"["private-turn-id","part","assistant","answer"]"#,
                r#"["private-turn-id","part","assistant","plan"]"#,
                r#"["private-turn-id","part","assistant","notice"]"#,
                r#"["private-turn-id","error","assistant"]"#,
            ]
        );
        let content = docs
            .iter()
            .map(|doc| doc.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        for expected in [
            "Find the regression",
            "Inspect the failing path",
            name,
            "Run tests",
            "cargo test\n2\ntrue",
            "deep output needle",
            "tool error",
            "tool.rs",
            "+added line",
            "old tool",
            "new tool",
            "src/main.rs",
            "src/lib.rs\nmismatch",
            "Fixed the regression",
            "Verify the fix",
            "Interrupted",
            "Provider disconnected",
        ] {
            assert!(content.contains(expected), "missing {expected}");
        }
        for hidden in ["private-turn-id", "private-call-id", "private raw input"] {
            assert!(!content.contains(hidden));
        }
        assert_eq!(content.matches("deep output needle").count(), 1);
        for doc in docs {
            assert_eq!(doc.reveal, [doc.id]);
        }
    }
}

#[test]
fn question_tools_and_notices_index_structured_options_without_serialized_inputs() {
    let questions = vec![AgentQuestion {
        header: Some("Database".into()),
        question: "Which database?".into(),
        multiple: false,
        options: vec![AgentQuestionOption {
            label: "SQLite: local".into(),
            description: Some("Local storage".into()),
        }],
    }];
    for name in [
        "question",
        "AskUserQuestion",
        "functions.request_user_input",
        "functions · request_user_input_async",
    ] {
        let mut part = tool(name);
        if let AgentTranscriptPart::Tool { state, .. } = &mut part {
            state.questions.clone_from(&questions);
            state.input = vec![
                AgentField {
                    key: "questions".into(),
                    value: AgentScalarValue::String {
                        value: "private serialized data".into(),
                    },
                },
                AgentField {
                    key: "question_summary".into(),
                    value: AgentScalarValue::String {
                        value: "Duplicate summary".into(),
                    },
                },
            ];
        }
        let state = snapshot(vec![part]);
        let docs = documents(&state);
        assert_eq!(
            docs[1].text,
            "Database\nWhich database?\nSQLite: local\nLocal storage\ndeep output needle\ntool error"
        );
    }
    let state = snapshot(vec![AgentTranscriptPart::Notice {
        id: "question".into(),
        level: AgentNoticeLevel::Info,
        text: "Please choose".into(),
        timestamp_ms: None,
        questions,
    }]);
    assert_eq!(
        documents(&state)[1].text,
        "Please choose\nDatabase\nWhich database?\nSQLite: local\nLocal storage"
    );
}

#[test]
fn respects_ordered_multi_prompt_turns_and_omits_hidden_parts_and_orphan_messages() {
    let mut hidden_tool = tool("exec");
    if let AgentTranscriptPart::Tool { id, .. } = &mut hidden_tool {
        *id = "raw-tool:hidden".into();
    }
    let mut state = snapshot(vec![
        text("empty", " \n "),
        hidden_tool,
        tool("todowrite"),
        text("reply", "first reply"),
    ]);
    state.messages.push(message(
        "followup",
        AgentMessageRole::User,
        vec![text("prompt2", "follow up")],
    ));
    state.messages.push(message(
        "orphan",
        AgentMessageRole::Assistant,
        vec![text("orphan", "old branch")],
    ));
    state.turns[0].message_ids = vec![
        "assistant".into(),
        "followup".into(),
        "user".into(),
        "missing".into(),
    ];
    let docs = documents(&state);
    assert_eq!(
        docs.iter().map(|doc| doc.text.as_str()).collect::<Vec<_>>(),
        ["first reply", "follow up", "Find the regression"]
    );
}

#[test]
fn user_images_exclude_inline_data_and_duplicate_file_names_have_distinct_reveal_anchors() {
    let mut state = snapshot(Vec::new());
    for source in ["data:image/png;base64,private", "/tmp/attached.png"] {
        state.messages[0].parts.push(AgentTranscriptPart::Image {
            id: "image".into(),
            source: source.into(),
            timestamp_ms: None,
        });
    }
    let file = "src/\"界\\file.rs";
    state.turns[0].diffs = (0..2)
        .map(|_| AgentFileDiff {
            file: file.into(),
            patch: None,
            before: Some("old".into()),
            after: Some("new".into()),
            additions: 1,
            deletions: 1,
        })
        .collect();
    let docs = documents(&state);
    assert_eq!(docs[0].text, "Find the regression\n/tmp/attached.png");
    assert_ne!(docs[1].id, docs[2].id);
    for (index, doc) in docs[1..].iter().enumerate() {
        let expected =
            serde_json::to_string(&["private-turn-id", "diff", file, &index.to_string()]).unwrap();
        assert_eq!(doc.id, expected);
        assert_eq!(doc.reveal, [r#"["private-turn-id","changes"]"#, &expected]);
        assert_eq!(doc.text, format!("{file}\nold\nnew"));
    }
}
