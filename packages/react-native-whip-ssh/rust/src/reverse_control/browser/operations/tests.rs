use std::collections::VecDeque;
use std::error::Error;

use super::*;

type TestResult = Result<(), Box<dyn Error>>;
static TEST_LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Ensure,
    Prepare,
    Document,
    Evaluate,
    Other,
}

pub(crate) struct Event {
    pub permit: Arc<BrowserEffectPermit>,
    pub session: String,
    pub action: Option<BrowserPlatformAction>,
    pub phase: Phase,
}

#[derive(Default)]
pub(crate) struct Platform {
    sessions: Mutex<HashMap<String, Arc<BrowserOperationSession>>>,
    pub events: Mutex<Vec<Event>>,
    pub hold: Mutex<Option<Phase>>,
    hold_evaluation: Mutex<Option<usize>>,
    release: Notify,
    replies: Mutex<VecDeque<(Phase, BrowserPlatformResult)>>,
}

impl Platform {
    async fn event(
        &self,
        permit: Arc<BrowserEffectPermit>,
        id: String,
        phase: Phase,
        action: Option<BrowserPlatformAction>,
    ) -> Result<(), BrowserPlatformError> {
        self.events.lock().push(Event {
            permit: permit.clone(),
            session: id,
            phase,
            action,
        });
        let release = self.release.notified();
        tokio::pin!(release);
        release.as_mut().enable();
        if *self.hold.lock() == Some(phase)
            || (phase == Phase::Evaluate && *self.hold_evaluation.lock() == Some(self.count(phase)))
        {
            release.await;
        }
        permit
            .check_active()
            .map_err(|_| BrowserPlatformError::Unavailable)
    }
    pub fn resume(&self) {
        *self.hold.lock() = None;
        *self.hold_evaluation.lock() = None;
        self.release.notify_waiters();
    }
    fn state(&self, id: &str) -> Result<Arc<BrowserOperationSession>, BrowserPlatformError> {
        self.sessions
            .lock()
            .get(id)
            .cloned()
            .ok_or(BrowserPlatformError::Unavailable)
    }
    fn count(&self, phase: Phase) -> usize {
        self.events
            .lock()
            .iter()
            .filter(|event| event.phase == phase)
            .count()
    }
}

#[async_trait::async_trait]
impl BrowserOperationPlatform for Platform {
    async fn ensure_session(
        &self,
        permit: Arc<BrowserEffectPermit>,
        owner: BrowserOwner,
        _route: bool,
    ) -> Result<(), BrowserPlatformError> {
        let session = BrowserOperationSession::new(owner.clone())
            .map_err(|_| BrowserPlatformError::Unavailable)?;
        let tab = session
            .initial_tab(true)
            .map_err(|_| BrowserPlatformError::Unavailable)?;
        if !tab.attached {
            session
                .set_driver_attached(tab.id, true)
                .map_err(|_| BrowserPlatformError::Unavailable)?;
        }
        session.initialize();
        self.sessions
            .lock()
            .insert(owner.session_id.clone(), session);
        self.event(permit, owner.session_id, Phase::Ensure, None)
            .await
    }
    async fn prepare_tab(
        &self,
        permit: Arc<BrowserEffectPermit>,
        id: String,
        tab: String,
        _resume: bool,
        _navigation: bool,
    ) -> Result<(), BrowserPlatformError> {
        self.event(permit, id.clone(), Phase::Prepare, None).await?;
        self.state(&id)?
            .set_driver_attached(tab, true)
            .map_err(|_| BrowserPlatformError::Unavailable)
    }
    async fn perform(
        &self,
        permit: Arc<BrowserEffectPermit>,
        id: String,
        action: BrowserPlatformAction,
    ) -> Result<BrowserPlatformResult, BrowserPlatformError> {
        let phase = match &action {
            BrowserPlatformAction::Evaluate { .. } => Phase::Evaluate,
            BrowserPlatformAction::Document { .. } => Phase::Document,
            _ => Phase::Other,
        };
        self.event(permit, id.clone(), phase, Some(action.clone()))
            .await?;
        {
            let mut replies = self.replies.lock();
            if replies
                .front()
                .is_some_and(|(expected, _)| *expected == phase)
                && let Some((_, reply)) = replies.pop_front()
            {
                return Ok(reply);
            }
        }
        let session = self.state(&id)?;
        match action {
            BrowserPlatformAction::Document { tab_id } => {
                let tab = session.tab(tab_id).map_err(|_| BrowserPlatformError::Unavailable)?;
                Ok(BrowserPlatformResult::Document { document: BrowserPageDocument { id: format!("document-{}", tab.generation), url: tab.url.clone(), public_url: tab.url, ready: true } })
            }
            BrowserPlatformAction::Evaluate { .. } => Ok(BrowserPlatformResult::Json { value_json: json!({"ok":true,"value":{"url":"https://example.test/","title":format!("page-{id}"),"generation":"document:0","elements":[],"readable":true,"dialogs":[],"stable_ms":1000,"waits":[]}}).to_string() }),
            BrowserPlatformAction::Navigate { tab_id, url } => {
                session.location(tab_id, url.clone(), String::new()).map_err(|_| BrowserPlatformError::Unavailable)?;
                Ok(BrowserPlatformResult::Navigation { target: Some(url), navigated: true })
            }
            BrowserPlatformAction::Back { .. } | BrowserPlatformAction::Forward { .. } | BrowserPlatformAction::Reload { .. } => Ok(BrowserPlatformResult::Navigation { target: None, navigated: false }),
            BrowserPlatformAction::Screenshot { .. } => Ok(BrowserPlatformResult::Image { image: "image".into() }),
            BrowserPlatformAction::CreateTab { .. } | BrowserPlatformAction::CloseTab { .. } => Ok(BrowserPlatformResult::Done),
            BrowserPlatformAction::Download { .. } => Err(BrowserPlatformError::DownloadFailed),
        }
    }
    fn cancel(&self, _id: String) {}
    fn changed(&self, _id: String) {}
}

