//! OpenSSH known_hosts parsing and verification for the Whip SSH core.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use russh::keys::PublicKey;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};

#[derive(Debug, Default)]
pub struct KnownHosts {
    entries: Vec<Entry>,
}

#[derive(Debug)]
struct Entry {
    hosts: Vec<String>,
    algorithm: String,
    key: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyChallenge {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TrustedHostKey {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub public_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum KnownHostStoreError {
    #[error("trusted host name is empty")]
    EmptyHost,
    #[error("trusted host port must be between 1 and 65535, received {0}")]
    InvalidPort(u16),
    #[error("trusted host key is malformed: {0}")]
    MalformedKey(String),
    #[error("trusted host key type {0} does not match decoded key type {1}")]
    KeyTypeMismatch(String, String),
    #[error("known-host id is empty")]
    EmptyId,
    #[error("known-host fingerprint is empty")]
    EmptyFingerprint,
    #[error("known-host creation timestamp is empty")]
    EmptyCreatedAt,
    #[error("persisted known-host data is malformed: {0}")]
    MalformedPersistedData(String),
    #[error("known-host mutation {0} is not active")]
    InvalidMutation(u64),
    #[error("known-host mutation {0} must be persisted or rolled back first")]
    MutationInProgress(u64),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostRecord {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub public_key: String,
    pub fingerprint: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownHostStoreView {
    pub revision: u64,
    pub hosts: Vec<KnownHostRecord>,
    pub persisted_value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownHostMutation {
    pub token: u64,
    pub changed: bool,
    pub view: KnownHostStoreView,
}

#[derive(Debug)]
struct PendingKnownHostMutation {
    token: u64,
    hosts: Vec<KnownHostRecord>,
}

#[derive(Debug, Default)]
struct KnownHostDomainState {
    revision: u64,
    next_token: u64,
    hosts: Vec<KnownHostRecord>,
    pending: Option<PendingKnownHostMutation>,
}

pub struct KnownHostStore {
    state: Mutex<KnownHostDomainState>,
}

impl KnownHostStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(KnownHostDomainState::default()),
        })
    }

    pub fn hydrate(
        &self,
        persisted: Option<String>,
    ) -> Result<KnownHostStoreView, KnownHostStoreError> {
        let hosts = persisted.map_or_else(
            || Ok(Vec::new()),
            |value| {
                serde_json::from_str::<Vec<KnownHostRecord>>(&value)
                    .map_err(|error| KnownHostStoreError::MalformedPersistedData(error.to_string()))
            },
        )?;
        let hosts = normalize_records(hosts)?;
        install_records(&hosts)?;
        let mut state = self.state.lock();
        state.hosts = hosts;
        state.pending = None;
        state.revision = state.revision.saturating_add(1);
        view(&state.hosts, state.revision)
    }

    pub fn view(&self) -> Result<KnownHostStoreView, KnownHostStoreError> {
        let state = self.state.lock();
        view(&state.hosts, state.revision)
    }

    pub fn prepare_add(
        &self,
        challenge: HostKeyChallenge,
        id: String,
        created_at: String,
    ) -> Result<KnownHostMutation, KnownHostStoreError> {
        let mut state = self.state.lock();
        ensure_no_pending(&state)?;
        let candidate = normalize_record(KnownHostRecord {
            id,
            host: challenge.host,
            port: challenge.port,
            key_type: challenge.key_type,
            public_key: challenge.public_key,
            fingerprint: challenge.fingerprint,
            created_at,
        })?;
        if state.hosts.iter().any(|host| duplicate(host, &candidate)) {
            return Ok(KnownHostMutation {
                token: 0,
                changed: false,
                view: view(&state.hosts, state.revision)?,
            });
        }
        let mut hosts = state.hosts.clone();
        hosts.push(candidate);
        let hosts = normalize_records(hosts)?;
        validate_records(&hosts)?;
        state.next_token = state.next_token.saturating_add(1).max(1);
        let token = state.next_token;
        let mutation_view = view(&hosts, state.revision.saturating_add(1))?;
        state.pending = Some(PendingKnownHostMutation { token, hosts });
        let mutation = KnownHostMutation {
            token,
            changed: true,
            view: mutation_view,
        };
        drop(state);
        Ok(mutation)
    }

    pub fn prepare_remove(&self, id: String) -> Result<KnownHostMutation, KnownHostStoreError> {
        let mut state = self.state.lock();
        ensure_no_pending(&state)?;
        let hosts = state
            .hosts
            .iter()
            .filter(|host| host.id != id)
            .cloned()
            .collect::<Vec<_>>();
        if hosts.len() == state.hosts.len() {
            return Ok(KnownHostMutation {
                token: 0,
                changed: false,
                view: view(&state.hosts, state.revision)?,
            });
        }
        validate_records(&hosts)?;
        state.next_token = state.next_token.saturating_add(1).max(1);
        let token = state.next_token;
        let mutation_view = view(&hosts, state.revision.saturating_add(1))?;
        state.pending = Some(PendingKnownHostMutation { token, hosts });
        let mutation = KnownHostMutation {
            token,
            changed: true,
            view: mutation_view,
        };
        drop(state);
        Ok(mutation)
    }

    pub fn commit(&self, token: u64) -> Result<KnownHostStoreView, KnownHostStoreError> {
        let mut state = self.state.lock();
        let Some(pending) = state.pending.take() else {
            return Err(KnownHostStoreError::InvalidMutation(token));
        };
        if pending.token != token {
            state.pending = Some(pending);
            return Err(KnownHostStoreError::InvalidMutation(token));
        }
        if let Err(error) = install_records(&pending.hosts) {
            state.pending = Some(pending);
            return Err(error);
        }
        state.hosts = pending.hosts;
        state.revision = state.revision.saturating_add(1);
        view(&state.hosts, state.revision)
    }

    pub fn rollback(&self, token: u64) -> Result<KnownHostStoreView, KnownHostStoreError> {
        let mut state = self.state.lock();
        if state.pending.as_ref().map(|pending| pending.token) != Some(token) {
            return Err(KnownHostStoreError::InvalidMutation(token));
        }
        state.pending = None;
        install_records(&state.hosts)?;
        view(&state.hosts, state.revision)
    }
}

fn ensure_no_pending(state: &KnownHostDomainState) -> Result<(), KnownHostStoreError> {
    state.pending.as_ref().map_or(Ok(()), |pending| {
        Err(KnownHostStoreError::MutationInProgress(pending.token))
    })
}

fn view(
    hosts: &[KnownHostRecord],
    revision: u64,
) -> Result<KnownHostStoreView, KnownHostStoreError> {
    Ok(KnownHostStoreView {
        revision,
        hosts: hosts.to_vec(),
        persisted_value: serde_json::to_string(hosts)
            .map_err(|error| KnownHostStoreError::MalformedPersistedData(error.to_string()))?,
    })
}

fn normalize_records(
    hosts: Vec<KnownHostRecord>,
) -> Result<Vec<KnownHostRecord>, KnownHostStoreError> {
    let mut normalized = hosts
        .into_iter()
        .map(normalize_record)
        .collect::<Result<Vec<_>, _>>()?;
    normalized.sort_by(|left, right| {
        left.host
            .to_lowercase()
            .cmp(&right.host.to_lowercase())
            .then(left.port.cmp(&right.port))
            .then(left.key_type.cmp(&right.key_type))
            .then(left.id.cmp(&right.id))
    });
    Ok(normalized)
}

fn normalize_record(mut record: KnownHostRecord) -> Result<KnownHostRecord, KnownHostStoreError> {
    record.id = record.id.trim().to_owned();
    if record.id.is_empty() {
        return Err(KnownHostStoreError::EmptyId);
    }
    record.host = record.host.trim().to_owned();
    normalize_host(&record.host)?;
    if record.port == 0 {
        return Err(KnownHostStoreError::InvalidPort(record.port));
    }
    record.key_type = record.key_type.trim().to_owned();
    record.public_key = record.public_key.trim().to_owned();
    record.fingerprint = record.fingerprint.trim().to_owned();
    if record.fingerprint.is_empty() {
        return Err(KnownHostStoreError::EmptyFingerprint);
    }
    record.created_at = record.created_at.trim().to_owned();
    if record.created_at.is_empty() {
        return Err(KnownHostStoreError::EmptyCreatedAt);
    }
    KnownHosts::from_trusted(vec![trusted(&record)])?;
    Ok(record)
}

fn trusted(record: &KnownHostRecord) -> TrustedHostKey {
    TrustedHostKey {
        host: record.host.clone(),
        port: record.port,
        key_type: record.key_type.clone(),
        public_key: record.public_key.clone(),
    }
}

fn install_records(records: &[KnownHostRecord]) -> Result<(), KnownHostStoreError> {
    let parsed = KnownHosts::from_trusted(records.iter().map(trusted).collect())?;
    *super::known_hosts().write() = parsed;
    Ok(())
}

fn validate_records(records: &[KnownHostRecord]) -> Result<(), KnownHostStoreError> {
    KnownHosts::from_trusted(records.iter().map(trusted).collect()).map(|_| ())
}

fn duplicate(left: &KnownHostRecord, right: &KnownHostRecord) -> bool {
    left.host.eq_ignore_ascii_case(&right.host)
        && left.port == right.port
        && left.key_type == right.key_type
        && left.fingerprint == right.fingerprint
}

#[derive(Debug)]
pub enum HostKeyDecision {
    Trusted,
    Unknown(HostKeyChallenge),
    Changed(HostKeyChallenge),
}

impl KnownHosts {
    pub fn parse(contents: &str) -> Self {
        let entries = contents
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
                    return None;
                }
                let mut fields = line.split_whitespace();
                let hosts = fields.next()?.split(',').map(str::to_owned).collect();
                let algorithm = fields.next()?.to_owned();
                let key = base64::engine::general_purpose::STANDARD
                    .decode(fields.next()?)
                    .ok()?;
                Some(Entry {
                    hosts,
                    algorithm,
                    key,
                })
            })
            .collect();
        Self { entries }
    }

    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> HostKeyDecision {
        let encoded_key = key.to_bytes().unwrap_or_default();
        let normalized_host = normalized_host(host);
        let canonical_host = canonical_host(&normalized_host, port);
        let algorithm = key.algorithm();
        let mut host_matched = false;
        let trusted = self.entries.iter().any(|entry| {
            let matches_host = entry
                .hosts
                .iter()
                .any(|candidate| host_matches(candidate, &canonical_host));
            host_matched |= matches_host;
            matches_host && entry.algorithm == algorithm.as_str() && entry.key == encoded_key
        });
        if trusted {
            return HostKeyDecision::Trusted;
        }
        let challenge = HostKeyChallenge::new(&normalized_host, port, key, encoded_key);
        if host_matched {
            HostKeyDecision::Changed(challenge)
        } else {
            HostKeyDecision::Unknown(challenge)
        }
    }

    pub fn from_trusted(entries: Vec<TrustedHostKey>) -> Result<Self, KnownHostStoreError> {
        let entries = entries
            .into_iter()
            .map(|entry| {
                let host = normalize_host(&entry.host)?;
                if entry.port == 0 {
                    return Err(KnownHostStoreError::InvalidPort(entry.port));
                }
                let encoded = public_key_base64(&entry.key_type, &entry.public_key)?;
                let key = russh::keys::parse_public_key_base64(encoded)
                    .map_err(|error| KnownHostStoreError::MalformedKey(error.to_string()))?;
                let decoded_type = key.algorithm().as_str().to_owned();
                if decoded_type != entry.key_type {
                    return Err(KnownHostStoreError::KeyTypeMismatch(
                        entry.key_type,
                        decoded_type,
                    ));
                }
                Ok(Entry {
                    hosts: vec![canonical_host(&host, entry.port)],
                    algorithm: key.algorithm().as_str().to_owned(),
                    key: key
                        .to_bytes()
                        .map_err(|error| KnownHostStoreError::MalformedKey(error.to_string()))?,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { entries })
    }
}

fn normalize_host(host: &str) -> Result<String, KnownHostStoreError> {
    let host = normalized_host(host);
    if host.is_empty() {
        return Err(KnownHostStoreError::EmptyHost);
    }
    Ok(host)
}

fn normalized_host(host: &str) -> String {
    let host = host.trim();
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
        .to_lowercase()
}

fn canonical_host(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    }
}

fn public_key_base64<'a>(
    key_type: &str,
    public_key: &'a str,
) -> Result<&'a str, KnownHostStoreError> {
    let mut fields = public_key.split_whitespace();
    let first = fields
        .next()
        .ok_or_else(|| KnownHostStoreError::MalformedKey("key is empty".to_owned()))?;
    if first.starts_with("ssh-") || first.starts_with("ecdsa-") || first.starts_with("sk-") {
        if first != key_type {
            return Err(KnownHostStoreError::KeyTypeMismatch(
                key_type.to_owned(),
                first.to_owned(),
            ));
        }
        fields
            .next()
            .ok_or_else(|| KnownHostStoreError::MalformedKey("key body is missing".to_owned()))
    } else {
        Ok(first)
    }
}

