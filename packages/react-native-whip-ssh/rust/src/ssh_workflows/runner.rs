use super::{
    Control, EFFECT_TIMEOUT, EffectGuard, Result, SshWorkflow, SshWorkflowError, SshWorkflowPermit,
    SshWorkflowPlatformError, SshWorkflowRequest, SshWorkflowResult, WORKFLOW_TIMEOUT,
};
use crate::{
    CredentialCommand, CredentialMaterial, CredentialResult, HostAuthMode, HostProfileStore,
    HostSshConfig, HostSshCredential, KnownHostRepositoryStatus,
};
use crate::{HostProfileRecord, HostRuntimeError, PairHostError, ssh::HostKeyChallenge};
use std::{collections::HashSet, future::Future};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
#[async_trait::async_trait]
pub(super) trait Transport: Send + Sync {
    async fn mutate(
        &self,
        request: &SshWorkflowRequest,
        route: Vec<HostSshConfig>,
        control: Arc<Control>,
    ) -> Result<SshWorkflowResult>;
}
struct NativeTransport;
#[async_trait::async_trait]
impl Transport for NativeTransport {
    async fn mutate(
        &self,
        request: &SshWorkflowRequest,
        mut route: Vec<HostSshConfig>,
        control: Arc<Control>,
    ) -> Result<SshWorkflowResult> {
        match request {
            SshWorkflowRequest::Pair {
                code,
                public_key,
                device_name,
                ..
            } => crate::pairing::pair_host_guarded(
                code,
                public_key,
                device_name,
                &route,
                Some(control),
            )
            .await
            .map(|result| SshWorkflowResult::Paired { result })
            .map_err(|error| SshWorkflowError::Pairing(error.into())),
            SshWorkflowRequest::Install { public_key, .. } => {
                let target = route.pop().ok_or(SshWorkflowError::InvalidRoute)?;
                crate::public_keys::install_on_route_guarded(
                    target,
                    route,
                    crate::inspect_public_key(public_key.clone(), false)
                        .map_err(SshWorkflowError::Installation)?,
                    Some(control),
                )
                .await
                .map(|outcome| SshWorkflowResult::Installed { outcome })
                .map_err(SshWorkflowError::Installation)
            }
        }
    }
}
impl SshWorkflow {
    pub(super) async fn execute(&self) -> Result<SshWorkflowResult> {
        self.execute_with(&NativeTransport).await
    }
    pub(super) async fn execute_with(
        &self,
        transport: &dyn Transport,
    ) -> Result<SshWorkflowResult> {
        self.execute_with_timeout(transport, WORKFLOW_TIMEOUT).await
    }
    pub(super) async fn execute_with_timeout(
        &self,
        transport: &dyn Transport,
        timeout: Duration,
    ) -> Result<SshWorkflowResult> {
        let result = tokio::select! {
            result = tokio::time::timeout(timeout, self.coordinate(transport)) => result.unwrap_or(Err(SshWorkflowError::Timeout)),
            () = async { loop { if self.control.check().is_err() { break; } tokio::time::sleep(Duration::from_millis(20)).await; } } => Err(SshWorkflowError::Cancelled),
        };
        if self.control.mutation_started.load(Ordering::Acquire)
            && ((result.is_err()
                && !matches!(
                    result,
                    Err(SshWorkflowError::Pairing(PairHostError::Refused { .. }))
                ))
                || self.control.check().is_err())
        {
            return Err(SshWorkflowError::OutcomeUnknown {
                operation_id: self.control.id.clone(),
            });
        }
        match result {
            Err(SshWorkflowError::Cancelled) => Ok(SshWorkflowResult::Cancelled),
            other => other,
        }
    }
    async fn credential(&self, command: CredentialCommand) -> Result<CredentialResult> {
        self.control.check()?;
        let result = self
            .credentials
            .begin_workflow(command, self.control.clone())
            .result()
            .await;
        self.control.check()?;
        result.map_err(|_| SshWorkflowError::InvalidRoute)
    }
    async fn canonical_hosts(&self) -> Result<Vec<HostProfileRecord>> {
        match self
            .credential(CredentialCommand::LoadHosts {
                from_storage: false,
                hosts: None,
                legacy: None,
            })
            .await?
        {
            CredentialResult::Hosts { hosts } => Ok(hosts),
            _ => Err(SshWorkflowError::InvalidRoute),
        }
    }
    async fn read(&self, host: &HostProfileRecord) -> Result<CredentialMaterial> {
        match self
            .credential(CredentialCommand::ReadHost {
                host: host.clone(),
                strict: true,
            })
            .await?
        {
            CredentialResult::Material { credential } => Ok(credential),
            _ => Err(SshWorkflowError::InvalidRoute),
        }
    }
    async fn prompt<
        T,
        F: Future<Output = std::result::Result<T, SshWorkflowPlatformError>> + Send,
    >(
        &self,
        effect: impl FnOnce(Arc<SshWorkflowPermit>) -> F + Send,
    ) -> Result<T> {
        self.control.check()?;
        let permit = Arc::new(SshWorkflowPermit {
            control: Arc::downgrade(&self.control),
            active: AtomicBool::new(true),
        });
        let _guard = EffectGuard(permit.clone());
        let result = tokio::time::timeout(EFFECT_TIMEOUT, effect(permit))
            .await
            .map_err(|_| SshWorkflowError::Timeout)?;
        self.control.check()?;
        result.map_err(|error| match error {
            SshWorkflowPlatformError::Cancelled => SshWorkflowError::Cancelled,
            SshWorkflowPlatformError::Unavailable => SshWorkflowError::Platform,
        })
    }
    async fn coordinate(&self, transport: &dyn Transport) -> Result<SshWorkflowResult> {
        let admission = self.control.security.lock().admission.clone();
        let _admission = admission.lock().await;
        self.control.check()?;
        let canonical = self.canonical_hosts().await?;
        let store = HostProfileStore::new();
        store
            .hydrate(Some(
                serde_json::to_string(&canonical).map_err(|_| SshWorkflowError::InvalidRoute)?,
            ))
            .map_err(|_| SshWorkflowError::InvalidRoute)?;
        let (id, jump) = match &self.request {
            SshWorkflowRequest::Pair {
                jump_host_id,
                code,
                public_key,
                ..
            } => {
                let payload =
                    whipair_protocol::decode_pairing_code(code.trim()).map_err(|error| {
                        SshWorkflowError::Pairing(crate::pairing::PairingError::from(error).into())
                    })?;
                if payload.tailcat && jump_host_id.is_some() {
                    return Err(SshWorkflowError::InvalidRoute);
                }
                crate::inspect_public_key(public_key.clone(), false)
                    .map_err(SshWorkflowError::Installation)?;
                (self.control.id.clone(), jump_host_id.clone())
            }
            SshWorkflowRequest::Install {
                host,
                public_key,
                connected,
            } => {
                crate::inspect_public_key(public_key.clone(), false)
                    .map_err(SshWorkflowError::Installation)?;
                if !canonical.iter().any(|saved| saved == host) {
                    return Err(SshWorkflowError::InvalidRoute);
                }
                if host.last_connected_at.is_none()
                    && !(*connected && crate::host_runtime::workflow_host_connected(host))
                {
                    return Err(SshWorkflowError::NeverConnected);
                }
                (host.id.clone(), host.jump_host_id.clone())
            }
        };
        let mut profiles = store
            .resolve_jump_chain(id, jump)
            .map_err(|_| SshWorkflowError::InvalidRoute)?;
        if let SshWorkflowRequest::Install { host, .. } = &self.request {
            profiles.push(host.clone());
        }
        if profiles
            .iter()
            .any(|host| !self.hosts.iter().any(|saved| saved == host))
            || profiles.iter().skip(1).any(|host| host.tailcat_enabled)
        {
            return Err(SshWorkflowError::InvalidRoute);
        }
        let biometric = self.biometric || self.control.security.lock().biometric;
        if biometric
            && profiles
                .iter()
                .any(|host| host.auth_mode == HostAuthMode::Key)
            && !self
                .prompt(|permit| self.platform.authenticate_private_key(permit))
                .await?
        {
            return Ok(SshWorkflowResult::Cancelled);
        }
        let mut materials = Vec::with_capacity(profiles.len());
        for host in &profiles {
            let credential = self.read(host).await?;
            let CredentialResult::Material { credential } = self
                .credential(CredentialCommand::EnsureIdentity {
                    host: host.clone(),
                    credential,
                })
                .await?
            else {
                return Err(SshWorkflowError::InvalidRoute);
            };
            if credential.secret.is_empty() {
                return Err(SshWorkflowError::MissingCredential);
            }
            materials.push(credential);
        }
        // Recheck metadata and pin the material after identity recovery/generation.
        let current = self.canonical_hosts().await?;
        for (host, material) in profiles.iter().zip(&materials) {
            if !current.iter().any(|saved| saved == host) || self.read(host).await? != *material {
                return Err(SshWorkflowError::InvalidRoute);
            }
        }
        let route = profiles
            .iter()
            .zip(materials)
            .map(|(host, material)| config(host, material))
            .collect::<Result<Vec<_>>>()?;
        let mut approved = HashSet::new();
        loop {
            self.control.check()?;
            match transport
                .mutate(&self.request, route.clone(), self.control.clone())
                .await
            {
                Ok(result) => {
                    self.control.check()?;
                    return Ok(result);
                }
                Err(error) => {
                    let Some(challenge) = unknown_challenge(&error) else {
                        return Err(error);
                    };
                    if self.control.mutation_started.load(Ordering::Acquire) {
                        return Err(error);
                    }
                    validate_challenge(&challenge, &route, &approved)?;
                    let known = self
                        .known_hosts
                        .view()
                        .map_err(|_| SshWorkflowError::TrustUnavailable)?;
                    if known.status != KnownHostRepositoryStatus::Loaded {
                        return Err(SshWorkflowError::TrustUnavailable);
                    }
                    if known.hosts.iter().any(|host| {
                        host.host == challenge.host
                            && host.port == challenge.port
                            && (host.public_key != challenge.public_key
                                || host.key_type != challenge.key_type)
                    }) {
                        return Err(SshWorkflowError::InvalidChallenge);
                    }
                    if !self
                        .prompt(|permit| self.platform.confirm_host_key(permit, challenge.clone()))
                        .await?
                    {
                        return Ok(SshWorkflowResult::Cancelled);
                    }
                    self.control.check()?;
                    let view = self
                        .known_hosts
                        .begin_workflow_trust(challenge.clone(), &known, self.control.clone())
                        .result()
                        .await
                        .map_err(|_| SshWorkflowError::TrustUnavailable)?;
                    self.control.check()?;
                    if view.status != KnownHostRepositoryStatus::Loaded
                        || !view.hosts.iter().any(|host| {
                            host.host == challenge.host
                                && host.port == challenge.port
                                && host.key_type == challenge.key_type
                                && host.public_key == challenge.public_key
                                && host.fingerprint == challenge.fingerprint
                        })
                    {
                        return Err(SshWorkflowError::TrustUnavailable);
                    }
                    approved.insert((challenge.host.clone(), challenge.port));
                    self.prompt(|permit| self.platform.host_key_trusted(permit, challenge))
                        .await?;
                }
            }
        }
    }
}
fn config(host: &HostProfileRecord, material: CredentialMaterial) -> Result<HostSshConfig> {
    let port = host
        .port
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or(SshWorkflowError::InvalidRoute)?;
    if host.host.trim().is_empty() || host.username.trim().is_empty() {
        return Err(SshWorkflowError::InvalidRoute);
    }
    Ok(HostSshConfig {
        host: host.host.trim().into(),
        port,
        username: host.username.trim().into(),
        forward_agent: false,
        tailcat_address: host
            .tailcat_enabled
            .then(|| material.tailcat_address.unwrap_or_default()),
        tailcat_private_key: host
            .tailcat_enabled
            .then(|| material.tailcat_private_key.unwrap_or_default()),
        tailcat_ssh_server: host.tailcat_enabled && host.tailcat_ssh_server,
        credential: match host.auth_mode {
            HostAuthMode::Password => HostSshCredential::Password {
                password: material.secret,
            },
            HostAuthMode::Key => HostSshCredential::Key {
                private_key: material.secret.replace("\\n", "\n").trim().to_owned(),
                passphrase: (!material.passphrase.is_empty()).then_some(material.passphrase),
            },
        },
    })
}
fn unknown_challenge(error: &SshWorkflowError) -> Option<HostKeyChallenge> {
    match error {
        SshWorkflowError::Pairing(PairHostError::HostKeyUnknown(challenge))
        | SshWorkflowError::Installation(HostRuntimeError::HostKeyUnknown(challenge)) => {
            Some(challenge.clone())
        }
        _ => None,
    }
}
fn validate_challenge(
    challenge: &HostKeyChallenge,
    route: &[HostSshConfig],
    approved: &HashSet<(String, u16)>,
) -> Result<()> {
    if !route.iter().any(|host| {
        let (name, port) = if host.tailcat_ssh_server {
            (format!("tailcat-ssh:{}", host.host), 22)
        } else {
            (host.host.clone(), host.port)
        };
        name == challenge.host && port == challenge.port
    }) || approved.contains(&(challenge.host.clone(), challenge.port))
        || approved.len() >= route.len()
    {
        return Err(SshWorkflowError::InvalidChallenge);
    }
    let key = crate::inspect_public_key(challenge.public_key.clone(), false)
        .map_err(|_| SshWorkflowError::InvalidChallenge)?;
    if key.fingerprint != challenge.fingerprint
        || key.key_type != challenge.key_type
        || key.public_key != challenge.public_key
    {
        return Err(SshWorkflowError::InvalidChallenge);
    }
    Ok(())
}
