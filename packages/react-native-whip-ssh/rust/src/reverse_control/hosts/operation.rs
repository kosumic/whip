use std::sync::Arc;

use serde_json::{Value, json};

use super::{HostActionConnection, HostActionPlatformError, HostActionProfilePatch, Operation};
use crate::app_core::AppConnectionStatus;
use crate::host_profiles::{HostAuthMode, HostProfileRecord, resolve_chain};
use crate::reverse_control::ReverseControl;
use crate::reverse_control::application::{
    CONNECT, DELETE, DISCONNECT, INSTRUCTIONS, LIST, SAVE, host_result,
};
use crate::reverse_control::browser::model::{BrowserError, ErrorCode};

pub(crate) enum HostAction {
    List,
    Instructions(Option<String>),
    Save {
        host_id: String,
        patch: Box<HostActionProfilePatch>,
        credential_source: Option<String>,
    },
    Connect(String),
    Disconnect(String),
    Delete(String),
}

impl HostAction {
    pub(crate) fn from_validated(name: &str, arguments: &Value) -> Result<Self, BrowserError> {
        let host_id = arguments["host_id"].as_str().map(str::to_owned);
        Ok(match name {
            LIST => Self::List,
            INSTRUCTIONS => Self::Instructions(host_id),
            SAVE => {
                let mut patch: HostActionProfilePatch =
                    serde_json::from_value(arguments["profile"].clone())
                        .map_err(|_| BrowserError::invalid("Invalid host profile fields"))?;
                patch.jump_host_changed = arguments["profile"].get("jumpHostId").is_some();
                Self::Save {
                    host_id: host_id.ok_or_else(|| BrowserError::invalid("host_id is required"))?,
                    patch: Box::new(patch),
                    credential_source: arguments["credential_from_host_id"]
                        .as_str()
                        .map(str::to_owned),
                }
            }
            CONNECT | DISCONNECT | DELETE => {
                let id = host_id.ok_or_else(|| BrowserError::invalid("host_id is required"))?;
                match name {
                    CONNECT => Self::Connect(id),
                    DISCONNECT => Self::Disconnect(id),
                    _ => Self::Delete(id),
                }
            }
            _ => return Err(BrowserError::invalid("Unknown host operation")),
        })
    }

    pub(crate) fn is_instructions(&self) -> bool {
        matches!(self, Self::Instructions(_))
    }

