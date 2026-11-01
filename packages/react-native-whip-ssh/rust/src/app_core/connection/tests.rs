#![allow(
    clippy::expect_used,
    reason = "Test fixtures fail immediately when setup or an expected callback does not complete"
)]
use super::{
    AppCore, CredentialCoordinator, EffectResult, HostAuthMode, HostProfileRecord, HostRuntime,
    Mutex, SessionConnectionFailure, SessionConnectionFailureKind, SessionConnectionOperation,
    SessionConnectionOutcome, SessionConnectionPermit, SessionConnectionPhase,
    SessionConnectionPlatform, SessionConnectionPlatformError, SessionConnectionPresentation,
    SessionConnectionProfile, SessionConnectionRequest, platform_failure,
};
use crate::{
    CredentialEffect, CredentialEffectPermit, CredentialEffectResult, CredentialPlatform,
    CredentialPlatformError, CredentialProfileView, CredentialStorageKey, HostRuntimeConfig,
    HostSshConfig, HostSshCredential, create_host_runtime,
};
use std::sync::Arc;
use std::{collections::VecDeque, error::Error, time::Duration};
use tokio::sync::Notify;

type TestResult = Result<(), Box<dyn Error>>;
#[derive(Default)]
struct Storage {
    hosts: Mutex<Vec<HostProfileRecord>>,
    other: Mutex<std::collections::HashMap<String, String>>,
}
#[async_trait::async_trait]
impl CredentialPlatform for Storage {
    async fn effect(
        &self,
        _permit: Arc<CredentialEffectPermit>,
        effect: CredentialEffect,
    ) -> Result<CredentialEffectResult, CredentialPlatformError> {
        match effect {
            CredentialEffect::ReadMetadata { keys } => Ok(CredentialEffectResult::Metadata {
                entries: keys
                    .into_iter()
                    .map(|key| crate::CredentialStorageEntry {
                        key,
                        value: if key == CredentialStorageKey::Hosts {
                            Some(serde_json::to_string(&*self.hosts.lock()).expect("test metadata"))
                        } else {
                            self.other.lock().get(&format!("{key:?}")).cloned()
                        },
                    })
                    .collect(),
            }),
            CredentialEffect::WriteMetadata { entries } => {
                for entry in entries {
                    if entry.key == CredentialStorageKey::Hosts {
                        *self.hosts.lock() =
                            serde_json::from_str(entry.value.as_deref().unwrap_or("[]"))
                                .expect("saved hosts");
                    } else if let Some(value) = entry.value {
                        self.other.lock().insert(format!("{:?}", entry.key), value);
                    } else {
                        self.other.lock().remove(&format!("{:?}", entry.key));
                    }
                }
                Ok(CredentialEffectResult::Done)
            }
            CredentialEffect::ReadSecure { .. } => Ok(CredentialEffectResult::Text { value: None }),
            CredentialEffect::WriteSecure { .. } | CredentialEffect::ClearSecure { .. } => {
                Ok(CredentialEffectResult::Done)
            }
            CredentialEffect::VaultAvailable => {
                Ok(CredentialEffectResult::Boolean { value: false })
            }
            _ => Err(CredentialPlatformError::Unsupported),
        }
    }
    fn profiles_changed(&self, _: CredentialProfileView) {}
    fn diagnostic(&self, _: String, _: Option<String>) {}
}

