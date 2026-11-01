use super::runner::Transport;
use super::*;
use crate::{
    CredentialEffect, CredentialEffectPermit, CredentialEffectResult, CredentialMaterial,
    CredentialPlatform, CredentialPlatformError, CredentialProfileView, CredentialSlot,
    CredentialStorageKey, HostAuthMode, HostSshConfig, KnownHostCommand,
};
use std::collections::{HashMap, VecDeque};
const KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti";
#[derive(Default)]
struct Storage {
    cancel_during_read: Mutex<Option<Weak<Control>>>,
    metadata: Mutex<HashMap<String, String>>,
    secure: Mutex<HashMap<String, CredentialMaterial>>,
    reads: Mutex<usize>,
}
#[async_trait::async_trait]
impl CredentialPlatform for Storage {
    async fn effect(
        &self,
        permit: Arc<CredentialEffectPermit>,
        effect: CredentialEffect,
    ) -> std::result::Result<CredentialEffectResult, CredentialPlatformError> {
        permit
            .check_active()
            .map_err(|_| CredentialPlatformError::Cancelled)?;
        Ok(match effect {
            CredentialEffect::ReadMetadata { keys } => CredentialEffectResult::Metadata {
                entries: keys
                    .into_iter()
                    .map(|key| crate::CredentialStorageEntry {
                        key,
                        value: self.metadata.lock().get(&format!("{key:?}")).cloned(),
                    })
                    .collect(),
            },
            CredentialEffect::WriteMetadata { entries } => {
                for entry in entries {
                    if let Some(value) = entry.value {
                        self.metadata
                            .lock()
                            .insert(format!("{:?}", entry.key), value);
                    }
                }
                CredentialEffectResult::Done
            }
            CredentialEffect::ReadSecure {
                slot: CredentialSlot::Host { id },
            } => {
                *self.reads.lock() += 1;
                if let Some(control) = self
                    .cancel_during_read
                    .lock()
                    .take()
                    .and_then(|control| control.upgrade())
                {
                    control.cancelled.store(true, Ordering::Release);
                }
                CredentialEffectResult::Text {
                    value: self
                        .secure
                        .lock()
                        .get(&id)
                        .map(|value| serde_json::to_string(value).unwrap()),
                }
            }
            CredentialEffect::VaultAvailable | CredentialEffect::HasRecoveryKey => {
                CredentialEffectResult::Boolean { value: false }
            }
            _ => return Err(CredentialPlatformError::Unsupported),
        })
    }
    fn profiles_changed(&self, _: CredentialProfileView) {}
    fn diagnostic(&self, _: String, _: Option<String>) {}
}
#[derive(Default)]
struct Prompts {
    concurrent_trust: Mutex<Option<Arc<KnownHostRepository>>>,
    edit: Mutex<Option<(Arc<CredentialCoordinator>, String)>>,
    deny_auth: AtomicBool,
    deny_trust: AtomicBool,
    revoke: AtomicBool,
    calls: Mutex<Vec<&'static str>>,
    permits: Mutex<Vec<Arc<SshWorkflowPermit>>>,
}
#[async_trait::async_trait]
impl SshWorkflowPlatform for Prompts {
    async fn authenticate_private_key(
        &self,
        permit: Arc<SshWorkflowPermit>,
    ) -> std::result::Result<bool, SshWorkflowPlatformError> {
        self.calls.lock().push("authenticate");
        self.permits.lock().push(permit.clone());
        if self.revoke.load(Ordering::Acquire) {
            let edit = self.edit.lock().clone();
            if let Some((coordinator, id)) = edit {
                let patch = serde_json::from_value(
                    serde_json::json!({ "name": "Edited during biometric approval" }),
                )
                .unwrap();
                let _ = coordinator
                    .begin(
                        crate::CredentialCommand::SaveMetadata {
                            id,
                            patch,
                            source: None,
                        },
                        None,
                    )
                    .result()
                    .await;
            }
        }
        Ok(!self.deny_auth.load(Ordering::Acquire))
    }
    async fn confirm_host_key(
        &self,
        permit: Arc<SshWorkflowPermit>,
        mut challenge: HostKeyChallenge,
    ) -> std::result::Result<bool, SshWorkflowPlatformError> {
        self.calls.lock().push("confirm");
        self.permits.lock().push(permit.clone());
        if self.revoke.load(Ordering::Acquire) {
            set_locked_for(&permit.control.upgrade().unwrap().security, true);
            set_locked_for(&permit.control.upgrade().unwrap().security, false);
        }
        let repository = self.concurrent_trust.lock().clone();
        if let Some(repository) = repository {
            let key = crate::inspect_public_key(
                "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI"
                    .into(),
                false,
            )
            .unwrap();
            challenge.public_key = key.public_key;
            challenge.fingerprint = key.fingerprint;
            challenge.key_type = key.key_type;
            repository
                .begin(KnownHostCommand::Trust { challenge })
                .result()
                .await
                .unwrap();
        }
        Ok(!self.deny_trust.load(Ordering::Acquire))
    }
    async fn host_key_trusted(
        &self,
        permit: Arc<SshWorkflowPermit>,
        _: HostKeyChallenge,
    ) -> std::result::Result<(), SshWorkflowPlatformError> {
        self.calls.lock().push("trusted");
        self.permits.lock().push(permit);
        Ok(())
    }
}
#[derive(Clone)]
enum Step {
    Success,
    Unknown(HostKeyChallenge),
    Changed(HostKeyChallenge),
    Fail(bool),
    Hang(bool),
    Edit,
    Lock,
}
struct FakeTransport {
    steps: Mutex<VecDeque<Step>>,
    routes: Mutex<Vec<Vec<HostSshConfig>>>,
}
impl FakeTransport {
    fn new(steps: Vec<Step>) -> Self {
        Self {
            steps: Mutex::new(steps.into()),
            routes: Mutex::new(vec![]),
        }
    }
}
#[async_trait::async_trait]
impl Transport for FakeTransport {
    async fn mutate(
        &self,
        request: &SshWorkflowRequest,
        route: Vec<HostSshConfig>,
        control: Arc<Control>,
    ) -> Result<SshWorkflowResult> {
        self.routes.lock().push(route);
        let step = self.steps.lock().pop_front().unwrap_or(Step::Success);
        match step {
            Step::Unknown(challenge) => {
                return Err(SshWorkflowError::Installation(
                    HostRuntimeError::HostKeyUnknown(challenge),
                ));
            }
            Step::Changed(challenge) => {
                return Err(SshWorkflowError::Installation(
                    HostRuntimeError::HostKeyChanged(challenge),
                ));
            }
            Step::Fail(dispatched) | Step::Hang(dispatched) => {
                if dispatched {
                    control.admit_mutation()?;
                }
                if matches!(step, Step::Hang(_)) {
                    std::future::pending::<()>().await;
                }
                return Err(SshWorkflowError::Installation(
                    HostRuntimeError::SshTransportFailure("lost transport".into()),
                ));
            }
            Step::Edit => {
                let _edit = CredentialMutation::begin_for(control.security.clone());
                control.admit_mutation()?;
            }
            Step::Lock => {
                set_locked_for(&control.security, true);
                set_locked_for(&control.security, false);
                control.admit_mutation()?;
            }
            Step::Success => control.admit_mutation()?,
        }
        Ok(match request {
            SshWorkflowRequest::Install { .. } => SshWorkflowResult::Installed {
                outcome: PublicKeyInstallOutcome::Added,
            },
            SshWorkflowRequest::Pair { .. } => SshWorkflowResult::Paired {
                result: PairHostResult {
                    ssh_host: "target.test".into(),
                    ssh_port: 22,
                    ssh_user: "user".into(),
                    ssh_host_fingerprint: "pinned".into(),
                    ssh_host_key_type: "ssh-ed25519".into(),
                    ssh_host_public_key: KEY.into(),
                    key_fingerprint: None,
                    already_present: false,
                    tailcat: None,
                },
            },
        })
    }
}
fn host(id: &str, jump: Option<&str>) -> HostProfileRecord {
    HostProfileRecord {
        id: id.into(),
        name: id.into(),
        host: format!("{id}.test"),
        port: "22".into(),
        username: "user".into(),
        jump_host_id: jump.map(str::to_owned),
        forward_agent: false,
        tailcat_enabled: false,
        tailcat_ssh_server: false,
        auth_mode: HostAuthMode::Password,
        herdr_enabled: true,
        herdr_backend: crate::HostHerdrBackend::Legacy,
        herdr_command: "herdr".into(),
        herdr_socket_path: String::new(),
        session_name: String::new(),
        agent_instructions: String::new(),
        created_at: "2026-01-01".into(),
        updated_at: "2026-01-01".into(),
        last_connected_at: Some("2026-01-02".into()),
    }
}
struct Fixture {
    operation: Arc<SshWorkflow>,
    storage: Arc<Storage>,
    prompts: Arc<Prompts>,
    _directory: tempfile::TempDir,
}
impl Fixture {
    fn new(hosts: Vec<HostProfileRecord>, pair: bool) -> Self {
        let storage = Arc::new(Storage::default());
        storage.metadata.lock().insert(
            format!("{:?}", CredentialStorageKey::Hosts),
            serde_json::to_string(&hosts).unwrap(),
        );
        for host in &hosts {
            let identity = tailcat_client::Identity::generate();
            storage.secure.lock().insert(
                host.id.clone(),
                CredentialMaterial {
                    secret: "saved-secret".into(),
                    passphrase: "passphrase".into(),
                    tailcat_address: host.tailcat_enabled.then(|| "tailcat-address".into()),
                    tailcat_private_key: host.tailcat_enabled.then(|| identity.private_key()),
                    tailcat_public_key: host.tailcat_enabled.then(|| identity.public_key()),
                },
            );
        }
        let directory = tempfile::tempdir().unwrap();
        let known =
            KnownHostRepository::workflow_test_repository(directory.path().join("known.db"));
        crate::runtime()
            .unwrap()
            .block_on(known.begin(KnownHostCommand::Load).result())
            .unwrap();
        let prompts = Arc::new(Prompts::default());
        let target = hosts.last().unwrap();
        let request = if pair {
            let fixture: serde_json::Value = serde_json::from_str(include_str!(
                "../../../../../crates/whipair-protocol/tests/fixtures/wp4-pairing.json"
            ))
            .unwrap();
            SshWorkflowRequest::Pair {
                code: fixture["cases"][0]["code"].as_str().unwrap().into(),
                public_key: KEY.into(),
                device_name: "phone".into(),
                jump_host_id: target.jump_host_id.clone(),
            }
        } else {
            SshWorkflowRequest::Install {
                host: target.clone(),
                public_key: KEY.into(),
                connected: false,
            }
        };
        let credentials = CredentialCoordinator::with_workflow_security(
            storage.clone(),
            Arc::new(Mutex::new(Security::default())),
        );
        *prompts.edit.lock() = Some((credentials.clone(), target.id.clone()));
        let operation = SshWorkflow::new(request, hosts, true, credentials, known, prompts.clone());
        Self {
            operation,
            storage,
            prompts,
            _directory: directory,
        }
    }
    fn run(&self, transport: &FakeTransport) -> Result<SshWorkflowResult> {
        crate::runtime()
            .unwrap()
            .block_on(self.operation.execute_with(transport))
    }
}
fn challenge(name: &str) -> HostKeyChallenge {
    let key = crate::inspect_public_key(KEY.into(), false).unwrap();
    HostKeyChallenge {
        host: format!("{name}.test"),
        port: 22,
        key_type: key.key_type,
        fingerprint: key.fingerprint,
        public_key: key.public_key,
    }
}
#[test]
fn direct_proxyjump_and_tailcat_preserve_routes_and_outcomes() {
    for pair in [false, true] {
        for tailcat in [false, true] {
            let mut outer = host("outer", None);
            outer.tailcat_enabled = tailcat;
            let f = Fixture::new(
                vec![
                    outer,
                    host("inner", Some("outer")),
                    host("target", Some("inner")),
                ],
                pair,
            );
            let transport = FakeTransport::new(vec![Step::Success]);
            assert!(f.run(&transport).is_ok());
            let routes = transport.routes.lock();
            let expected = if pair {
                vec!["outer.test", "inner.test"]
            } else {
                vec!["outer.test", "inner.test", "target.test"]
            };
            assert_eq!(
                routes[0]
                    .iter()
                    .map(|host| host.host.as_str())
                    .collect::<Vec<_>>(),
                expected
            );
            assert_eq!(routes[0][0].tailcat_address.is_some(), tailcat);
            assert!(routes[0].iter().all(|host| !host.forward_agent));
            drop(routes);
        }
    }
    let f = Fixture::new(vec![host("target", None)], true);
    let transport = FakeTransport::new(vec![Step::Success]);
    assert!(matches!(
        f.run(&transport),
        Ok(SshWorkflowResult::Paired { .. })
    ));
    assert!(transport.routes.lock()[0].is_empty());
}
#[test]
fn credentials_and_prior_connection_are_required_before_network() {
    let mut target = host("target", None);
    target.last_connected_at = None;
    let f = Fixture::new(vec![target], false);
    let transport = FakeTransport::new(vec![]);
    assert!(matches!(
        f.run(&transport),
        Err(SshWorkflowError::NeverConnected)
    ));
    assert_eq!(*f.storage.reads.lock(), 0);
    let f = Fixture::new(vec![host("target", None)], false);
    f.storage.secure.lock().clear();
    assert!(matches!(
        f.run(&transport),
        Err(SshWorkflowError::MissingCredential)
    ));
    assert!(transport.routes.lock().is_empty());
}
#[test]
fn biometric_denial_and_profile_edits_cannot_release_credentials_to_transport() {
    for edit in [false, true] {
        let mut target = host("target", None);
        target.auth_mode = HostAuthMode::Key;
        let f = Fixture::new(vec![target], false);
        let transport = FakeTransport::new(vec![]);
        f.prompts.deny_auth.store(!edit, Ordering::Release);
        f.prompts.revoke.store(edit, Ordering::Release);
        assert!(matches!(
            f.run(&transport),
            Ok(SshWorkflowResult::Cancelled)
        ));
        assert!(transport.routes.lock().is_empty());
        assert_eq!(*f.storage.reads.lock(), 0);
        assert!(
            f.prompts
                .permits
                .lock()
                .iter()
                .all(|permit| permit.check_active().is_err())
        );
    }
}
#[test]
fn unknown_key_requires_exact_durable_trust_and_retries_only_once_per_endpoint() {
    let f = Fixture::new(vec![host("target", None)], false);
    let transport = FakeTransport::new(vec![Step::Unknown(challenge("target")), Step::Success]);
    assert!(matches!(
        f.run(&transport),
        Ok(SshWorkflowResult::Installed { .. })
    ));
    assert_eq!(*f.prompts.calls.lock(), ["confirm", "trusted"]);
    assert_eq!(transport.routes.lock().len(), 2);
    assert_eq!(
        f.operation.known_hosts.view().unwrap().hosts[0].public_key,
        KEY
    );
    assert!(
        f.prompts
            .permits
            .lock()
            .iter()
            .all(|permit| permit.check_active().is_err())
    );
    let f = Fixture::new(vec![host("target", None)], false);
    let transport = FakeTransport::new(vec![
        Step::Unknown(challenge("target")),
        Step::Unknown(challenge("target")),
    ]);
    assert!(matches!(
        f.run(&transport),
        Err(SshWorkflowError::InvalidChallenge)
    ));
    assert_eq!(transport.routes.lock().len(), 2);
}
#[test]
fn rejection_changed_keys_and_foreign_challenges_never_auto_trust() {
    for step in [
        Step::Unknown(challenge("target")),
        Step::Changed(challenge("target")),
        Step::Unknown(challenge("foreign")),
    ] {
        let f = Fixture::new(vec![host("target", None)], false);
        f.prompts.deny_trust.store(true, Ordering::Release);
        let transport = FakeTransport::new(vec![step]);
        assert!(!matches!(
            f.run(&transport),
            Ok(SshWorkflowResult::Installed { .. })
        ));
        assert!(f.operation.known_hosts.view().unwrap().hosts.is_empty());
        assert_eq!(transport.routes.lock().len(), 1);
    }
}
#[test]
fn app_lock_during_approval_or_connection_cannot_resume_on_unlock() {
    let f = Fixture::new(vec![host("target", None)], false);
    f.prompts.revoke.store(true, Ordering::Release);
    assert!(matches!(
        f.run(&FakeTransport::new(vec![Step::Unknown(challenge(
            "target"
        ))])),
        Ok(SshWorkflowResult::Cancelled)
    ));
    assert!(f.operation.known_hosts.view().unwrap().hosts.is_empty());
    for step in [Step::Edit, Step::Lock] {
        let f = Fixture::new(vec![host("target", None)], false);
        assert!(matches!(
            f.run(&FakeTransport::new(vec![step])),
            Ok(SshWorkflowResult::Cancelled)
        ));
    }
}
#[test]
fn transport_failures_never_replay_mutations_and_report_lost_acknowledgements() {
    for dispatched in [false, true] {
        let f = Fixture::new(vec![host("target", None)], false);
        let transport = FakeTransport::new(vec![Step::Fail(dispatched)]);
        let result = f.run(&transport);
        assert_eq!(
            matches!(result, Err(SshWorkflowError::OutcomeUnknown { .. })),
            dispatched
        );
        assert!(result.is_err());
        assert_eq!(transport.routes.lock().len(), 1);
    }
}
#[test]
fn stale_target_port_missing_jump_and_deleted_profiles_stop_before_network() {
    for variant in 0..3 {
        let mut f = Fixture::new(vec![host("target", None)], false);
        let request = &mut Arc::get_mut(&mut f.operation).unwrap().request;
        if let SshWorkflowRequest::Install { host, .. } = request {
            match variant {
                0 => host.port = "2222".into(),
                1 => host.jump_host_id = Some("missing".into()),
                _ => host.id = "deleted".into(),
            }
        }
        let transport = FakeTransport::new(vec![]);
        assert!(matches!(
            f.run(&transport),
            Err(SshWorkflowError::InvalidRoute)
        ));
        assert!(transport.routes.lock().is_empty());
    }
}