pub(crate) struct Harness {
    _lock: tokio::sync::OwnedMutexGuard<()>,
    pub platform: Arc<Platform>,
    pub coordinator: Arc<BrowserOperationCoordinator>,
}

impl Harness {
    pub async fn new() -> Self {
        let lock = TEST_LOCK
            .get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
            .lock_owned()
            .await;
        let platform = Arc::new(Platform::default());
        let coordinator = BrowserOperationCoordinator::new(platform.clone());
        Self {
            _lock: lock,
            platform,
            coordinator,
        }
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.coordinator.close();
        for session in self.platform.sessions.lock().values() {
            session.close();
        }
    }
}

fn owner() -> Arc<ReverseControl> {
    let owner = Arc::new(ReverseControl::default());
    crate::reverse_control::tests::insert(&owner, "a", "pane-a");
    crate::reverse_control::tests::insert(&owner, "b", "pane-b");
    owner
}

fn call(
    owner: &Arc<ReverseControl>,
    session: &str,
    name: &str,
    args: Value,
) -> Result<tokio::sync::oneshot::Receiver<Value>, Box<dyn Error>> {
    owner
        .start_action(
            session,
            json!(1),
            &json!({"params":{"name":format!("browser.{name}"),"arguments":args}}),
        )
        .map_err(|error| error.to_string().into())
}

pub(crate) async fn until(predicate: impl Fn() -> bool) -> TestResult {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await?;
    Ok(())
}

#[test]
fn native_tabs_keep_full_owner_identity_generations_and_nonreused_ids() -> TestResult {
    let identity = BrowserOwner {
        runtime_id: "owner-test".into(),
        session_id: "logical-session".into(),
        pane_id: "pane".into(),
        terminal_id: "terminal".into(),
    };
    let session = BrowserOperationSession::new(identity.clone())?;
    let tab = session.initial_tab(true)?;
    assert!(session.can_suspend(tab.id.clone()));
    session.hold_tab(tab.id.clone(), "lease".into())?;
    assert!(!session.can_suspend(tab.id.clone()));
    session.release_lease("lease".into());
    assert!(session.can_suspend(tab.id.clone()));
    let changed = session.change(tab.id.clone(), BrowserTabChange::Crash)?;
    assert!(changed.generation > tab.generation);
    assert!(changed.view_generation > tab.view_generation);
    let mut wrong = identity.clone();
    wrong.terminal_id = "replacement".into();
    assert!(matches!(
        BrowserOperationSession::new(wrong),
        Err(BrowserOperationError::Unauthorized)
    ));
    session.close();
    let reopened = BrowserOperationSession::new(identity)?;
    assert_ne!(reopened.initial_tab(true)?.id, tab.id);
    reopened.close();
    Ok(())
}