#[derive(Default)]
struct State {
    calls: Vec<&'static str>,
    hold: Option<&'static str>,
    missing: bool,
    biometric: bool,
    trust: bool,
    errors: VecDeque<SessionConnectionPlatformError>,
    restore_error: bool,
    cleanup_retain: Vec<bool>,
    permits: Vec<Arc<SessionConnectionPermit>>,
    runtime: Option<Arc<HostRuntime>>,
    projections: usize,
    loaded_ids: Vec<String>,
    cleanup_error: bool,
}
#[derive(Default)]
struct Platform {
    state: Mutex<State>,
    wake: Notify,
}
impl Platform {
    async fn called(&self, name: &'static str, permit: Arc<SessionConnectionPermit>) {
        {
            let mut state = self.state.lock();
            state.calls.push(name);
            state.permits.push(permit);
        }
        loop {
            let wake = self.wake.notified();
            if self.state.lock().hold != Some(name) {
                break;
            }
            wake.await;
        }
    }
    fn release(&self) {
        self.state.lock().hold = None;
        self.wake.notify_waiters();
    }
    async fn wait(&self, name: &'static str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !self.state.lock().calls.contains(&name) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("effect started");
    }
}
#[async_trait::async_trait]
impl SessionConnectionPlatform for Platform {
    async fn load_profile(
        &self,
        permit: Arc<SessionConnectionPermit>,
        host: HostProfileRecord,
        _interactive: bool,
    ) -> EffectResult<Option<SessionConnectionProfile>> {
        self.called("credential", permit).await;
        self.state.lock().loaded_ids.push(host.id.clone());
        Ok(
            (!self.state.lock().missing).then(|| SessionConnectionProfile {
                host,
                credential: crate::CredentialMaterial {
                    secret: "PRIVATE-MATERIAL".into(),
                    ..Default::default()
                },
            }),
        )
    }
    async fn verify_keys(&self, permit: Arc<SessionConnectionPermit>) -> EffectResult<bool> {
        self.called("biometric", permit).await;
        Ok(self.state.lock().biometric)
    }
    async fn wait_for_cleanup(
        &self,
        permit: Arc<SessionConnectionPermit>,
        _: String,
    ) -> EffectResult<()> {
        self.called("wait", permit).await;
        Ok(())
    }
    async fn connect_runtime(
        &self,
        permit: Arc<SessionConnectionPermit>,
        profile: SessionConnectionProfile,
        _: Vec<SessionConnectionProfile>,
    ) -> EffectResult<Arc<HostRuntime>> {
        self.called("connect", permit).await;
        let mut state = self.state.lock();
        if let Some(error) = state.errors.pop_front() {
            return Err(error);
        }
        let runtime = create_host_runtime(HostRuntimeConfig {
            runtime_id: profile.host.id.clone(),
            ssh: HostSshConfig {
                host: profile.host.host,
                port: 22,
                username: "test".into(),
                credential: HostSshCredential::Password {
                    password: profile.credential.secret,
                },
                forward_agent: false,
                tailcat_address: None,
                tailcat_private_key: None,
                tailcat_ssh_server: false,
            },
            jump_hosts: vec![],
            herdr_enabled: profile.host.herdr_enabled,
            herdr_backend: crate::HostHerdrBackend::Legacy,
            session_name: "main".into(),
            herdr_command: "herdr".into(),
            socket_path: None,
            cached_socket_path: None,
        })
        .expect("fake runtime");
        state.runtime = Some(runtime.clone());
        drop(state);
        Ok(runtime)
    }
    async fn confirm_trust(
        &self,
        permit: Arc<SessionConnectionPermit>,
        _: crate::ssh::HostKeyChallenge,
    ) -> EffectResult<bool> {
        self.called("confirm", permit).await;
        Ok(self.state.lock().trust)
    }
    async fn record_trust(
        &self,
        permit: Arc<SessionConnectionPermit>,
        _: crate::ssh::HostKeyChallenge,
    ) -> EffectResult<()> {
        self.called("trust", permit).await;
        Ok(())
    }
    async fn restore_terminals(
        &self,
        permit: Arc<SessionConnectionPermit>,
        _: String,
    ) -> EffectResult<bool> {
        self.called("restore", permit).await;
        if self.state.lock().restore_error {
            Err(platform_failure(SessionConnectionFailureKind::Platform))
        } else {
            Ok(false)
        }
    }
    async fn cleanup(
        &self,
        permit: Arc<SessionConnectionPermit>,
        _: String,
        retain: bool,
    ) -> EffectResult<()> {
        assert!(permit.is_current());
        self.called("cleanup", permit).await;
        self.state.lock().cleanup_retain.push(retain);
        if self.state.lock().cleanup_error {
            return Err(platform_failure(SessionConnectionFailureKind::Platform));
        }
        let runtime = self.state.lock().runtime.take();
        if let Some(runtime) = runtime
            && !retain
        {
            runtime.disconnect().await.expect("fake disconnect");
        }
        Ok(())
    }
    fn present(&self, permit: Arc<SessionConnectionPermit>, _: SessionConnectionPresentation) {
        assert!(permit.is_current());
    }
    fn failure_message(&self, _: SessionConnectionFailure) -> String {
        "localized failure".into()
    }
    fn state_changed(&self) {
        self.state.lock().projections += 1;
    }
    fn connecting_changed(&self, _: Vec<String>) {}
    fn diagnostic(&self, _: String, _: SessionConnectionPhase, _: u64, _: bool) {}
}
struct Fixture {
    core: Arc<AppCore>,
    credentials: Arc<CredentialCoordinator>,
    storage: Arc<Storage>,
    platform: Arc<Platform>,
    request: SessionConnectionRequest,
}
impl Fixture {
    fn new() -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        let host = HostProfileRecord {
            id,
            name: "test".into(),
            host: "example.test".into(),
            port: "22".into(),
            username: "test".into(),
            auth_mode: HostAuthMode::Password,
            jump_host_id: None,
            forward_agent: false,
            tailcat_enabled: false,
            tailcat_ssh_server: false,
            herdr_enabled: false,
            herdr_backend: crate::HostHerdrBackend::Legacy,
            herdr_command: "herdr".into(),
            herdr_socket_path: String::new(),
            session_name: "main".into(),
            agent_instructions: String::new(),
            created_at: "created".into(),
            updated_at: "updated".into(),
            last_connected_at: None,
        };
        let storage = Arc::new(Storage {
            hosts: Mutex::new(vec![host.clone()]),
            ..Default::default()
        });
        let credentials = CredentialCoordinator::new(storage.clone());
        Self {
            core: AppCore::new(),
            credentials,
            storage,
            platform: Arc::new(Platform::default()),
            request: SessionConnectionRequest {
                host,
                credential: None,
                saved: true,
                persist_profile: false,
                navigate: false,
                activate: true,
                reuse_placeholder: true,
                biometric_verified: false,
                protect_keys: false,
                prompt_for_trust: true,
                existing_host: None,
                ssh_shell_title: "SSH".into(),
                attempt: None,
            },
        }
    }
    fn start(&self) -> Arc<SessionConnectionOperation> {
        self.core.start_connection(
            self.request.clone(),
            self.credentials.clone(),
            self.platform.clone(),
        )
    }
}
fn challenge() -> SessionConnectionPlatformError {
    SessionConnectionPlatformError::UnknownHostKey {
        challenge: crate::ssh::HostKeyChallenge {
            host: "example.test".into(),
            port: 22,
            key_type: "ssh-ed25519".into(),
            fingerprint: "fingerprint".into(),
            public_key: "public".into(),
        },
    }
}

