//! Application-owned remote registration lifecycle. Platform callbacks only perform
//! vault, push-SDK and HTTP effects; secrets never enter a presentation projection.
use std::{collections::HashMap, future::Future, sync::Arc, time::Duration};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Mutex;

use crate::host_runtime::{HostRuntime, get_host_runtime};

const ENCRYPTION_PREFERENCE: &str = "whip.notify.e2ee.v1.";
const REPLAYS: &str = "whip.notify.replays.v1.";
const VERIFICATION_TIMEOUT: Duration = Duration::from_secs(45);
const INSTALL_PROGRESS_POLL: Duration = Duration::from_millis(500);
const LEASE_PULSE_INTERVAL_MS: u32 = 3000;
const LEASE_PULSE_INTERVAL: Duration = Duration::from_millis(LEASE_PULSE_INTERVAL_MS as u64);

#[derive(Clone, Debug, thiserror::Error, uniffi::Error)]
pub enum NotificationError {
    #[error("{message}")]
    Failed { message: String },
}

impl From<uniffi::UnexpectedUniFFICallbackError> for NotificationError {
    fn from(error: uniffi::UnexpectedUniFFICallbackError) -> Self {
        failure(error.reason)
    }
}

fn failure(message: impl Into<String>) -> NotificationError {
    NotificationError::Failed {
        message: message.into(),
    }
}

type Result<T> = std::result::Result<T, NotificationError>;

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum NotificationRelayMethod {
    Put,
    Post,
    Delete,
}

