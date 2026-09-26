//! RSA client keys signed by *ring*.
//!
//! russh decodes and signs RSA keys through the RustCrypto `rsa` crate, which
//! carries an unpatched timing side channel (RUSTSEC-2023-0071). Whip leaves
//! russh's `rsa` feature disabled and instead signs RSA public-key
//! authentication with *ring*, whose RSA implementation is constant-time and
//! blinded. Ed25519 and ECDSA keys still go through russh unchanged.
//!
//! Supported RSA encodings are OpenSSH (optionally passphrase-protected),
//! unencrypted PKCS#1 (`BEGIN RSA PRIVATE KEY`), and unencrypted PKCS#8
//! (`BEGIN PRIVATE KEY`, as issued by several cloud consoles). Signatures use
//! `rsa-sha2-512` or `rsa-sha2-256`; legacy SHA-1 `ssh-rsa` signatures are not
//! produced.

use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use num_bigint::BigUint;
use ring::{rand::SystemRandom, rsa, signature};
use russh::client;
use russh::keys::agent::AgentIdentity;
use russh::keys::ssh_key::{
    Mpint,
    private::{KeypairData, RsaKeypair},
    public::{KeyData, RsaPublicKey},
};
use russh::keys::{HashAlg, PrivateKey, PublicKey};