#[tokio::test]
async fn saved_plain_ssh_restores_then_opens_one_fallback_shell() -> TestResult {
    let f = Fixture::new();
    assert_eq!(f.start().result().await, SessionConnectionOutcome::Ready);
    assert_eq!(
        f.platform.state.lock().calls,
        ["wait", "credential", "connect", "restore"]
    );
    assert_eq!(f.core.view().sessions[0].terminal_rail.terminals.len(), 1);
    assert!(!f.core.connection_pending(f.request.host.id.clone()));
    assert!(
        f.platform
            .state
            .lock()
            .permits
            .iter()
            .all(|permit| !permit.is_current())
    );
    Ok(())
}
#[tokio::test]
async fn missing_credentials_fail_in_a_recoverable_placeholder_before_transport() -> TestResult {
    let f = Fixture::new();
    f.platform.state.lock().missing = true;
    assert!(matches!(
        f.start().result().await,
        SessionConnectionOutcome::Failed {
            failure: SessionConnectionFailure {
                kind: SessionConnectionFailureKind::Credential,
                ..
            }
        }
    ));
    assert!(!f.platform.state.lock().calls.contains(&"connect"));
    assert_eq!(
        f.core.view().sessions[0].connection_status,
        super::super::AppConnectionStatus::Error
    );
    Ok(())
}
#[tokio::test]
async fn biometric_cancellation_never_constructs_transport() -> TestResult {
    let mut f = Fixture::new();
    f.request.protect_keys = true;
    f.request.host.auth_mode = HostAuthMode::Key;
    f.storage.hosts.lock()[0].auth_mode = HostAuthMode::Key;
    assert_eq!(
        f.start().result().await,
        SessionConnectionOutcome::Cancelled
    );
    assert!(!f.platform.state.lock().calls.contains(&"connect"));
    Ok(())
}
#[tokio::test]
async fn rejected_trust_cleans_up_and_never_attaches() -> TestResult {
    let f = Fixture::new();
    f.platform.state.lock().errors.push_back(challenge());
    assert!(matches!(
        f.start().result().await,
        SessionConnectionOutcome::Failed { .. }
    ));
    assert_eq!(f.platform.state.lock().cleanup_retain, [false]);
    assert!(!f.platform.state.lock().calls.contains(&"restore"));
    Ok(())
}
#[tokio::test]
async fn unknown_keys_are_retried_only_after_explicit_approval_and_have_a_bound() -> TestResult {
    let f = Fixture::new();
    {
        let mut state = f.platform.state.lock();
        state.trust = true;
        state.errors.extend([challenge(), challenge()]);
    }
    assert!(matches!(
        f.start().result().await,
        SessionConnectionOutcome::Failed { .. }
    ));
    assert_eq!(
        f.platform
            .state
            .lock()
            .calls
            .iter()
            .filter(|call| **call == "connect")
            .count(),
        2
    );
    assert_eq!(
        f.platform
            .state
            .lock()
            .calls
            .iter()
            .filter(|call| **call == "trust")
            .count(),
        1
    );
    Ok(())
}
#[tokio::test]
async fn approved_key_connects_and_changed_keys_never_overwrite_trust() -> TestResult {
    let f = Fixture::new();
    {
        let mut state = f.platform.state.lock();
        state.trust = true;
        state.errors.push_back(challenge());
    }
    assert_eq!(f.start().result().await, SessionConnectionOutcome::Ready);
    let changed = Fixture::new();
    let SessionConnectionPlatformError::UnknownHostKey { challenge } = challenge() else {
        unreachable!()
    };
    changed
        .platform
        .state
        .lock()
        .errors
        .push_back(SessionConnectionPlatformError::ChangedHostKey { challenge });
    assert!(matches!(
        changed.start().result().await,
        SessionConnectionOutcome::Failed { .. }
    ));
    assert!(!changed.platform.state.lock().calls.contains(&"confirm"));
    Ok(())
}
#[tokio::test]
async fn close_during_credential_loading_invalidates_its_callback_lease() -> TestResult {
    let f = Fixture::new();
    f.platform.state.lock().hold = Some("credential");
    let operation = f.start();
    f.platform.wait("credential").await;
    f.core.close_session(f.request.host.id.clone());
    assert!(
        !f.platform
            .state
            .lock()
            .permits
            .last()
            .expect("permit")
            .is_current()
    );
    f.platform.release();
    assert_eq!(
        operation.result().await,
        SessionConnectionOutcome::Cancelled
    );
    assert!(f.core.view().sessions.is_empty());
    assert!(!f.platform.state.lock().calls.contains(&"connect"));
    Ok(())
}
#[tokio::test]
async fn repeated_taps_do_not_start_a_second_transaction() -> TestResult {
    let f = Fixture::new();
    f.platform.state.lock().hold = Some("credential");
    let first = f.start();
    f.platform.wait("credential").await;
    assert_eq!(f.start().result().await, SessionConnectionOutcome::Busy);
    f.platform.release();
    assert_eq!(first.result().await, SessionConnectionOutcome::Ready);
    Ok(())
}
#[tokio::test]
async fn cancellation_drains_connect_before_a_rapid_retry_can_create_transport() -> TestResult {
    let f = Fixture::new();
    f.platform.state.lock().hold = Some("connect");
    let first = f.start();
    f.platform.wait("connect").await;
    f.core.cancel_connection(f.request.host.id.clone());
    let second = f.start();
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        f.platform
            .state
            .lock()
            .calls
            .iter()
            .filter(|call| **call == "connect")
            .count(),
        1
    );
    f.platform.release();
    assert_eq!(first.result().await, SessionConnectionOutcome::Cancelled);
    assert_eq!(second.result().await, SessionConnectionOutcome::Ready);
    assert_eq!(f.platform.state.lock().cleanup_retain, [false]);
    assert_eq!(f.core.view().sessions.len(), 1);
    Ok(())
}
#[tokio::test]
async fn terminal_restore_failure_detaches_binding_and_retains_healthy_transport() -> TestResult {
    let f = Fixture::new();
    f.platform.state.lock().restore_error = true;
    assert!(matches!(
        f.start().result().await,
        SessionConnectionOutcome::Failed {
            failure: SessionConnectionFailure {
                phase: SessionConnectionPhase::TerminalRestore,
                ..
            }
        }
    ));
    assert_eq!(f.platform.state.lock().cleanup_retain, [true]);
    assert_eq!(
        f.core.view().sessions[0].connection_status,
        super::super::AppConnectionStatus::Error
    );
    Ok(())
}
#[tokio::test]
async fn cancel_during_restore_releases_transport_and_cannot_open_a_shell() -> TestResult {
    let f = Fixture::new();
    f.platform.state.lock().hold = Some("restore");
    let operation = f.start();
    f.platform.wait("restore").await;
    operation.cancel();
    f.platform.release();
    assert_eq!(
        operation.result().await,
        SessionConnectionOutcome::Cancelled
    );
    assert_eq!(f.platform.state.lock().cleanup_retain, [false]);
    assert!(f.core.view().sessions.is_empty());
    Ok(())
}
#[tokio::test]
async fn repository_replacement_after_connect_is_fenced_before_attach() -> TestResult {
    let f = Fixture::new();
    f.platform.state.lock().hold = Some("connect");
    let operation = f.start();
    f.platform.wait("connect").await;
    f.storage.hosts.lock()[0].host = "replacement.test".into();
    f.platform.release();
    assert!(matches!(
        operation.result().await,
        SessionConnectionOutcome::Failed {
            failure: SessionConnectionFailure {
                kind: SessionConnectionFailureKind::StaleProfile,
                ..
            }
        }
    ));
    assert!(!f.platform.state.lock().calls.contains(&"restore"));
    assert_eq!(f.platform.state.lock().cleanup_retain, [false]);
    Ok(())
}
#[tokio::test]
async fn stale_saved_profile_and_foreign_attempt_cannot_read_credentials() -> TestResult {
    let mut f = Fixture::new();
    f.request.host.host = "stale.test".into();
    assert!(matches!(
        f.start().result().await,
        SessionConnectionOutcome::Failed { .. }
    ));
    assert!(f.platform.state.lock().calls.is_empty());
    let foreign = AppCore::new();
    f.request.attempt = foreign.begin_connection(f.request.host.id.clone());
    assert_eq!(
        f.start().result().await,
        SessionConnectionOutcome::Cancelled
    );
    Ok(())
}
#[tokio::test]
async fn app_unmount_and_late_trust_approval_cannot_resume_connect() -> TestResult {
    let f = Fixture::new();
    {
        let mut state = f.platform.state.lock();
        state.hold = Some("confirm");
        state.trust = true;
        state.errors.push_back(challenge());
    }
    let operation = f.start();
    f.platform.wait("confirm").await;
    f.core.cancel_connections();
    f.platform.release();
    assert_eq!(
        operation.result().await,
        SessionConnectionOutcome::Cancelled
    );
    assert!(!f.platform.state.lock().calls.contains(&"trust"));
    assert_eq!(f.platform.state.lock().cleanup_retain, [false]);
    Ok(())
}