#[derive(Clone, uniffi::Record)]
pub struct NotificationRelayRequest {
    pub url: String,
    pub method: NotificationRelayMethod,
    pub management_token: String,
    pub body: Option<String>,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct NotificationRelayResponse {
    pub status: u16,
    pub code: Option<String>,
}

#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait NotificationPlatform: Send + Sync {
    async fn read_registrations(&self) -> Result<Option<String>>;
    async fn write_registrations(&self, value: String) -> Result<()>;
    async fn read_data(&self, key: String) -> Result<Option<String>>;
    async fn write_data(&self, key: String, value: Option<String>) -> Result<()>;
    async fn push_token(&self) -> Result<String>;
    // Must attach the listener before returning, including for an immediate push.
    async fn begin_verification(&self, device_id: String) -> Result<()>;
    async fn verification_proof(&self, device_id: String) -> Result<String>;
    fn cancel_verification(&self, device_id: String);
    async fn relay_request(
        &self,
        request: NotificationRelayRequest,
    ) -> Result<NotificationRelayResponse>;
    fn changed(&self);
    fn install_progress(&self, host_id: String, progress: NotificationPluginInstallProgress);
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct RemoteNotificationState {
    pub host_id: String,
    pub relay_url: String,
    pub enabled: bool,
    pub connected: bool,
    pub pending_host_removal: bool,
    pub end_to_end_encrypted: bool,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct NotificationConsumerState {
    pub watch_push_token: bool,
    pub pulse: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct RemoteNotificationTarget {
    pub notification_id: String,
    pub host_id: String,
    pub pane_id: String,
    pub remote_device_id: String,
}

#[derive(Clone, Debug, Deserialize, uniffi::Record)]
pub struct NotificationPluginState {
    pub installed: bool,
    pub enabled: bool,
    pub version: Option<String>,
    pub install_command: Option<String>,
    pub update_available: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize, uniffi::Enum)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationInstallStage {
    CheckingHost,
    CheckingRelease,
    Downloading,
    Enabling,
    Verifying,
    Complete,
}

#[derive(Clone, Debug, Deserialize, uniffi::Record)]
pub struct NotificationPluginInstallProgress {
    pub stage: NotificationInstallStage,
    pub completed_stages: Vec<NotificationInstallStage>,
    pub elapsed_ms: u64,
    pub timeout_ms: u64,
    pub running: bool,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Paths {
    config: String,
    state: String,
    binary: String,
    #[serde(default)]
    notification_previews: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct Keys {
    private_key: String,
    public_key: String,
    key_id: String,
}

#[derive(Deserialize)]
struct Identity {
    public_key: String,
    host_id: String,
}
#[derive(Deserialize)]
struct Discovery {
    paths: Paths,
    identity: Identity,
    session: String,
}

// Preserve the existing Keychain schema so upgrades retain keys, pins and
// cleanup capabilities. An absent legacy encryption setting means encrypted.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registration {
    host_id: String,
    device_id: String,
    keys: Keys,
    host_key: String,
    host_identity: String,
    management_token: String,
    route_token: String,
    relay_url: String,
    session: String,
    paths: Paths,
    enabled: bool,
    pending_host_removal: bool,
    relay_revoked: bool,
    #[serde(default = "legacy_encryption")]
    end_to_end_encrypted: bool,
    #[serde(default)]
    forget_after_host_removal: bool,
    // Only a confirmed relay challenge can populate this device/host cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    verified_expo_token: Option<String>,
}
fn legacy_encryption() -> bool {
    true
}

#[async_trait::async_trait]
trait NotificationHost: Send + Sync {
    fn identity(&self) -> (String, u64);
    async fn command(&self, operation: &str, payload: Value) -> Result<Value>;
}

#[async_trait::async_trait]
impl NotificationHost for HostRuntime {
    fn identity(&self) -> (String, u64) {
        (self.runtime_id(), self.runtime_incarnation())
    }
    async fn command(&self, operation: &str, payload: Value) -> Result<Value> {
        let value = self
            .notification_command(operation.into(), payload.to_string())
            .await
            .map_err(|error| failure(error.to_string()))?;
        if value.is_empty() {
            Ok(Value::Null)
        } else {
            decode(&value)
        }
    }
}

type Host = Arc<dyn NotificationHost>;
struct Manager {
    platform: Arc<dyn NotificationPlatform>,
    registrations: Mutex<Option<Vec<Registration>>>,
    operations: Mutex<()>,
    pending_commands: AtomicUsize,
    hosts: RwLock<HashMap<String, Host>>,
}

impl Manager {
    async fn load(&self) -> Result<Vec<Registration>> {
        let mut cache = self.registrations.lock().await;
        if cache.is_none() {
            let stored = self
                .platform
                .read_registrations()
                .await?
                .map(whip_notify::Zeroizing::new);
            *cache = Some(match stored {
                Some(value) if value.len() <= 4_000_000 => decode(&value)?,
                Some(_) => {
                    return Err(failure(
                        "Notification registration data is too large; data was preserved",
                    ));
                }
                None => Vec::new(),
            });
        }
        Ok(cache.as_ref().cloned().unwrap_or_default())
    }

    async fn save(&self, registrations: Vec<Registration>) -> Result<()> {
        let stored = serde_json::to_string(&registrations)
            .map_err(|_| failure("Could not encode notification registration data"))?;
        self.platform.write_registrations(stored).await?;
        *self.registrations.lock().await = Some(registrations);
        self.platform.changed();
        Ok(())
    }

    fn host(&self, host_id: &str) -> Result<Host> {
        self.hosts
            .read()
            .get(host_id)
            .cloned()
            .ok_or_else(|| failure("Connect to this saved host to manage its notification plugin"))
    }

    fn require_current(&self, host_id: &str, host: &Host) -> Result<()> {
        if self
            .hosts
            .read()
            .get(host_id)
            .is_some_and(|current| current.identity() == host.identity())
        {
            Ok(())
        } else {
            Err(failure(
                "The notification host connection changed; try again",
            ))
        }
    }

    async fn states(&self) -> Result<Vec<RemoteNotificationState>> {
        Ok(self
            .load()
            .await?
            .into_iter()
            .map(|r| RemoteNotificationState {
                connected: self.hosts.read().contains_key(&r.host_id),
                host_id: r.host_id,
                relay_url: r.relay_url,
                enabled: r.enabled,
                pending_host_removal: r.pending_host_removal,
                end_to_end_encrypted: r.end_to_end_encrypted,
            })
            .collect())
    }

    async fn encryption(&self, host_id: &str, registration: Option<&Registration>) -> Result<bool> {
        if let Some(registration) = registration {
            return Ok(registration.end_to_end_encrypted);
        }
        Ok(self
            .platform
            .read_data(format!("{ENCRYPTION_PREFERENCE}{host_id}"))
            .await?
            .as_deref()
            == Some("true"))
    }

    async fn discover(&self, registration: &Registration, host: &Host) -> Result<Discovery> {
        let discovery: Discovery = decode_value(host.command("discover", json!({})).await?)?;
        if discovery.identity.public_key != registration.host_key
            || discovery.identity.host_id != registration.host_identity
            || discovery.session != registration.session
        {
            return Err(failure(
                "The notification host or Herdr session changed; register this device again",
            ));
        }
        self.require_current(&registration.host_id, host)?;
        Ok(discovery)
    }

    async fn register_host(&self, registration: &Registration, host: &Host) -> Result<()> {
        require_preview_support(&registration.paths, registration.end_to_end_encrypted)?;
        self.require_current(&registration.host_id, host)?;
        let mut payload = json!({
            "device_id": registration.device_id, "public_key": registration.keys.public_key,
            "relay_url": registration.relay_url, "route_token": registration.route_token,
            "session": registration.session,
        });
        if registration.paths.notification_previews {
            payload["end_to_end_encrypted"] = registration.end_to_end_encrypted.into();
        }
        host.command(
            "register",
            json!({"paths": registration.paths, "registration": payload}),
        )
        .await?;
        self.require_current(&registration.host_id, host)
    }

    async fn relay(
        &self,
        registration: &Registration,
        method: NotificationRelayMethod,
        token: Option<&str>,
        challenge: Option<&str>,
    ) -> Result<()> {
        let body = match method {
            NotificationRelayMethod::Put => Some(
                json!({"protocol": 2, "expo_token": token,
                "route_token": registration.route_token, "host_id": registration.host_identity,
                "key_id": registration.keys.key_id})
                .to_string(),
            ),
            NotificationRelayMethod::Post => Some(json!({"challenge": challenge}).to_string()),
            NotificationRelayMethod::Delete => None,
        };
        let response = self
            .platform
            .relay_request(NotificationRelayRequest {
                url: format!(
                    "{}/v1/devices/{}",
                    registration.relay_url, registration.device_id
                ),
                method,
                management_token: registration.management_token.clone(),
                body,
            })
            .await?;
        if !(200..300).contains(&response.status) {
            let action = match method {
                NotificationRelayMethod::Put => "registration",
                NotificationRelayMethod::Post => "verification",
                NotificationRelayMethod::Delete => "cleanup",
            };
            let reason = if response.code.as_deref() == Some("PUSH_PROVIDER_AUTH_FAILED") {
                "The relay’s push service credentials need updating. Contact the relay administrator."
            } else {
                relay_failure_reason(response.status)
            };
            return Err(failure(format!(
                "Notification relay {action} failed (HTTP {}). {reason}",
                response.status
            )));
        }
        if matches!(method, NotificationRelayMethod::Put) && response.status != 202 {
            return Err(failure(
                "This notification relay needs an update for automatic registration",
            ));
        }
        Ok(())
    }

    async fn verify_relay(&self, registration: &Registration, token: &str) -> Result<()> {
        self.platform
            .begin_verification(registration.device_id.clone())
            .await?;
        let _cancel = CancelProof {
            platform: self.platform.clone(),
            device_id: registration.device_id.clone(),
        };
        let challenge = async {
            tokio::time::timeout(
                VERIFICATION_TIMEOUT,
                self.platform
                    .verification_proof(registration.device_id.clone()),
            )
            .await
            .map_err(|_| {
                failure("Push verification timed out. Keep Whip open and try enabling push again.")
            })?
        };
        let ((), challenge) = tokio::try_join!(
            self.relay(
                registration,
                NotificationRelayMethod::Put,
                Some(token),
                None
            ),
            challenge
        )?;
        if challenge.len() != 43 || !whip_notify::valid_id(&challenge) {
            return Err(failure("Invalid notification registration proof"));
        }
        self.relay(
            registration,
            NotificationRelayMethod::Post,
            None,
            Some(&challenge),
        )
        .await
    }

    async fn enable(
        &self,
        host_id: String,
        relay_url: String,
        encryption: Option<bool>,
    ) -> Result<()> {
        let _operation = self.operations.lock().await;
        let host = self.host(&host_id)?;
        let mut values = self.load().await?;
        let previous = values.iter().find(|r| r.host_id == host_id);
        if previous.is_some_and(|r| !r.relay_revoked || r.pending_host_removal) {
            return Err(failure(
                "Finish disabling the previous registration before rotating keys",
            ));
        }
        let relay_url = relay_origin(&relay_url)?;
        let token = self.platform.push_token().await?;
        let discovery: Discovery = decode_value(host.command("discover", json!({})).await?)?;
        self.require_current(&host_id, &host)?;
        let encrypted = match encryption {
            Some(value) => value,
            None => self.encryption(&host_id, previous).await?,
        };
        require_preview_support(&discovery.paths, encrypted)?;
        self.platform
            .write_data(
                format!("{ENCRYPTION_PREFERENCE}{host_id}"),
                Some(encrypted.to_string()),
            )
            .await?;
        let keys = crate::notification_crypto::notification_key_generate()
            .map_err(|error| failure(error.to_string()))?;
        let registration = Registration {
            host_id: host_id.clone(),
            device_id: crate::notification_crypto::notification_token_generate(),
            keys: decode(&keys)?,
            host_key: discovery.identity.public_key,
            host_identity: discovery.identity.host_id,
            management_token: crate::notification_crypto::notification_token_generate(),
            route_token: crate::notification_crypto::notification_token_generate(),
            relay_url,
            session: discovery.session,
            paths: discovery.paths,
            enabled: false,
            pending_host_removal: false,
            relay_revoked: false,
            end_to_end_encrypted: encrypted,
            forget_after_host_removal: false,
            verified_expo_token: None,
        };
        values.retain(|r| r.host_id != host_id);
        values.push(registration.clone());
        // Keys and management capability must be durable before either sender exists.
        self.save(values.clone()).await?;
        if let Err(error) = self.verify_relay(&registration, &token).await {
            if self
                .relay(&registration, NotificationRelayMethod::Delete, None, None)
                .await
                .is_ok()
            {
                if let Some(record) = values.last_mut() {
                    record.relay_revoked = true;
                }
                // A failed cleanup write still retains the original capability.
                let _ = self.save(values).await;
            }
            return Err(error);
        }
        self.register_host(&registration, &host).await?;
        if let Some(record) = values.last_mut() {
            record.enabled = true;
            record.verified_expo_token = Some(token);
        }
        self.save(values).await
    }

    async fn refresh_push_token(&self) -> Result<()> {
        let _operation = self.operations.lock().await;
        let mut values = self.load().await?;
        if !values
            .iter()
            .any(|r| r.enabled && !r.relay_revoked && !r.pending_host_removal)
        {
            return Ok(());
        }
        let token = self.platform.push_token().await?;
        let pending: Vec<_> = values
            .iter_mut()
            .filter(|r| {
                r.enabled
                    && !r.relay_revoked
                    && !r.pending_host_removal
                    && r.verified_expo_token.as_deref() != Some(token.as_str())
            })
            .collect();
        // Finish every host's attempt and persist successes even if another
        // host fails, so retries never reverify an already confirmed token.
        let results =
            futures::future::join_all(pending.iter().map(|r| self.verify_relay(r, &token))).await;
        let mut changed = false;
        let mut error = None;
        for (registration, result) in pending.into_iter().zip(results) {
            match result {
                Ok(()) => {
                    registration.verified_expo_token = Some(token.clone());
                    changed = true;
                }
                Err(failure) => {
                    error.get_or_insert(failure);
                }
            }
        }
        if changed {
            self.save(values).await?;
        }
        error.map_or(Ok(()), Err)
    }

    async fn set_encryption(&self, host_id: String, encrypted: bool) -> Result<()> {
        let _operation = self.operations.lock().await;
        let mut values = self.load().await?;
        if let Some(index) = values.iter().position(|r| r.host_id == host_id) {
            let registration = values[index].clone();
            if !registration.enabled && !registration.relay_revoked {
                return Err(failure(
                    "Finish unregistering the previous registration before changing encryption",
                ));
            }
            values[index].end_to_end_encrypted = encrypted;
            if registration.enabled {
                let host = self.host(&host_id)?;
                values[index].paths = self.discover(&registration, &host).await?.paths;
                require_preview_support(&values[index].paths, encrypted)?;
                // Record disclosure before it can start; claim encryption only
                // after the sender acknowledges that disclosure has stopped.
                if !encrypted {
                    self.save(values.clone()).await?;
                }
                self.register_host(&values[index], &host).await?;
            }
            if encrypted || !registration.enabled {
                self.save(values).await?;
            }
        }
        self.platform
            .write_data(
                format!("{ENCRYPTION_PREFERENCE}{host_id}"),
                Some(encrypted.to_string()),
            )
            .await?;
        self.platform.changed();
        Ok(())
    }

    async fn disable(&self, host_id: &str, forget: bool) -> Result<()> {
        let mut values = self.load().await?;
        let Some(index) = values.iter().position(|r| r.host_id == host_id) else {
            return Ok(());
        };
        values[index].enabled = false;
        values[index].verified_expo_token = None;
        values[index].pending_host_removal = true;
        values[index].forget_after_host_removal = forget;
        // Stop local acceptance and lease renewal even if relay cleanup fails.
        self.save(values.clone()).await?;
        self.relay(&values[index], NotificationRelayMethod::Delete, None, None)
            .await?;
        self.platform
            .write_data(format!("{REPLAYS}{}", values[index].device_id), None)
            .await?;
        values[index].relay_revoked = true;
        if forget {
            values[index].keys.private_key.clear();
        }
        // Retain an independently durable SSH cleanup tombstone.
        self.save(values.clone()).await?;
        let host = self.hosts.read().get(host_id).cloned();
        if let Some(host) = host {
            self.remove_from_host(&values[index], &host).await?;
            values[index].pending_host_removal = false;
        }
        if forget && !values[index].pending_host_removal {
            values.remove(index);
        }
        self.save(values).await
    }

    async fn remove_from_host(&self, registration: &Registration, host: &Host) -> Result<()> {
        self.require_current(&registration.host_id, host)?;
        host.command(
            "unregister",
            json!({"paths": registration.paths, "device_id": registration.device_id}),
        )
        .await?;
        self.require_current(&registration.host_id, host)
    }

    async fn cleanup_host(&self, host_id: String, host: Host) -> Result<()> {
        let _operation = self.operations.lock().await;
        self.require_current(&host_id, &host)?;
        let mut values = self.load().await?;
        if let Some(index) = values
            .iter()
            .position(|r| r.host_id == host_id && r.pending_host_removal)
        {
            self.remove_from_host(&values[index], &host).await?;
            values[index].pending_host_removal = false;
            if values[index].forget_after_host_removal && values[index].relay_revoked {
                values.remove(index);
            }
            self.save(values).await?;
        }
        Ok(())
    }

    async fn renew(&self, received: tokio::time::Instant) -> Result<()> {
        // Pulses never queue behind enrollment/cleanup: a delayed pulse is no
        // longer evidence that the JS consumer can deliver an alert now.
        if self.pending_commands.load(Ordering::Acquire) != 0 {
            return Ok(());
        }
        let Ok(_operation) = self.operations.try_lock() else {
            return Ok(());
        };
        let values = self.load().await?;
        let renewals = values.into_iter().filter(|r| r.enabled).map(|registration| async move {
            let host = self.hosts.read().get(&registration.host_id).cloned();
            if let Some(host) = host
                && received.elapsed() < LEASE_PULSE_INTERVAL
                && self.require_current(&registration.host_id, &host).is_ok() {
                // HostRuntime additionally checks monitoring, freshness, event
                // subscription and the event sink before touching the lease.
                let _ = host.command("renew", json!({"paths": registration.paths, "device_id": registration.device_id})).await;
            }
        });
        futures::future::join_all(renewals).await;
        Ok(())
    }

    async fn target(
        &self,
        data: String,
        notification_id: String,
    ) -> Result<Option<RemoteNotificationTarget>> {
        let _operation = self.operations.lock().await;
        if data.len() > 16_384 {
            return Err(failure("Notification authentication failed"));
        }
        let data: Value = decode(&data)?;
        let Some(payload) = data.get("whip_notify").filter(|value| !value.is_null()) else {
            return Ok(None);
        };
        let values = self.load().await?;
        let registration = values
            .iter()
            .find(|r| r.enabled && payload["header"]["device_id"].as_str() == Some(&r.device_id))
            .ok_or_else(|| failure("Notification registration is unavailable or revoked"))?;
        let ledger_key = format!("{REPLAYS}{}", registration.device_id);
        let keys = serde_json::to_string(&registration.keys)
            .map_err(|_| failure("Notification authentication failed"))?;
        let opened = crate::notification_crypto::notification_open(
            keys,
            registration.host_key.clone(),
            registration.device_id.clone(),
            payload.to_string(),
            self.platform
                .read_data(ledger_key.clone())
                .await?
                .unwrap_or_else(|| "{}".into()),
        )
        .map_err(|error| failure(error.to_string()))?;
        let opened: Value = decode(&opened)?;
        if opened["event"]["session"].as_str() != Some(&registration.session) {
            return Err(failure("Notification session mismatch"));
        }
        let pane_id = opened["event"]["pane_id"]
            .as_str()
            .ok_or_else(|| failure("Notification authentication failed"))?
            .to_owned();
        // Never expose a target until the replay receipt is durably committed.
        self.platform
            .write_data(ledger_key, Some(opened["ledger"].to_string()))
            .await?;
        Ok(Some(RemoteNotificationTarget {
            notification_id,
            host_id: registration.host_id.clone(),
            pane_id,
            remote_device_id: registration.device_id.clone(),
        }))
    }

    async fn read_progress(&self, host_id: &str, host: &Host, finished: bool) {
        if let Ok(value) = host.command("plugin-install-progress", json!({})).await
            && let Ok(progress) = decode_value::<NotificationPluginInstallProgress>(value)
            && (finished || progress.running)
            && self.require_current(host_id, host).is_ok()
        {
            self.platform.install_progress(host_id.to_owned(), progress);
        }
    }

    async fn install(&self, host_id: String) -> Result<()> {
        let _operation = self.operations.lock().await;
        let host = self.host(&host_id)?;
        let installation = host.command("plugin-install", json!({}));
        tokio::pin!(installation);
        let result = loop {
            tokio::select! {
                result = &mut installation => break result,
                () = tokio::time::sleep(INSTALL_PROGRESS_POLL) => self.read_progress(&host_id, &host, false).await,
            }
        };
        self.read_progress(&host_id, &host, true).await;
        result?;
        self.require_current(&host_id, &host)?;
        self.platform.changed();
        Ok(())
    }
}

struct CancelProof {
    platform: Arc<dyn NotificationPlatform>,
    device_id: String,
}
impl Drop for CancelProof {
    fn drop(&mut self) {
        self.platform.cancel_verification(self.device_id.clone());
    }
}

fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value)
        .map_err(|_| failure("Invalid notification data; stored data was preserved"))
}
fn decode_value<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| failure("Invalid notification host response"))
}
fn require_preview_support(paths: &Paths, encrypted: bool) -> Result<()> {
    if !encrypted && !paths.notification_previews {
        Err(failure(
            "Update whip-notify on this host to support notification previews",
        ))
    } else {
        Ok(())
    }
}
fn relay_origin(value: &str) -> Result<String> {
    let url = url::Url::parse(value).map_err(|_| failure("Enter the HTTPS relay origin"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(failure("Enter the HTTPS relay origin"));
    }
    Ok(url.origin().ascii_serialization())
}
fn relay_failure_reason(status: u16) -> &'static str {
    match status {
        400 => "The relay could not accept this registration. Update Whip and try again.",
        401 => "The relay could not authenticate this registration.",
        403 => {
            "The relay could not authorize this registration. Unregister and try enabling again."
        }
        404 => "The notification relay endpoint was not found. Check the custom relay URL.",
        409 => "Push verification is already in progress. Wait two minutes and try again.",
        410 => "This device’s push token is no longer valid. Restart Whip and try again.",
        426 => "Update Whip to register with this notification relay.",
        429 => "Too many notification requests. Wait a minute and try again.",
        503 => "The relay or push provider is unavailable. Try again shortly.",
        _ => "Try again shortly.",
    }
}

