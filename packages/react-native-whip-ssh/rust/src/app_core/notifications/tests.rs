//! Real lifecycle tests with fault-injected platform effects and host commands.
#![allow(
    clippy::unwrap_used,
    reason = "Test setup and assertions stop immediately on failure"
)]

use super::*;
use parking_lot::Mutex as SyncMutex;
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};
use whip_notify::{Header, NotificationEvent};

fn run(work: impl Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(work);
}

#[derive(Default)]
struct Platform {
    vault: SyncMutex<Option<String>>,
    data: SyncMutex<HashMap<String, String>>,
    effects: SyncMutex<Vec<String>>,
    relay_results: SyncMutex<VecDeque<Result<NotificationRelayResponse>>>,
    fail_vault: AtomicBool,
    fail_data: AtomicBool,
    fail_proof: AtomicBool,
    pending_proof: AtomicBool,
    cancelled: Arc<AtomicUsize>,
    token: SyncMutex<String>,
    load_delay: SyncMutex<Option<Duration>>,
    progress: SyncMutex<Vec<NotificationPluginInstallProgress>>,
}
#[async_trait::async_trait]
impl NotificationPlatform for Platform {
    async fn read_registrations(&self) -> Result<Option<String>> {
        let delay = self.load_delay.lock().take();
        if let Some(delay) = delay {
            tokio::time::sleep(delay).await;
        }
        Ok(self.vault.lock().clone())
    }
    async fn write_registrations(&self, value: String) -> Result<()> {
        if self.fail_vault.swap(false, Ordering::SeqCst) {
            return Err(failure("vault locked"));
        }
        self.effects.lock().push("vault".into());
        *self.vault.lock() = Some(value);
        Ok(())
    }
    async fn read_data(&self, key: String) -> Result<Option<String>> {
        Ok(self.data.lock().get(&key).cloned())
    }
    async fn write_data(&self, key: String, value: Option<String>) -> Result<()> {
        if self.fail_data.swap(false, Ordering::SeqCst) {
            return Err(failure("storage unavailable"));
        }
        self.effects.lock().push(format!("data:{key}"));
        match value {
            Some(value) => {
                self.data.lock().insert(key, value);
            }
            None => {
                self.data.lock().remove(&key);
            }
        }
        Ok(())
    }
    async fn push_token(&self) -> Result<String> {
        Ok(self.token.lock().clone())
    }
    async fn begin_verification(&self, _: String) -> Result<()> {
        self.effects.lock().push("listen".into());
        Ok(())
    }
    async fn verification_proof(&self, _: String) -> Result<String> {
        if self.pending_proof.load(Ordering::SeqCst) {
            return futures::future::pending().await;
        }
        if self.fail_proof.load(Ordering::SeqCst) {
            Err(failure("proof failed"))
        } else {
            Ok("c".repeat(43))
        }
    }
    fn cancel_verification(&self, _: String) {
        self.cancelled.fetch_add(1, Ordering::SeqCst);
    }
    async fn relay_request(
        &self,
        request: NotificationRelayRequest,
    ) -> Result<NotificationRelayResponse> {
        self.effects.lock().push(format!(
            "relay:{:?}:{}",
            request.method,
            request.body.as_deref().unwrap_or_default()
        ));
        self.relay_results.lock().pop_front().unwrap_or_else(|| {
            Ok(NotificationRelayResponse {
                status: if matches!(request.method, NotificationRelayMethod::Put) {
                    202
                } else {
                    200
                },
                code: None,
            })
        })
    }
    fn changed(&self) {}
    fn install_progress(&self, _: String, progress: NotificationPluginInstallProgress) {
        self.progress.lock().push(progress);
    }
}

