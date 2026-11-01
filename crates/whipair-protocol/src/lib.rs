#![doc = include_str!("../README.md")]

use serde::{Deserialize, Serialize};
use ssh_key::{HashAlg, PublicKey};
use std::net::IpAddr;

pub const ED25519_SEED_BYTES: usize = 32;
pub const SHA256_BYTES: usize = 32;
pub const MAX_PUBLIC_KEY_BYTES: usize = 4096;
pub const ENVELOPE_PREFIX: &str = "WP4:";
const BASE45_ALPHABET: &[u8; 45] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const ADDRESS_IPV4: u8 = 1;
const ADDRESS_IPV6: u8 = 2;
const ADDRESS_HOSTNAME: u8 = 3;
const ADDRESS_TAILCAT: u8 = 4;
const MAX_HOSTNAME_BYTES: usize = 253;
const MAX_TAILCAT_ADDRESS_BYTES: usize = 1024;
const MAX_USERNAME_BYTES: usize = u8::MAX as usize;
const MAX_PAYLOAD_BYTES: usize =
    MAX_TAILCAT_ADDRESS_BYTES + 3 + 2 + 1 + MAX_USERNAME_BYTES + ED25519_SEED_BYTES + SHA256_BYTES;
const MAX_BASE45_BYTES: usize = MAX_PAYLOAD_BYTES.div_ceil(2) * 3;

#[derive(Clone, Eq, PartialEq)]
pub struct PairingPayload {
    pub ssh_host: String,
    pub tailcat: bool,
    pub ssh_port: u16,
    pub ssh_user: String,
    pub temporary_private_key_seed: [u8; ED25519_SEED_BYTES],
    pub ssh_host_key_sha256: [u8; SHA256_BYTES],
}

