use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::{control::OperationControl, engine::*, fence::*, model::*};

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct MemoryBridge {
    replies: Mutex<VecDeque<Result<Value, BrowserError>>>,
    calls: Mutex<Vec<Primitive>>,
}
impl MemoryBridge {
    fn new(replies: Vec<Result<Value, BrowserError>>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            calls: Mutex::default(),
        })
    }
}
impl Bridge for MemoryBridge {
    fn call(&self, operation: Primitive) -> BoxFuture<'_, Result<Value, BrowserError>> {
        Box::pin(async move {
            self.calls.lock().push(operation);
            self.replies.lock().pop_front().unwrap_or_else(|| {
                Err(BrowserError::new(
                    ErrorCode::BrowserUnavailable,
                    "No fake response",
                ))
            })
        })
    }
}
fn context() -> Context {
    Context {
        tab_id: TabId("a-tab-1".into()),
        tabs: vec![TabInfo {
            tab_id: TabId("a-tab-1".into()),
            url: "https://example.test/".into(),
            title: "Example".into(),
            selected: true,
        }],
    }
}
fn document(id: &str, url: &str) -> Value {
    json!({"id":id,"identity":format!("a-tab-1-{id}"),"url":url,"public_url":url,"ready":true})
}
async fn execute(
    bridge: Arc<dyn Bridge>,
    name: &str,
    args: Value,
) -> Result<BrowserResult, BrowserError> {
    run(
        bridge,
        &SessionId("a".into()),
        "request",
        BrowserAction::parse(name, &args)?,
        context(),
    )
    .await
}

#[tokio::test(start_paused = true)]
async fn navigation_waits_for_a_new_ready_document() -> TestResult {
    let old = document("old", "https://example.test/");
    let bridge = MemoryBridge::new(vec![
        Ok(old.clone()),
        Ok(json!({"navigated":true,"target":"https://example.test/new"})),
        Ok(old),
        Ok(document("new", "https://example.test/new")),
    ]);
    let result = execute(
        bridge.clone(),
        "navigate",
        json!({"url":"https://example.test/new"}),
    )
    .await?;
    assert!(
        matches!(result, BrowserResult::Navigation { url, navigated: true, .. } if url == "https://example.test/new")
    );
    assert_eq!(bridge.calls.lock().len(), 4);
    Ok(())
}

#[tokio::test]
async fn stale_native_document_is_not_retried_on_the_replacement_page() -> TestResult {
    let bridge = MemoryBridge::new(vec![
        Ok(document("old", "https://example.test/")),
        Err(BrowserError::new(
            ErrorCode::StalePage,
            "Document changed before evaluation",
        )),
    ]);
    let error = execute(bridge.clone(), "snapshot", json!({}))
        .await
        .err()
        .ok_or("expected stale page")?;
    assert_eq!(error.code, ErrorCode::StalePage);
    assert_eq!(bridge.calls.lock().len(), 2);
    Ok(())
}

#[tokio::test]
async fn direct_actions_and_cross_session_contexts_are_validated_before_dispatch() -> TestResult {
    let bridge = MemoryBridge::new(vec![]);
    let action = BrowserAction::Navigate(NavigateArgs {
        tab_id: None,
        url: "file:///private".into(),
    });
    let error = run(
        bridge.clone(),
        &SessionId("a".into()),
        "request",
        action,
        context(),
    )
    .await
    .err()
    .ok_or("expected validation")?;
    assert_eq!(error.code, ErrorCode::InvalidArgument);
    let action = BrowserAction::parse("snapshot", &json!({}))?;
    let error = run(
        bridge.clone(),
        &SessionId("other".into()),
        "request",
        action,
        context(),
    )
    .await
    .err()
    .ok_or("expected ownership rejection")?;
    assert_eq!(error.code, ErrorCode::Unauthorized);
    assert!(bridge.calls.lock().is_empty());
    Ok(())
}