struct FakeHost {
    platform: Arc<Platform>,
    key: whip_notify::KeyPair,
    commands: SyncMutex<Vec<(String, Value)>>,
    fail: SyncMutex<Option<String>>,
    previews: AtomicBool,
    installation_done: AtomicBool,
    session: SyncMutex<String>,
    delay: SyncMutex<Option<(String, Duration)>>,
    incarnation: u64,
}
impl FakeHost {
    fn new(platform: Arc<Platform>, incarnation: u64) -> Arc<Self> {
        Arc::new(Self {
            platform,
            key: whip_notify::generate_key().unwrap(),
            commands: SyncMutex::new(Vec::new()),
            fail: SyncMutex::new(None),
            previews: AtomicBool::new(true),
            installation_done: AtomicBool::new(false),
            session: SyncMutex::new("/session.sock".into()),
            delay: SyncMutex::new(None),
            incarnation,
        })
    }
    fn fail_next(&self, operation: &str) {
        *self.fail.lock() = Some(operation.into());
    }
}
#[async_trait::async_trait]
impl NotificationHost for FakeHost {
    fn identity(&self) -> (String, u64) {
        ("host".into(), self.incarnation)
    }
    async fn command(&self, operation: &str, payload: Value) -> Result<Value> {
        self.commands
            .lock()
            .push((operation.into(), payload.clone()));
        self.platform
            .effects
            .lock()
            .push(format!("host:{operation}"));
        let delay = self.delay.lock().take();
        if let Some((expected, delay)) = delay {
            assert_eq!(operation, expected);
            tokio::time::sleep(delay).await;
        }
        if self.fail.lock().as_deref() == Some(operation) {
            *self.fail.lock() = None;
            return Err(failure("ambiguous SSH response"));
        }
        if operation == "plugin-install" {
            self.installation_done.store(true, Ordering::SeqCst);
        }
        match operation {
            "discover" => Ok(
                json!({"paths": {"config": "/config", "state": "/state", "binary": "/notify", "notification_previews": self.previews.load(Ordering::SeqCst)},
                "identity": {"public_key": self.key.public_key, "host_id": whip_notify::key_id(&self.key.public_key)}, "session": *self.session.lock()}),
            ),
            "plugin-install-progress" => Ok(
                json!({"stage": if self.installation_done.load(Ordering::SeqCst) { "complete" } else { "downloading" }, "completed_stages": ["checking-host"], "elapsed_ms": 500,
                "timeout_ms": 180_000, "running": !self.installation_done.load(Ordering::SeqCst), "error": null}),
            ),
            _ => Ok(Value::Null),
        }
    }
}

struct Fixture {
    manager: Arc<Manager>,
    platform: Arc<Platform>,
    host: Arc<FakeHost>,
}
impl Fixture {
    fn new() -> Self {
        let platform = Arc::new(Platform::default());
        let host = FakeHost::new(platform.clone(), 1);
        let manager = NotificationManager::new(platform.clone())
            .unwrap()
            .inner
            .clone();
        manager.hosts.write().insert("host".into(), host.clone());
        Self {
            manager,
            platform,
            host,
        }
    }
    async fn enable(&self, encrypted: bool) {
        self.manager
            .enable(
                "host".into(),
                "https://notify.example".into(),
                Some(encrypted),
            )
            .await
            .unwrap();
    }
    fn restart(&mut self) {
        self.manager = NotificationManager::new(self.platform.clone())
            .unwrap()
            .inner
            .clone();
        self.manager
            .hosts
            .write()
            .insert("host".into(), self.host.clone());
    }
    async fn registration(&self) -> Registration {
        self.manager.load().await.unwrap().remove(0)
    }
    async fn envelope(&self, session: &str) -> Value {
        let registration = self.registration().await;
        let header = Header {
            version: 1,
            host_id: whip_notify::key_id(&self.host.key.public_key),
            device_id: registration.device_id,
            key_id: registration.keys.key_id,
            event_id: crate::notification_crypto::notification_token_generate(),
            issued_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        };
        let event = NotificationEvent {
            pane_id: "w1:p1".into(),
            workspace_id: "w1".into(),
            session: session.into(),
            status: "blocked".into(),
            title: None,
        };
        json!({"whip_notify": whip_notify::encrypt(&self.host.key, &registration.keys.public_key, header, &event).unwrap(), "hostId": "forged", "paneId": "forged"})
    }
}

#[test]
fn enrollment_commits_capabilities_before_remote_effects_and_uses_public_material_only() {
    run(async {
        let f = Fixture::new();
        f.enable(false).await;
        let effects = f.platform.effects.lock().clone();
        let vault = effects.iter().position(|s| s == "vault").unwrap();
        let listen = effects.iter().position(|s| s == "listen").unwrap();
        let put = effects
            .iter()
            .position(|s| s.starts_with("relay:Put"))
            .unwrap();
        let post = effects
            .iter()
            .position(|s| s.starts_with("relay:Post"))
            .unwrap();
        let register = effects.iter().position(|s| s == "host:register").unwrap();
        assert!(vault < listen && listen < put && put < post && post < register);
        let registration = f.registration().await;
        assert!(registration.enabled);
        assert!(!format!("{:?}", f.host.commands.lock()).contains(&registration.keys.private_key));
        assert!(!effects.join(" ").contains(&registration.keys.private_key));
        assert_eq!(f.platform.cancelled.load(Ordering::SeqCst), 1);
        assert!(!f.manager.states().await.unwrap()[0].end_to_end_encrypted);
    });
}