#[test]
fn native_browser_requests_use_no_json_steps_and_keep_all_basic_actions() -> TestResult {
    crate::runtime()?.block_on(async {
        let harness = Harness::new().await;
        let owner = owner();
        let snapshot = call(&owner, "a", "snapshot", json!({}))?.await?;
        assert_eq!(snapshot["structuredContent"]["title"], "page-a");
        assert!(owner.steps.lock().is_empty());
        let initial = harness.platform.state("a")?.tabs()[0].id.clone();
        let navigation = call(
            &owner,
            "a",
            "navigate",
            json!({"url":"https://example.test/new?private=hidden"}),
        )?
        .await?;
        assert_eq!(
            navigation["structuredContent"]["url"],
            "https://example.test/new"
        );
        assert!(!navigation.to_string().contains("hidden"));
        let created = call(&owner, "a", "new_tab", json!({}))?.await?;
        let created = created["structuredContent"]["tab_id"]
            .as_str()
            .ok_or("new tab missing")?
            .to_owned();
        assert_ne!(initial, created);
        assert_eq!(
            call(&owner, "a", "list_tabs", json!({}))?.await?["structuredContent"]["tabs"]
                .as_array()
                .map(Vec::len),
            Some(2)
        );
        assert_eq!(
            call(&owner, "a", "close_tab", json!({"tab_id":created}))?.await?["structuredContent"]
                ["closed"],
            true
        );
        assert_eq!(
            call(&owner, "a", "screenshot", json!({}))?.await?["isError"],
            Value::Null
        );
        owner.shutdown();
        drop(harness);
        Ok(())
    })
}

#[test]
fn queued_requests_pin_the_arrival_tab_and_keep_it_leased() -> TestResult {
    crate::runtime()?.block_on(async {
        let harness = Harness::new().await;
        let owner = owner();
        call(&owner, "a", "list_tabs", json!({}))?.await?;
        let session = harness.platform.state("a")?;
        let first = session.tabs()[0].id.clone();
        *harness.platform.hold.lock() = Some(Phase::Evaluate);
        let a = call(&owner, "a", "snapshot", json!({}))?;
        until(|| harness.platform.count(Phase::Evaluate) == 1).await?;
        let b = call(&owner, "a", "snapshot", json!({}))?;
        let second = session.create_tab(true)?.id;
        assert_eq!(session.selected_tab(), Some(second));
        assert!(!session.can_suspend(first.clone()));
        harness.platform.resume();
        assert_eq!(a.await?["structuredContent"]["tab_id"], first);
        assert_eq!(b.await?["structuredContent"]["tab_id"], first);
        assert!(harness.platform.events.lock().iter().filter(|event| event.phase == Phase::Evaluate).all(|event| {
            event.session == "a" && matches!(&event.action, Some(BrowserPlatformAction::Evaluate { tab_id, .. }) if tab_id == &first)
        }));
        until(|| session.can_suspend(first.clone())).await?;
        owner.shutdown();
        drop(harness);
        Ok(())
    })
}

#[test]
fn failed_new_tab_navigation_retains_the_address_after_request_cleanup() -> TestResult {
    crate::runtime()?.block_on(async {
        let harness = Harness::new().await;
        let owner = owner();
        call(&owner, "a", "list_tabs", json!({}))?.await?;
        let session = harness.platform.state("a")?;
        let initial = session.selected_tab().ok_or("missing initial tab")?;
        harness.platform.replies.lock().extend([
            (
                Phase::Document,
                BrowserPlatformResult::Document {
                    document: BrowserPageDocument {
                        id: "blank".into(),
                        url: "about:blank".into(),
                        public_url: "about:blank".into(),
                        ready: true,
                    },
                },
            ),
            (
                Phase::Document,
                BrowserPlatformResult::Document {
                    document: BrowserPageDocument {
                        id: "error".into(),
                        url: "chrome-error://chromewebdata/".into(),
                        public_url: "chrome-error://chromewebdata/".into(),
                        ready: true,
                    },
                },
            ),
        ]);
        let url = "https://unreachable.test/page?q=1#details";
        let result = call(&owner, "a", "new_tab", json!({"url":url}))?.await?;
        assert_eq!(result["isError"], true);
        until(|| harness.coordinator.active.lock().is_empty()).await?;
        let selected = session.selected_tab().ok_or("missing failed tab")?;
        assert_ne!(selected, initial);
        assert_eq!(session.tab(selected)?.url, url);
        assert_eq!(session.tabs().len(), 2);
        assert!(session.tab(initial).is_ok());
        let invalid = call(&owner, "a", "new_tab", json!({"url":"file:///secret"}));
        assert!(invalid.is_err());
        assert_eq!(session.tabs().len(), 2);
        owner.shutdown();
        drop(harness);
        Ok(())
    })
}

