use std::error::Error;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::{
    HostActionContext, HostActionCoordinator, HostActionCredential, HostActionPermit,
    HostActionPlatform, HostActionPlatformError, HostActionProfilePatch,
};
use crate::host_profiles::{HostAuthMode, HostProfileRecord};
use crate::reverse_control::ReverseControl;

pub(crate) fn host(id: &str) -> HostProfileRecord {
    HostProfileRecord {
        id: id.to_owned(),
        name: id.to_owned(),
        host: format!("{id}.test"),
        port: "22".to_owned(),
        username: "user".to_owned(),
        auth_mode: HostAuthMode::Key,
        jump_host_id: None,
        forward_agent: false,
        tailcat_enabled: false,
        tailcat_ssh_server: false,
        herdr_enabled: true,
        herdr_command: "herdr".to_owned(),
        herdr_socket_path: String::new(),
        session_name: String::new(),
        agent_instructions: "# Host instructions".to_owned(),
        created_at: String::new(),
        updated_at: String::new(),
        last_connected_at: None,
    }
}

pub(crate) fn context() -> HostActionContext {
    HostActionContext {
        ready: true,
        locked: false,
        biometric_for_keys: true,
        global_instructions: "# Global instructions".to_owned(),
        hosts: vec![host("host"), host("mini")],
        connections: Vec::new(),
    }
}

pub(crate) struct Platform {
    calls: Mutex<Vec<String>>,
    permits: Mutex<Vec<Arc<HostActionPermit>>>,
    pause: Mutex<Option<&'static str>>,
    resume: Notify,
    fail: Mutex<Option<&'static str>>,
    authenticated: AtomicBool,
    missing_credential: AtomicBool,
    cancellations: Mutex<Vec<String>>,
}

impl Default for Platform {
    fn default() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            permits: Mutex::new(Vec::new()),
            pause: Mutex::new(None),
            resume: Notify::new(),
            fail: Mutex::new(None),
            authenticated: AtomicBool::new(true),
            missing_credential: AtomicBool::new(false),
            cancellations: Mutex::new(Vec::new()),
        }
    }
}

impl Platform {
    async fn step(
        &self,
        permit: Arc<HostActionPermit>,
        stage: &'static str,
    ) -> Result<(), HostActionPlatformError> {
        permit
            .check_active()
            .map_err(|_| HostActionPlatformError::Unavailable)?;
        self.calls.lock().push(stage.to_owned());
        self.permits.lock().push(permit);
        let paused = *self.pause.lock() == Some(stage);
        if paused {
            self.resume.notified().await;
        }
        if *self.fail.lock() == Some(stage) {
            return Err(HostActionPlatformError::Unavailable);
        }
        Ok(())
    }

