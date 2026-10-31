#![allow(
    clippy::unwrap_used,
    reason = "Tests stop immediately on unexpected setup or restoration failure"
)]
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize};

fn run(work: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(work);
}
struct Platform {
    core: Arc<AppCore>,
    calls: Mutex<Vec<String>>,
    granted: AtomicBool,
    blocked: AtomicBool,
    current: AtomicUsize,
    maximum: AtomicUsize,
    terminals: Mutex<Vec<String>>,
    failed_host: Mutex<Option<String>>,
    select_during: Mutex<Option<String>>,
    connect_gate: Mutex<Option<Arc<tokio::sync::Notify>>>,
    connect_started: tokio::sync::Notify,
    verify_started: tokio::sync::Notify,
}
impl Platform {
    fn new(core: Arc<AppCore>) -> Arc<Self> {
        Arc::new(Self {
            core,
            calls: Mutex::new(Vec::new()),
            granted: AtomicBool::new(true),
            blocked: AtomicBool::new(false),
            current: AtomicUsize::new(0),
            maximum: AtomicUsize::new(0),
            terminals: Mutex::new(Vec::new()),
            failed_host: Mutex::new(None),
            select_during: Mutex::new(None),
            connect_gate: Mutex::new(None),
            connect_started: tokio::sync::Notify::new(),
            verify_started: tokio::sync::Notify::new(),
        })
    }
}
#[async_trait::async_trait]
impl SessionRestorePlatform for Platform {
    async fn prepare(&self) -> Result<(), SessionRestoreError> {
        self.calls.lock().push("prepare".into());
        Ok(())
    }
    async fn verify_keys(&self) -> Result<bool, SessionRestoreError> {
        self.calls.lock().push("verify".into());
        self.verify_started.notify_one();
        if self.blocked.load(Ordering::SeqCst) {
            futures::future::pending::<()>().await;
        }
        Ok(self.granted.load(Ordering::SeqCst))
    }
    async fn connect_host(
        &self,
        host_id: String,
        verified: bool,
        _attempt: Arc<SessionConnectionAttempt>,
    ) -> Result<bool, SessionRestoreError> {
        self.calls
            .lock()
            .push(format!("connect:{host_id}:{verified}"));
        let gate = self.connect_gate.lock().take();
        self.connect_started.notify_one();
        if let Some(gate) = gate {
            gate.notified().await;
        }
        let active = self.current.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximum.fetch_max(active, Ordering::SeqCst);
        tokio::task::yield_now().await;
        self.current.fetch_sub(1, Ordering::SeqCst);
        if self.failed_host.lock().as_deref() == Some(&host_id) {
            return Err(failure("credential unavailable"));
        }
        self.core.open_ssh_shell(host_id.clone(), "shell".into());
        let view = self.core.view();
        let resume = view
            .sessions
            .iter()
            .find(|session| session.id == host_id)
            .unwrap()
            .terminal_rail
            .resume_blob
            .clone();
        self.core.restore_terminals(host_id.clone(), Some(resume));
        self.core.set_placeholder_connection(
            host_id.clone(),
            AppConnectionStatus::Ready,
            None,
            None,
        );
        let selection = self.select_during.lock().take();
        if let Some(selection) = selection {
            self.core.select_host(selection);
        }
        Ok(true)
    }
    fn state_changed(&self) {}
    fn host_failed(&self, host_id: String, _: String) {
        self.calls.lock().push(format!("failed:{host_id}"));
    }
    fn terminal_ready(&self, session_id: String) {
        self.terminals.lock().push(session_id);
    }
}
fn host(id: &str, key_auth: bool, jump: Option<&str>) -> StartupSessionHost {
    StartupSessionHost {
        host_id: id.into(),
        key_auth,
        jump_host_id: jump.map(str::to_owned),
    }
}

#[test]
fn attempt_admission_is_unique_and_old_completions_cannot_clear_a_new_attempt() {
    let core = AppCore::new();
    let first = core.begin_connection("host".into()).unwrap();
    assert!(core.begin_connection("host".into()).is_none());
    core.cancel_connection("host".into());
    let second = core.begin_connection("host".into()).unwrap();
    assert!(!first.is_current());
    assert!(!first.finish());
    assert!(second.is_current());
    assert!(second.finish());
    assert!(!core.connection_pending("host".into()));
}

