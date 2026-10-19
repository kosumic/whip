use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use russh::{
    ChannelMsg, client,
    keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ssh_key::{PrivateKey, private::Ed25519Keypair};
use tokio::time::timeout;

use crate::host_runtime::{HostSshConfig, disconnect_sessions, ssh_config};
use crate::ssh::{SshFailure, SshSession};

const ENVELOPE_PREFIX: &str = "WP4:";
const BASE45_ALPHABET: &[u8; 45] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const ADDRESS_IPV4: u8 = 1;
const ADDRESS_IPV6: u8 = 2;
const ADDRESS_HOSTNAME: u8 = 3;
const MAX_HOSTNAME_BYTES: usize = 253;
const MAX_BASE45_BYTES: usize = 461;
const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const ED25519_SEED_BYTES: usize = 32;
const SHA256_BYTES: usize = 32;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const APPROVAL_TIMEOUT: Duration = Duration::from_mins(10);

#[derive(Debug, thiserror::Error)]
pub(crate) enum PairingError {
    #[error("pairing code has the wrong prefix or version")]
    BadPrefix,
    #[error("pairing code is not valid Base45")]
    BadEncoding,
    #[error("pairing code contains an invalid SSH profile")]
    BadPayload,
    #[error("SSH pairing connection timed out")]
    ConnectionTimeout,
    #[error("host approval timed out")]
    ApprovalTimeout,
    #[error("temporary SSH authentication failed")]
    AuthenticationFailed,
    #[error("SSH host key did not match the fingerprint pinned in the QR code")]
    HostKeyMismatch,
    #[error("SSH host certificates are not supported for pairing")]
    UnsupportedHostCertificate,
    #[error("restricted pairing command returned invalid data")]
    InvalidResponse,
    #[error("restricted pairing command failed: {0}")]
    CommandFailed(String),
    #[error("enrollment refused ({code}): {message}")]
    Refused { code: String, message: String },
    #[error("{0}")]
    Ssh(#[from] russh::Error),
    #[error("{0}")]
    SshKey(#[from] ssh_key::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("jump host: {0}")]
    JumpHost(#[from] SshFailure),
}

#[derive(Default)]
struct PairingJumpSessions(Vec<Arc<SshSession>>);

impl Drop for PairingJumpSessions {
    fn drop(&mut self) {
        let sessions = std::mem::take(&mut self.0);
        if !sessions.is_empty()
            && let Ok(runtime) = crate::runtime()
        {
            runtime.spawn(disconnect_sessions(sessions));
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct PairHostResult {
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_user: String,
    pub ssh_host_fingerprint: String,
    pub ssh_host_key_type: String,
    pub ssh_host_public_key: String,
    pub key_fingerprint: Option<String>,
    pub already_present: bool,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct PairingPayload {
    ssh_host: String,
    ssh_port: u16,
    ssh_user: String,
    temporary_private_key_seed: [u8; ED25519_SEED_BYTES],
    ssh_host_key_sha256: [u8; SHA256_BYTES],
}

#[derive(Serialize)]
struct EnrollmentRequest<'a> {
    device_name: &'a str,
    public_key: &'a str,
}

#[derive(Deserialize)]
struct EnrollmentResponse {
    approved: bool,
    fingerprint: Option<String>,
    already_present: Option<bool>,
    code: Option<String>,
    message: Option<String>,
}

#[derive(Clone)]
struct PinnedSshHostKey {
    expected_sha256: [u8; SHA256_BYTES],
    accepted: Arc<Mutex<Option<AcceptedHostKey>>>,
}

#[derive(Clone)]
struct AcceptedHostKey {
    key_type: String,
    public_key: String,
}

impl PinnedSshHostKey {
    fn verify_server_key(
        &self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, PairingError> {
        let PublicKeyOrCertificate::PublicKey {
            key: server_public_key,
            ..
        } = server_public_key
        else {
            return Err(PairingError::UnsupportedHostCertificate);
        };
        let encoded = server_public_key.to_bytes()?;
        let actual: [u8; SHA256_BYTES] = Sha256::digest(&encoded).into();
        if actual != self.expected_sha256 {
            return Err(PairingError::HostKeyMismatch);
        }
        if let Ok(mut accepted) = self.accepted.lock() {
            *accepted = Some(AcceptedHostKey {
                key_type: server_public_key.algorithm().as_str().to_owned(),
                public_key: server_public_key.to_openssh()?,
            });
        }
        Ok(true)
    }
}

impl client::Handler for PinnedSshHostKey {
    type Error = PairingError;

    fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        std::future::ready(self.verify_server_key(server_public_key))
    }
}

pub(crate) async fn pair_host(
    code: &str,
    public_key: &str,
    device_name: &str,
    jump_hosts: &[HostSshConfig],
) -> Result<PairHostResult, PairingError> {
    let payload = decode_pairing_code(code.trim())?;
    let public_key = public_key.trim();
    if public_key.is_empty() || public_key.len() > 4096 || public_key.chars().any(char::is_control)
    {
        return Err(PairingError::InvalidResponse);
    }

    let accepted_host_key = Arc::new(Mutex::new(None));
    let handler = PinnedSshHostKey {
        expected_sha256: payload.ssh_host_key_sha256,
        accepted: accepted_host_key.clone(),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        nodelay: true,
        ..Default::default()
    });
    let mut jumps = PairingJumpSessions::default();
    for jump in jump_hosts {
        let mut connection = ssh_config(jump);
        connection.forward_agent = false;
        let session = timeout(
            CONNECT_TIMEOUT,
            SshSession::connect(&connection, jumps.0.last().map(Arc::as_ref)),
        )
        .await
        .map_err(|_| PairingError::ConnectionTimeout)??;
        jumps.0.push(session);
    }
    let mut handle = timeout(CONNECT_TIMEOUT, async {
        if let Some(jump) = jumps.0.last() {
            let stream = jump
                .open_direct_tcpip(&payload.ssh_host, payload.ssh_port)
                .await?;
            Ok::<_, PairingError>(client::connect_stream(config, stream, handler).await?)
        } else {
            Ok(client::connect(
                config,
                (payload.ssh_host.as_str(), payload.ssh_port),
                handler,
            )
            .await?)
        }
    })
    .await
    .map_err(|_| PairingError::ConnectionTimeout)??;

    let private_key = Arc::new(temporary_private_key(&payload.temporary_private_key_seed));
    let authentication = handle
        .authenticate_publickey(
            &payload.ssh_user,
            PrivateKeyWithHashAlg::new(private_key, None),
        )
        .await?;
    if !authentication.success() {
        return Err(PairingError::AuthenticationFailed);
    }

    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, "whipair").await?;
    let device_name = printable_device_name(device_name);
    let mut encoded = serde_json::to_vec(&EnrollmentRequest {
        device_name: &device_name,
        public_key,
    })?;
    encoded.push(b'\n');
    channel.data(encoded.as_slice()).await?;
    channel.eof().await?;

    let (stdout, stderr, exit_status) = timeout(APPROVAL_TIMEOUT, async {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_status = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => append_bounded(&mut stdout, &data)?,
                ChannelMsg::ExtendedData { data, ext: 1 } => append_bounded(&mut stderr, &data)?,
                ChannelMsg::ExitStatus { exit_status: value } => exit_status = Some(value),
                _ => {}
            }
        }
        Ok::<_, PairingError>((stdout, stderr, exit_status))
    })
    .await
    .map_err(|_| PairingError::ApprovalTimeout)??;
    if exit_status.is_some_and(|status| status != 0) {
        return Err(PairingError::CommandFailed(
            String::from_utf8_lossy(&stderr).trim().to_owned(),
        ));
    }

    let response: EnrollmentResponse = serde_json::from_slice(trim_line_ending(&stdout))
        .map_err(|_| PairingError::InvalidResponse)?;
    if !response.approved {
        return Err(PairingError::Refused {
            code: response.code.unwrap_or_else(|| "unknown".into()),
            message: response.message.unwrap_or_else(|| "no detail".into()),
        });
    }
    let accepted = accepted_host_key
        .lock()
        .ok()
        .and_then(|key| key.clone())
        .ok_or(PairingError::InvalidResponse)?;
    let ssh_host_fingerprint = format!(
        "SHA256:{}",
        STANDARD_NO_PAD.encode(payload.ssh_host_key_sha256)
    );

    Ok(PairHostResult {
        ssh_host: payload.ssh_host,
        ssh_port: payload.ssh_port,
        ssh_user: payload.ssh_user,
        ssh_host_fingerprint,
        ssh_host_key_type: accepted.key_type,
        ssh_host_public_key: accepted.public_key,
        key_fingerprint: response.fingerprint,
        already_present: response.already_present.unwrap_or(false),
    })
}

fn temporary_private_key(seed: &[u8; ED25519_SEED_BYTES]) -> PrivateKey {
    Ed25519Keypair::from_seed(seed).into()
}

fn append_bounded(destination: &mut Vec<u8>, source: &[u8]) -> Result<(), PairingError> {
    if destination.len().saturating_add(source.len()) > MAX_MESSAGE_BYTES {
        return Err(PairingError::InvalidResponse);
    }
    destination.extend_from_slice(source);
    Ok(())
}

fn trim_line_ending(bytes: &[u8]) -> &[u8] {
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    bytes.strip_suffix(b"\r").unwrap_or(bytes)
}

fn printable_device_name(value: &str) -> String {
    let value: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect();
    if value.trim().is_empty() {
        "Whip".into()
    } else {
        value
    }
}

fn decode_pairing_code(code: &str) -> Result<PairingPayload, PairingError> {
    let body = code
        .strip_prefix(ENVELOPE_PREFIX)
        .ok_or(PairingError::BadPrefix)?;
    let decoded = base45_decode(body)?;
    let mut cursor = 0;
    let address_type = take_bytes(&decoded, &mut cursor, 1)?
        .first()
        .copied()
        .ok_or(PairingError::BadEncoding)?;
    let ssh_host = match address_type {
        ADDRESS_IPV4 => {
            let octets: [u8; 4] = take_bytes(&decoded, &mut cursor, 4)?
                .try_into()
                .map_err(|_| PairingError::BadEncoding)?;
            IpAddr::from(octets).to_string()
        }
        ADDRESS_IPV6 => {
            let octets: [u8; 16] = take_bytes(&decoded, &mut cursor, 16)?
                .try_into()
                .map_err(|_| PairingError::BadEncoding)?;
            IpAddr::from(octets).to_string()
        }
        ADDRESS_HOSTNAME => {
            let length = usize::from(
                take_bytes(&decoded, &mut cursor, 1)?
                    .first()
                    .copied()
                    .ok_or(PairingError::BadEncoding)?,
            );
            String::from_utf8(take_bytes(&decoded, &mut cursor, length)?.to_vec())
                .map_err(|_| PairingError::BadEncoding)?
        }
        _ => return Err(PairingError::BadEncoding),
    };
    let ssh_port = u16::from_be_bytes(
        take_bytes(&decoded, &mut cursor, 2)?
            .try_into()
            .map_err(|_| PairingError::BadEncoding)?,
    );
    let user_length = usize::from(
        take_bytes(&decoded, &mut cursor, 1)?
            .first()
            .copied()
            .ok_or(PairingError::BadEncoding)?,
    );
    let ssh_user = String::from_utf8(take_bytes(&decoded, &mut cursor, user_length)?.to_vec())
        .map_err(|_| PairingError::BadEncoding)?;
    let temporary_private_key_seed = take_bytes(&decoded, &mut cursor, ED25519_SEED_BYTES)?
        .try_into()
        .map_err(|_| PairingError::BadEncoding)?;
    let ssh_host_key_sha256 = take_bytes(&decoded, &mut cursor, SHA256_BYTES)?
        .try_into()
        .map_err(|_| PairingError::BadEncoding)?;
    if cursor != decoded.len()
        || ssh_host.is_empty()
        || ssh_host.len() > MAX_HOSTNAME_BYTES
        || ssh_port == 0
        || ssh_user.is_empty()
        || !ssh_host.is_ascii()
        || !ssh_user.is_ascii()
        || ssh_host
            .chars()
            .chain(ssh_user.chars())
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(PairingError::BadPayload);
    }
    Ok(PairingPayload {
        ssh_host,
        ssh_port,
        ssh_user,
        temporary_private_key_seed,
        ssh_host_key_sha256,
    })
}

fn take_bytes<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    length: usize,
) -> Result<&'a [u8], PairingError> {
    let end = cursor
        .checked_add(length)
        .ok_or(PairingError::BadEncoding)?;
    let value = bytes.get(*cursor..end).ok_or(PairingError::BadEncoding)?;
    *cursor = end;
    Ok(value)
}