fn host_matches(pattern: &str, canonical_host: &str) -> bool {
    if pattern == canonical_host {
        return true;
    }
    let Some(hashed) = pattern.strip_prefix("|1|") else {
        return false;
    };
    let mut fields = hashed.split('|');
    let (Some(salt), Some(expected), None) = (fields.next(), fields.next(), fields.next()) else {
        return false;
    };
    let Ok(salt) = base64::engine::general_purpose::STANDARD.decode(salt) else {
        return false;
    };
    let Ok(expected) = base64::engine::general_purpose::STANDARD.decode(expected) else {
        return false;
    };
    Hmac::<Sha1>::new_from_slice(&salt).is_ok_and(|mut hmac| {
        hmac.update(canonical_host.as_bytes());
        hmac.verify_slice(&expected).is_ok()
    })
}

impl HostKeyChallenge {
    fn new(host: &str, port: u16, key: &PublicKey, encoded_key: Vec<u8>) -> Self {
        let digest = Sha256::digest(&encoded_key);
        let fingerprint = format!(
            "SHA256:{}",
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest),
        );
        let key_type = key.algorithm().as_str().to_owned();
        let public_key = format!(
            "{} {}",
            key_type,
            base64::engine::general_purpose::STANDARD.encode(encoded_key),
        );
        Self {
            host: host.to_owned(),
            port,
            key_type,
            fingerprint,
            public_key,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> russh::keys::PrivateKey {
        let mut rng =
            russh::keys::ssh_key::rand_core::UnwrapErr(russh::keys::ssh_key::getrandom::SysRng);
        russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519).unwrap()
    }