    fn name(&self) -> &'static str {
        match self {
            Self::List => LIST,
            Self::Instructions(_) => INSTRUCTIONS,
            Self::Save { .. } => SAVE,
            Self::Connect(_) => CONNECT,
            Self::Disconnect(_) => DISCONNECT,
            Self::Delete(_) => DELETE,
        }
    }

    pub(crate) async fn run(
        self,
        owner: Arc<ReverseControl>,
        session: &str,
        parent: &str,
        caller_host: &str,
    ) -> Result<Value, BrowserError> {
        let operation = Operation::begin(&owner, session, parent)?;
        let name = self.name();
        let result = if matches!(self, Self::List | Self::Instructions(_)) {
            self.execute(&operation, caller_host).await
        } else {
            let _serial = operation.coordinator.mutation.lock().await;
            self.execute(&operation, caller_host).await
        };
        operation.finish(result.and_then(|value| host_result(name, value)));
        // The authenticated response was settled while the permit was active.
        // The ordinary request cleanup sees no pending response to send again.
        Ok(Value::Null)
    }

    async fn execute(
        self,
        operation: &Operation,
        caller_host: &str,
    ) -> Result<Value, BrowserError> {
        let context = operation.context()?;
        let platform = &operation.coordinator.platform;
        let permit = &operation.permit;
        match self {
            Self::List => Ok(json!({
                "hosts": context.hosts,
                "connections": context.connections.iter().map(connection_value).collect::<Vec<_>>(),
            })),
            Self::Instructions(host_id) => {
                let host = find_host(&context.hosts, host_id.as_deref().unwrap_or(caller_host))?;
                Ok(
                    json!({"host_id":host.id,"global":context.global_instructions,"host":host.agent_instructions}),
                )
            }
            Self::Save {
                host_id,
                patch,
                credential_source,
            } => {
                if let Some(source_id) = &credential_source {
                    let source = find_host(&context.hosts, source_id)?;
                    permit.pin_credential(source)?;
                    if context.biometric_for_keys && source.auth_mode == HostAuthMode::Key {
                        authenticate(operation).await?;
                    }
                }
                let previous = operation.host_snapshot(&host_id)?;
                let host = operation
                    .effect(
                        "save_metadata",
                        platform.save_metadata(
                            permit.clone(),
                            host_id.clone(),
                            *patch,
                            credential_source,
                        ),
                    )
                    .await?;
                if host.id != host_id {
                    return Err(BrowserError::new(
                        ErrorCode::InvalidResult,
                        "Saved host response belongs to a different host",
                    ));
                }
                operation.confirm_host(&host_id, previous.as_ref(), Some(host.clone()));
                Ok(json!({"host":host}))
            }
            Self::Connect(host_id) => {
                let host = find_host(&context.hosts, &host_id)?.clone();
                if let Some(connection) = context
                    .connections
                    .iter()
                    .find(|connection| connected_to(connection, &host_id))
                {
                    return Ok(connection_value(connection));
                }
                let jump_hosts = resolve_chain(
                    &context.hosts,
                    &host_id,
                    host.jump_host_id.as_deref(),
                )
                .map_err(|_| {
                    BrowserError::invalid("Saved jump-host configuration is unavailable or invalid")
                })?;
                permit.pin_connections(
                    std::iter::once(host.clone()).chain(jump_hosts.iter().cloned()),
                )?;
                if context.biometric_for_keys
                    && std::iter::once(&host)
                        .chain(&jump_hosts)
                        .any(|profile| profile.auth_mode == HostAuthMode::Key)
                {
                    authenticate(operation).await?;
                }
                let credential = operation
                    .effect(
                        "read_credential",
                        platform.read_credential(permit.clone(), host.clone()),
                    )
                    .await?;
                if credential.secret.is_empty() {
                    return Err(BrowserError::invalid(
                        HostActionPlatformError::CredentialMissing.to_string(),
                    ));
                }
                // Credential loading or local trust prompts may yield to edits.
                // Never connect a captured credential to a replaced host profile.
                permit.check()?;
                let previous = operation.connection_snapshot(&host_id)?;
                if !operation
                    .effect(
                        "connect",
                        platform.connect(permit.clone(), host, credential),
                    )
                    .await?
                {
                    return Err(permit.with_progress(BrowserError::new(
                        ErrorCode::DeviceUnavailable,
                        "Host connection did not complete",
                    )));
                }
                let current = operation.context()?;
                let connection = current
                    .connections
                    .iter()
                    .find(|connection| connected_to(connection, &host_id))
                    .cloned()
                    .unwrap_or(HostActionConnection {
                        host_id: host_id.clone(),
                        status: AppConnectionStatus::Connected,
                    });
                operation.confirm_connection(&host_id, previous.as_ref(), Some(connection.clone()));
                Ok(connection_value(&connection))
            }
            Self::Disconnect(host_id) => {
                find_host(&context.hosts, &host_id)?;
                let previous = operation.connection_snapshot(&host_id)?;
                operation
                    .effect(
                        "disconnect",
                        platform.disconnect(permit.clone(), host_id.clone(), true),
                    )
                    .await?;
                operation.confirm_connection(&host_id, previous.as_ref(), None);
                Ok(json!({"host_id":host_id,"completed":true}))
            }
            Self::Delete(host_id) => {
                find_host(&context.hosts, &host_id)?;
                // Preserve existing order: no later phase runs after a failure.
                // Earlier committed phases are explicitly reported, never rolled
                // back or represented as an atomic cross-store transaction.
                operation
                    .effect(
                        "delete_transcripts",
                        platform.delete_transcripts(permit.clone(), host_id.clone()),
                    )
                    .await?;
                operation
                    .effect(
                        "delete_snapshot",
                        platform.delete_snapshot(permit.clone(), host_id.clone()),
                    )
                    .await?;
                let previous = operation.host_snapshot(&host_id)?;
                operation
                    .effect(
                        "delete_profile",
                        platform.delete_profile(permit.clone(), host_id.clone()),
                    )
                    .await?;
                operation.confirm_host(&host_id, previous.as_ref(), None);
                // This is last: deleting the caller's own host revokes its MCP
                // session as well. Do not recreate deleted metadata on close.
                let previous = operation.connection_snapshot(&host_id)?;
                operation
                    .effect(
                        "disconnect",
                        platform.disconnect(permit.clone(), host_id.clone(), false),
                    )
                    .await?;
                operation.confirm_connection(&host_id, previous.as_ref(), None);
                Ok(json!({"host_id":host_id,"completed":true}))
            }
        }
    }
}

async fn authenticate(operation: &Operation) -> Result<(), BrowserError> {
    if operation
        .effect(
            "authenticate",
            operation
                .coordinator
                .platform
                .authenticate(operation.permit.clone()),
        )
        .await?
    {
        Ok(())
    } else {
        Err(operation.permit.with_progress(BrowserError::new(
            ErrorCode::PermissionDenied,
            "Credential use was not authorized",
        )))
    }
}

fn find_host<'a>(
    hosts: &'a [HostProfileRecord],
    id: &str,
) -> Result<&'a HostProfileRecord, BrowserError> {
    hosts
        .iter()
        .find(|host| host.id == id)
        .ok_or_else(|| BrowserError::new(ErrorCode::NotFound, "Saved host does not exist"))
}

fn connected_to(connection: &HostActionConnection, host_id: &str) -> bool {
    connection.host_id == host_id
        && matches!(
            connection.status,
            AppConnectionStatus::Connected | AppConnectionStatus::Ready
        )
}

fn connection_value(connection: &HostActionConnection) -> Value {
    let status = match connection.status {
        AppConnectionStatus::Connecting => "connecting",
        AppConnectionStatus::Connected => "connected",
        AppConnectionStatus::Ready => "ready",
        AppConnectionStatus::Reconnecting => "reconnecting",
        AppConnectionStatus::Disconnected => "disconnected",
        AppConnectionStatus::Error => "error",
    };
    json!({"host_id":connection.host_id,"status":status})
}