    async fn wait_for(&self, stage: &str) -> Result<(), Box<dyn Error>> {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !self.calls.lock().iter().any(|call| call == stage) {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        Ok(())
    }
}

#[async_trait::async_trait]
impl HostActionPlatform for Platform {
    async fn authenticate(
        &self,
        permit: Arc<HostActionPermit>,
    ) -> Result<bool, HostActionPlatformError> {
        self.step(permit, "authenticate").await?;
        Ok(self.authenticated.load(Ordering::Acquire))
    }
    async fn save_metadata(
        &self,
        permit: Arc<HostActionPermit>,
        host_id: String,
        _patch: HostActionProfilePatch,
        _source: Option<String>,
    ) -> Result<HostProfileRecord, HostActionPlatformError> {
        self.step(permit, "save_metadata").await?;
        Ok(host(&host_id))
    }
    async fn read_credential(
        &self,
        permit: Arc<HostActionPermit>,
        _host: HostProfileRecord,
    ) -> Result<HostActionCredential, HostActionPlatformError> {
        self.step(permit, "read_credential").await?;
        Ok(HostActionCredential {
            secret: if self.missing_credential.load(Ordering::Acquire) {
                String::new()
            } else {
                "private-test-secret".to_owned()
            },
            passphrase: String::new(),
            tailcat_address: None,
            tailcat_private_key: None,
            tailcat_public_key: None,
        })
    }
    async fn connect(
        &self,
        permit: Arc<HostActionPermit>,
        _host: HostProfileRecord,
        _credential: HostActionCredential,
    ) -> Result<bool, HostActionPlatformError> {
        self.step(permit, "connect").await?;
        Ok(true)
    }
    async fn delete_transcripts(
        &self,
        permit: Arc<HostActionPermit>,
        _host: String,
    ) -> Result<(), HostActionPlatformError> {
        self.step(permit, "delete_transcripts").await
    }
    async fn delete_snapshot(
        &self,
        permit: Arc<HostActionPermit>,
        _host: String,
    ) -> Result<(), HostActionPlatformError> {
        self.step(permit, "delete_snapshot").await
    }
    async fn delete_profile(
        &self,
        permit: Arc<HostActionPermit>,
        _host: String,
    ) -> Result<(), HostActionPlatformError> {
        self.step(permit, "delete_profile").await
    }
    async fn disconnect(
        &self,
        permit: Arc<HostActionPermit>,
        _host: String,
        record: bool,
    ) -> Result<(), HostActionPlatformError> {
        self.step(
            permit,
            if record {
                "disconnect"
            } else {
                "disconnect_deleted"
            },
        )
        .await
    }
    fn cancel(&self, operation_id: String) {
        self.cancellations.lock().push(operation_id);
    }
}

fn setup() -> (
    Arc<ReverseControl>,
    Arc<HostActionCoordinator>,
    Arc<Platform>,
) {
    let owner = Arc::new(ReverseControl::default());
    super::super::tests::insert(&owner, "a", "pane-a");
    super::super::tests::insert(&owner, "b", "pane-b");
    let platform = Arc::new(Platform::default());
    let coordinator = HostActionCoordinator::new(platform.clone());
    coordinator.update_context(context());
    (owner, coordinator, platform)
}

fn start(
    owner: &Arc<ReverseControl>,
    session: &str,
    action: &str,
    arguments: Value,
) -> Result<tokio::sync::oneshot::Receiver<Value>, Box<dyn Error>> {
    owner
        .start_action(
            session,
            json!(1),
            &json!({"params":{"name":action,"arguments":arguments}}),
        )
        .map_err(|value| value.to_string().into())
}

#[test]
fn all_host_tools_use_one_native_dispatcher_and_return_only_typed_metadata()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, _coordinator, platform) = setup();
        for (action, arguments) in [
            ("hosts.list", json!({})),
            ("hosts.instructions", json!({})),
            (
                "hosts.save",
                json!({"host_id":"mini","profile":{"name":"Build"}}),
            ),
            ("hosts.connect", json!({"host_id":"mini"})),
            ("hosts.disconnect", json!({"host_id":"mini"})),
            ("hosts.delete", json!({"host_id":"mini"})),
        ] {
            let result = start(&owner, "a", action, arguments)?.await?;
            assert_eq!(result["isError"], false, "{result}");
            assert_eq!(result["structuredContent"]["kind"], action);
            assert!(!result.to_string().contains("private-test-secret"));
        }
        assert_eq!(
            *platform.calls.lock(),
            [
                "save_metadata",
                "authenticate",
                "read_credential",
                "connect",
                "disconnect",
                "delete_transcripts",
                "delete_snapshot",
                "delete_profile",
                "disconnect_deleted"
            ]
        );
        assert!(owner.browser_sessions.lock().is_empty());
        assert!(owner.steps.lock().is_empty());
        Ok(())
    })
}

#[test]
fn lock_and_unavailable_state_deny_host_effects() -> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, coordinator, platform) = setup();
        for (locked, ready, code) in [
            (true, true, "permission_denied"),
            (false, false, "device_unavailable"),
        ] {
            coordinator.update_context(HostActionContext {
                ready,
                locked,
                ..context()
            });
            let result = start(&owner, "a", "hosts.connect", json!({"host_id":"mini"}))?.await?;
            assert_eq!(result["structuredContent"]["error"]["code"], code);
        }
        assert!(platform.calls.lock().is_empty());
        Ok(())
    })
}