#[tokio::test]
async fn untrusted_adapter_results_are_bounded_and_revalidated() -> TestResult {
    let bridge = MemoryBridge::new(vec![Ok(
        json!({"tabs":[],"oversized":"x".repeat(MAX_IMAGE_RESULT)}),
    )]);
    assert_eq!(
        execute(bridge, "list_tabs", json!({}))
            .await
            .err()
            .map(|e| e.code),
        Some(ErrorCode::ResultTooLarge)
    );
    let bridge = MemoryBridge::new(vec![
        Ok(document("old", "https://example.test/")),
        Ok(
            json!({"ok":true,"value":{"url":"https://example.test/","title":"x".repeat(MAX_TEXT_RESULT),"generation":"old","elements":[]}}),
        ),
    ]);
    assert_eq!(
        execute(bridge, "snapshot", json!({}))
            .await
            .err()
            .map(|e| e.code),
        Some(ErrorCode::ResultTooLarge)
    );
    let bridge = MemoryBridge::new(vec![Ok(document(
        "old",
        "https://user:secret@example.test/",
    ))]);
    assert_eq!(
        execute(bridge, "snapshot", json!({}))
            .await
            .err()
            .map(|e| e.code),
        Some(ErrorCode::InvalidResult)
    );
    let bridge = MemoryBridge::new(vec![Ok(
        json!({"tabs":[{"tab_id":"other-tab-1","url":"about:blank","title":"","selected":true}]}),
    )]);
    assert_eq!(
        execute(bridge, "list_tabs", json!({}))
            .await
            .err()
            .map(|e| e.code),
        Some(ErrorCode::Unauthorized)
    );
    Ok(())
}

#[tokio::test]
async fn download_results_cannot_exceed_the_requested_size_or_change_destination() -> TestResult {
    for (bytes, destination) in [(5, "report.csv"), (4, "other.csv")] {
        let bridge = MemoryBridge::new(vec![
            Ok(document("old", "https://example.test/")),
            Ok(json!({"bytes":bytes,"destination_path":destination,"mime_type":"text/csv"})),
        ]);
        let error = execute(bridge, "download", json!({"url":"https://example.test/report","destination_path":"report.csv","max_bytes":4})).await.err().ok_or("expected invalid result")?;
        assert_eq!(error.code, ErrorCode::InvalidResult);
    }
    Ok(())
}

struct PendingBridge {
    started: tokio::sync::Notify,
    dropped: AtomicUsize,
}
struct Effect<'a>(&'a AtomicUsize);
impl Drop for Effect<'_> {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}
impl Bridge for PendingBridge {
    fn call(&self, _: Primitive) -> BoxFuture<'_, Result<Value, BrowserError>> {
        Box::pin(async move {
            let _effect = Effect(&self.dropped);
            self.started.notify_one();
            std::future::pending().await
        })
    }
}
fn pending_bridge() -> Arc<PendingBridge> {
    Arc::new(PendingBridge {
        started: tokio::sync::Notify::new(),
        dropped: AtomicUsize::new(0),
    })
}