#[test]
fn detachment_invalidates_all_attempts_and_native_activity_projections() {
    let core = AppCore::new();
    let first = core.begin_connection("a".into()).unwrap();
    let second = core.begin_connection("b".into()).unwrap();
    assert_eq!(core.set_connecting("b".into(), true), vec!["b"]);
    assert_eq!(core.set_connecting("a".into(), true), vec!["a", "b"]);
    core.cancel_connections();
    assert!(!first.is_current() && !second.is_current());
    assert!(core.set_connecting("a".into(), false).is_empty());
}

#[test]
fn startup_restores_active_host_first_and_limits_background_concurrency() {
    run(async {
        let core = AppCore::new();
        let platform = Platform::new(core.clone());
        let raw = Some(r#"{"hostIds":["a","b","c","d","a","missing"],"activeHostId":"b"}"#.into());
        let hosts = ["a", "b", "c", "d"]
            .into_iter()
            .map(|id| host(id, false, None))
            .collect();
        let result = core
            .start_session_restore(raw, true, hosts, true, true, platform.clone())
            .unwrap()
            .wait()
            .await
            .unwrap();
        let calls = platform.calls.lock().clone();
        assert_eq!(calls[0], "prepare");
        assert_eq!(calls[1], "connect:b:false");
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.starts_with("connect:"))
                .count(),
            4
        );
        assert_eq!(platform.maximum.load(Ordering::SeqCst), 2);
        assert_eq!(result.view.active_session_id.as_deref(), Some("b"));
        assert_eq!(*platform.terminals.lock(), vec!["b"]);
        assert!(core.state.lock().restore_can_persist);
    });
}