#[test]
fn cancelling_a_waiter_preserves_arrival_order_for_later_operations() -> TestResult {
    crate::runtime()?.block_on(async {
        let harness = Harness::new().await;
        let owner = owner();
        *harness.platform.hold.lock() = Some(Phase::Evaluate);
        let first = call(&owner, "a", "snapshot", json!({}))?;
        until(|| harness.platform.count(Phase::Evaluate) == 1).await?;
        let cancelled = owner
            .start_action("a", json!(2), &json!({"params":{"name":"browser.new_tab"}}))
            .map_err(|error| error.to_string())?;
        let created = call(&owner, "a", "new_tab", json!({}))?;
        let listed = call(&owner, "a", "list_tabs", json!({}))?;
        owner
            .request(
                "a",
                &json!({"method":"notifications/cancelled","params":{"requestId":2}}),
            )
            .await;
        assert_eq!(
            cancelled.await?["structuredContent"]["error"]["code"],
            "cancelled"
        );
        harness.platform.resume();
        assert_eq!(first.await?["structuredContent"]["title"], "page-a");
        let created = created.await?["structuredContent"]["tab_id"].clone();
        let listed = listed.await?;
        let tabs = listed["structuredContent"]["tabs"]
            .as_array()
            .ok_or("missing tabs")?;
        assert_eq!(tabs.len(), 2);
        assert!(tabs.iter().any(|tab| tab["tab_id"] == created));
        owner.shutdown();
        drop(harness);
        Ok(())
    })
}

#[test]
fn native_modal_dialog_errors_stop_batches_before_page_actions() -> TestResult {
    crate::runtime()?.block_on(async {
        for phase in [Phase::Document, Phase::Evaluate] {
            let harness = Harness::new().await;
            let owner = owner();
            harness.platform.replies.lock().push_back((phase, BrowserPlatformResult::Json {
                value_json: json!({"ok":false,"error":{"code":"unexpected_popup","message":"Page JavaScript dialog is open"}}).to_string(),
            }));
            let result = call(&owner, "a", "run_steps", json!({"steps":[
                {"action":"type","arguments":{"target":{"label":"Query"},"text":"never"}},
                {"action":"snapshot"}
            ]}))?.await?;
            assert_eq!(result["structuredContent"]["error"]["code"], "unexpected_popup", "{result}");
            assert_eq!(result["structuredContent"]["completed_steps"], 0);
            assert_eq!(result["structuredContent"]["steps"].as_array().map(Vec::len), Some(1));
            assert_eq!(harness.platform.count(Phase::Evaluate), usize::from(phase == Phase::Evaluate));
            owner.shutdown();
            drop(harness);
        }
        Ok(())
    })
}