#[test]
fn committed_credential_source_changes_fence_a_request_before_react_refreshes_context()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, coordinator, platform) = setup();
        let mut projected = context();
        projected.hosts.iter_mut().find(|host| host.id == "mini").ok_or("missing source")?.auth_mode = HostAuthMode::Password;
        coordinator.update_context(projected.clone());
        *platform.pause.lock() = Some("save_metadata");
        let saving = start(&owner, "a", "hosts.save", json!({
            "host_id":"new-host", "profile":{"host":"new.test","username":"user","authMode":"key"}, "credential_from_host_id":"mini"
        }))?;
        platform.wait_for("save_metadata").await?;
        let permit = platform.permits.lock().last().cloned().ok_or("missing permit")?;
        assert!(permit.check_active().is_ok());
        assert!(!platform.calls.lock().iter().any(|call| call == "authenticate"));
        // The committed repository now contains a private-key source. The old
        // renderer projection still describes a password source and cannot
        // authorize copying it without the required biometric decision.
        projected.hosts.iter_mut().find(|host| host.id == "mini").ok_or("missing source")?.auth_mode = HostAuthMode::Key;
        assert!(permit.check_repository_profiles(&projected.hosts).is_err());
        platform.resume.notify_one();
        saving.await?;
        owner.shutdown();
        coordinator.close();
        Ok(())
    })
}

#[test]
fn unrelated_app_updates_do_not_hide_a_confirmed_new_host() -> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, coordinator, platform) = setup();
        *platform.pause.lock() = Some("save_metadata");
        let saving = start(
            &owner,
            "a",
            "hosts.save",
            json!({"profile":{"host":"new.test","username":"user"}}),
        )?;
        platform.wait_for("save_metadata").await?;
        let mut updated = context();
        updated.connections.push(super::HostActionConnection {
            host_id: "other".to_owned(),
            status: crate::app_core::AppConnectionStatus::Ready,
        });
        coordinator.update_context(updated);
        platform.resume.notify_one();
        let saved = saving.await?;
        let id = saved["structuredContent"]["value"]["host"]["id"]
            .as_str()
            .ok_or("created host missing")?;
        assert_eq!(
            start(&owner, "a", "hosts.connect", json!({"host_id":id}))?.await?["isError"],
            false
        );
        Ok(())
    })
}

#[test]
fn late_save_results_do_not_replace_a_newer_projection_of_the_same_host()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, coordinator, platform) = setup();
        *platform.pause.lock() = Some("save_metadata");
        let saving = start(
            &owner,
            "a",
            "hosts.save",
            json!({"host_id":"mini","profile":{"name":"Agent edit"}}),
        )?;
        platform.wait_for("save_metadata").await?;
        let mut updated = context();
        updated.hosts[1].name = "Newer user edit".to_owned();
        updated.hosts[1].updated_at = "later".to_owned();
        coordinator.update_context(updated);
        platform.resume.notify_one();
        assert_eq!(saving.await?["isError"], false);
        let listed = start(&owner, "a", "hosts.list", json!({}))?.await?;
        let hosts = listed["structuredContent"]["value"]["hosts"]
            .as_array()
            .ok_or("hosts missing")?;
        assert!(
            hosts
                .iter()
                .any(|host| host["id"] == "mini" && host["name"] == "Newer user edit")
        );
        Ok(())
    })
}

#[test]
fn confirmed_mutations_are_visible_to_the_next_request_without_a_react_render()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, _coordinator, _platform) = setup();
        let created = start(
            &owner,
            "a",
            "hosts.save",
            json!({"profile":{"host":"new.test","username":"user"}}),
        )?
        .await?;
        let id = created["structuredContent"]["value"]["host"]["id"]
            .as_str()
            .ok_or("created host missing")?;
        assert_eq!(
            start(&owner, "a", "hosts.connect", json!({"host_id":id}))?.await?["isError"],
            false
        );
        let listed = start(&owner, "a", "hosts.list", json!({}))?.await?;
        assert!(
            listed["structuredContent"]["value"]["connections"]
                .as_array()
                .ok_or("connections missing")?
                .iter()
                .any(|connection| connection["host_id"] == id)
        );
        assert_eq!(
            start(&owner, "a", "hosts.delete", json!({"host_id":id}))?.await?["isError"],
            false
        );
        let listed = start(&owner, "a", "hosts.list", json!({}))?.await?;
        assert!(
            !listed["structuredContent"]["value"]["hosts"]
                .as_array()
                .ok_or("hosts missing")?
                .iter()
                .any(|host| host["id"] == id)
        );
        assert!(
            !listed["structuredContent"]["value"]["connections"]
                .as_array()
                .ok_or("connections missing")?
                .iter()
                .any(|connection| connection["host_id"] == id)
        );
        Ok(())
    })
}