fn base45_decode(encoded: &str) -> Result<Vec<u8>, PairingError> {
    if encoded.is_empty()
        || encoded.len() > MAX_BASE45_BYTES
        || encoded.len() % 3 == 1
        || !encoded.is_ascii()
    {
        return Err(PairingError::BadEncoding);
    }
    let mut decoded = Vec::with_capacity(encoded.len() * 2 / 3);
    for chunk in encoded.as_bytes().chunks(3) {
        let (first, second, third) = match chunk {
            [first, second, third] => (*first, *second, Some(*third)),
            [first, second] => (*first, *second, None),
            _ => return Err(PairingError::BadEncoding),
        };
        let mut value = base45_value(first)? + 45 * base45_value(second)?;
        if let Some(third) = third {
            value += 45 * 45 * base45_value(third)?;
            if value > u16::MAX.into() {
                return Err(PairingError::BadEncoding);
            }
            let value = u16::try_from(value).map_err(|_| PairingError::BadEncoding)?;
            decoded.extend_from_slice(&value.to_be_bytes());
        } else {
            if value > u8::MAX.into() {
                return Err(PairingError::BadEncoding);
            }
            decoded.push(u8::try_from(value).map_err(|_| PairingError::BadEncoding)?);
        }
    }
    Ok(decoded)
}