#[tokio::test]
async fn native_jump_chain_includes_key_protection_and_rejects_cycles_before_transport()
-> TestResult {
    let mut f = Fixture::new();
    let mut jump = f.request.host.clone();
    jump.id = uuid::Uuid::new_v4().to_string();
    jump.auth_mode = HostAuthMode::Key;
    f.request.host.jump_host_id = Some(jump.id.clone());
    f.request.protect_keys = true;
    *f.storage.hosts.lock() = vec![f.request.host.clone(), jump.clone()];
    f.platform.state.lock().biometric = true;
    assert_eq!(f.start().result().await, SessionConnectionOutcome::Ready);
    assert_eq!(
        f.platform.state.lock().loaded_ids,
        [f.request.host.id.clone(), jump.id.clone()]
    );
    assert!(f.platform.state.lock().calls.contains(&"biometric"));
    jump.jump_host_id = Some(f.request.host.id.clone());
    *f.storage.hosts.lock() = vec![f.request.host.clone(), jump];
    assert!(matches!(
        f.start().result().await,
        SessionConnectionOutcome::Failed { .. }
    ));
    Ok(())
}

#[tokio::test]
async fn interactive_save_calls_credential_transactions_before_connecting() -> TestResult {
    let mut f = Fixture::new();
    f.request.saved = false;
    f.request.persist_profile = true;
    f.request.credential = Some(crate::CredentialMaterial {
        secret: "PRIVATE-MATERIAL".into(),
        ..Default::default()
    });
    f.request.host.host = "edited.test".into();
    assert_eq!(f.start().result().await, SessionConnectionOutcome::Ready);
    assert_eq!(f.storage.hosts.lock()[0].host, "edited.test");
    assert!(!f.platform.state.lock().calls.contains(&"credential"));
    assert!(
        f.storage
            .other
            .lock()
            .values()
            .all(|value| !value.contains("PRIVATE-MATERIAL"))
    );
    Ok(())
}