type OperationResult = Result<Option<RemoteNotificationTarget>>;
type QueuedOperation = (
    futures::future::BoxFuture<'static, OperationResult>,
    tokio::sync::watch::Sender<Option<OperationResult>>,
    Arc<Manager>,
);

/// Completion of an already-admitted native operation. Waiting or dropping the
/// UI promise cannot reorder or cancel its durable lifecycle transitions.
#[derive(uniffi::Object)]
pub struct NotificationOperation {
    result: tokio::sync::watch::Receiver<Option<OperationResult>>,
}

#[uniffi::export]
impl NotificationOperation {
    pub async fn wait(&self) -> Result<()> {
        self.target().await.map(|_| ())
    }
    pub async fn target(&self) -> Result<Option<RemoteNotificationTarget>> {
        let mut result = self.result.clone();
        loop {
            let completed = result.borrow_and_update().clone();
            if let Some(completed) = completed {
                return completed;
            }
            result
                .changed()
                .await
                .map_err(|_| failure("Notification operation stopped unexpectedly"))?;
        }
    }
}

/// One application-lifetime owner, independent of connected host lifetimes.
#[derive(uniffi::Object)]
pub struct NotificationManager {
    inner: Arc<Manager>,
    queue: tokio::sync::mpsc::UnboundedSender<QueuedOperation>,
    refresh: parking_lot::Mutex<Option<Arc<NotificationOperation>>>,
}