#[derive(Debug, thiserror::Error)]
pub(super) enum RsaKeyError {
    #[error("RSA private key was rejected: {0}")]
    Rejected(String),
    #[error(
        "encrypted PKCS#1/PKCS#8 RSA keys are not supported; convert the key to OpenSSH format with `ssh-keygen -p -f <key>`"
    )]
    EncryptedPem,
    #[error("the SSH server does not accept rsa-sha2-256 or rsa-sha2-512 signatures")]
    NoSha2Signatures,
    #[error("RSA signing failed")]
    Signing,
    #[error("SSH session closed during RSA authentication")]
    SessionClosed,
    #[error("{0}")]
    Ssh(#[from] russh::Error),
    #[error("{0}")]
    Key(#[from] russh::keys::Error),
    #[error("{0}")]
    SshKey(#[from] russh::keys::ssh_key::Error),
}

impl From<russh::SendError> for RsaKeyError {
    fn from(_: russh::SendError) -> Self {
        Self::SessionClosed
    }
}

/// A decoded client private key.
pub(super) enum ClientKey {
    /// Ed25519 and ECDSA keys, signed by russh.
    Russh(Arc<PrivateKey>),
    /// RSA keys, signed by *ring*.
    Rsa(RsaClientKey),
}

impl ClientKey {
    pub(super) fn public_key(&self) -> PublicKey {
        match self {
            Self::Russh(key) => key.public_key().clone(),
            Self::Rsa(key) => key.public_key.clone(),
        }
    }
}

pub(super) struct RsaClientKey {
    key_pair: Arc<rsa::KeyPair>,
    public_key: PublicKey,
}

impl RsaClientKey {
    fn new(key_pair: rsa::KeyPair) -> Result<Self, RsaKeyError> {
        let components = rsa::PublicKeyComponents::<Vec<u8>>::from(key_pair.public());
        let public = RsaPublicKey::new(
            Mpint::from_positive_bytes(&components.e),
            Mpint::from_positive_bytes(&components.n),
        )?;
        Ok(Self {
            key_pair: Arc::new(key_pair),
            public_key: PublicKey::new(KeyData::Rsa(public), ""),
        })
    }

    pub(super) fn key_size(&self) -> u32 {
        u32::try_from(self.key_pair.public().modulus_len() * 8).unwrap_or_default()
    }

    /// Authenticates with `rsa-sha2-512` or `rsa-sha2-256`, preferring what
    /// the server advertises in `server-sig-algs`. Servers that do not send
    /// the extension are offered `rsa-sha2-512`, matching OpenSSH clients.
    pub(super) async fn authenticate<H: client::Handler>(
        &self,
        handle: &mut client::Handle<H>,
        username: &str,
    ) -> Result<bool, RsaKeyError> {
        let hash_alg = match handle.best_supported_rsa_hash().await? {
            Some(Some(HashAlg::Sha256)) => HashAlg::Sha256,
            Some(Some(_)) | None => HashAlg::Sha512,
            Some(None) => return Err(RsaKeyError::NoSha2Signatures),
        };
        let mut signer = RsaSigner {
            key_pair: self.key_pair.clone(),
        };
        Ok(handle
            .authenticate_publickey_with(
                username,
                self.public_key.clone(),
                Some(hash_alg),
                &mut signer,
            )
            .await?
            .success())
    }
}

struct RsaSigner {
    key_pair: Arc<rsa::KeyPair>,
}

impl RsaSigner {
    /// Appends the SSH signature blob for `data`, framed the way russh
    /// expects from an external signer: `string(string(alg) || string(sig))`.
    fn sign(&self, hash_alg: Option<HashAlg>, mut data: Vec<u8>) -> Result<Vec<u8>, RsaKeyError> {
        let (encoding, name): (&'static dyn signature::RsaEncoding, &str) = match hash_alg {
            Some(HashAlg::Sha256) => (&signature::RSA_PKCS1_SHA256, "rsa-sha2-256"),
            Some(HashAlg::Sha512) => (&signature::RSA_PKCS1_SHA512, "rsa-sha2-512"),
            _ => return Err(RsaKeyError::NoSha2Signatures),
        };
        let mut signature = vec![0; self.key_pair.public().modulus_len()];
        self.key_pair
            .sign(encoding, &SystemRandom::new(), &data, &mut signature)
            .map_err(|_| RsaKeyError::Signing)?;
        let blob_len = 4 + name.len() + 4 + signature.len();
        data.reserve(4 + blob_len);
        push_ssh_u32(&mut data, blob_len)?;
        push_ssh_string(&mut data, name.as_bytes())?;
        push_ssh_string(&mut data, &signature)?;
        Ok(data)
    }
}

impl russh::Signer for RsaSigner {
    type Error = RsaKeyError;

    fn auth_sign(
        &mut self,
        _key: &AgentIdentity,
        hash_alg: Option<HashAlg>,
        to_sign: Vec<u8>,
    ) -> impl Future<Output = Result<Vec<u8>, Self::Error>> + Send {
        std::future::ready(self.sign(hash_alg, to_sign))
    }
}

fn push_ssh_u32(buffer: &mut Vec<u8>, value: usize) -> Result<(), RsaKeyError> {
    let value = u32::try_from(value).map_err(|_| RsaKeyError::Signing)?;
    buffer.extend_from_slice(&value.to_be_bytes());
    Ok(())
}

fn push_ssh_string(buffer: &mut Vec<u8>, value: &[u8]) -> Result<(), RsaKeyError> {
    push_ssh_u32(buffer, value.len())?;
    buffer.extend_from_slice(value);
    Ok(())
}

/// Decodes a client private key, routing RSA keys to *ring*.
pub(super) fn decode_client_key(
    private_key: &str,
    passphrase: Option<&str>,
) -> Result<ClientKey, RsaKeyError> {
    match pem_block(private_key) {
        Some(("RSA PRIVATE KEY", body)) => {
            if body.lines().any(|line| line.contains(':')) {
                return Err(RsaKeyError::EncryptedPem);
            }
            let der = decode_pem_body(body)?;
            let key_pair = rsa::KeyPair::from_der(&der).map_err(rejected)?;
            return Ok(ClientKey::Rsa(RsaClientKey::new(key_pair)?));
        }
        Some(("PRIVATE KEY", body)) => {
            let der = decode_pem_body(body)?;
            match rsa::KeyPair::from_pkcs8(&der) {
                Ok(key_pair) => return Ok(ClientKey::Rsa(RsaClientKey::new(key_pair)?)),
                // Not an RSA key (or a malformed one); let russh decide below.
                Err(_) if !is_rsa_pkcs8(&der) => {}
                Err(error) => return Err(rejected(error)),
            }
        }
        Some(("ENCRYPTED PRIVATE KEY", _)) => {
            return russh::keys::decode_secret_key(private_key, passphrase)
                .map(|key| ClientKey::Russh(Arc::new(key)))
                .map_err(|error| match error {
                    russh::keys::Error::UnknownAlgorithm(oid)
                        if oid.to_string() == RSA_ENCRYPTION_OID =>
                    {
                        RsaKeyError::EncryptedPem
                    }
                    error => error.into(),
                });
        }
        _ => {}
    }

    let key = russh::keys::decode_secret_key(private_key, passphrase)?;
    match key.key_data() {
        KeypairData::Rsa(keypair) => Ok(ClientKey::Rsa(RsaClientKey::new(ring_key_from_openssh(
            keypair,
        )?)?)),
        _ => Ok(ClientKey::Russh(Arc::new(key))),
    }
}

const RSA_ENCRYPTION_OID: &str = "1.2.840.113549.1.1.1";

/// DER encoding of the rsaEncryption OID, as found in a PKCS#8
/// AlgorithmIdentifier.
const RSA_ENCRYPTION_OID_DER: &[u8] = &[
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
];

fn is_rsa_pkcs8(der: &[u8]) -> bool {
    // The AlgorithmIdentifier sits within the first few dozen bytes of a
    // PrivateKeyInfo; this only chooses between a precise RSA error and
    // falling back to russh for other algorithms.
    der.windows(RSA_ENCRYPTION_OID_DER.len())
        .take(32)
        .any(|window| window == RSA_ENCRYPTION_OID_DER)
}

fn rejected(error: ring::error::KeyRejected) -> RsaKeyError {
    RsaKeyError::Rejected(error.to_string())
}

/// Rebuilds the CRT parameters *ring* needs from an OpenSSH RSA key, which
/// stores only `d`, `iqmp`, `p`, and `q`. This runs once on the device when a
/// key is loaded and is not reachable by a remote peer.
fn ring_key_from_openssh(keypair: &RsaKeypair) -> Result<rsa::KeyPair, RsaKeyError> {
    let bytes = positive_bytes;
    let public = keypair.public();
    let private = keypair.private();
    let d = BigUint::from_bytes_be(bytes(private.d())?);
    let mut p = BigUint::from_bytes_be(bytes(private.p())?);
    let mut q = BigUint::from_bytes_be(bytes(private.q())?);
    let one = BigUint::from(1_u8);
    if p <= one || q <= one || p == q {
        return Err(invalid_component());
    }
    // *ring* requires q < p; OpenSSH does not guarantee that order.
    let q_inv = if q < p {
        BigUint::from_bytes_be(bytes(private.iqmp())?)
    } else {
        std::mem::swap(&mut p, &mut q);
        q.modinv(&p).ok_or_else(invalid_component)?
    };
    let d_p = &d % (&p - &one);
    let d_q = &d % (&q - &one);
    let components = rsa::KeyPairComponents {
        public_key: rsa::PublicKeyComponents {
            n: bytes(public.n())?.to_vec(),
            e: bytes(public.e())?.to_vec(),
        },
        d: d.to_bytes_be(),
        p: p.to_bytes_be(),
        q: q.to_bytes_be(),
        dP: d_p.to_bytes_be(),
        dQ: d_q.to_bytes_be(),
        qInv: q_inv.to_bytes_be(),
    };
    rsa::KeyPair::from_components(&components).map_err(rejected)
}

fn positive_bytes(value: &Mpint) -> Result<&[u8], RsaKeyError> {
    value.as_positive_bytes().ok_or_else(invalid_component)
}

fn invalid_component() -> RsaKeyError {
    RsaKeyError::Rejected("invalid RSA key component".to_owned())
}

/// Returns the label and body of the first PEM block, tolerating the loose
/// whitespace that pasted keys often carry.
fn pem_block(text: &str) -> Option<(&str, &str)> {
    let start = text.find("-----BEGIN ")?;
    let rest = &text[start + "-----BEGIN ".len()..];
    let label_end = rest.find("-----")?;
    let label = &rest[..label_end];
    let body_start = &rest[label_end + "-----".len()..];
    let end = body_start.find(&format!("-----END {label}-----"))?;
    Some((label, &body_start[..end]))
}

fn decode_pem_body(body: &str) -> Result<Vec<u8>, RsaKeyError> {
    let encoded: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD
        .decode(encoded)
        .map_err(|_| RsaKeyError::Rejected("private key is not valid PEM".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::private::RsaPrivateKey;

    const PUBLIC_KEY: &str = include_str!("../../test-fixtures/rsa/id_rsa.pub");
    const PKCS1: &str = include_str!("../../test-fixtures/rsa/pkcs1.pem");
    const PKCS1_ENCRYPTED: &str = include_str!("../../test-fixtures/rsa/pkcs1-encrypted.pem");
    const PKCS8: &str = include_str!("../../test-fixtures/rsa/pkcs8.pem");
    const PKCS8_ENCRYPTED: &str = include_str!("../../test-fixtures/rsa/pkcs8-encrypted.pem");
    const OPENSSH: &str = include_str!("../../test-fixtures/rsa/openssh");
    const OPENSSH_ENCRYPTED: &str = include_str!("../../test-fixtures/rsa/openssh-encrypted");
    const PASSPHRASE: &str = "test-passphrase";

    fn rsa_key(private_key: &str, passphrase: Option<&str>) -> RsaClientKey {
        match decode_client_key(private_key, passphrase).unwrap() {
            ClientKey::Rsa(key) => key,
            ClientKey::Russh(_) => panic!("RSA key was not routed to ring"),
        }
    }

    fn read_ssh_string<'a>(input: &mut &'a [u8]) -> &'a [u8] {
        let (length, rest) = input.split_at(4);
        let length = usize::try_from(u32::from_be_bytes(length.try_into().unwrap())).unwrap();
        let (value, rest) = rest.split_at(length);
        *input = rest;
        value
    }

    fn verify(key: &RsaClientKey, hash_alg: HashAlg, expected_name: &str) -> Vec<u8> {
        let data = b"session-id and userauth request".to_vec();
        let signed = RsaSigner {
            key_pair: key.key_pair.clone(),
        }
        .sign(Some(hash_alg), data.clone())
        .unwrap();
        let (prefix, mut framed) = signed.split_at(data.len());
        assert_eq!(prefix, data);
        let mut blob = read_ssh_string(&mut framed);
        assert!(framed.is_empty());
        assert_eq!(read_ssh_string(&mut blob), expected_name.as_bytes());
        let signature = read_ssh_string(&mut blob).to_vec();
        assert!(blob.is_empty());

        let public = key.public_key.key_data().rsa().unwrap();
        let verification = match hash_alg {
            HashAlg::Sha256 => &signature::RSA_PKCS1_2048_8192_SHA256,
            _ => &signature::RSA_PKCS1_2048_8192_SHA512,
        };
        signature::RsaPublicKeyComponents {
            n: public.n().as_positive_bytes().unwrap(),
            e: public.e().as_positive_bytes().unwrap(),
        }
        .verify(verification, &data, &signature)
        .unwrap();
        signature
    }

    #[test]
    fn decodes_every_supported_rsa_encoding_to_the_same_key() {
        let expected = PublicKey::from_openssh(PUBLIC_KEY.trim()).unwrap();
        for (private_key, passphrase) in [
            (PKCS1, None),
            (PKCS8, None),
            (OPENSSH, None),
            (OPENSSH_ENCRYPTED, Some(PASSPHRASE)),
        ] {
            let key = rsa_key(private_key, passphrase);
            assert_eq!(key.public_key.key_data(), expected.key_data());
            assert_eq!(key.key_size(), 2048);
        }
    }

    #[test]
    fn tolerates_pasted_whitespace_and_crlf() {
        let pasted = format!("\n  {}\n", PKCS8.replace('\n', "\r\n"));
        rsa_key(&pasted, None);
    }

    #[test]
    fn encrypted_pem_rsa_keys_explain_how_to_convert() {
        for private_key in [PKCS1_ENCRYPTED, PKCS8_ENCRYPTED] {
            assert!(matches!(
                decode_client_key(private_key, Some(PASSPHRASE)),
                Err(RsaKeyError::EncryptedPem)
            ));
        }
    }

    #[test]
    fn signs_with_rsa_sha2_and_never_sha1() {
        let key = rsa_key(PKCS8, None);
        verify(&key, HashAlg::Sha256, "rsa-sha2-256");
        verify(&key, HashAlg::Sha512, "rsa-sha2-512");
        let signer = RsaSigner {
            key_pair: key.key_pair,
        };
        assert!(matches!(
            signer.sign(None, Vec::new()),
            Err(RsaKeyError::NoSha2Signatures)
        ));
    }

    #[test]
    fn reorders_openssh_primes_for_ring() {
        let openssh = PrivateKey::from_openssh(OPENSSH).unwrap();
        let original = openssh.key_data().rsa().unwrap();
        let private = original.private();
        let p = BigUint::from_bytes_be(private.p().as_positive_bytes().unwrap());
        let q = BigUint::from_bytes_be(private.q().as_positive_bytes().unwrap());
        assert!(q < p, "fixture should start in ring's order");
        let swapped = RsaKeypair::new(
            original.public().clone(),
            RsaPrivateKey::new(
                private.d().clone(),
                Mpint::from_positive_bytes(&p.modinv(&q).unwrap().to_bytes_be()),
                private.q().clone(),
                private.p().clone(),
            )
            .unwrap(),
        )
        .unwrap();

        let reordered = RsaClientKey::new(ring_key_from_openssh(&swapped).unwrap()).unwrap();
        let direct = rsa_key(OPENSSH, None);
        // PKCS#1 v1.5 signatures are deterministic, so both keys must agree.
        assert_eq!(
            verify(&reordered, HashAlg::Sha512, "rsa-sha2-512"),
            verify(&direct, HashAlg::Sha512, "rsa-sha2-512"),
        );
    }

    #[test]
    fn non_rsa_keys_stay_with_russh() {
        let mut rng =
            russh::keys::ssh_key::rand_core::UnwrapErr(russh::keys::ssh_key::getrandom::SysRng);
        let ed25519 = PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519).unwrap();
        let encoded = ed25519
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap();
        assert!(matches!(
            decode_client_key(&encoded, None).unwrap(),
            ClientKey::Russh(_)
        ));
    }
}