#[test]
fn persistence_failures_prevent_creating_remote_routes() {
    run(async {
        for vault in [false, true] {
            let f = Fixture::new();
            if vault {
                f.platform.fail_vault.store(true, Ordering::SeqCst);
            } else {
                f.platform.fail_data.store(true, Ordering::SeqCst);
            }
            assert!(
                f.manager
                    .enable("host".into(), "https://notify.example".into(), None)
                    .await
                    .is_err()
            );
            assert!(
                !f.platform
                    .effects
                    .lock()
                    .iter()
                    .any(|s| s.starts_with("relay:"))
            );
            assert!(f.manager.states().await.unwrap().is_empty());
        }
    });
}

#[test]
fn legacy_encryption_and_per_host_preferences_survive_restart() {
    run(async {
        let mut f = Fixture::new();
        assert!(!f.manager.encryption("host", None).await.unwrap());
        f.manager.set_encryption("host".into(), true).await.unwrap();
        f.restart();
        assert!(f.manager.encryption("host", None).await.unwrap());
        assert!(!f.manager.encryption("other", None).await.unwrap());
        f.manager
            .enable("host".into(), "https://notify.example".into(), None)
            .await
            .unwrap();
        let mut legacy: Value =
            serde_json::from_str(f.platform.vault.lock().as_ref().unwrap()).unwrap();
        legacy[0]
            .as_object_mut()
            .unwrap()
            .remove("endToEndEncrypted");
        *f.platform.vault.lock() = Some(legacy.to_string());
        f.restart();
        assert!(f.registration().await.end_to_end_encrypted);
    });
}

#[test]
fn ambiguous_encryption_updates_never_claim_encryption_after_disclosure_may_start() {
    run(async {
        let mut f = Fixture::new();
        f.enable(true).await;
        f.host.fail_next("register");
        assert!(
            f.manager
                .set_encryption("host".into(), false)
                .await
                .is_err()
        );
        assert!(!f.registration().await.end_to_end_encrypted);
        f.restart();
        assert!(!f.registration().await.end_to_end_encrypted);
        f.host.fail_next("register");
        assert!(f.manager.set_encryption("host".into(), true).await.is_err());
        assert!(!f.registration().await.end_to_end_encrypted);
        f.platform.fail_vault.store(true, Ordering::SeqCst);
        f.host.commands.lock().clear();
        assert!(
            f.manager
                .set_encryption("host".into(), false)
                .await
                .is_err()
        );
        assert!(
            !f.host
                .commands
                .lock()
                .iter()
                .any(|(op, _)| op == "register")
        );
    });
}

#[test]
fn encryption_rechecks_host_identity_session_and_preview_capability() {
    run(async {
        let f = Fixture::new();
        f.enable(true).await;
        *f.host.session.lock() = "/replacement.sock".into();
        assert!(
            f.manager
                .set_encryption("host".into(), false)
                .await
                .unwrap_err()
                .to_string()
                .contains("changed")
        );
        assert!(f.registration().await.end_to_end_encrypted);
        *f.host.session.lock() = "/session.sock".into();
        f.host.previews.store(false, Ordering::SeqCst);
        assert!(
            f.manager
                .set_encryption("host".into(), false)
                .await
                .unwrap_err()
                .to_string()
                .contains("Update whip-notify")
        );
        assert!(f.registration().await.end_to_end_encrypted);
    });
}