impl NotificationManager {
    fn from_inner(inner: Arc<Manager>) -> Result<Arc<Self>> {
        let (queue, mut work) = tokio::sync::mpsc::unbounded_channel::<QueuedOperation>();
        crate::runtime().map_err(failure)?.spawn(async move {
            while let Some((operation, completed, owner)) = work.recv().await {
                let result = tokio::spawn(operation).await.unwrap_or_else(|_| {
                    Err(failure("Notification operation stopped unexpectedly"))
                });
                owner.pending_commands.fetch_sub(1, Ordering::Release);
                let _ = completed.send(Some(result));
            }
        });
        Ok(Arc::new(Self {
            inner,
            queue,
            refresh: parking_lot::Mutex::new(None),
        }))
    }

    // This method is synchronous across UniFFI. Channel admission happens in
    // the caller's order, before the completion future can be polled elsewhere.
    fn admit<F: Future<Output = OperationResult> + Send + 'static>(
        &self,
        work: impl FnOnce(Arc<Manager>) -> F,
    ) -> Result<Arc<NotificationOperation>> {
        let (completed, result) = tokio::sync::watch::channel(None);
        self.inner.pending_commands.fetch_add(1, Ordering::Release);
        if self
            .queue
            .send((
                Box::pin(work(self.inner.clone())),
                completed,
                self.inner.clone(),
            ))
            .is_err()
        {
            self.inner.pending_commands.fetch_sub(1, Ordering::Release);
            return Err(failure("Notification operation queue is unavailable"));
        }
        Ok(Arc::new(NotificationOperation { result }))
    }

    async fn run<T: Send + 'static, F: Future<Output = Result<T>> + Send + 'static>(
        &self,
        work: impl FnOnce(Arc<Manager>) -> F,
    ) -> Result<T> {
        crate::runtime()
            .map_err(failure)?
            .spawn(work(self.inner.clone()))
            .await
            .map_err(|_| failure("Notification operation stopped unexpectedly"))?
    }
}

