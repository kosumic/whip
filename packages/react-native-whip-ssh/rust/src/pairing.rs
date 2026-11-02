use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use russh::{
    ChannelMsg, client,
    keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate},
};
use sha2::{Digest, Sha256};
use ssh_key::{PrivateKey, private::Ed25519Keypair};
use tokio::time::timeout;

use crate::host_runtime::{HostSshConfig, ssh_config};
use crate::ssh::{SshFailure, SshSession};

use whipair_protocol::{
    ED25519_SEED_BYTES, EnrollmentRequest, EnrollmentResponse, ProtocolError, SHA256_BYTES,
};

const CANCELLED_OPERATION: &str = "SSH operation cancelled";
const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TAILCAT_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
const APPROVAL_TIMEOUT: Duration = Duration::from_mins(10);

#[derive(Debug, thiserror::Error)]
pub(crate) enum PairingError {
    #[error("pairing code has the wrong prefix or version")]
    BadPrefix,
    #[error("pairing code is not valid Base45")]
    BadEncoding,
    #[error("pairing code contains an invalid SSH profile")]
    BadPayload,
    #[error("Tailcat pairing cannot use a jump host")]
    TailcatJumpHost,
    #[error("Tailcat connection failed; check the address and server")]
    TailcatConnection,
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
    pub tailcat: Option<PairedTailcat>,
}

#[derive(Clone, Eq, PartialEq, uniffi::Record)]
pub struct PairedTailcat {
    pub address: String,
    pub private_key: String,
    pub public_key: String,
}

impl std::fmt::Debug for PairedTailcat {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PairedTailcat")
            .field("public_key", &self.public_key)
            .finish_non_exhaustive()
    }
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
    pair_host_guarded(code, public_key, device_name, jump_hosts, None).await
}
pub(crate) async fn pair_host_guarded(
    code: &str,
    public_key: &str,
    device_name: &str,
    jump_hosts: &[HostSshConfig],
    control: Option<Arc<crate::ssh_workflows::Control>>,
) -> Result<PairHostResult, PairingError> {
    if let Some(control) = &control {
        control
            .check()
            .map_err(|_| PairingError::CommandFailed(CANCELLED_OPERATION.into()))?;
    }
    let payload = decode_pairing_code(code.trim())?;
    if payload.tailcat && !jump_hosts.is_empty() {
        return Err(PairingError::TailcatJumpHost);
    }
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
    let mut jumps = crate::ssh::SessionRoute::default();
    for jump in jump_hosts {
        let mut connection = ssh_config(jump);
        connection.forward_agent = false;
        let session = timeout(
            CONNECT_TIMEOUT,
            SshSession::connect_guarded(
                &connection,
                jumps.0.last().map(Arc::as_ref),
                control.as_deref(),
            ),
        )
        .await
        .map_err(|_| PairingError::ConnectionTimeout)??;
        jumps.0.push(session);
    }
    let tailcat_identity = payload.tailcat.then(tailcat_client::Identity::generate);
    let connect_timeout = if payload.tailcat {
        TAILCAT_CONNECT_TIMEOUT
    } else {
        CONNECT_TIMEOUT
    };
    let mut handle = timeout(connect_timeout, async {
        if let Some(identity) = &tailcat_identity {
            let client = tailcat_client::Client::connect(
                &payload.ssh_host,
                identity,
                tailcat_client::ClientOptions::default(),
            )
            .await
            .map_err(|_| PairingError::TailcatConnection)?;
            let stream = client
                .dial_tcp(payload.ssh_port)
                .await
                .map_err(|_| PairingError::TailcatConnection)?;
            Ok(client::connect_stream(config, stream, handler).await?)
        } else if let Some(jump) = jumps.0.last() {
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

    if let Some(control) = &control {
        control
            .check()
            .map_err(|_| PairingError::CommandFailed(CANCELLED_OPERATION.into()))?;
    }
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
        device_name,
        public_key: public_key.to_owned(),
    })?;
    encoded.push(b'\n');
    if let Some(control) = &control {
        control
            .admit_mutation()
            .map_err(|_| PairingError::CommandFailed(CANCELLED_OPERATION.into()))?;
    }
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

    let tailcat = tailcat_identity.map(|identity| PairedTailcat {
        address: payload.ssh_host.clone(),
        private_key: identity.private_key(),
        public_key: identity.public_key(),
    });
    let ssh_host = if payload.tailcat {
        let digest = format!("{:x}", Sha256::digest(payload.ssh_host.as_bytes()));
        format!("tailcat-{}.invalid", &digest[..16])
    } else {
        payload.ssh_host
    };
    Ok(PairHostResult {
        ssh_host,
        ssh_port: payload.ssh_port,
        ssh_user: payload.ssh_user,
        ssh_host_fingerprint,
        ssh_host_key_type: accepted.key_type,
        ssh_host_public_key: accepted.public_key,
        key_fingerprint: response.fingerprint,
        already_present: response.already_present.unwrap_or(false),
        tailcat,
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

fn decode_pairing_code(code: &str) -> Result<whipair_protocol::PairingPayload, PairingError> {
    whipair_protocol::decode_pairing_code(code).map_err(PairingError::from)
}

impl From<ProtocolError> for PairingError {
    fn from(error: ProtocolError) -> Self {
        match error {
            ProtocolError::BadPrefix => Self::BadPrefix,
            ProtocolError::BadEncoding => Self::BadEncoding,
            ProtocolError::TrailingData | ProtocolError::BadPayload(_) => Self::BadPayload,
            ProtocolError::UnsupportedKey | ProtocolError::MalformedKey => Self::InvalidResponse,
        }
    }
}

#[cfg(test)]
mod transport_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_cli_golden_tailcat_codes() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../crates/whipair-protocol/tests/fixtures/tailcat-pairing.json"
        ))
        .unwrap();
        for (address_field, code_field) in [("address", "code"), ("longAddress", "longCode")] {
            let payload = decode_pairing_code(fixture[code_field].as_str().unwrap()).unwrap();
            assert!(payload.tailcat);
            assert_eq!(payload.ssh_host, fixture[address_field].as_str().unwrap());
            assert_eq!(payload.ssh_port, 22);
            assert_eq!(payload.ssh_user, "alice");
        }
    }

    #[test]
    fn preserves_public_codec_error_categories() {
        assert!(matches!(
            decode_pairing_code("WP3:BB8"),
            Err(PairingError::BadPrefix)
        ));
        assert!(matches!(
            decode_pairing_code("WP4:00"),
            Err(PairingError::BadEncoding)
        ));
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../crates/whipair-protocol/tests/fixtures/wp4-pairing.json"
        ))
        .unwrap();
        for field in ["trailingDataCode", "malformedTailcatCode"] {
            assert!(matches!(
                decode_pairing_code(fixture[field].as_str().unwrap()),
                Err(PairingError::BadPayload)
            ));
        }
    }

    #[test]
    fn temporary_private_key_is_deterministic() {
        let first = temporary_private_key(&[7; ED25519_SEED_BYTES]);
        let second = temporary_private_key(&[7; ED25519_SEED_BYTES]);
        assert_eq!(
            first.public_key().to_openssh().unwrap(),
            second.public_key().to_openssh().unwrap()
        );
    }
}