#[test]
fn offline_revocation_stops_acceptance_and_retains_retry_capabilities() {
    run(async {
        let f = Fixture::new();
        f.enable(false).await;
        let payload = f.envelope("/session.sock").await;
        f.platform
            .relay_results
            .lock()
            .push_back(Err(failure("relay offline")));
        assert!(f.manager.disable("host", true).await.is_err());
        let disabled = f.registration().await;
        assert!(!disabled.enabled && disabled.pending_host_removal && !disabled.relay_revoked);
        assert!(!disabled.keys.private_key.is_empty());
        f.host.commands.lock().clear();
        f.manager.renew(tokio::time::Instant::now()).await.unwrap();
        assert!(f.host.commands.lock().is_empty());
        assert!(
            f.manager
                .target(payload.to_string(), "tap".into())
                .await
                .is_err()
        );
        assert!(
            f.manager
                .enable("host".into(), "https://notify.example".into(), None)
                .await
                .is_err()
        );
        assert!(f.manager.set_encryption("host".into(), true).await.is_err());
        f.manager.disable("host", true).await.unwrap();
        assert!(f.manager.states().await.unwrap().is_empty());
    });
}

#[test]
fn disconnected_host_cleanup_tombstone_survives_restart_and_preserves_other_hosts() {
    run(async {
        let mut f = Fixture::new();
        f.enable(true).await;
        f.manager
            .hosts
            .write()
            .insert("other".into(), f.host.clone());
        f.manager
            .enable("other".into(), "https://notify.example".into(), Some(true))
            .await
            .unwrap();
        f.manager.hosts.write().remove("host");
        f.manager.disable("host", true).await.unwrap();
        let disabled = f.registration().await;
        assert!(
            disabled.relay_revoked
                && disabled.pending_host_removal
                && disabled.keys.private_key.is_empty()
        );
        f.restart();
        f.manager
            .cleanup_host("host".into(), f.host.clone())
            .await
            .unwrap();
        let states = f.manager.states().await.unwrap();
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].host_id, "other");
        assert!(states[0].enabled);
    });
}

#[test]
fn failed_proof_revokes_pending_route_and_allows_rotation_only_after_confirmed_cleanup() {
    run(async {
        let f = Fixture::new();
        f.platform.fail_proof.store(true, Ordering::SeqCst);
        assert!(
            f.manager
                .enable("host".into(), "https://notify.example".into(), None)
                .await
                .is_err()
        );
        assert!(f.registration().await.relay_revoked);
        assert_eq!(f.platform.cancelled.load(Ordering::SeqCst), 1);
        f.platform.fail_proof.store(false, Ordering::SeqCst);
        f.enable(false).await;
        let f = Fixture::new();
        f.platform.relay_results.lock().extend([
            Err(failure("registration offline")),
            Err(failure("cleanup offline")),
        ]);
        assert!(
            f.manager
                .enable("host".into(), "https://notify.example".into(), None)
                .await
                .is_err()
        );
        assert!(!f.registration().await.relay_revoked);
        assert!(
            f.manager
                .enable("host".into(), "https://notify.example".into(), None)
                .await
                .is_err()
        );
    });
}

#[test]
fn token_refresh_verifies_new_token_without_replacing_host_registration() {
    run(async {
        let f = Fixture::new();
        f.enable(false).await;
        *f.platform.token.lock() = "ExpoPushToken[rotated]".into();
        f.platform.effects.lock().clear();
        f.host.commands.lock().clear();
        let facade = NotificationManager::from_inner(f.manager.clone()).unwrap();
        facade.refresh_push_token().unwrap().wait().await.unwrap();
        assert!(
            f.platform
                .effects
                .lock()
                .iter()
                .any(|s| s.contains("ExpoPushToken[rotated]"))
        );
        assert!(
            f.platform
                .effects
                .lock()
                .iter()
                .any(|s| s.starts_with("relay:Post"))
        );
        assert!(f.host.commands.lock().is_empty());
        assert!(f.registration().await.enabled);
    });
}

#[test]
fn uninstall_preserves_cleanup_on_relay_failure_and_stops_on_vault_failure() {
    run(async {
        for vault in [false, true] {
            let f = Fixture::new();
            f.enable(false).await;
            f.host.commands.lock().clear();
            if vault {
                f.platform.fail_vault.store(true, Ordering::SeqCst);
            } else {
                f.platform
                    .relay_results
                    .lock()
                    .push_back(Err(failure("relay offline")));
            }
            let facade = NotificationManager::from_inner(f.manager.clone()).unwrap();
            assert!(
                facade
                    .uninstall_plugin("host".into())
                    .unwrap()
                    .wait()
                    .await
                    .is_err()
            );
            assert_eq!(
                f.host
                    .commands
                    .lock()
                    .iter()
                    .any(|(op, _)| op == "plugin-uninstall"),
                !vault
            );
            assert_eq!(f.registration().await.enabled, vault);
        }
    });
}

