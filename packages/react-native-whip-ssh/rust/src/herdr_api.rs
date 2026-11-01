//! Whip's transport and native boundary for the shared control protocol.

use crate::herdr_connection::{HerdrConnection, HerdrConnectionError, HerdrRequestReplay};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

pub(crate) use herdr_protocol::control::session_snapshot;
pub use herdr_protocol::control::{
    HerdrAgentInfo, HerdrAgentKind, HerdrAgentSessionInfo, HerdrAgentSessionKind, HerdrAgentStatus,
    HerdrControlRequest, HerdrControlResult, HerdrIntegrationInfo, HerdrIntegrationInstallResult,
    HerdrIntegrationState, HerdrPaneInfo, HerdrPaneLayoutPane, HerdrPaneLayoutRect,
    HerdrPaneLayoutSnapshot, HerdrPaneLayoutSplit, HerdrPaneReadFormat, HerdrPaneReadResult,
    HerdrPaneReadSource, HerdrPaneScrollInfo, HerdrPaneZoomReason, HerdrPaneZoomResult,
    HerdrSessionSnapshot, HerdrSplitDirection, HerdrTabInfo, HerdrWorkspaceInfo,
    HerdrWorkspaceWorktreeInfo, HerdrWorktreeInfo, MAX_CONTROL_RESPONSE_BYTES,
};

macro_rules! native_type {
    ($kind:ident, $item:item) => {
        #[uniffi::remote($kind)]
        $item
    };
}
herdr_protocol::herdr_control_type_schema!(native_type);