#[tokio::test(start_paused = true)]
async fn cancellation_drops_inflight_effects_and_rejects_reuse() -> TestResult {
    let bridge = pending_bridge();
    let control = OperationControl::new(Duration::from_secs(60));
    let session = SessionId("a".into());
    let work = run_with_control(
        bridge.clone(),
        &session,
        "cancel",
        BrowserAction::parse("list_tabs", &json!({}))?,
        context(),
        &control,
    );
    let (result, ()) = tokio::join!(work, async {
        bridge.started.notified().await;
        control.cancel();
    });
    assert_eq!(result.err().map(|e| e.code), Some(ErrorCode::Cancelled));
    assert_eq!(bridge.dropped.load(Ordering::Relaxed), 1);
    let result = run_with_control(
        bridge.clone(),
        &session,
        "cancel",
        BrowserAction::parse("list_tabs", &json!({}))?,
        context(),
        &control,
    )
    .await;
    assert_eq!(result.err().map(|e| e.code), Some(ErrorCode::Cancelled));
    assert_eq!(bridge.dropped.load(Ordering::Relaxed), 1);
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn expiry_and_the_default_deadline_drop_pending_effects() -> TestResult {
    for duration in [Duration::from_millis(1), Duration::from_secs(60)] {
        let bridge = pending_bridge();
        let control = OperationControl::new(duration);
        let start = tokio::time::Instant::now();
        let result = run_with_control(
            bridge.clone(),
            &SessionId("a".into()),
            "expire",
            BrowserAction::parse("list_tabs", &json!({}))?,
            context(),
            &control,
        )
        .await;
        assert_eq!(result.err().map(|e| e.code), Some(ErrorCode::Timeout));
        assert_eq!(bridge.dropped.load(Ordering::Relaxed), 1);
        assert_eq!(start.elapsed(), duration.min(Duration::from_secs(20)));
    }
    Ok(())
}

#[test]
fn tab_fences_reject_document_view_driver_user_and_owner_changes() -> Result<(), FenceError> {
    let tab = TabState {
        tab: "a-tab-1",
        generation: 1,
        view_generation: 2,
        driver_generation: 3,
        interaction_generation: 4,
        closed: false,
    };
    let fence = TabFence {
        tab: tab.tab.into(),
        generation: Some(1),
        view_generation: 2,
        driver_generation: Some(3),
        interaction_generation: 4,
        allow_closed: false,
    };
    fence.validate(tab)?;
    for changed in [
        TabState {
            generation: 2,
            ..tab
        },
        TabState {
            view_generation: 3,
            ..tab
        },
        TabState {
            driver_generation: 4,
            ..tab
        },
        TabState {
            interaction_generation: 5,
            ..tab
        },
    ] {
        assert_eq!(fence.validate(changed), Err(FenceError::StalePage));
    }
    assert_eq!(
        fence.validate(TabState {
            tab: "b-tab-1",
            ..tab
        }),
        Err(FenceError::Unauthorized)
    );
    assert_eq!(
        fence.validate(TabState {
            closed: true,
            ..tab
        }),
        Err(FenceError::TabClosed)
    );
    let navigation = TabFence {
        generation: None,
        ..fence.clone()
    };
    navigation.validate(TabState {
        generation: 2,
        ..tab
    })?;
    assert_eq!(
        navigation.validate(TabState {
            generation: 2,
            view_generation: 3,
            ..tab
        }),
        Err(FenceError::StalePage)
    );
    let closing = TabFence {
        allow_closed: true,
        ..fence
    };
    closing.validate(TabState {
        closed: true,
        ..tab
    })?;
    Ok(())
}

fn batch(steps: Value) -> Value {
    json!({"steps":steps})
}
fn page_result() -> Value {
    json!({"ok":true,"value":{"url":"https://example.test/","title":"Example","generation":"old:0","elements":[]}})
}
fn successful_step() -> Vec<Result<Value, BrowserError>> {
    let doc = document("old", "https://example.test/");
    vec![
        Ok(doc.clone()),
        Ok(doc.clone()),
        Ok(page_result()),
        Ok(doc.clone()),
        Ok(doc),
    ]
}

#[tokio::test]
async fn batches_stop_at_the_first_failed_write_and_preserve_prior_results() -> TestResult {
    for code in [
        ErrorCode::StaleRef,
        ErrorCode::AmbiguousTarget,
        ErrorCode::InputRejected,
    ] {
        let mut replies = successful_step();
        let doc = document("old", "https://example.test/");
        replies.extend([
            Ok(doc.clone()),
            Ok(doc),
            Err(BrowserError::new(code.clone(), "Observe again")),
        ]);
        let bridge = MemoryBridge::new(replies);
        let result = execute(
            bridge.clone(),
            "run_steps",
            batch(json!([
                {"action":"snapshot"}, {"action":"click","arguments":{"ref":"observed"}},
                {"action":"type","arguments":{"target":{"label":"Query"},"text":"never"}}
            ])),
        )
        .await?
        .mcp()?;
        let report = &result["structuredContent"];
        assert_eq!(result["isError"], true);
        assert_eq!(report["completed_steps"], 1);
        assert_eq!(report["steps"].as_array().map(Vec::len), Some(2));
        assert_eq!(report["steps"][0]["result"]["kind"], "snapshot");
        assert_eq!(
            report["steps"][1]["error"]["code"],
            serde_json::to_value(code)?
        );
        assert_eq!(
            bridge
                .calls
                .lock()
                .iter()
                .filter(|op| matches!(op, Primitive::Evaluate { .. }))
                .count(),
            2
        );
    }
    Ok(())
}

#[tokio::test]
async fn unexpected_navigation_after_a_write_or_between_steps_stops_the_batch() -> TestResult {
    for between in [false, true] {
        let old = document("old", "https://example.test/");
        let new = document("new", "https://example.test/new");
        let replies = if between {
            let mut replies = successful_step();
            replies.push(Ok(new));
            replies
        } else {
            vec![Ok(old.clone()), Ok(old), Ok(page_result()), Ok(new)]
        };
        let bridge = MemoryBridge::new(replies);
        let result = execute(
            bridge.clone(),
            "run_steps",
            batch(json!([
                {"action":"click","arguments":{"target":{"name":"Open"}}},
                {"action":"type","arguments":{"target":{"label":"Query"},"text":"never"}}
            ])),
        )
        .await?
        .mcp()?;
        let report = &result["structuredContent"];
        assert_eq!(report["error"]["code"], "stale_page");
        assert_eq!(report["completed_steps"], usize::from(between));
        assert_eq!(report["final_page"]["url"], "https://example.test/new");
        assert!(
            report["final_page"]["generation"]
                .as_str()
                .is_some_and(|value| value.contains("new"))
        );
        assert_eq!(
            bridge
                .calls
                .lock()
                .iter()
                .filter(|op| matches!(op, Primitive::Evaluate { .. }))
                .count(),
            1
        );
    }
    Ok(())
}

#[tokio::test]
async fn explicit_navigation_rebaselines_the_next_step() -> TestResult {
    let old = document("old", "https://example.test/");
    let new = document("new", "https://example.test/new");
    let bridge = MemoryBridge::new(vec![
        Ok(old.clone()),
        Ok(old),
        Ok(json!({"navigated":true,"target":"https://example.test/new"})),
        Ok(new.clone()),
        Ok(new.clone()),
        Ok(new.clone()),
        Ok(new.clone()),
        Ok(new.clone()),
        Ok(page_result()),
        Ok(new.clone()),
        Ok(new),
    ]);
    let result = execute(
        bridge,
        "run_steps",
        batch(json!([
            {"action":"navigate","arguments":{"url":"https://example.test/new"}},
            {"action":"snapshot"}
        ])),
    )
    .await?
    .mcp()?;
    assert_eq!(result["structuredContent"]["completed_steps"], 2);
    assert!(result["structuredContent"]["error"].is_null());
    Ok(())
}

struct BatchPendingBridge {
    replies: Mutex<VecDeque<Result<Value, BrowserError>>>,
    pending: Arc<PendingBridge>,
}
impl Bridge for BatchPendingBridge {
    fn call(&self, operation: Primitive) -> BoxFuture<'_, Result<Value, BrowserError>> {
        Box::pin(async move {
            let reply = self.replies.lock().pop_front();
            if let Some(reply) = reply {
                reply
            } else {
                self.pending.call(operation).await
            }
        })
    }
}

