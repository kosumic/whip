use super::{engine::*, model::*};
use serde_json::json;
type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn all_actions_round_trip_with_typed_arguments() -> TestResult {
    for name in BrowserAction::NAMES {
        let args = match *name {
            "navigate" => json!({"url":"https://example.test/"}),
            "download" => {
                json!({"url":"https://example.test/report.pdf","destination_path":"~/report.pdf"})
            }
            "find" => json!({"role":"button","name":"Save","limit":5}),
            "get" => json!({"property":"text","target":{"role":"button"}}),
            "click" | "check" | "uncheck" => json!({"ref":"ref-1"}),
            "type" => json!({"target":{"label":"Query"},"text":""}),
            "keys" => json!({"target":{"css":"input"},"key":"Control+a"}),
            "select" => json!({"target":{"role":"combobox"},"option":"Newest"}),
            "scroll" => json!({"y":500}),
            "eval" => json!({"js":"await fetch('/api').then(r => r.json())"}),
            _ => json!({}),
        };
        let action = BrowserAction::parse(name, &args)?;
        assert_eq!(action.name(), *name);
        let serialized = serde_json::to_value(&action)?;
        let decoded: BrowserAction = serde_json::from_value(serialized)?;
        assert_eq!(decoded.name(), *name);
        BrowserAction::parse(name, &action.arguments()?)?;
    }
    Ok(())
}
#[test]
fn malformed_arguments_and_limits_fail_before_dispatch() {
    for (name, args) in [
        ("eval", json!({"js":3})),
        ("eval", json!({"js":"1","readonly":true})),
        ("snapshot", json!({"unknown":1})),
        ("navigate", json!({"url":"file:///secret"})),
        (
            "download",
            json!({"url":"file:///secret", "destination_path":"report"}),
        ),
        (
            "download",
            json!({"url":"https://user:password@example.test/report", "destination_path":"report"}),
        ),
        (
            "download",
            json!({"url":"https://example.test/report", "destination_path":"/tmp/"}),
        ),
        (
            "download",
            json!({"url":"https://example.test/report", "destination_path":"/tmp/.."}),
        ),
        (
            "download",
            json!({"url":"https://example.test/report", "destination_path":"report", "max_bytes": MAX_DOWNLOAD_BYTES + 1}),
        ),
        (
            "download",
            json!({"url":"https://example.test/report", "destination_path":"report", "max_bytes": 0}),
        ),
        (
            "download",
            json!({"url":"https://example.test/report", "destination_path":"report", "cookies":"secret"}),
        ),
        (
            "navigate",
            json!({"url":"https://user:secret@example.test/"}),
        ),
        ("find", json!({})),
        ("find", json!({"role":"button","limit":51})),
        ("click", json!({"target":{"name":"Save"},"ref":"ref"})),
        ("click", json!({"target":{"ref":"ref","css":"button"}})),
        ("type", json!({"ref":"ref","text":"x".repeat(MAX_INPUT+1)})),
        ("scroll", json!({"y":i32::MIN})),
        ("scroll", json!({"y":1.5})),
        (
            "get",
            json!({"property":"text","ref":"ref","max_chars":MAX_READ+1}),
        ),
        ("extract", json!({"chunk_size":12001})),
        ("extract", json!({"start":-1})),
        ("wait", json!({"condition":"text"})),
        ("wait", json!({"timeout_ms":MAX_WAIT_MS+1})),
        ("keys", json!({"ref":"ref","key":"executeNative"})),
        ("eval", json!({"js":"x".repeat(MAX_REQUEST)})),
        ("snapshot", json!(3)),
        ("snapshot", json!({"action":"eval"})),
    ] {
        assert_eq!(
            BrowserAction::parse(name, &args)
                .err()
                .map(|error| error.code),
            Some(ErrorCode::InvalidArgument),
            "{name}"
        );
    }
    assert_eq!(
        BrowserAction::parse("execute_js", &json!({}))
            .err()
            .map(|error| error.code),
        Some(ErrorCode::UnknownAction)
    );
}
#[test]
fn results_and_errors_have_structured_bounded_envelopes() -> TestResult {
    let result = BrowserResult::Eval {
        tab_id: TabId("a-tab-1".into()),
        value: json!({"items":[1,2]}),
    };
    let encoded = serde_json::to_string(&result)?;
    let decoded: BrowserResult = serde_json::from_str(&encoded)?;
    assert_eq!(
        decoded.mcp()?["structuredContent"]["value"],
        json!({"items":[1,2]})
    );
    let error = BrowserError::new(ErrorCode::StaleRef, "Observe again");
    assert_eq!(
        error.mcp()["structuredContent"]["error"]["code"],
        "stale_ref"
    );
    let huge = BrowserResult::Eval {
        tab_id: TabId("a-tab-1".into()),
        value: json!("x".repeat(MAX_TEXT_RESULT)),
    };
    assert_eq!(
        huge.mcp().err().map(|error| error.code),
        Some(ErrorCode::ResultTooLarge)
    );
    let huge_image = BrowserResult::Screenshot {
        tab_id: TabId("a-tab-1".into()),
        image: "a".repeat(MAX_IMAGE_RESULT),
        annotations: None,
    };
    assert_eq!(
        huge_image.mcp().err().map(|error| error.code),
        Some(ErrorCode::ResultTooLarge)
    );
    Ok(())
}
fn context() -> Context {
    Context {
        tab_id: TabId("a-tab-1".into()),
        tabs: vec![TabInfo {
            tab_id: TabId("a-tab-1".into()),
            url: "https://example.test/page".into(),
            title: "Test".into(),
            selected: true,
        }],
    }
}
#[test]
fn tab_authorization_is_checked_in_rust() -> TestResult {
    let session = SessionId("a".into());
    let action = BrowserAction::parse("snapshot", &json!({}))?;
    validate_context(&session, &action, &context())?;
    assert_eq!(
        authorize_tab(&session, &TabId("b-tab-1".into()))
            .err()
            .map(|error| error.code),
        Some(ErrorCode::Unauthorized)
    );
    let mut context = context();
    context.tab_id = TabId("a-tab-9".into());
    assert_eq!(
        validate_context(&session, &action, &context)
            .err()
            .map(|error| error.code),
        Some(ErrorCode::TabClosed)
    );
    context.tab_id = TabId("a-tab-1".into());
    let requested = BrowserAction::parse("snapshot", &json!({"tab_id":"a-tab-2"}))?;
    assert_eq!(
        validate_context(&session, &requested, &context)
            .err()
            .map(|error| error.code),
        Some(ErrorCode::Unauthorized)
    );
    Ok(())
}