#[test]
fn protected_jump_dependencies_share_one_biometric_prompt_and_denial_skips_them() {
    run(async {
        let core = AppCore::new();
        let platform = Platform::new(core.clone());
        platform.granted.store(false, Ordering::SeqCst);
        let hosts = vec![
            host("protected", false, Some("jump")),
            host("jump", true, None),
            host("password", false, None),
        ];
        let raw = Some(r#"{"hostIds":["protected","password"],"activeHostId":"protected"}"#.into());
        let result = core
            .start_session_restore(raw, true, hosts, true, false, platform.clone())
            .unwrap()
            .wait()
            .await
            .unwrap();
        let calls = platform.calls.lock().clone();
        assert_eq!(calls.iter().filter(|call| *call == "verify").count(), 1);
        assert!(
            !calls
                .iter()
                .any(|call| call.starts_with("connect:protected:"))
        );
        assert!(calls.iter().any(|call| call == "connect:password:false"));
        assert_eq!(result.view.sessions.len(), 1);
        assert_eq!(result.view.sessions[0].host_id, "password");
    });
}

#[test]
fn protected_dependencies_are_verified_once_before_any_credentials_are_requested() {
    run(async {
        let core = AppCore::new();
        let platform = Platform::new(core.clone());
        let hosts = vec![
            host("a", false, Some("jump")),
            host("b", true, None),
            host("jump", true, None),
        ];
        let raw = Some(r#"{"hostIds":["a","b"],"activeHostId":"a"}"#.into());
        core.start_session_restore(raw, true, hosts, true, false, platform.clone())
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(
            *platform.calls.lock(),
            vec!["prepare", "verify", "connect:a:true", "connect:b:true"]
        );
    });
}

#[test]
fn restoration_keeps_failures_isolated_and_does_not_override_user_navigation() {
    run(async {
        let core = AppCore::new();
        let platform = Platform::new(core.clone());
        *platform.failed_host.lock() = Some("failed".into());
        *platform.select_during.lock() = Some("other".into());
        let raw = Some(r#"{"hostIds":["active","other","failed"],"activeHostId":"active"}"#.into());
        let hosts = ["active", "other", "failed"]
            .into_iter()
            .map(|id| host(id, false, None))
            .collect();
        let view = core
            .start_session_restore(raw, true, hosts, false, true, platform.clone())
            .unwrap()
            .wait()
            .await
            .unwrap()
            .view;
        assert_eq!(view.active_session_id.as_deref(), Some("other"));
        assert!(platform.terminals.lock().is_empty());
        let failed = view
            .sessions
            .iter()
            .find(|session| session.id == "failed")
            .unwrap();
        assert_eq!(failed.connection_status, AppConnectionStatus::Error);
        assert!(
            platform
                .calls
                .lock()
                .iter()
                .any(|call| call == "failed:failed")
        );
    });
}

#[test]
fn repeated_start_calls_share_one_native_restore_operation() {
    run(async {
        let core = AppCore::new();
        let platform = Platform::new(core.clone());
        let first = core
            .start_session_restore(None, true, vec![], false, false, platform.clone())
            .unwrap();
        let second = core
            .start_session_restore(None, true, vec![], false, false, platform.clone())
            .unwrap();
        second.wait().await.unwrap();
        first.wait().await.unwrap();
        assert_eq!(*platform.calls.lock(), vec!["prepare"]);
    });
}

#[test]
fn canceling_during_authentication_prevents_connection_and_allows_a_new_restore() {
    run(async {
        let core = AppCore::new();
        let platform = Platform::new(core.clone());
        platform.blocked.store(true, Ordering::SeqCst);
        let operation = core
            .start_session_restore(
                Some(r#"{"hostIds":["host"]}"#.into()),
                true,
                vec![host("host", true, None)],
                true,
                false,
                platform.clone(),
            )
            .unwrap();
        platform.verify_started.notified().await;
        core.cancel_session_restore();
        assert!(operation.wait().await.is_err());
        assert!(
            !platform
                .calls
                .lock()
                .iter()
                .any(|call| call.starts_with("connect:"))
        );
        assert!(!core.state.lock().restore_can_persist);
        platform.blocked.store(false, Ordering::SeqCst);
        core.start_session_restore(None, true, vec![], false, false, platform)
            .unwrap()
            .wait()
            .await
            .unwrap();
    });
}

#[test]
fn malformed_membership_disables_persistence_instead_of_overwriting_saved_data() {
    run(async {
        let core = AppCore::new();
        let platform = Platform::new(core.clone());
        assert!(
            core.start_session_restore(
                Some("{invalid".into()),
                true,
                vec![],
                false,
                false,
                platform
            )
            .unwrap()
            .wait()
            .await
            .is_err()
        );
        assert!(!core.state.lock().restore_can_persist);
    });
}

#[test]
fn cyclic_jump_metadata_cannot_loop_during_biometric_planning() {
    let hosts: HashMap<_, _> = [host("a", false, Some("b")), host("b", true, Some("a"))]
        .into_iter()
        .map(|host| (host.host_id.clone(), host))
        .collect();
    assert!(protected_host("a", &hosts, true));
    assert!(!protected_host("a", &hosts, false));
}

#[test]
fn empty_terminal_hydration_allows_new_terminals_but_recreated_sessions_wait_for_storage() {
    let core = AppCore::new();
    core.open_session("host".into(), "host".into(), true);
    assert!(!core.state.lock().terminal_storage_loaded.contains("host"));
    core.restore_terminals("host".into(), None);
    assert!(core.state.lock().terminal_storage_loaded.contains("host"));
    assert!(!core.state.lock().restored_terminals.contains("host"));
    core.open_ssh_shell("host".into(), "shell".into());
    core.close_session("host".into());
    core.open_session("host".into(), "host".into(), true);
    assert!(!core.state.lock().terminal_storage_loaded.contains("host"));
}

#[test]
fn membership_filters_invalid_ids_and_repairs_active_selection() {
    let parsed = membership(Some(
        r#"{"hostIds":["a","",4,"a","b"],"activeHostId":"missing"}"#,
    ))
    .unwrap();
    assert_eq!(parsed.host_ids, vec!["a", "b"]);
    assert_eq!(parsed.active_host_id.as_deref(), Some("a"));
    assert!(membership(Some("[]")).is_err());
    assert!(membership(None).unwrap().host_ids.is_empty());
}

#[test]
fn canceled_restore_callbacks_release_admission_without_clearing_a_replacement() {
    run(async {
        let core = AppCore::new();
        let platform = Platform::new(core.clone());
        *platform.connect_gate.lock() = Some(Arc::new(tokio::sync::Notify::new()));
        let operation = core
            .start_session_restore(
                Some(r#"{"hostIds":["host"]}"#.into()),
                true,
                vec![host("host", false, None)],
                false,
                false,
                platform.clone(),
            )
            .unwrap();
        platform.connect_started.notified().await;
        assert!(core.connection_pending("host".into()));
        core.cancel_session_restore();
        let manual = core.begin_connection("host".into()).unwrap();
        assert!(operation.wait().await.is_err());
        assert!(manual.is_current());
        assert!(manual.finish());
    });
}

#[test]
fn removed_active_profiles_select_the_first_surviving_host_without_terminal_navigation() {
    run(async {
        let core = AppCore::new();
        let platform = Platform::new(core.clone());
        let result = core
            .start_session_restore(
                Some(r#"{"hostIds":["removed","host"],"activeHostId":"removed"}"#.into()),
                true,
                vec![host("host", false, None)],
                false,
                false,
                platform,
            )
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(result.view.active_session_id.as_deref(), Some("host"));
    });
}