#[test]
fn authenticated_cold_launch_commits_replay_before_returning_target() {
    run(async {
        let mut f = Fixture::new();
        f.enable(false).await;
        let payload = f.envelope("/session.sock").await;
        f.restart();
        f.manager.hosts.write().clear();
        let target = f
            .manager
            .target(payload.to_string(), "tap".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target.host_id, "host");
        assert_eq!(target.pane_id, "w1:p1");
        assert!(
            f.platform
                .data
                .lock()
                .keys()
                .any(|key| key.starts_with(REPLAYS))
        );
        f.restart();
        assert!(
            f.manager
                .target(payload.to_string(), "replay".into())
                .await
                .is_err()
        );
    });
}

#[test]
fn replay_write_failure_tampering_and_wrong_session_never_return_navigation() {
    run(async {
        let f = Fixture::new();
        f.enable(true).await;
        let payload = f.envelope("/session.sock").await;
        f.platform.fail_data.store(true, Ordering::SeqCst);
        assert!(
            f.manager
                .target(payload.to_string(), "failed receipt".into())
                .await
                .is_err()
        );
        assert!(
            f.manager
                .target(payload.to_string(), "retry".into())
                .await
                .unwrap()
                .is_some()
        );
        let wrong_session = f.envelope("/wrong.sock").await;
        assert!(
            f.manager
                .target(wrong_session.to_string(), "wrong session".into())
                .await
                .is_err()
        );
        let mut tampered = f.envelope("/session.sock").await;
        tampered["whip_notify"]["ciphertext"] = "forged".into();
        assert!(
            f.manager
                .target(tampered.to_string(), "forged".into())
                .await
                .is_err()
        );
        assert!(
            f.manager
                .target(json!({"hostId": "forged"}).to_string(), "plaintext".into())
                .await
                .unwrap()
                .is_none()
        );
    });
}

#[test]
fn leases_require_a_new_live_pulse_and_skip_busy_operations() {
    run(async {
        tokio::time::pause();
        let f = Fixture::new();
        f.enable(true).await;
        f.host.commands.lock().clear();
        tokio::time::advance(Duration::from_secs(30)).await;
        assert!(f.host.commands.lock().is_empty());
        let busy = f.manager.operations.lock().await;
        f.manager.renew(tokio::time::Instant::now()).await.unwrap();
        assert!(f.host.commands.lock().is_empty());
        drop(busy);
        f.manager.renew(tokio::time::Instant::now()).await.unwrap();
        assert_eq!(
            f.host
                .commands
                .lock()
                .iter()
                .filter(|(op, _)| op == "renew")
                .count(),
            1
        );
        f.restart_cache_for_slow_load();
        *f.platform.load_delay.lock() = Some(Duration::from_secs(4));
        f.manager.renew(tokio::time::Instant::now()).await.unwrap();
        assert_eq!(
            f.host
                .commands
                .lock()
                .iter()
                .filter(|(op, _)| op == "renew")
                .count(),
            1
        );
    });
}

impl Fixture {
    fn restart_cache_for_slow_load(&self) {
        *self.manager.registrations.try_lock().unwrap() = None;
    }
}

#[test]
fn stale_runtime_detach_and_verification_cannot_target_a_replacement() {
    run(async {
        let f = Fixture::new();
        f.enable(true).await;
        let replacement = FakeHost::new(f.platform.clone(), 2);
        f.manager
            .hosts
            .write()
            .insert("host".into(), replacement.clone());
        let facade = NotificationManager::from_inner(f.manager.clone()).unwrap();
        facade.detach_runtime("host".into(), "host".into(), 1);
        assert!(f.manager.states().await.unwrap()[0].connected);
        let device_id = f.registration().await.device_id;
        assert!(
            facade
                .verify_host("host".into(), device_id.clone(), "host".into(), 1)
                .unwrap()
                .wait()
                .await
                .is_err()
        );
        assert!(
            facade
                .verify_host("host".into(), device_id, "host".into(), 2)
                .unwrap()
                .wait()
                .await
                .unwrap_err()
                .to_string()
                .contains("changed")
        );
    });
}