fn base45_value(byte: u8) -> Result<usize, PairingError> {
    BASE45_ALPHABET
        .iter()
        .position(|candidate| *candidate == byte)
        .ok_or(PairingError::BadEncoding)
}

#[cfg(test)]
mod transport_tests;

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn base45_encode(bytes: &[u8]) -> String {
        let mut encoded = String::new();
        for chunk in bytes.chunks(2) {
            let value = if chunk.len() == 2 {
                usize::from(chunk[0]) * 256 + usize::from(chunk[1])
            } else {
                usize::from(chunk[0])
            };
            encoded.push(char::from(BASE45_ALPHABET[value % 45]));
            encoded.push(char::from(BASE45_ALPHABET[(value / 45) % 45]));
            if chunk.len() == 2 {
                encoded.push(char::from(BASE45_ALPHABET[value / (45 * 45)]));
            }
        }
        encoded
    }

    fn code(address: &[u8], username: &str) -> String {
        let mut bytes = address.to_vec();
        bytes.extend_from_slice(&22_u16.to_be_bytes());
        bytes.push(u8::try_from(username.len()).unwrap());
        bytes.extend_from_slice(username.as_bytes());
        bytes.extend_from_slice(&[7; 32]);
        bytes.extend_from_slice(&[9; 32]);
        format!("{ENVELOPE_PREFIX}{}", base45_encode(&bytes))
    }

    #[test]
    fn decodes_v4_ipv4_payload() {
        let payload = decode_pairing_code(&code(&[ADDRESS_IPV4, 192, 168, 1, 7], "alice")).unwrap();
        assert_eq!(payload.ssh_host, "192.168.1.7");
        assert_eq!(payload.ssh_port, 22);
        assert_eq!(payload.ssh_user, "alice");
        assert_eq!(payload.temporary_private_key_seed, [7; 32]);
        assert_eq!(payload.ssh_host_key_sha256, [9; 32]);
    }

    #[test]
    fn rejects_wrong_version_and_truncated_payloads() {
        assert!(matches!(
            decode_pairing_code("WP3:BB8"),
            Err(PairingError::BadPrefix)
        ));
        assert!(matches!(
            decode_pairing_code("WP4:00"),
            Err(PairingError::BadEncoding)
        ));
    }

    #[test]
    fn base45_matches_rfc_vectors() {
        for (plain, encoded) in [
            ("AB", "BB8"),
            ("Hello!!", "%69 VD92EX0"),
            ("base-45", "UJCLQE7W581"),
        ] {
            assert_eq!(base45_decode(encoded).unwrap(), plain.as_bytes());
        }
    }

    #[test]
    fn temporary_private_key_is_deterministic() {
        let first = temporary_private_key(&[7; 32]);
        let second = temporary_private_key(&[7; 32]);
        assert_eq!(
            first.public_key().to_openssh().unwrap(),
            second.public_key().to_openssh().unwrap()
        );
    }
}
