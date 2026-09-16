//! Private QR-pinned bootstrap SSH connection used for WP4 pairing.

mod agent_sessions;
mod agent_transcript;
mod app_core;
mod chat_speech;
mod codex;
mod herdr_api;
mod herdr_codec;
mod herdr_connection;
mod herdr_events;
mod herdr_terminal;
mod host_profiles;
mod host_runtime;
mod host_state;
mod pairing;
mod remote_ops;
mod remote_preview;
mod ssh;

pub use agent_sessions::*;
pub use agent_transcript::*;
pub use app_core::*;
pub use chat_speech::*;
pub use herdr_api::*;
pub use herdr_events::*;
pub use herdr_terminal::*;
pub use host_profiles::*;
pub use host_runtime::*;
pub use host_state::*;
pub use remote_ops::*;

use std::sync::OnceLock;

use tokio::runtime::Runtime;

uniffi::setup_scaffolding!();

static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();

fn runtime() -> Result<&'static Runtime, String> {
    RUNTIME
        .get_or_init(|| Runtime::new().map_err(|error| error.to_string()))
        .as_ref()
        .map_err(Clone::clone)
}

fn lower_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        encoded.push(char::from(DIGITS[usize::from(byte >> 4)]));
        encoded.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    encoded
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum PairHostError {
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
    SshFailure(String),
    #[error("failed to initialize pairing runtime: {0}")]
    RuntimeInitialization(String),
    #[error("pairing runtime task failed: {0}")]
    RuntimeTaskFailed(String),
}

impl From<pairing::PairingError> for PairHostError {
    fn from(error: pairing::PairingError) -> Self {
        match error {
            pairing::PairingError::BadPrefix => Self::BadPrefix,
            pairing::PairingError::BadEncoding => Self::BadEncoding,
            pairing::PairingError::BadPayload => Self::BadPayload,
            pairing::PairingError::ConnectionTimeout => Self::ConnectionTimeout,
            pairing::PairingError::ApprovalTimeout => Self::ApprovalTimeout,
            pairing::PairingError::AuthenticationFailed => Self::AuthenticationFailed,
            pairing::PairingError::HostKeyMismatch => Self::HostKeyMismatch,
            pairing::PairingError::UnsupportedHostCertificate => Self::UnsupportedHostCertificate,
            pairing::PairingError::InvalidResponse => Self::InvalidResponse,
            pairing::PairingError::CommandFailed(message) => Self::CommandFailed(message),
            pairing::PairingError::Refused { code, message } => Self::Refused { code, message },
            pairing::PairingError::Ssh(error) => Self::SshFailure(error.to_string()),
            pairing::PairingError::SshKey(error) => Self::SshFailure(error.to_string()),
            pairing::PairingError::Json(error) => Self::SshFailure(error.to_string()),
        }
    }
}

#[uniffi::export]
pub async fn pair_host(
    code: String,
    public_key: String,
    device_name: String,
) -> Result<pairing::PairHostResult, PairHostError> {
    let task = match runtime() {
        Ok(runtime) => runtime.spawn(async move {
            pairing::pair_host(&code, &public_key, &device_name)
                .await
                .map_err(PairHostError::from)
        }),
        Err(error) => return Err(PairHostError::RuntimeInitialization(error)),
    };
    match task.await {
        Ok(response) => response,
        Err(error) => Err(PairHostError::RuntimeTaskFailed(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        sync::Arc,
        task::{Context, Poll, Wake, Waker},
        thread,
    };

    use super::{pair_host, ssh};

    const BASE45_ALPHABET: &[u8; 45] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

    struct ThreadWaker(thread::Thread);

    impl Wake for ThreadWaker {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }

    fn block_on_without_tokio<F: Future>(future: F) -> F::Output {
        let waker = Waker::from(Arc::new(ThreadWaker(thread::current())));
        let mut context = Context::from_waker(&waker);
        let mut future = std::pin::pin!(future);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(output) => return output,
                Poll::Pending => thread::park(),
            }
        }
    }

    fn base45_encode(bytes: &[u8]) -> String {
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

    fn unreachable_pairing_code() -> String {
        let mut payload = vec![1, 127, 0, 0, 1];
        payload.extend_from_slice(&1_u16.to_be_bytes());
        payload.push(4);
        payload.extend_from_slice(b"test");
        payload.extend_from_slice(&[7; 32]);
        payload.extend_from_slice(&[9; 32]);
        format!("WP4:{}", base45_encode(&payload))
    }

    #[test]
    fn exported_pairing_future_supplies_its_own_tokio_runtime() {
        let error = block_on_without_tokio(pair_host(
            unreachable_pairing_code(),
            "ssh-ed25519 AAAA test".to_owned(),
            "test device".to_owned(),
        ))
        .unwrap_err();
        let message = error.to_string();

        assert!(!message.contains("no reactor running"), "{message}");
        assert!(!matches!(error, super::PairHostError::RuntimeTaskFailed(_)));
    }

    #[test]
    fn exported_ssh_future_uses_the_core_tokio_runtime() {
        let error = block_on_without_tokio(ssh::connect_ssh(
            "127.0.0.1".to_owned(),
            1,
            "test".to_owned(),
            ssh::SshAuthentication::Password {
                password: "test".to_owned(),
            },
            "direct-core-test".to_owned(),
            None,
        ))
        .unwrap_err();
        let message = error.to_string();

        assert!(!message.contains("no reactor running"), "{message}");
        assert!(!message.contains("SSH runtime task failed"), "{message}");
        assert!(!message.contains("native transport"), "{message}");
    }
}