#[test]
fn batches_hold_one_arrival_tab_and_lease_while_other_sessions_remain_independent() -> TestResult {
    crate::runtime()?.block_on(async {
        let harness = Harness::new().await;
        let owner = owner();
        call(&owner, "a", "list_tabs", json!({}))?.await?;
        let session = harness.platform.state("a")?;
        let first = session.tabs()[0].id.clone();
        *harness.platform.hold_evaluation.lock() = Some(5);
        let batch = call(&owner, "a", "run_steps", json!({"steps":[
            {"action":"snapshot"}, {"action":"snapshot"}, {"action":"snapshot"}
        ]}))?;
        until(|| harness.platform.count(Phase::Evaluate) == 5).await?;
        let queued = call(&owner, "a", "snapshot", json!({}))?;
        session.create_tab(true)?;
        assert!(!session.can_suspend(first.clone()));
        let other = call(&owner, "b", "snapshot", json!({}))?.await?;
        assert_eq!(other["structuredContent"]["title"], "page-b");
        // The queued call did not interleave between batch steps.
        assert_eq!(harness.platform.events.lock().iter().filter(|event| event.phase == Phase::Evaluate && event.session == "a").count(), 5);
        harness.platform.resume();
        let result = batch.await?;
        assert_eq!(result["structuredContent"]["completed_steps"], 3, "{result}");
        assert_eq!(result["structuredContent"]["tab_id"], first);
        assert_eq!(queued.await?["structuredContent"]["tab_id"], first);
        assert!(harness.platform.events.lock().iter().filter(|event| event.phase == Phase::Evaluate && event.session == "a").all(|event|
            matches!(&event.action, Some(BrowserPlatformAction::Evaluate { tab_id, .. }) if tab_id == &first)));
        until(|| session.can_suspend(first.clone())).await?;
        // A foreign outer tab and any per-step tab override fail before dispatch.
        let count = harness.platform.events.lock().len();
        assert!(call(&owner, "b", "run_steps", json!({"tab_id":first,"steps":[{"action":"snapshot"}]})).is_err());
        assert!(call(&owner, "a", "run_steps", json!({"steps":[{"action":"snapshot","arguments":{"tab_id":"b-tab-1"}}]})).is_err());
        assert_eq!(harness.platform.events.lock().len(), count);
        owner.shutdown();
        drop(harness);
        Ok(())
    })
}

#[test]
fn cancelling_or_closing_a_batch_revokes_its_effect_and_keeps_partial_progress() -> TestResult {
    crate::runtime()?.block_on(async {
        for close in [false, true] {
            let harness = Harness::new().await;
            let owner = owner();
            *harness.platform.hold_evaluation.lock() = Some(5);
            let receiver = owner
                .start_action(
                    "a",
                    json!(373),
                    &json!({"params":{"name":"browser.run_steps","arguments":{"steps":[
                        {"action":"snapshot"}, {"action":"snapshot"}, {"action":"snapshot"}
                    ]}}}),
                )
                .map_err(|e| e.to_string())?;
            until(|| harness.platform.count(Phase::Evaluate) == 5).await?;
            let permit = harness
                .platform
                .events
                .lock()
                .iter()
                .filter(|e| e.phase == Phase::Evaluate)
                .nth(4)
                .ok_or("missing second effect")?
                .permit
                .clone();
            if close {
                owner.close_session("a");
            } else {
                owner
                    .request(
                        "a",
                        &json!({"method":"notifications/cancelled","params":{"requestId":373}}),
                    )
                    .await;
            }
            let result = receiver.await?;
            assert_eq!(result["isError"], true);
            let error = &result["structuredContent"]["error"];
            assert_eq!(
                error["code"],
                if close { "session_closed" } else { "cancelled" }
            );
            assert_eq!(error["details"]["report"]["completed_steps"], 1, "{result}");
            assert_eq!(
                error["details"]["report"]["steps"].as_array().map(Vec::len),
                Some(2)
            );
            assert!(permit.check_active().is_err());
            harness.platform.resume();
            // Another launch still works and no unexecuted step runs.
            assert_eq!(
                call(&owner, "b", "snapshot", json!({}))?.await?["structuredContent"]["title"],
                "page-b"
            );
            assert_eq!(
                harness
                    .platform
                    .events
                    .lock()
                    .iter()
                    .filter(|e| e.phase == Phase::Evaluate && e.session == "a")
                    .count(),
                5
            );
            owner.shutdown();
            drop(harness);
        }
        Ok(())
    })
}

#[test]
fn requests_waiting_for_initial_hydration_pin_the_restored_selection() -> TestResult {
    crate::runtime()?.block_on(async {
        let harness = Harness::new().await;
        let owner = owner();
        *harness.platform.hold.lock() = Some(Phase::Ensure);
        let request = call(&owner, "a", "snapshot", json!({}))?;
        until(|| harness.platform.count(Phase::Ensure) == 1).await?;
        let session = harness.platform.state("a")?;
        let initial = session.tabs()[0].id.clone();
        assert!(!session.can_suspend(initial.clone()));
        session.create_tab(true)?;
        harness.platform.resume();
        assert_eq!(request.await?["structuredContent"]["tab_id"], initial);
        owner.shutdown();
        drop(harness);
        Ok(())
    })
}