#[test]
fn timeout_before_dispatch_is_safe_and_after_dispatch_is_indeterminate() {
    for dispatched in [false, true] {
        let f = Fixture::new(vec![host("target", None)], false);
        let transport = FakeTransport::new(vec![Step::Hang(dispatched)]);
        let result = crate::runtime().unwrap().block_on(
            f.operation
                .execute_with_timeout(&transport, Duration::from_secs(1)),
        );
        if dispatched {
            assert!(matches!(
                result,
                Err(SshWorkflowError::OutcomeUnknown { .. })
            ));
        } else {
            assert!(matches!(result, Err(SshWorkflowError::Timeout)));
        }
        assert_eq!(transport.routes.lock().len(), 1);
    }
}

#[test]
fn exported_workflow_owns_runtime_and_consumes_result_once() {
    let mut f = Fixture::new(vec![host("target", None)], true);
    if let SshWorkflowRequest::Pair { code, .. } =
        &mut Arc::get_mut(&mut f.operation).unwrap().request
    {
        *code = "invalid".into();
    }
    assert!(matches!(
        futures::executor::block_on(f.operation.clone().run()),
        Err(SshWorkflowError::Pairing(PairHostError::BadPrefix))
    ));
    assert!(matches!(
        futures::executor::block_on(f.operation.clone().run()),
        Err(SshWorkflowError::ResultConsumed)
    ));
}
#[test]
fn malformed_fingerprints_or_wrong_ports_never_reach_a_trust_prompt() {
    for fingerprint in [false, true] {
        let f = Fixture::new(vec![host("target", None)], false);
        let mut challenge = challenge("target");
        if fingerprint {
            challenge.fingerprint = "SHA256:forged".into();
        } else {
            challenge.port = 2222;
        }
        assert!(matches!(
            f.run(&FakeTransport::new(vec![Step::Unknown(challenge)])),
            Err(SshWorkflowError::InvalidChallenge)
        ));
        assert!(f.prompts.calls.lock().is_empty());
        assert!(f.operation.known_hosts.view().unwrap().hosts.is_empty());
    }
}

