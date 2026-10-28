//! Notification keys cross the bridge only into the platform Keychain adapter.
use super::host_runtime::HostRuntimeError;
use whip_notify::{Envelope, KeyPair, ReplayLedger};

fn failure() -> HostRuntimeError {
    HostRuntimeError::InvalidConfiguration("Notification authentication failed".into())
}

#[uniffi::export]
pub fn notification_key_generate() -> Result<String, HostRuntimeError> {
    let key = whip_notify::generate_key().map_err(|_| failure())?;
    let json = serde_json::json!({
        "private_key": key.private_key,
        "public_key": key.public_key,
        "key_id": whip_notify::key_id(&key.public_key)
    });
    serde_json::to_string(&json).map_err(|_| failure())
}

#[uniffi::export]
pub fn notification_token_generate() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[uniffi::export]
pub fn notification_open(
    key_json: String,
    host_key: String,
    device_id: String,
    envelope_json: String,
    ledger_json: String,
) -> Result<String, HostRuntimeError> {
    let key_json = whip_notify::Zeroizing::new(key_json);
    let result = (|| -> whip_notify::Result<String> {
        if key_json.len() > 1024 || envelope_json.len() > 3072 || ledger_json.len() > 4_000_000 {
            return Err("oversize notification".into());
        }
        let key: KeyPair = serde_json::from_str(&key_json)?;
        let envelope: Envelope = serde_json::from_str(&envelope_json)?;
        let mut ledger: ReplayLedger = serde_json::from_str(&ledger_json)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        let event = whip_notify::decrypt(&key, &host_key, &device_id, &envelope, now)?;
        ledger.accept(&envelope.header, now)?;
        Ok(serde_json::to_string(
            &serde_json::json!({"event": event, "ledger": ledger}),
        )?)
    })();
    result.map_err(|_| failure())
}