#[uniffi::export]
impl NotificationManager {
    #[uniffi::constructor]
    pub fn new(platform: Arc<dyn NotificationPlatform>) -> Result<Arc<Self>> {
        Self::from_inner(Arc::new(Manager {
            platform,
            registrations: Mutex::new(None),
            operations: Mutex::new(()),
            pending_commands: AtomicUsize::new(0),
            hosts: RwLock::new(HashMap::new()),
        }))
    }

    pub fn attach_runtime(
        &self,
        host_id: String,
        runtime_id: String,
        incarnation: u64,
    ) -> Result<()> {
        let runtime = get_host_runtime(runtime_id)
            .filter(|runtime| runtime.runtime_incarnation() == incarnation)
            .ok_or_else(|| failure("Notification host connection is unavailable"))?;
        let host: Host = runtime;
        self.inner
            .hosts
            .write()
            .insert(host_id.clone(), host.clone());
        self.inner.platform.changed();
        // Cleanup shares the same admission order as explicit user commands.
        // Its tombstone survives a failed host operation for a later retry.
        self.admit(|inner| async move {
            inner.cleanup_host(host_id, host).await?;
            Ok(None)
        })?;
        Ok(())
    }

    pub fn detach_runtime(&self, host_id: String, runtime_id: String, incarnation: u64) {
        let mut hosts = self.inner.hosts.write();
        if hosts
            .get(&host_id)
            .is_some_and(|host| host.identity() == (runtime_id, incarnation))
        {
            hosts.remove(&host_id);
        }
        drop(hosts);
        self.inner.platform.changed();
    }

