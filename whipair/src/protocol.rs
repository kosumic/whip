use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use ssh_key::{HashAlg, PublicKey};
use std::net::IpAddr;

pub const ENVELOPE_PREFIX: &str = "WP4:";
const BASE45_ALPHABET: &[u8; 45] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const ADDRESS_IPV4: u8 = 1;
const ADDRESS_IPV6: u8 = 2;
const ADDRESS_HOSTNAME: u8 = 3;
const ADDRESS_TAILCAT: u8 = 4;
const MAX_HOSTNAME_BYTES: usize = 253;
const MAX_TAILCAT_ADDRESS_BYTES: usize = 1024;
const MAX_BASE45_BYTES: usize = (MAX_TAILCAT_ADDRESS_BYTES + 3 + 2 + 1 + 255 + 64).div_ceil(2) * 3;

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct PairingPayload {
    pub ssh_host: String,
    pub tailcat: bool,
    pub ssh_port: u16,
    pub ssh_user: String,
    pub temporary_private_key_seed: [u8; 32],
    pub ssh_host_key_sha256: [u8; 32],
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
    let temporary_private_key_seed = take_bytes(&decoded, &mut cursor, 32)?
        .try_into()
        .map_err(|_| ProtocolError::BadEncoding)?;
    let ssh_host_key_sha256 = take_bytes(&decoded, &mut cursor, 32)?
        .try_into()
        .map_err(|_| ProtocolError::BadEncoding)?;
    if cursor != decoded.len() {
        return Err(ProtocolError::BadEncoding);
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
        || payload.ssh_user.len() > u8::MAX.into()
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
        && address.strip_prefix("tc").is_some_and(|body| {
            !body.is_empty()
                && URL_SAFE_NO_PAD
                    .decode(body)
                    .is_ok_and(|bytes| !bytes.is_empty())
        });
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
    if trimmed.is_empty() || trimmed.len() > 4096 || trimmed.chars().any(char::is_control) {
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
    Ok(verification_code(&digest))
}

fn verification_code(digest: &[u8; 32]) -> String {
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    let digits = format!("{value:06}");
    format!("{}-{}", &digits[..3], &digits[3..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use qrcode::{EcLevel, QrCode};

    fn payload() -> PairingPayload {
        PairingPayload {
            ssh_host: "100.64.0.2".into(),
            tailcat: false,
            ssh_port: 22,
            ssh_user: "alice".into(),
            temporary_private_key_seed: [7; 32],
            ssh_host_key_sha256: [9; 32],
        }
    }

    #[test]
    fn pairing_code_round_trips() {
        let payload = payload();
        let code = encode_pairing_code(&payload).unwrap();
        assert!(code.starts_with(ENVELOPE_PREFIX));
        assert_eq!(code.len(), 120);
        let qr = QrCode::with_error_correction_level(code.as_bytes(), EcLevel::L).unwrap();
        assert_eq!(qr.width(), 37);
        assert_eq!(decode_pairing_code(&code).unwrap(), payload);
    }

    #[test]
    fn pairing_code_round_trips_ipv6_and_hostname() {
        for ssh_host in ["fd7a:115c:a1e0::1", "host.example.test"] {
            let mut payload = payload();
            payload.ssh_host = ssh_host.into();
            let code = encode_pairing_code(&payload).unwrap();
            assert!(code.len() <= 145);
            assert_eq!(decode_pairing_code(&code).unwrap(), payload);
        }
    }

    #[test]
    fn tailcat_code_matches_the_mobile_scanner_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/tailcat-pairing.json")).unwrap();
        let mut payload = payload();
        payload.tailcat = true;
        for (address_field, code_field) in [("address", "code"), ("longAddress", "longCode")] {
            payload.ssh_host = fixture[address_field].as_str().unwrap().into();
            let code = encode_pairing_code(&payload).unwrap();
            assert_eq!(code, fixture[code_field].as_str().unwrap());
            assert_eq!(decode_pairing_code(&code).unwrap(), payload);
            assert!(QrCode::with_error_correction_level(code.as_bytes(), EcLevel::L).is_ok());
        }
    }

    #[test]
    fn tailcat_addresses_must_fit_the_qr() {
        let mut payload = payload();
        payload.tailcat = true;
        payload.ssh_host = format!(
            "tc{}",
            URL_SAFE_NO_PAD.encode([1; MAX_TAILCAT_ADDRESS_BYTES])
        );
        assert!(encode_pairing_code(&payload).is_err());
        for address in ["", "tc", "tc!!!!", "host.example.test", "tcYWJj\n"] {
            assert!(validate_tailcat_address(address).is_err());
        }
    }

    #[test]
    fn pairing_code_rejects_another_version() {
        assert!(matches!(
            decode_pairing_code("WP3:BB8"),
            Err(ProtocolError::BadPrefix)
        ));
    }

    #[test]
    fn pairing_code_rejects_truncated_data() {
        let code = format!("{ENVELOPE_PREFIX}00");
        assert!(matches!(
            decode_pairing_code(&code),
            Err(ProtocolError::BadEncoding)
        ));
    }

    #[test]
    fn base45_matches_rfc_vectors() {
        for (plain, encoded) in [
            ("AB", "BB8"),
            ("Hello!!", "%69 VD92EX0"),
            ("base-45", "UJCLQE7W581"),
        ] {
            assert_eq!(base45_encode(plain.as_bytes()), encoded);
            assert_eq!(base45_decode(encoded).unwrap(), plain.as_bytes());
        }
    }

    #[test]
    fn base45_rejects_invalid_or_overflowing_input() {
        for encoded in ["0", "ab", ":::"] {
            assert!(matches!(
                base45_decode(encoded),
                Err(ProtocolError::BadEncoding)
            ));
        }
    }

    #[test]
    fn parses_a_real_ed25519_public_blob() {
        let mut blob = Vec::new();
        blob.extend_from_slice(&(11_u32.to_be_bytes()));
        blob.extend_from_slice(b"ssh-ed25519");
        blob.extend_from_slice(&(32_u32.to_be_bytes()));
        blob.extend_from_slice(&[7_u8; 32]);
        let line = format!(
            "ssh-ed25519 {} prototype device",
            base64::engine::general_purpose::STANDARD.encode(blob)
        );
        let key = validate_public_key(&line).unwrap();
        assert_eq!(key.canonical_line(), line);
        assert!(fingerprint_public_key(&key).starts_with("SHA256:"));
    }

    #[test]
    fn formats_a_six_digit_verification_code() {
        let mut digest = [0_u8; 32];
        digest[..4].copy_from_slice(&0x1234_5678_u32.to_be_bytes());
        assert_eq!(verification_code(&digest), "419-896");
    }

    #[test]
    fn verification_code_matches_the_phone_implementation() {
        let key = validate_public_key(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti phone",
        )
        .unwrap();
        assert_eq!(verification_code_public_key(&key).unwrap(), "610-862");
    }

    #[test]
    fn accepts_other_public_key_algorithms_understood_by_russh_key_parser() {
        let ecdsa = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc= ecdsa@example";
        let security_key = "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAINSoElFleH+nN83FoLqqepJjN+y7Gs5lrn7qXjBqQZyuAAAABHNzaDo= token@example";
        let mut rsa_blob = Vec::new();
        append_ssh_field(&mut rsa_blob, b"ssh-rsa");
        append_ssh_field(&mut rsa_blob, &[1, 0, 1]);
        let mut modulus = vec![0_u8, 0x80];
        modulus.extend_from_slice(&[0x5a; 255]);
        append_ssh_field(&mut rsa_blob, &modulus);
        let rsa = format!(
            "ssh-rsa {} rsa@example",
            base64::engine::general_purpose::STANDARD.encode(rsa_blob)
        );
        for line in [ecdsa, security_key, &rsa] {
            let key = validate_public_key(line).unwrap();
            assert_eq!(key.canonical_line(), line);
            assert!(fingerprint_public_key(&key).starts_with("SHA256:"));
        }
    }

    fn append_ssh_field(encoded: &mut Vec<u8>, value: &[u8]) {
        encoded.extend_from_slice(&u32::try_from(value.len()).unwrap().to_be_bytes());
        encoded.extend_from_slice(value);
    }

    #[test]
    fn rejects_authorized_key_options() {
        let line = "restrict ssh-ed25519 AAAA";
        assert!(matches!(
            validate_public_key(line),
            Err(ProtocolError::UnsupportedKey)
        ));
    }

    #[test]
    fn rejects_terminal_control_characters_in_comments() {
        let mut blob = Vec::new();
        blob.extend_from_slice(&(11_u32.to_be_bytes()));
        blob.extend_from_slice(b"ssh-ed25519");
        blob.extend_from_slice(&(32_u32.to_be_bytes()));
        blob.extend_from_slice(&[9_u8; 32]);
        let line = format!(
            "ssh-ed25519 {} device\u{1b}[2J",
            base64::engine::general_purpose::STANDARD.encode(blob)
        );
        assert!(matches!(
            validate_public_key(&line),
            Err(ProtocolError::MalformedKey)
        ));
    }
}