#[test]
fn relay_errors_keep_stage_and_known_guidance_without_provider_details() {
    run(async {
        for status in [403, 410, 426, 429, 503] {
            let f = Fixture::new();
            f.platform
                .relay_results
                .lock()
                .push_back(Ok(NotificationRelayResponse { status, code: None }));
            let error = f
                .manager
                .enable("host".into(), "https://notify.example".into(), None)
                .await
                .unwrap_err()
                .to_string();
            assert!(error.contains(&format!("registration failed (HTTP {status})")));
            assert!(error.contains(relay_failure_reason(status)));
            assert!(f.registration().await.relay_revoked);
        }
    });
}

#[test]
fn invalid_or_corrupt_persistence_is_preserved_and_unsafe_origins_are_rejected() {
    run(async {
        let f = Fixture::new();
        *f.platform.vault.lock() = Some("invalid".into());
        assert!(f.manager.states().await.is_err());
        assert_eq!(f.platform.vault.lock().as_deref(), Some("invalid"));
        for origin in [
            "http://notify.example",
            "https://user:password@notify.example",
            "https://notify.example/path",
            "https://notify.example/?query=1",
        ] {
            assert!(relay_origin(origin).is_err());
        }
    });
}

#[test]
fn native_verification_deadline_cancels_the_listener_and_revokes_the_pending_route() {
    run(async {
        tokio::time::pause();
        let f = Fixture::new();
        f.platform.pending_proof.store(true, Ordering::SeqCst);
        let error = f
            .manager
            .enable("host".into(), "https://notify.example".into(), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert_eq!(f.platform.cancelled.load(Ordering::SeqCst), 1);
        assert!(f.registration().await.relay_revoked);
        assert!(
            !f.host
                .commands
                .lock()
                .iter()
                .any(|(op, _)| op == "register")
        );
    });
}

#[test]
fn native_admission_preserves_call_order_independent_of_completion_poll_order() {
    run(async {
        let f = Fixture::new();
        let facade = NotificationManager::from_inner(f.manager.clone()).unwrap();
        let enable = facade
            .enable("host".into(), "https://notify.example".into(), Some(false))
            .unwrap();
        let encryption = facade.set_encryption("host".into(), true).unwrap();
        let disable = facade.disable("host".into(), false).unwrap();
        // Await in reverse order: admission order must still win.
        disable.wait().await.unwrap();
        encryption.wait().await.unwrap();
        enable.wait().await.unwrap();
        assert!(!f.registration().await.enabled);
        let registrations: Vec<_> = f
            .host
            .commands
            .lock()
            .iter()
            .filter(|(operation, _)| operation == "register")
            .cloned()
            .collect();
        assert_eq!(registrations.len(), 2);
        assert_eq!(
            registrations[0].1["registration"]["end_to_end_encrypted"],
            false
        );
        assert_eq!(
            registrations[1].1["registration"]["end_to_end_encrypted"],
            true
        );
    });
}

#[test]
fn failed_operation_does_not_poison_the_native_queue() {
    run(async {
        let f = Fixture::new();
        let facade = NotificationManager::from_inner(f.manager.clone()).unwrap();
        let rejected = facade
            .enable("host".into(), "http://invalid.example".into(), None)
            .unwrap();
        let preference = facade.set_encryption("host".into(), true).unwrap();
        preference.wait().await.unwrap();
        assert!(rejected.wait().await.is_err());
        assert!(f.manager.encryption("host", None).await.unwrap());
    });
}

#[test]
fn native_installation_progress_stops_when_installation_finishes() {
    run(async {
        tokio::time::pause();
        let f = Fixture::new();
        *f.host.delay.lock() = Some(("plugin-install".into(), Duration::from_millis(1200)));
        f.manager.install("host".into()).await.unwrap();
        let count = f.platform.progress.lock().len();
        assert!(count >= 2);
        assert!(f.platform.progress.lock()[0].running);
        assert!(!f.platform.progress.lock().last().unwrap().running);
        tokio::time::advance(Duration::from_secs(10)).await;
        assert_eq!(f.platform.progress.lock().len(), count);
    });
}

#[test]
fn installation_errors_preserve_detail_and_never_retry_implicitly() {
    run(async {
        let f = Fixture::new();
        f.host.fail_next("plugin-install");
        let error = f.manager.install("host".into()).await.unwrap_err();
        assert_eq!(error.to_string(), "ambiguous SSH response");
        assert_eq!(
            f.host
                .commands
                .lock()
                .iter()
                .filter(|(operation, _)| operation == "plugin-install")
                .count(),
            1
        );
    });
}