impl std::fmt::Debug for PairingPayload {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PairingPayload")
            .field(
                "ssh_host",
                &if self.tailcat {
                    "<redacted>"
                } else {
                    &self.ssh_host
                },
            )
            .field("tailcat", &self.tailcat)
            .field("ssh_port", &self.ssh_port)
            .field("ssh_user", &self.ssh_user)
            .field("ssh_host_key_sha256", &self.ssh_host_key_sha256)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EnrollmentRequest {
    pub device_name: String,
    pub public_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EnrollmentResponse {
    pub approved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already_present: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl EnrollmentResponse {
    pub fn approved(fingerprint: &str, already_present: bool) -> Self {
        Self {
            approved: true,
            fingerprint: Some(fingerprint.into()),
            already_present: Some(already_present),
            code: None,
            message: None,
        }
    }

    pub fn error(code: &str, message: &str) -> Self {
        Self {
            approved: false,
            fingerprint: None,
            already_present: None,
            code: Some(code.into()),
            message: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ValidatedPublicKey {
    public_key: PublicKey,
    canonical_line: String,
}

impl ValidatedPublicKey {
    pub fn canonical_line(&self) -> &str {
        &self.canonical_line
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("pairing code has the wrong prefix or version")]
    BadPrefix,
    #[error("pairing code is not valid Base45")]
    BadEncoding,
    /// Extra bytes after a complete WP4 payload. Consumers preserve their own error category.
    #[error("pairing code is not valid Base45")]
    TrailingData,
    #[error("pairing payload is invalid: {0}")]
    BadPayload(String),
    #[error("only a bare OpenSSH public key supported by Whip is accepted")]
    UnsupportedKey,
    #[error("SSH public key is malformed")]
    MalformedKey,
}

pub fn encode_pairing_code(payload: &PairingPayload) -> Result<String, ProtocolError> {
    validate_payload(payload)?;
    let mut bytes = Vec::with_capacity(104);
    if payload.tailcat {
        let address = payload.ssh_host.as_bytes();
        let length = u16::try_from(address.len())
            .map_err(|_| ProtocolError::BadPayload("Tailcat address is too long".into()))?;
        bytes.push(ADDRESS_TAILCAT);
        bytes.extend_from_slice(&length.to_be_bytes());
        bytes.extend_from_slice(address);
    } else {
        match payload.ssh_host.parse::<IpAddr>() {
            Ok(IpAddr::V4(address)) => {
                bytes.push(ADDRESS_IPV4);
                bytes.extend_from_slice(&address.octets());
            }
            Ok(IpAddr::V6(address)) => {
                bytes.push(ADDRESS_IPV6);
                bytes.extend_from_slice(&address.octets());
            }
            Err(_) => {
                let host = payload.ssh_host.as_bytes();
                if host.len() > MAX_HOSTNAME_BYTES {
                    return Err(ProtocolError::BadPayload(
                        "pairing hostname is too long".into(),
                    ));
                }
                let length = u8::try_from(host.len()).map_err(|_| {
                    ProtocolError::BadPayload("pairing hostname is too long".into())
                })?;
                bytes.push(ADDRESS_HOSTNAME);
                bytes.push(length);
                bytes.extend_from_slice(host);
            }
        }
    }
    bytes.extend_from_slice(&payload.ssh_port.to_be_bytes());
    let user = payload.ssh_user.as_bytes();
    let user_length = u8::try_from(user.len())
        .map_err(|_| ProtocolError::BadPayload("SSH username is too long".into()))?;
    bytes.push(user_length);
    bytes.extend_from_slice(user);
    bytes.extend_from_slice(&payload.temporary_private_key_seed);
    bytes.extend_from_slice(&payload.ssh_host_key_sha256);
    Ok(format!("{ENVELOPE_PREFIX}{}", base45_encode(&bytes)))
}

pub fn decode_pairing_code(code: &str) -> Result<PairingPayload, ProtocolError> {
    let body = code
        .strip_prefix(ENVELOPE_PREFIX)
        .ok_or(ProtocolError::BadPrefix)?;
    let decoded = base45_decode(body)?;
    let mut cursor = 0;
    let address_type = *take_bytes(&decoded, &mut cursor, 1)?
        .first()
        .ok_or(ProtocolError::BadEncoding)?;
    let ssh_host = match address_type {
        ADDRESS_IPV4 => {
            let octets: [u8; 4] = take_bytes(&decoded, &mut cursor, 4)?
                .try_into()
                .map_err(|_| ProtocolError::BadEncoding)?;
            IpAddr::from(octets).to_string()
        }
        ADDRESS_IPV6 => {
            let octets: [u8; 16] = take_bytes(&decoded, &mut cursor, 16)?
                .try_into()
                .map_err(|_| ProtocolError::BadEncoding)?;
            IpAddr::from(octets).to_string()
        }
        ADDRESS_HOSTNAME => {
            let length = usize::from(
                *take_bytes(&decoded, &mut cursor, 1)?
                    .first()
                    .ok_or(ProtocolError::BadEncoding)?,
            );
            String::from_utf8(take_bytes(&decoded, &mut cursor, length)?.to_vec())
                .map_err(|_| ProtocolError::BadEncoding)?
        }
        ADDRESS_TAILCAT => {
            let length = u16::from_be_bytes(
                take_bytes(&decoded, &mut cursor, 2)?
                    .try_into()
                    .map_err(|_| ProtocolError::BadEncoding)?,
            );
            String::from_utf8(take_bytes(&decoded, &mut cursor, usize::from(length))?.to_vec())
                .map_err(|_| ProtocolError::BadEncoding)?
        }
        _ => return Err(ProtocolError::BadEncoding),
    };
    let ssh_port = u16::from_be_bytes(
        take_bytes(&decoded, &mut cursor, 2)?
            .try_into()
            .map_err(|_| ProtocolError::BadEncoding)?,
    );
    let user_length = usize::from(
        *take_bytes(&decoded, &mut cursor, 1)?
            .first()
            .ok_or(ProtocolError::BadEncoding)?,
    );
    let ssh_user = String::from_utf8(take_bytes(&decoded, &mut cursor, user_length)?.to_vec())
        .map_err(|_| ProtocolError::BadEncoding)?;
    let temporary_private_key_seed = take_bytes(&decoded, &mut cursor, ED25519_SEED_BYTES)?
        .try_into()
        .map_err(|_| ProtocolError::BadEncoding)?;
    let ssh_host_key_sha256 = take_bytes(&decoded, &mut cursor, SHA256_BYTES)?
        .try_into()
        .map_err(|_| ProtocolError::BadEncoding)?;
    if cursor != decoded.len() {
        return Err(ProtocolError::TrailingData);
    }
    let payload = PairingPayload {
        ssh_host,
        tailcat: address_type == ADDRESS_TAILCAT,
        ssh_port,
        ssh_user,
        temporary_private_key_seed,
        ssh_host_key_sha256,
    };
    validate_payload(&payload)?;
    Ok(payload)
}

fn validate_payload(payload: &PairingPayload) -> Result<(), ProtocolError> {
    if payload.ssh_host.is_empty()
        || (!payload.tailcat && payload.ssh_host.len() > MAX_HOSTNAME_BYTES)
        || payload.ssh_port == 0
        || payload.ssh_user.is_empty()
        || payload.ssh_user.len() > MAX_USERNAME_BYTES
    {
        return Err(ProtocolError::BadPayload(
            "missing or invalid required field".into(),
        ));
    }
    if payload.tailcat {
        validate_tailcat_address(&payload.ssh_host)?;
    }
    if !payload.ssh_host.is_ascii()
        || !payload.ssh_user.is_ascii()
        || payload
            .ssh_host
            .chars()
            .chain(payload.ssh_user.chars())
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(ProtocolError::BadPayload(
            "pairing hostname must be printable ASCII without whitespace".into(),
        ));
    }
    Ok(())
}

pub fn validate_tailcat_address(address: &str) -> Result<(), ProtocolError> {
    let valid = address.len() <= MAX_TAILCAT_ADDRESS_BYTES
        && address.is_ascii()
        && !address
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        && tailcat_client::validate_address(address).is_ok();
    if valid {
        Ok(())
    } else {
        Err(ProtocolError::BadPayload(format!(
            "enter a Tailcat tc address of at most {MAX_TAILCAT_ADDRESS_BYTES} bytes"
        )))
    }
}

fn take_bytes<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    length: usize,
) -> Result<&'a [u8], ProtocolError> {
    let end = cursor
        .checked_add(length)
        .ok_or(ProtocolError::BadEncoding)?;
    let value = bytes.get(*cursor..end).ok_or(ProtocolError::BadEncoding)?;
    *cursor = end;
    Ok(value)
}

fn base45_encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(2) * 3);
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

fn base45_decode(encoded: &str) -> Result<Vec<u8>, ProtocolError> {
    if encoded.is_empty()
        || encoded.len() > MAX_BASE45_BYTES
        || encoded.len() % 3 == 1
        || !encoded.is_ascii()
    {
        return Err(ProtocolError::BadEncoding);
    }
    let mut decoded = Vec::with_capacity(encoded.len() * 2 / 3);
    for chunk in encoded.as_bytes().chunks(3) {
        let (first, second, third) = match chunk {
            [first, second, third] => (*first, *second, Some(*third)),
            [first, second] => (*first, *second, None),
            _ => return Err(ProtocolError::BadEncoding),
        };
        let mut value = base45_value(first)? + 45 * base45_value(second)?;
        if let Some(third) = third {
            value += 45 * 45 * base45_value(third)?;
            if value > u16::MAX.into() {
                return Err(ProtocolError::BadEncoding);
            }
            let value = u16::try_from(value).map_err(|_| ProtocolError::BadEncoding)?;
            decoded.extend_from_slice(&value.to_be_bytes());
        } else {
            if value > u8::MAX.into() {
                return Err(ProtocolError::BadEncoding);
            }
            decoded.push(u8::try_from(value).map_err(|_| ProtocolError::BadEncoding)?);
        }
    }
    Ok(decoded)
}

fn base45_value(byte: u8) -> Result<usize, ProtocolError> {
    BASE45_ALPHABET
        .iter()
        .position(|candidate| *candidate == byte)
        .ok_or(ProtocolError::BadEncoding)
}

pub fn validate_public_key(line: &str) -> Result<ValidatedPublicKey, ProtocolError> {
    let trimmed = line.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_PUBLIC_KEY_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return Err(ProtocolError::MalformedKey);
    }
    let public_key = PublicKey::from_openssh(trimmed).map_err(|_| ProtocolError::UnsupportedKey)?;
    let canonical_line = public_key
        .to_openssh()
        .map_err(|_| ProtocolError::MalformedKey)?;
    Ok(ValidatedPublicKey {
        public_key,
        canonical_line,
    })
}

pub fn fingerprint_public_key(key: &ValidatedPublicKey) -> String {
    key.public_key.fingerprint(HashAlg::Sha256).to_string()
}

pub fn verification_code_public_key(key: &ValidatedPublicKey) -> Result<String, ProtocolError> {
    let fingerprint = key.public_key.fingerprint(HashAlg::Sha256);
    let digest = fingerprint.sha256().ok_or(ProtocolError::MalformedKey)?;
    Ok(verification_code_sha256(&digest))
}

pub fn verification_code_sha256(digest: &[u8; 32]) -> String {
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    let digits = format!("{value:06}");
    format!("{}-{}", &digits[..3], &digits[3..])
}

#[cfg(test)]
mod tests;
