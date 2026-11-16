//! Shared policy for the restricted SSH enrollment exchange.
//!
//! SSH certificate rejection, transport routing, cancellation, exit-status and
//! refusal reporting belong to each client. A response need not end in a newline:
//! the SSH channel closing also frames it. JSON must still be complete.
use crate::{EnrollmentRequest, EnrollmentResponse, SHA256_BYTES};
use sha2::{Digest, Sha256};
use ssh_key::PublicKey;

pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;

/// Compare the digest of the bare SSH wire key, never its text or comment.
/// An absent pin is used only by the CLI's explicit host-key discovery step.
pub fn host_key_matches(
    key: &PublicKey,
    expected: Option<&[u8; SHA256_BYTES]>,
) -> Result<bool, ssh_key::Error> {
    let actual: [u8; SHA256_BYTES] = Sha256::digest(key.to_bytes()?).into();
    Ok(expected.is_none_or(|expected| actual == *expected))
}

#[derive(Debug, thiserror::Error)]
#[error("restricted pairing command returned too much data")]
pub struct MessageTooLarge;

/// Each output stream has its own bound. Reject a chunk without appending any
/// part of it, so failure never leaves an apparently complete truncated reply.
pub fn append_bounded(destination: &mut Vec<u8>, source: &[u8]) -> Result<(), MessageTooLarge> {
    if destination.len().saturating_add(source.len()) > MAX_MESSAGE_BYTES {
        return Err(MessageTooLarge);
    }
    destination.extend_from_slice(source);
    Ok(())
}

pub fn trim_line_ending(bytes: &[u8]) -> &[u8] {
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    bytes.strip_suffix(b"\r").unwrap_or(bytes)
}

pub fn encode_request(request: &EnrollmentRequest) -> Result<Vec<u8>, serde_json::Error> {
    let mut encoded = serde_json::to_vec(request)?;
    encoded.push(b'\n');
    Ok(encoded)
}

/// Preserve optional approval fields and denial defaults for caller policy.
pub fn decode_response(bytes: &[u8]) -> Result<EnrollmentResponse, serde_json::Error> {
    serde_json::from_slice(trim_line_ending(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_bare_wire_keys() -> Result<(), Box<dyn std::error::Error>> {
        let key: ssh_key::PrivateKey = ssh_key::private::Ed25519Keypair::from_seed(&[7; 32]).into();
        let public = key.public_key();
        let digest = public
            .fingerprint(ssh_key::HashAlg::Sha256)
            .sha256()
            .ok_or("digest")?;
        assert!(host_key_matches(public, Some(&digest))?);
        assert!(!host_key_matches(public, Some(&[0; SHA256_BYTES]))?);
        assert!(host_key_matches(public, None)?);
        Ok(())
    }

    #[test]
    fn output_limits_apply_to_accumulated_chunks_without_partial_append()
    -> Result<(), MessageTooLarge> {
        let mut bytes = Vec::new();
        append_bounded(&mut bytes, &vec![b' '; MAX_MESSAGE_BYTES - 1])?;
        append_bounded(&mut bytes, b"\n")?;
        assert!(append_bounded(&mut bytes, b"x").is_err());
        assert_eq!(bytes.len(), MAX_MESSAGE_BYTES);
        assert!(append_bounded(&mut Vec::new(), &vec![0; MAX_MESSAGE_BYTES + 1]).is_err());
        Ok(())
    }

    #[test]
    fn exchange_framing_preserves_wire_and_denial_semantics() -> Result<(), serde_json::Error> {
        let request = EnrollmentRequest {
            device_name: "phone".into(),
            public_key: "ssh-ed25519 key".into(),
        };
        assert_eq!(
            encode_request(&request)?,
            b"{\"device_name\":\"phone\",\"public_key\":\"ssh-ed25519 key\"}\n"
        );
        for ending in ["", "\n", "\r\n", "\r"] {
            let reply = format!("{{\"approved\":true}}{ending}");
            assert!(decode_response(reply.as_bytes())?.approved);
        }
        let denied = decode_response(br#"{"approved":false,"code":"denied","message":"no"}"#)?;
        assert!(!denied.approved);
        assert_eq!(denied.code.as_deref(), Some("denied"));
        assert!(decode_response(br#"{"approved":false}"#)?.message.is_none());
        for malformed in [
            b"".as_slice(),
            b"{\"approved\":",
            b"{}",
            b"{\"approved\":true}junk",
            b"{\"approved\":true}\n{}",
            b"\xff",
        ] {
            assert!(decode_response(malformed).is_err());
        }
        assert_eq!(trim_line_ending(b"x\r\n\n"), b"x\r\n");
        Ok(())
    }
}