    fn trusted(host: &str, port: u16, key: &russh::keys::PrivateKey) -> TrustedHostKey {
        TrustedHostKey {
            host: host.to_owned(),
            port,
            key_type: key.public_key().algorithm().as_str().to_owned(),
            public_key: key.public_key().to_openssh().unwrap(),
        }
    }

    fn record(id: &str, host: &str, key: &russh::keys::PrivateKey) -> KnownHostRecord {
        KnownHostRecord {
            id: id.to_owned(),
            host: host.to_owned(),
            port: 22,
            key_type: key.public_key().algorithm().as_str().to_owned(),
            public_key: key.public_key().to_openssh().unwrap(),
            fingerprint: format!("SHA256:{id}"),
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
        }
    }

    #[test]
    fn parser_ignores_comments_and_invalid_lines() {
        let parsed = KnownHosts::parse("# comment\ninvalid\nexample.com ssh-ed25519 AAAA\n");
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].hosts, ["example.com"]);
    }

    #[test]
    fn matches_hashed_hosts_and_scopes_nonstandard_ports() {
        use base64::engine::general_purpose::STANDARD;

        let salt = b"russh-known-hosts-test";
        let mut hmac = Hmac::<Sha1>::new_from_slice(salt).unwrap();
        hmac.update(b"[example.com]:2222");
        let pattern = format!(
            "|1|{}|{}",
            STANDARD.encode(salt),
            STANDARD.encode(hmac.finalize().into_bytes())
        );
        assert!(host_matches(&pattern, "[example.com]:2222"));
        assert!(!host_matches(&pattern, "example.com"));
        assert!(!host_matches("example.com", "[example.com]:2222"));

        let key = test_key();
        let contents = format!(
            "{pattern} {} {}\n",
            key.public_key().algorithm().as_str(),
            STANDARD.encode(key.public_key().to_bytes().unwrap())
        );
        let known = KnownHosts::parse(&contents);
        assert!(matches!(
            known.check("example.com", 2222, key.public_key()),
            HostKeyDecision::Trusted
        ));
    }

    #[test]
    fn structured_keys_normalize_dns_names_and_support_default_and_nonstandard_ports() {
        let key = test_key();
        let default = KnownHosts::from_trusted(vec![trusted("Example.COM", 22, &key)]).unwrap();
        assert!(matches!(
            default.check("example.com", 22, key.public_key()),
            HostKeyDecision::Trusted
        ));

        let nonstandard =
            KnownHosts::from_trusted(vec![trusted("192.0.2.10", 2222, &key)]).unwrap();
        assert!(matches!(
            nonstandard.check("192.0.2.10", 2222, key.public_key()),
            HostKeyDecision::Trusted
        ));
        assert!(matches!(
            nonstandard.check("192.0.2.10", 22, key.public_key()),
            HostKeyDecision::Unknown(_)
        ));
    }

    #[test]
    fn structured_keys_support_ipv6_hosts() {
        let key = test_key();
        let known = KnownHosts::from_trusted(vec![trusted("[2001:db8::1]", 2222, &key)]).unwrap();
        assert!(matches!(
            known.check("2001:DB8::1", 2222, key.public_key()),
            HostKeyDecision::Trusted
        ));
    }

    #[test]
    fn structured_keys_reject_invalid_ports_and_key_material() {
        let key = test_key();
        assert!(matches!(
            KnownHosts::from_trusted(vec![trusted("example.com", 0, &key)]),
            Err(KnownHostStoreError::InvalidPort(0))
        ));
        assert!(matches!(
            KnownHosts::from_trusted(vec![TrustedHostKey {
                host: "example.com".to_owned(),
                port: 22,
                key_type: "ssh-ed25519".to_owned(),
                public_key: "not-base64".to_owned(),
            }]),
            Err(KnownHostStoreError::MalformedKey(_))
        ));
        assert!(matches!(
            KnownHosts::from_trusted(vec![TrustedHostKey {
                host: "example.com".to_owned(),
                port: 22,
                key_type: "ssh-rsa".to_owned(),
                public_key: key.public_key().to_openssh().unwrap(),
            }]),
            Err(KnownHostStoreError::KeyTypeMismatch(_, _))
        ));
    }

    #[test]
    fn different_key_for_a_known_alias_is_changed_not_unknown() {
        let trusted_key = test_key();
        let received_key = test_key();
        let known =
            KnownHosts::from_trusted(vec![trusted("example.com", 22, &trusted_key)]).unwrap();
        assert!(matches!(
            known.check("example.com", 22, received_key.public_key()),
            HostKeyDecision::Changed(_)
        ));
    }

    #[test]
    fn canonical_store_hydrates_validates_and_sorts_records() {
        let first_key = test_key();
        let second_key = test_key();
        let store = KnownHostStore::new();
        let persisted = serde_json::to_string(&vec![
            record("second", "z.example", &second_key),
            record("first", "a.example", &first_key),
        ])
        .unwrap();

        let view = store.hydrate(Some(persisted)).unwrap();

        assert_eq!(
            view.hosts
                .iter()
                .map(|host| host.id.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert_eq!(
            serde_json::from_str::<Vec<KnownHostRecord>>(&view.persisted_value).unwrap(),
            view.hosts
        );
    }

    #[test]
    fn canonical_store_rejects_malformed_persisted_data() {
        let store = KnownHostStore::new();
        assert!(matches!(
            store.hydrate(Some("{not json".to_owned())),
            Err(KnownHostStoreError::MalformedPersistedData(_))
        ));
    }

    #[test]
    fn duplicate_add_is_noop_but_same_host_different_key_is_allowed() {
        let first_key = test_key();
        let second_key = test_key();
        let store = KnownHostStore::new();
        let first = record("first", "same.example", &first_key);
        store
            .hydrate(Some(serde_json::to_string(&vec![first.clone()]).unwrap()))
            .unwrap();
        let duplicate = HostKeyChallenge {
            host: first.host,
            port: first.port,
            key_type: first.key_type,
            fingerprint: first.fingerprint,
            public_key: first.public_key,
        };

        assert!(
            !store
                .prepare_add(
                    duplicate,
                    "duplicate".to_owned(),
                    "2026-01-02T00:00:00.000Z".to_owned(),
                )
                .unwrap()
                .changed
        );

        let second = record("second", "same.example", &second_key);
        let mutation = store
            .prepare_add(
                HostKeyChallenge {
                    host: second.host,
                    port: second.port,
                    key_type: second.key_type,
                    fingerprint: second.fingerprint,
                    public_key: second.public_key,
                },
                second.id,
                second.created_at,
            )
            .unwrap();
        assert!(mutation.changed);
        assert_eq!(mutation.view.hosts.len(), 2);
    }

    #[test]
    fn rollback_preserves_committed_state_and_pending_mutations_serialize() {
        let first_key = test_key();
        let second_key = test_key();
        let store = KnownHostStore::new();
        let first = record("first", "a.example", &first_key);
        store
            .hydrate(Some(serde_json::to_string(&vec![first.clone()]).unwrap()))
            .unwrap();
        let second = record("second", "b.example", &second_key);
        let mutation = store
            .prepare_add(
                HostKeyChallenge {
                    host: second.host,
                    port: second.port,
                    key_type: second.key_type,
                    fingerprint: second.fingerprint,
                    public_key: second.public_key,
                },
                second.id,
                second.created_at,
            )
            .unwrap();

        assert!(matches!(
            store.prepare_remove(first.id.clone()),
            Err(KnownHostStoreError::MutationInProgress(_))
        ));
        assert!(matches!(
            store.commit(mutation.token + 1),
            Err(KnownHostStoreError::InvalidMutation(_))
        ));
        let rolled_back = store.rollback(mutation.token).unwrap();

        assert_eq!(rolled_back.hosts, vec![first]);
    }
}