#[test]
fn page_renderer_driver_clear_and_route_changes_reject_late_effects() -> TestResult {
    crate::runtime()?.block_on(async {
        for event in [
            BrowserTabChange::Document,
            BrowserTabChange::Crash,
            BrowserTabChange::Clear,
            BrowserTabChange::Route,
            BrowserTabChange::UserAction,
            BrowserTabChange::ProcessRestart,
        ] {
            let harness = Harness::new().await;
            let owner = owner();
            *harness.platform.hold.lock() = Some(Phase::Evaluate);
            let receiver = call(&owner, "a", "snapshot", json!({}))?;
            until(|| harness.platform.count(Phase::Evaluate) == 1).await?;
            let session = harness.platform.state("a")?;
            let id = session.tabs()[0].id.clone();
            let late = harness
                .platform
                .events
                .lock()
                .iter()
                .find(|event| event.phase == Phase::Evaluate)
                .ok_or("effect missing")?
                .permit
                .clone();
            session.change(id, event)?;
            let result = receiver.await?;
            assert!(matches!(
                result["structuredContent"]["error"]["code"].as_str(),
                Some("stale_page" | "browser_unavailable")
            ));
            assert!(late.check_active().is_err());
            harness.platform.resume();
            assert!(owner.pending.lock().is_empty());
            owner.shutdown();
            drop(harness);
        }
        let harness = Harness::new().await;
        let owner = owner();
        *harness.platform.hold.lock() = Some(Phase::Evaluate);
        let receiver = call(&owner, "a", "snapshot", json!({}))?;
        until(|| harness.platform.count(Phase::Evaluate) == 1).await?;
        let session = harness.platform.state("a")?;
        session.set_driver_attached(session.tabs()[0].id.clone(), true)?;
        assert_eq!(
            receiver.await?["structuredContent"]["error"]["code"],
            "stale_page"
        );
        owner.shutdown();
        drop(harness);
        Ok(())
    })
}

#[test]
fn clearing_page_data_rejects_a_navigation_still_waiting_on_the_platform() -> TestResult {
    crate::runtime()?.block_on(async {
        let harness = Harness::new().await;
        let owner = owner();
        *harness.platform.hold.lock() = Some(Phase::Other);
        let receiver = call(
            &owner,
            "a",
            "navigate",
            json!({"url":"https://example.test/new"}),
        )?;
        until(|| harness.platform.count(Phase::Other) == 1).await?;
        let session = harness.platform.state("a")?;
        session.change(session.tabs()[0].id.clone(), BrowserTabChange::Clear)?;
        assert_eq!(
            receiver.await?["structuredContent"]["error"]["code"],
            "stale_page"
        );
        assert!(owner.pending.lock().is_empty());
        owner.shutdown();
        drop(harness);
        Ok(())
    })
}

#[test]
fn cancellation_closure_and_transport_changes_cannot_revalidate_old_permits() -> TestResult {
    crate::runtime()?.block_on(async {
        for action in 0..3 {
            let harness = Harness::new().await;
            let owner = owner();
            *harness.platform.hold.lock() = Some(Phase::Evaluate);
            let receiver = call(&owner, "a", "snapshot", json!({}))?;
            until(|| harness.platform.count(Phase::Evaluate) == 1).await?;
            let late = harness
                .platform
                .events
                .lock()
                .iter()
                .find(|event| event.phase == Phase::Evaluate)
                .ok_or("missing effect")?
                .permit
                .clone();
            match action {
                0 => {
                    let id = owner
                        .pending
                        .lock()
                        .keys()
                        .next()
                        .cloned()
                        .ok_or("request missing")?;
                    owner.cancel_request(&id, "Browser action cancelled");
                }
                1 => owner.close_session("a"),
                _ => {
                    owner.epoch.fetch_add(1, Ordering::AcqRel);
                    harness.platform.resume();
                }
            }
            assert_eq!(receiver.await?["isError"], true);
            assert!(late.check_active().is_err());
            assert!(owner.steps.lock().is_empty());
            owner.shutdown();
            drop(harness);
        }
        Ok(())
    })
}