    pub async fn states(&self) -> Result<Vec<RemoteNotificationState>> {
        self.run(|inner| async move { inner.states().await }).await
    }
    pub async fn consumer_state(&self) -> Result<NotificationConsumerState> {
        self.run(|inner| async move {
            let values = inner.load().await?;
            let hosts = inner.hosts.read();
            Ok(NotificationConsumerState {
                watch_push_token: values.iter().any(|r| r.enabled),
                pulse: values
                    .iter()
                    .any(|r| r.enabled && hosts.contains_key(&r.host_id)),
            })
        })
        .await
    }
    pub async fn encryption(&self, host_id: String) -> Result<bool> {
        self.run(|inner| async move {
            let values = inner.load().await?;
            inner
                .encryption(&host_id, values.iter().find(|r| r.host_id == host_id))
                .await
        })
        .await
    }
    pub fn set_encryption(
        &self,
        host_id: String,
        encrypted: bool,
    ) -> Result<Arc<NotificationOperation>> {
        self.admit(|inner| async move {
            inner.set_encryption(host_id, encrypted).await?;
            Ok(None)
        })
    }
    pub fn enable(
        &self,
        host_id: String,
        relay_url: String,
        encrypted: Option<bool>,
    ) -> Result<Arc<NotificationOperation>> {
        self.admit(|inner| async move {
            inner.enable(host_id, relay_url, encrypted).await?;
            Ok(None)
        })
    }
    pub fn disable(&self, host_id: String, forget: bool) -> Result<Arc<NotificationOperation>> {
        self.admit(|inner| async move {
            let _operation = inner.operations.lock().await;
            inner.disable(&host_id, forget).await?;
            Ok(None)
        })
    }
    pub fn consumer_pulse(&self) -> Result<Arc<NotificationOperation>> {
        // Timestamp the synchronous bridge call, before executor scheduling.
        // This evidence must never enter the lifecycle FIFO.
        let received = tokio::time::Instant::now();
        let inner = self.inner.clone();
        let (completed, result) = tokio::sync::watch::channel(None);
        crate::runtime().map_err(failure)?.spawn(async move {
            let outcome = inner.renew(received).await.map(|()| None);
            let _ = completed.send(Some(outcome));
        });
        Ok(Arc::new(NotificationOperation { result }))
    }
    pub fn refresh_push_token(&self) -> Result<Arc<NotificationOperation>> {
        // Coalesce at synchronous admission, including failed attempts. A later
        // event can retry after completion; overlapping events share one proof.
        let mut refresh = self.refresh.lock();
        if let Some(operation) = refresh.as_ref()
            && operation.result.borrow().is_none()
        {
            return Ok(operation.clone());
        }
        let operation = self.admit(|inner| async move {
            inner.refresh_push_token().await?;
            Ok(None)
        })?;
        *refresh = Some(operation.clone());
        drop(refresh);
        Ok(operation)
    }
    pub fn notification_target(
        &self,
        data: String,
        notification_id: String,
    ) -> Result<Arc<NotificationOperation>> {
        self.admit(|inner| async move { inner.target(data, notification_id).await })
    }
    pub fn verify_host(
        &self,
        host_id: String,
        device_id: String,
        runtime_id: String,
        incarnation: u64,
    ) -> Result<Arc<NotificationOperation>> {
        self.admit(|inner| async move {
            let _operation = inner.operations.lock().await;
            let values = inner.load().await?;
            let registration = values
                .iter()
                .find(|r| r.enabled && r.host_id == host_id && r.device_id == device_id)
                .ok_or_else(|| failure("Notification registration was revoked"))?;
            let host = inner.host(&host_id)?;
            if host.identity() != (runtime_id, incarnation) {
                return Err(failure(
                    "The notification host connection changed; try again",
                ));
            }
            inner.discover(registration, &host).await?;
            Ok(None)
        })
    }
    pub async fn plugin_state(&self, host_id: String) -> Result<Option<NotificationPluginState>> {
        self.run(|inner| async move {
            let host = inner.hosts.read().get(&host_id).cloned();
            match host {
                Some(host) => Ok(Some(decode_value(
                    host.command("plugin-status", json!({})).await?,
                )?)),
                None => Ok(None),
            }
        })
        .await
    }
    pub fn install_plugin(&self, host_id: String) -> Result<Arc<NotificationOperation>> {
        self.admit(|inner| async move {
            inner.install(host_id).await?;
            Ok(None)
        })
    }
    pub fn uninstall_plugin(&self, host_id: String) -> Result<Arc<NotificationOperation>> {
        self.admit(|inner| async move {
            let _operation = inner.operations.lock().await;
            let host = inner.host(&host_id)?;
            let cleanup_failed = if let Err(error) = inner.disable(&host_id, true).await {
                if inner.load().await?.iter().any(|r| r.host_id == host_id && r.enabled) { return Err(error); }
                true
            } else { false };
            inner.require_current(&host_id, &host)?;
            host.command("plugin-uninstall", json!({})).await?;
            inner.platform.changed();
            if cleanup_failed { return Err(failure("Host plugin uninstalled; retry Unregister to finish this device’s relay cleanup")); }
            Ok(None)
        })
    }
}

#[uniffi::export]
pub fn notification_lease_pulse_interval_ms() -> u32 {
    LEASE_PULSE_INTERVAL_MS
}

#[cfg(test)]
mod tests;