#[tokio::test]
async fn startup_attempt_and_prior_biometrics_are_reused_without_new_admission() -> TestResult {
    let mut f = Fixture::new();
    f.request.host.auth_mode = HostAuthMode::Key;
    f.storage.hosts.lock()[0].auth_mode = HostAuthMode::Key;
    f.request.protect_keys = true;
    f.request.biometric_verified = true;
    f.request.attempt = f.core.begin_connection(f.request.host.id.clone());
    assert_eq!(f.start().result().await, SessionConnectionOutcome::Ready);
    assert!(!f.platform.state.lock().calls.contains(&"biometric"));
    assert!(!f.core.connection_pending(f.request.host.id.clone()));
    Ok(())
}

#[tokio::test]
async fn herdr_mode_restores_its_rail_without_a_plain_ssh_fallback() -> TestResult {
    let mut f = Fixture::new();
    f.request.host.herdr_enabled = true;
    f.storage.hosts.lock()[0].herdr_enabled = true;
    assert_eq!(f.start().result().await, SessionConnectionOutcome::Ready);
    assert!(f.core.view().sessions[0].terminal_rail.terminals.is_empty());
    Ok(())
}

#[tokio::test]
async fn signal_cancel_allows_a_new_attempt_but_keeps_the_physical_lane_until_cleanup() -> TestResult
{
    let f = Fixture::new();
    f.platform.state.lock().hold = Some("connect");
    let first = f.start();
    f.platform.wait("connect").await;
    first.cancel();
    assert!(!f.core.connection_pending(f.request.host.id.clone()));
    let second = f.start();
    f.platform.release();
    assert_eq!(first.result().await, SessionConnectionOutcome::Cancelled);
    assert_eq!(second.result().await, SessionConnectionOutcome::Ready);
    assert_eq!(f.core.view().sessions.len(), 1);
    Ok(())
}