#[test]
fn concurrent_trust_change_during_approval_cannot_authorize_the_old_challenge() {
    let f = Fixture::new(vec![host("target", None)], false);
    *f.prompts.concurrent_trust.lock() = Some(f.operation.known_hosts.clone());
    let transport = FakeTransport::new(vec![Step::Unknown(challenge("target"))]);
    assert!(matches!(
        f.run(&transport),
        Err(SshWorkflowError::TrustUnavailable)
    ));
    let known = f.operation.known_hosts.view().unwrap();
    assert_eq!(known.hosts.len(), 1);
    assert_ne!(known.hosts[0].public_key, KEY);
    assert_eq!(transport.routes.lock().len(), 1);
}
#[test]
fn tailcat_builtin_ssh_first_hop_uses_its_canonical_trust_identity() {
    let mut outer = host("outer", None);
    outer.tailcat_enabled = true;
    outer.tailcat_ssh_server = true;
    outer.auth_mode = HostAuthMode::Key;
    let f = Fixture::new(vec![outer, host("target", Some("outer"))], false);
    let mut challenge = challenge("outer");
    challenge.host = "tailcat-ssh:outer.test".into();
    let transport = FakeTransport::new(vec![Step::Unknown(challenge), Step::Success]);
    assert!(matches!(
        f.run(&transport),
        Ok(SshWorkflowResult::Installed { .. })
    ));
    assert_eq!(
        *f.prompts.calls.lock(),
        ["authenticate", "confirm", "trusted"]
    );
    assert!(transport.routes.lock()[0][0].tailcat_ssh_server);
}

#[test]
fn a_keychain_read_that_finishes_after_cancellation_cannot_release_ssh_credentials() {
    let mut target = host("target", None);
    target.auth_mode = HostAuthMode::Key;
    let f = Fixture::new(vec![target], false);
    *f.storage.cancel_during_read.lock() = Some(Arc::downgrade(&f.operation.control));
    let transport = FakeTransport::new(vec![]);
    assert!(matches!(
        f.run(&transport),
        Ok(SshWorkflowResult::Cancelled)
    ));
    assert!(transport.routes.lock().is_empty());
}