pub(crate) const CONTROL_TIMEOUT_MS: u64 = 15_000;

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrTabLaunch {
    Shell,
    Agent {
        kind: HerdrAgentKind,
        args: Vec<String>,
    },
    Command {
        command: String,
    },
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum HerdrTabLaunchResult {
    Created {
        tab: HerdrTabInfo,
        root_pane: HerdrPaneInfo,
    },
    LaunchFailed {
        tab: HerdrTabInfo,
        root_pane: HerdrPaneInfo,
        stage: HerdrTabLaunchStage,
        failure: HerdrControlFailure,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrControlFailureKind {
    TransportDisconnected,
    MalformedResponse,
    ProtocolError,
    UnsupportedResponse,
    InvalidField,
    RequestCancelled,
    RequestTimeout,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HerdrControlFailure {
    pub kind: HerdrControlFailureKind,
    pub code: Option<String>,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrTabLaunchStage {
    AgentStart,
    CommandInput,
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum HerdrControlError {
    #[error("{0}")]
    TransportDisconnected(String),
    #[error("{0}")]
    MalformedResponse(String),
    #[error("Herdr API error {0}: {1}")]
    ProtocolError(String, String),
    #[error("{0}")]
    UnsupportedResponse(String),
    #[error("{0}")]
    InvalidField(String),
    #[error("{0}")]
    RequestCancelled(String),
    #[error("{0}")]
    RequestTimeout(String),
}

impl From<HerdrControlError> for HerdrControlFailure {
    fn from(error: HerdrControlError) -> Self {
        let (kind, code) = match &error {
            HerdrControlError::TransportDisconnected(_) => {
                (HerdrControlFailureKind::TransportDisconnected, None)
            }
            HerdrControlError::MalformedResponse(_) => {
                (HerdrControlFailureKind::MalformedResponse, None)
            }
            HerdrControlError::ProtocolError(code, _) => {
                (HerdrControlFailureKind::ProtocolError, Some(code.clone()))
            }
            HerdrControlError::UnsupportedResponse(_) => {
                (HerdrControlFailureKind::UnsupportedResponse, None)
            }
            HerdrControlError::InvalidField(_) => (HerdrControlFailureKind::InvalidField, None),
            HerdrControlError::RequestCancelled(_) => {
                (HerdrControlFailureKind::RequestCancelled, None)
            }
            HerdrControlError::RequestTimeout(_) => (HerdrControlFailureKind::RequestTimeout, None),
        };
        Self {
            kind,
            code,
            message: error.to_string(),
        }
    }
}

impl From<herdr_protocol::control::HerdrControlProtocolError> for HerdrControlError {
    fn from(error: herdr_protocol::control::HerdrControlProtocolError) -> Self {
        use herdr_protocol::control::HerdrControlProtocolError as Error;
        match error {
            Error::MalformedResponse(message) => Self::MalformedResponse(message),
            Error::ProtocolError(code, message) => Self::ProtocolError(code, message),
            Error::UnsupportedResponse(message) => Self::UnsupportedResponse(message),
            Error::InvalidField(message) => Self::InvalidField(message),
        }
    }
}

static CONTROL_SEQUENCES: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn control_sequences() -> &'static Mutex<HashMap<String, u64>> {
    CONTROL_SEQUENCES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_request_id(client_key: &str) -> String {
    let sequence = {
        let mut sequences = control_sequences().lock();
        let sequence = sequences.entry(client_key.to_owned()).or_default();
        *sequence += 1;
        let sequence = *sequence;
        drop(sequences);
        sequence
    };
    format!("android_{sequence}")
}

fn transport_error(error: HerdrConnectionError) -> HerdrControlError {
    if matches!(error, HerdrConnectionError::Disabled) {
        return HerdrControlError::InvalidField(error.to_string());
    }
    let timed_out = error.is_timeout();
    let message = error.to_string();
    if timed_out {
        HerdrControlError::RequestTimeout(message)
    } else {
        HerdrControlError::TransportDisconnected(message)
    }
}

pub(crate) async fn request_on_runtime(
    connection: Arc<HerdrConnection>,
    request: HerdrControlRequest,
    replay: HerdrRequestReplay,
) -> Result<HerdrControlResult, HerdrControlError> {
    let request_id = next_request_id(connection.client_key());
    if connection.backend().await? == crate::host_profiles::HostHerdrBackend::Core {
        return connection.core().await?.control(request, &request_id).await;
    }
    let bytes = request.encode(&request_id)?;
    let response = connection
        .request(
            &bytes,
            b'\n',
            CONTROL_TIMEOUT_MS,
            MAX_CONTROL_RESPONSE_BYTES,
            replay,
        )
        .await
        .map_err(transport_error)?;
    parse_response(&request, &response)
}

#[uniffi::export]
pub async fn herdr_control_request(
    client_key: String,
    socket_path: String,
    request: HerdrControlRequest,
) -> Result<HerdrControlResult, HerdrControlError> {
    let runtime = crate::runtime().map_err(HerdrControlError::TransportDisconnected)?;
    let connection = HerdrConnection::registered(client_key, socket_path)
        .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?;
    runtime
        .spawn(request_on_runtime(
            connection,
            request,
            HerdrRequestReplay::Never,
        ))
        .await
        .map_err(|error| {
            HerdrControlError::RequestCancelled(format!(
                "Herdr control runtime task failed: {error}"
            ))
        })?
}

pub(crate) fn parse_response(
    request: &HerdrControlRequest,
    bytes: &[u8],
) -> Result<HerdrControlResult, HerdrControlError> {
    herdr_protocol::control::parse_response(request, bytes).map_err(Into::into)
}

/// The reverse-control surface preserves fields newer than the native UI model.
pub(crate) async fn request_json_on_runtime(
    connection: Arc<HerdrConnection>,
    method: &str,
    params: Value,
    timeout_ms: u64,
) -> Result<Value, HerdrControlError> {
    if connection.backend().await? == crate::HostHerdrBackend::Core {
        let core = connection.core().await?;
        return tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            core.request_json(method, params, &next_request_id(connection.client_key())),
        )
        .await
        .map_err(|_| {
            HerdrControlError::RequestTimeout(
                "core request timed out; its outcome may be unknown".into(),
            )
        })?;
    }
    let mut bytes = serde_json::to_vec(&serde_json::json!({
        "id": next_request_id(connection.client_key()), "method":method, "params":params
    }))
    .map_err(|error| HerdrControlError::InvalidField(error.to_string()))?;
    bytes.push(b'\n');
    let response = connection
        .request(
            &bytes,
            b'\n',
            timeout_ms,
            MAX_CONTROL_RESPONSE_BYTES,
            HerdrRequestReplay::Never,
        )
        .await
        .map_err(transport_error)?;
    parse_json_response(&response)
}

pub(crate) fn parse_json_response(bytes: &[u8]) -> Result<Value, HerdrControlError> {
    herdr_protocol::control::parse_json_response(bytes).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_failures_keep_the_native_error_categories_and_server_codes() {
        let cases: &[(&[u8], HerdrControlFailureKind, Option<&str>)] = &[
            (b"invalid", HerdrControlFailureKind::MalformedResponse, None),
            (
                br#"{"error":{"code":"not_found","message":"missing pane"}}"#,
                HerdrControlFailureKind::ProtocolError,
                Some("not_found"),
            ),
            (
                br#"{"result":{"type":"future_response"}}"#,
                HerdrControlFailureKind::UnsupportedResponse,
                None,
            ),
            (
                br#"{"result":{"type":"pong","version":3,"protocol":22}}"#,
                HerdrControlFailureKind::InvalidField,
                None,
            ),
        ];
        for (bytes, kind, code) in cases {
            let error = parse_response(&HerdrControlRequest::Ping, bytes).unwrap_err();
            let failure = HerdrControlFailure::from(error);
            assert_eq!(failure.kind, *kind);
            assert_eq!(failure.code.as_deref(), *code);
        }
    }
}