#[test]
fn same_request_numbers_on_different_hosts_do_not_collide_on_adapter_replacement() -> TestResult {
    crate::runtime()?.block_on(async {
        let harness = Harness::new().await;
        let a = owner();
        let b = owner();
        *harness.platform.hold.lock() = Some(Phase::Evaluate);
        let first = call(&a, "a", "snapshot", json!({}))?;
        let second = call(&b, "b", "snapshot", json!({}))?;
        until(|| harness.platform.count(Phase::Evaluate) == 2).await?;
        assert_eq!(harness.coordinator.active.lock().len(), 2);
        let replacement = BrowserOperationCoordinator::new(Arc::new(Platform::default()));
        assert_eq!(
            first.await?["structuredContent"]["error"]["code"],
            "cancelled"
        );
        assert_eq!(
            second.await?["structuredContent"]["error"]["code"],
            "cancelled"
        );
        replacement.close();
        a.shutdown();
        b.shutdown();
        drop(harness);
        Ok(())
    })
}

#[test]
fn closing_a_queued_target_does_not_redirect_it_to_the_new_selection() -> TestResult {
    crate::runtime()?.block_on(async {
        let harness = Harness::new().await;
        let owner = owner();
        call(&owner, "a", "list_tabs", json!({}))?.await?;
        let session = harness.platform.state("a")?;
        let id = session.tabs()[0].id.clone();
        *harness.platform.hold.lock() = Some(Phase::Evaluate);
        let first = call(&owner, "a", "snapshot", json!({}))?;
        until(|| harness.platform.count(Phase::Evaluate) == 1).await?;
        let queued = call(&owner, "a", "snapshot", json!({}))?;
        session.create_tab(true)?;
        session.close_tab(id)?;
        assert_eq!(
            first.await?["structuredContent"]["error"]["code"],
            "tab_closed"
        );
        assert_eq!(
            queued.await?["structuredContent"]["error"]["code"],
            "tab_closed"
        );
        assert_eq!(harness.platform.count(Phase::Evaluate), 1);
        owner.shutdown();
        drop(harness);
        Ok(())
    })
}

#[test]
fn cancelled_restoration_rolls_back_only_the_original_view_generation() -> TestResult {
    crate::runtime()?.block_on(async {
        let harness = Harness::new().await;
        let owner = owner();
        call(&owner, "a", "list_tabs", json!({}))?.await?;
        let session = harness.platform.state("a")?;
        let id = session.tabs()[0].id.clone();
        session.change(id.clone(), BrowserTabChange::Suspend)?;
        *harness.platform.hold.lock() = Some(Phase::Prepare);
        let receiver = call(&owner, "a", "snapshot", json!({}))?;
        until(|| harness.platform.count(Phase::Prepare) == 1).await?;
        let request = owner
            .pending
            .lock()
            .keys()
            .next()
            .cloned()
            .ok_or("missing request")?;
        owner.cancel_request(&request, "Browser action cancelled");
        receiver.await?;
        until(|| {
            session
                .tab(id.clone())
                .is_ok_and(|tab| tab.lifecycle == BrowserTabLifecycle::Suspended)
        })
        .await?;
        owner.shutdown();
        drop(harness);
        Ok(())
    })
}

#[test]
fn malformed_oversized_and_wrong_typed_platform_results_release_the_queue() -> TestResult {
    crate::runtime()?.block_on(async {
        let harness = Harness::new().await;
        let owner = owner();
        for (reply, code) in [
            (BrowserPlatformResult::Done, "invalid_result"),
            (BrowserPlatformResult::Json { value_json: "invalid".into() }, "invalid_result"),
            (BrowserPlatformResult::Json { value_json: "x".repeat(super::super::model::MAX_IMAGE_RESULT + 1) }, "result_too_large"),
        ] {
            harness.platform.replies.lock().push_back((Phase::Evaluate, reply));
            assert_eq!(call(&owner, "a", "snapshot", json!({}))?.await?["structuredContent"]["error"]["code"], code);
        }
        assert_eq!(call(&owner, "a", "snapshot", json!({}))?.await?["structuredContent"]["title"], "page-a");
        owner.shutdown();
        drop(harness);
        Ok(())
    })
}