#[tokio::test]
async fn cleanup_failure_is_a_distinct_recoverable_result() -> TestResult {
    let f = Fixture::new();
    {
        let mut state = f.platform.state.lock();
        state.errors.push_back(challenge());
        state.cleanup_error = true;
    }
    assert!(matches!(
        f.start().result().await,
        SessionConnectionOutcome::CleanupFailed {
            failure: SessionConnectionFailure {
                phase: SessionConnectionPhase::Cleanup,
                ..
            }
        }
    ));
    assert!(!f.core.connection_pending(f.request.host.id.clone()));
    Ok(())
}

#[tokio::test]
async fn dropping_an_unobserved_operation_revokes_its_lease_and_drains_cleanup() -> TestResult {
    let f = Fixture::new();
    f.platform.state.lock().hold = Some("connect");
    let operation = f.start();
    f.platform.wait("connect").await;
    drop(operation);
    assert!(!f.core.connection_pending(f.request.host.id.clone()));
    f.platform.release();
    f.platform.wait("cleanup").await;
    assert!(f.core.view().sessions.is_empty());
    Ok(())
}

#[tokio::test]
async fn existing_runtime_selection_is_fenced_by_the_committed_target() -> TestResult {
    let mut f = Fixture::new();
    assert_eq!(f.start().result().await, SessionConnectionOutcome::Ready);
    f.platform.state.lock().calls.clear();
    f.request.existing_host = Some(f.request.host.clone());
    f.core
        .open_session(f.request.host.id.clone(), f.request.host.id.clone(), true);
    assert_eq!(f.start().result().await, SessionConnectionOutcome::Selected);
    assert!(f.platform.state.lock().calls.is_empty());
    f.storage.hosts.lock()[0].host = "replacement.test".into();
    assert!(matches!(
        f.start().result().await,
        SessionConnectionOutcome::Failed { .. }
    ));
    assert!(f.platform.state.lock().calls.is_empty());
    Ok(())
}