#[test]
fn mcp_cancellation_reports_interrupted_deletion_without_running_later_phases()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, _coordinator, platform) = setup();
        *platform.pause.lock() = Some("delete_snapshot");
        let pending = start(&owner, "a", "hosts.delete", json!({"host_id":"mini"}))?;
        platform.wait_for("delete_snapshot").await?;
        let parent = platform.permits.lock()[0].parent.clone();
        owner.cancel_request(&parent, "Host action cancelled");
        platform.resume.notify_one();
        let result = pending.await?;
        assert_eq!(result["structuredContent"]["error"]["code"], "cancelled");
        assert_eq!(
            result["structuredContent"]["error"]["details"]["stage"],
            "delete_snapshot"
        );
        assert_eq!(
            result["structuredContent"]["error"]["details"]["completed_stages"],
            json!(["delete_transcripts"])
        );
        assert_eq!(
            *platform.calls.lock(),
            ["delete_transcripts", "delete_snapshot"]
        );
        Ok(())
    })
}

#[test]
fn queued_mutations_share_native_ordering_and_cancel_without_executing()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, _coordinator, platform) = setup();
        *platform.pause.lock() = Some("read_credential");
        let connecting = start(&owner, "a", "hosts.connect", json!({"host_id":"mini"}))?;
        platform.wait_for("read_credential").await?;
        let queued = start(&owner, "b", "hosts.delete", json!({"host_id":"mini"}))?;
        let parent = owner
            .pending
            .lock()
            .iter()
            .find(|(_, pending)| pending.session == "b")
            .map(|(id, _)| id.clone())
            .ok_or("queued action missing")?;
        owner.cancel_request(&parent, "Host action cancelled");
        assert_eq!(
            queued.await?["structuredContent"]["error"]["code"],
            "cancelled"
        );
        platform.resume.notify_one();
        assert_eq!(connecting.await?["isError"], false);
        assert_eq!(
            *platform.calls.lock(),
            ["authenticate", "read_credential", "connect"]
        );
        Ok(())
    })
}

#[test]
fn replacing_the_platform_revokes_old_operations_and_keeps_the_new_adapter_live()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, previous, platform) = setup();
        *platform.pause.lock() = Some("read_credential");
        let pending = start(&owner, "a", "hosts.connect", json!({"host_id":"mini"}))?;
        platform.wait_for("read_credential").await?;
        let replacement = HostActionCoordinator::new(Arc::new(Platform::default()));
        replacement.update_context(context());
        previous.close();
        platform.resume.notify_one();
        assert_eq!(
            pending.await?["structuredContent"]["error"]["code"],
            "cancelled"
        );
        assert_eq!(
            start(&owner, "b", "hosts.list", json!({}))?.await?["isError"],
            false
        );
        assert!(!platform.calls.lock().iter().any(|call| call == "connect"));
        Ok(())
    })
}

#[test]
fn source_credential_revocation_during_biometrics_prevents_copying() -> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, coordinator, platform) = setup();
        *platform.pause.lock() = Some("authenticate");
        let pending = start(
            &owner,
            "a",
            "hosts.save",
            json!({
                "host_id":"mini","profile":{"name":"New"},"credential_from_host_id":"host"
            }),
        )?;
        platform.wait_for("authenticate").await?;
        let mut updated = context();
        updated.hosts.retain(|host| host.id != "host");
        coordinator.update_context(updated);
        platform.resume.notify_one();
        assert_eq!(
            pending.await?["structuredContent"]["error"]["code"],
            "cancelled"
        );
        assert_eq!(*platform.calls.lock(), ["authenticate"]);
        Ok(())
    })
}

#[test]
fn jump_host_keys_require_biometrics_and_connected_hosts_do_not_reload_credentials()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, coordinator, platform) = setup();
        let mut configuration = context();
        configuration.hosts[1].auth_mode = HostAuthMode::Password;
        configuration.hosts[1].jump_host_id = Some("host".to_owned());
        coordinator.update_context(configuration.clone());
        assert_eq!(start(&owner, "a", "hosts.connect", json!({"host_id":"mini"}))?.await?["isError"], false);
        assert_eq!(*platform.calls.lock(), ["authenticate", "read_credential", "connect"]);
        configuration.connections.push(super::HostActionConnection { host_id: "mini".to_owned(), status: crate::app_core::AppConnectionStatus::Ready });
        coordinator.update_context(configuration);
        platform.calls.lock().clear();
        assert_eq!(start(&owner, "a", "hosts.connect", json!({"host_id":"mini"}))?.await?["structuredContent"]["value"]["status"], "ready");
        assert!(platform.calls.lock().is_empty());
        Ok(())
    })
}