#[tokio::test(start_paused = true)]
async fn batch_cancellation_and_total_expiry_drop_work_with_a_partial_report() -> TestResult {
    for cancel in [true, false] {
        let pending = pending_bridge();
        let mut replies = successful_step();
        replies.extend([
            Ok(document("old", "https://example.test/")),
            Ok(document("old", "https://example.test/")),
        ]);
        let bridge = Arc::new(BatchPendingBridge {
            replies: Mutex::new(replies.into()),
            pending: pending.clone(),
        });
        let control = OperationControl::new(Duration::from_secs(60));
        let action = BrowserAction::parse(
            "run_steps",
            &json!({"timeout_ms":500,"steps":[
                {"action":"snapshot"}, {"action":"click","arguments":{"target":{"name":"Save"}}},
                {"action":"snapshot"}
            ]}),
        )?;
        let session = SessionId("a".into());
        let work = run_with_control(
            bridge,
            &session,
            "batch-cancel",
            action,
            context(),
            &control,
        );
        let (result, ()) = tokio::join!(work, async {
            pending.started.notified().await;
            if cancel {
                control.cancel();
            }
        });
        let result = result?.mcp()?;
        assert_eq!(result["structuredContent"]["completed_steps"], 1);
        assert_eq!(
            result["structuredContent"]["steps"]
                .as_array()
                .map(Vec::len),
            Some(2)
        );
        assert_eq!(
            result["structuredContent"]["error"]["code"],
            if cancel { "cancelled" } else { "timeout" }
        );
        assert_eq!(pending.dropped.load(Ordering::Relaxed), 1);
    }
    Ok(())
}

#[tokio::test]
async fn batch_report_limit_preserves_a_failure_without_running_the_next_step() -> TestResult {
    let doc = document("old", "https://example.test/");
    let bridge = MemoryBridge::new(vec![
        Ok(doc.clone()),
        Ok(doc),
        Ok(json!({"ok":true,"value":{
            "url":"https://example.test/","title":"x".repeat(MAX_STEPS_RESULTS),"generation":"old:0","elements":[]
        }})),
    ]);
    let result = execute(
        bridge.clone(),
        "run_steps",
        batch(json!([
            {"action":"snapshot"}, {"action":"click","arguments":{"ref":"never"}}
        ])),
    )
    .await?
    .mcp()?;
    assert_eq!(
        result["structuredContent"]["error"]["code"],
        "result_too_large"
    );
    assert_eq!(
        result["structuredContent"]["steps"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    assert!(result.to_string().len() < MAX_TEXT_RESULT);
    assert_eq!(bridge.calls.lock().len(), 3);
    Ok(())
}