#[tokio::test]
async fn bridge_detachment_revokes_a_late_transport_result() -> TestResult {
    let f = Fixture::new();
    f.platform.state.lock().hold = Some("connect");
    let operation = f.start();
    f.platform.wait("connect").await;
    f.credentials.close();
    f.platform.release();
    assert_eq!(
        operation.result().await,
        SessionConnectionOutcome::Cancelled
    );
    assert!(f.core.view().sessions.is_empty());
    assert_eq!(f.platform.state.lock().cleanup_retain, [false]);
    Ok(())
}

#[tokio::test]
async fn mode_replacement_releases_the_previous_binding_before_loading_credentials() -> TestResult {
    let mut f = Fixture::new();
    assert_eq!(f.start().result().await, SessionConnectionOutcome::Ready);
    f.request.existing_host = Some(f.request.host.clone());
    f.request.host.herdr_enabled = true;
    f.storage.hosts.lock()[0].herdr_enabled = true;
    {
        let mut state = f.platform.state.lock();
        state.calls.clear();
        state.hold = Some("credential");
    }
    let operation = f.start();
    f.platform.wait("credential").await;
    assert!(!f.core.has_connection_runtime(&f.request.host.id));
    assert_eq!(f.platform.state.lock().cleanup_retain, [false]);
    f.platform.release();
    assert_eq!(operation.result().await, SessionConnectionOutcome::Ready);
    assert!(f.core.has_connection_runtime(&f.request.host.id));
    Ok(())
}

#[tokio::test]
async fn abort_after_a_successful_result_cannot_tear_down_the_completed_connection() -> TestResult {
    let f = Fixture::new();
    let operation = f.start();
    assert_eq!(operation.result().await, SessionConnectionOutcome::Ready);
    operation.cancel();
    assert!(f.core.has_connection_runtime(&f.request.host.id));
    assert!(f.platform.state.lock().cleanup_retain.is_empty());
    Ok(())
}

#[tokio::test]
async fn cancel_during_retained_transport_cleanup_must_still_disconnect_the_transport() -> TestResult
{
    let f = Fixture::new();
    {
        let mut state = f.platform.state.lock();
        state.restore_error = true;
        state.hold = Some("cleanup");
    }
    let operation = f.start();
    f.platform.wait("cleanup").await;
    let runtime = f
        .platform
        .state
        .lock()
        .runtime
        .clone()
        .expect("connected transport");
    operation.cancel();
    f.platform.release();
    assert_eq!(
        operation.result().await,
        SessionConnectionOutcome::Cancelled
    );
    assert_eq!(f.platform.state.lock().cleanup_retain, [true, false]);
    assert_eq!(
        runtime.status().state,
        crate::HostConnectionState::Disconnected
    );
    assert!(f.core.view().sessions.is_empty());
    Ok(())
}