#[test]
fn biometric_refusal_and_missing_credentials_never_connect() -> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, _coordinator, platform) = setup();
        platform.authenticated.store(false, Ordering::Release);
        let refused = start(&owner, "a", "hosts.connect", json!({"host_id":"mini"}))?.await?;
        assert_eq!(
            refused["structuredContent"]["error"]["code"],
            "permission_denied"
        );
        assert_eq!(*platform.calls.lock(), ["authenticate"]);
        platform.authenticated.store(true, Ordering::Release);
        platform.missing_credential.store(true, Ordering::Release);
        let missing = start(&owner, "a", "hosts.connect", json!({"host_id":"mini"}))?.await?;
        assert_eq!(
            missing["structuredContent"]["error"]["code"],
            "invalid_argument"
        );
        assert!(!platform.calls.lock().iter().any(|call| call == "connect"));
        Ok(())
    })
}

#[test]
fn deletion_stops_at_each_failed_phase_and_reports_committed_progress() -> Result<(), Box<dyn Error>>
{
    crate::runtime()?.block_on(async {
        let phases = [
            "delete_transcripts",
            "delete_snapshot",
            "delete_profile",
            "disconnect_deleted",
        ];
        for (index, phase) in phases.iter().enumerate() {
            let (owner, _coordinator, platform) = setup();
            *platform.fail.lock() = Some(*phase);
            let result = start(&owner, "a", "hosts.delete", json!({"host_id":"mini"}))?.await?;
            assert_eq!(*platform.calls.lock(), phases[..=index]);
            assert_eq!(
                result["structuredContent"]["error"]["code"],
                "device_unavailable"
            );
            assert_eq!(
                result["structuredContent"]["error"]["details"]["completed_stages"],
                json!(&phases[..index])
            );
            assert_eq!(
                result["structuredContent"]["error"]["details"]["outcome_unknown"],
                true
            );
        }
        Ok(())
    })
}

#[test]
fn locking_during_biometrics_cancels_the_operation_even_after_unlock() -> Result<(), Box<dyn Error>>
{
    crate::runtime()?.block_on(async {
        let (owner, coordinator, platform) = setup();
        *platform.pause.lock() = Some("authenticate");
        let pending = start(&owner, "a", "hosts.connect", json!({"host_id":"mini"}))?;
        platform.wait_for("authenticate").await?;
        coordinator.update_context(HostActionContext {
            locked: true,
            ..context()
        });
        coordinator.update_context(context());
        platform.resume.notify_one();
        let result = pending.await?;
        assert_eq!(
            result["structuredContent"]["error"]["code"],
            "permission_denied"
        );
        assert_eq!(*platform.calls.lock(), ["authenticate"]);
        assert!(
            platform
                .permits
                .lock()
                .iter()
                .all(|permit| permit.check_active().is_err())
        );
        Ok(())
    })
}

#[test]
fn profile_replacement_during_credential_loading_cannot_retarget_connect()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, coordinator, platform) = setup();
        *platform.pause.lock() = Some("read_credential");
        let pending = start(&owner, "a", "hosts.connect", json!({"host_id":"mini"}))?;
        platform.wait_for("read_credential").await?;
        let mut updated = context();
        updated.hosts[1].host = "replacement.test".to_owned();
        coordinator.update_context(updated);
        platform.resume.notify_one();
        assert_eq!(
            pending.await?["structuredContent"]["error"]["code"],
            "cancelled"
        );
        assert!(!platform.calls.lock().iter().any(|call| call == "connect"));
        Ok(())
    })
}

#[test]
fn session_revocation_fences_late_platform_completions_without_affecting_another_agent()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let (owner, _coordinator, platform) = setup();
        *platform.pause.lock() = Some("delete_snapshot");
        let pending = start(&owner, "a", "hosts.delete", json!({"host_id":"mini"}))?;
        platform.wait_for("delete_snapshot").await?;
        owner.close_session("a");
        platform.resume.notify_one();
        assert_eq!(
            pending.await?["structuredContent"]["error"]["code"],
            "session_closed"
        );
        let result = start(&owner, "b", "hosts.list", json!({}))?.await?;
        assert_eq!(result["isError"], false);
        assert!(
            !platform
                .calls
                .lock()
                .iter()
                .any(|call| call == "delete_profile")
        );
        Ok(())
    })
}
