//! Versioned, padded HPKE Auth envelopes shared by the host and mobile Rust core.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use hpke_rs::{Hpke, HpkePrivateKey, HpkePublicKey, Mode};
use hpke_rs_crypto::types::{AeadAlgorithm, KdfAlgorithm, KemAlgorithm};
use hpke_rs_rust_crypto::HpkeRustCrypto;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub use zeroize::Zeroizing;

#[cfg(feature = "host")]
pub mod host;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const VERSION: u8 = 1;
pub const PADDED_BYTES: usize = 1024;
pub const MAX_AGE_SECONDS: u64 = 86_400;
const INFO: &[u8] = b"whip-notify/hpke-auth/x25519-hkdf-sha256-chacha20poly1305/v1";

fn suite() -> Hpke<HpkeRustCrypto> {
    Hpke::new(
        Mode::Auth,
        KemAlgorithm::DhKem25519,
        KdfAlgorithm::HkdfSha256,
        AeadAlgorithm::ChaCha20Poly1305,
    )
}

#[derive(Serialize, Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub struct KeyPair {
    pub private_key: String,
    pub public_key: String,
}

pub fn generate_key() -> Result<KeyPair> {
    let keys = suite()
        .generate_key_pair()
        .map_err(|_| "HPKE key generation failed")?;
    Ok(KeyPair {
        private_key: B64.encode(keys.private_key().as_slice()),
        public_key: B64.encode(keys.public_key().as_slice()),
    })
}

pub fn key_id(public_key: &str) -> String {
    B64.encode(Sha256::digest(public_key.as_bytes()))
}

pub fn valid_id(id: &str) -> bool {
    (16..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn public_key(value: &str) -> Result<HpkePublicKey> {
    let bytes = B64.decode(value)?;
    if bytes.len() != 32 || bytes.iter().all(|b| *b == 0) {
        return Err("invalid X25519 key".into());
    }
    Ok(HpkePublicKey::new(bytes))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub version: u8,
    pub host_id: String,
    pub device_id: String,
    pub key_id: String,
    pub event_id: String,
    pub issued_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub header: Header,
    pub enc: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NotificationEvent {
    pub pane_id: String,
    pub workspace_id: String,
    pub session: String,
    pub status: String,
    pub title: Option<String>,
}

impl Header {
    pub fn validate(&self) -> Result<()> {
        if self.version != VERSION
            || ![&self.host_id, &self.device_id, &self.key_id, &self.event_id]
                .into_iter()
                .all(|s| valid_id(s))
        {
            return Err("invalid notification header".into());
        }
        Ok(())
    }
    fn aad(&self) -> Result<Vec<u8>> {
        self.validate()?;
        // Ordered tuple avoids JSON object ordering differences in future native readers.
        Ok(serde_json::to_vec(&(
            INFO,
            self.version,
            &self.host_id,
            &self.device_id,
            &self.key_id,
            &self.event_id,
            self.issued_at,
        ))?)
    }
}

pub fn encrypt(
    host: &KeyPair,
    recipient: &str,
    header: Header,
    event: &NotificationEvent,
) -> Result<Envelope> {
    if header.host_id != key_id(&host.public_key) || header.key_id != key_id(recipient) {
        return Err("identity mismatch".into());
    }
    let json = Zeroizing::new(serde_json::to_vec(event)?);
    if json.len() > PADDED_BYTES - 2 {
        return Err("event too large".into());
    }
    let mut padded = Zeroizing::new(vec![0; PADDED_BYTES]);
    padded[..2].copy_from_slice(&(json.len() as u16).to_be_bytes());
    padded[2..json.len() + 2].copy_from_slice(&json);
    let sk = HpkePrivateKey::new(B64.decode(&host.private_key)?);
    let (enc, ct) = suite()
        .seal(
            &public_key(recipient)?,
            INFO,
            &header.aad()?,
            &padded,
            None,
            None,
            Some(&sk),
        )
        .map_err(|_| "HPKE encryption failed")?;
    Ok(Envelope {
        header,
        enc: B64.encode(enc),
        ciphertext: B64.encode(ct),
    })
}

pub fn decrypt(
    device: &KeyPair,
    pinned_host_key: &str,
    expected_device: &str,
    envelope: &Envelope,
    now: u64,
) -> Result<NotificationEvent> {
    let h = &envelope.header;
    if h.host_id != key_id(pinned_host_key)
        || h.device_id != expected_device
        || h.key_id != key_id(&device.public_key)
    {
        return Err("wrong host, device, or key".into());
    }
    if h.issued_at > now.saturating_add(300) || now.saturating_sub(h.issued_at) > MAX_AGE_SECONDS {
        return Err("notification expired or future dated".into());
    }
    let enc = B64.decode(&envelope.enc)?;
    let ct = B64.decode(&envelope.ciphertext)?;
    if enc.len() != 32 || ct.len() != PADDED_BYTES + 16 {
        return Err("invalid envelope length".into());
    }
    let bytes = Zeroizing::new(
        suite()
            .open(
                &enc,
                &HpkePrivateKey::new(B64.decode(&device.private_key)?),
                INFO,
                &h.aad()?,
                &ct,
                None,
                None,
                Some(&public_key(pinned_host_key)?),
            )
            .map_err(|_| "HPKE authentication failed")?,
    );
    let len = usize::from(u16::from_be_bytes([bytes[0], bytes[1]]));
    let json = bytes.get(2..len + 2).ok_or("invalid padding")?;
    let event: NotificationEvent = serde_json::from_slice(json)?;
    if !matches!(event.status.as_str(), "blocked" | "done") || event.pane_id.is_empty() {
        return Err("invalid event".into());
    }
    Ok(event)
}

/// Persist this ledger before acting on a decrypted event. Never evict a live ID.
#[derive(Default, Serialize, Deserialize)]
pub struct ReplayLedger(pub std::collections::BTreeMap<String, u64>);
impl ReplayLedger {
    pub fn accept(&mut self, header: &Header, now: u64) -> Result<()> {
        self.0.retain(|_, expires| *expires >= now);
        let id = format!("{}:{}:{}", header.host_id, header.key_id, header.event_id);
        if self.0.contains_key(&id) {
            return Err("replayed notification".into());
        }
        if self.0.len() >= 16_384 {
            return Err("replay ledger full; rotate registration".into());
        }
        self.0
            .insert(id, header.issued_at.saturating_add(MAX_AGE_SECONDS + 300));
        Ok(())
    }
}
