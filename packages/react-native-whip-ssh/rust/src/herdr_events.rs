//! Native Herdr event subscription, JSONL framing, normalization, and validation.

use crate::sink_calls::SinkCalls;
use std::collections::HashMap;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

use crate::herdr_api::{
    HerdrAgentStatus, HerdrPaneInfo, HerdrPaneLayoutSnapshot, HerdrPaneScrollInfo, HerdrTabInfo,
    HerdrWorkspaceInfo, HerdrWorktreeInfo, agent_status, bool_value, non_empty_string_value,
    non_negative_number, object, optional_string, pane, pane_layout, pane_scroll, required,
    required_string, string_array, string_map, tab, workspace, worktree,
};
use crate::herdr_codec;
use crate::herdr_connection::{HerdrConnection, HerdrStream, HerdrStreamFraming, HerdrStreamKind};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::oneshot;

const MAX_EVENT_LINE_BYTES: usize = 1024 * 1024;
const EVENT_READ_CHUNK_BYTES: usize = 32 * 1024;
const SUBSCRIPTION_ACK_TIMEOUT: Duration = Duration::from_secs(15);
const SUBSCRIPTION_REQUEST_ID: &str = "android_events";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SubscriptionKind {
    None,
    Lifecycle,
    PerPane,
}

macro_rules! herdr_event_kinds {
    ($($variant:ident => ($name:literal, $min_protocol:literal, $subscription:ident)),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        enum HerdrEventKind {
            $($variant),+
        }

        impl HerdrEventKind {
            const ALL: &'static [Self] = &[$(Self::$variant),+];

            const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $name),+
                }
            }

            const fn min_protocol(self) -> u32 {
                match self {
                    $(Self::$variant => $min_protocol),+
                }
            }

            const fn subscription(self) -> SubscriptionKind {
                match self {
                    $(Self::$variant => SubscriptionKind::$subscription),+
                }
            }

            fn parse(value: &str) -> Option<Self> {
                match value {
                    $($name => Some(Self::$variant)),+,
                    _ => None,
                }
            }
        }
    };
}

herdr_event_kinds! {
    WorkspaceCreated => ("workspace.created", 17, Lifecycle),
    WorkspaceUpdated => ("workspace.updated", 17, Lifecycle),
    WorkspaceMetadataUpdated => ("workspace.metadata_updated", 17, Lifecycle),
    WorkspaceClosed => ("workspace.closed", 17, Lifecycle),
    WorkspaceRenamed => ("workspace.renamed", 17, Lifecycle),
    WorkspaceMoved => ("workspace.moved", 17, Lifecycle),
    WorkspaceReordered => ("workspace.reordered", 18, Lifecycle),
    WorkspaceFocused => ("workspace.focused", 17, Lifecycle),
    WorktreeCreated => ("worktree.created", 17, Lifecycle),
    WorktreeOpened => ("worktree.opened", 17, Lifecycle),
    WorktreeRemoved => ("worktree.removed", 17, Lifecycle),
    TabCreated => ("tab.created", 17, Lifecycle),
    TabClosed => ("tab.closed", 17, Lifecycle),
    TabFocused => ("tab.focused", 17, Lifecycle),
    TabRenamed => ("tab.renamed", 17, Lifecycle),
    TabMoved => ("tab.moved", 17, Lifecycle),
    PaneCreated => ("pane.created", 17, Lifecycle),
    PaneUpdated => ("pane.updated", 17, Lifecycle),
    PaneClosed => ("pane.closed", 17, Lifecycle),
    PaneFocused => ("pane.focused", 17, Lifecycle),
    PaneExited => ("pane.exited", 17, Lifecycle),
    PaneMoved => ("pane.moved", 17, Lifecycle),
    PaneOutputChanged => ("pane.output_changed", 17, None),
    PaneAgentDetected => ("pane.agent_detected", 17, Lifecycle),
    PaneAgentStatusChanged => ("pane.agent_status_changed", 17, PerPane),
    PaneScrollChanged => ("pane.scroll_changed", 17, PerPane),
    LayoutUpdated => ("layout.updated", 17, Lifecycle),
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
// UniFFI data-carrying variants keep the JS boundary exhaustive. Boxing the
// records would add allocations to every event without reducing FFI payloads.
#[allow(
    clippy::large_enum_variant,
    reason = "boxing UniFFI event payloads would add allocations without reducing FFI payload size"
)]
pub enum HerdrEvent {
    WorkspaceCreated {
        workspace: HerdrWorkspaceInfo,
    },
    WorkspaceUpdated {
        workspace: HerdrWorkspaceInfo,
    },
    WorkspaceMetadataUpdated {
        workspace: HerdrWorkspaceInfo,
    },
    WorkspaceClosed {
        workspace_id: String,
        workspace: Option<HerdrWorkspaceInfo>,
    },
    WorkspaceRenamed {
        workspace_id: String,
        label: String,
    },
    WorkspaceMoved {
        workspace_id: String,
        insert_index: f64,
        workspaces: Vec<HerdrWorkspaceInfo>,
    },
    WorkspaceReordered {
        workspace_ids: Vec<String>,
        workspaces: Vec<HerdrWorkspaceInfo>,
        before_workspace_id: Option<String>,
    },
    WorkspaceFocused {
        workspace_id: String,
    },
    WorktreeCreated {
        workspace: HerdrWorkspaceInfo,
        worktree: HerdrWorktreeInfo,
    },
    WorktreeOpened {
        workspace: HerdrWorkspaceInfo,
        worktree: HerdrWorktreeInfo,
        already_open: bool,
    },
    WorktreeRemoved {
        workspace_id: String,
        workspace: Option<HerdrWorkspaceInfo>,
        worktree: HerdrWorktreeInfo,
        forced: bool,
    },
    TabCreated {
        tab: HerdrTabInfo,
    },
    TabClosed {
        workspace_id: String,
        tab_id: String,
    },
    TabFocused {
        workspace_id: String,
        tab_id: String,
    },
    TabRenamed {
        workspace_id: String,
        tab_id: String,
        label: String,
    },
    TabMoved {
        workspace_id: String,
        tab_id: String,
        insert_index: f64,
        tabs: Vec<HerdrTabInfo>,
    },
    PaneCreated {
        pane: HerdrPaneInfo,
    },
    PaneUpdated {
        pane: HerdrPaneInfo,
    },
    PaneClosed {
        workspace_id: String,
        pane_id: String,
    },
    PaneFocused {
        workspace_id: String,
        pane_id: String,
    },
    PaneExited {
        workspace_id: String,
        pane_id: String,
    },
    PaneMoved {
        previous_pane_id: String,
        previous_workspace_id: String,
        previous_tab_id: String,
        pane: HerdrPaneInfo,
        created_workspace: Option<HerdrWorkspaceInfo>,
        created_tab: Option<HerdrTabInfo>,
        closed_workspace_id: Option<String>,
        closed_tab_id: Option<String>,
    },
    PaneOutputChanged {
        workspace_id: String,
        pane_id: String,
        revision: f64,
    },
    PaneScrollChanged {
        workspace_id: String,
        pane_id: String,
        scroll: HerdrPaneScrollInfo,
    },
    PaneAgentDetected {
        workspace_id: String,
        pane_id: String,
        agent: Option<String>,
        released: bool,
        final_status: Option<HerdrAgentStatus>,
    },
    PaneAgentStatusChanged {
        workspace_id: String,
        pane_id: String,
        agent_status: HerdrAgentStatus,
        agent: Option<String>,
        title: Option<String>,
        display_agent: Option<String>,
        state_labels: Option<HashMap<String, String>>,
    },
    LayoutUpdated {
        layout: HerdrPaneLayoutSnapshot,
    },
    ProtocolUnknown {
        raw_event: String,
    },
    ProtocolInvalid {
        raw_event: String,
        reason: String,
    },
}

#[uniffi::export(with_foreign)]
pub trait HerdrEventSink: Send + Sync {
    fn event(&self, client_key: String, event: HerdrEvent);
    fn closed(&self, client_key: String, reason: String);
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum HerdrEventError {
    #[error("{0}")]
    UnsupportedProtocol(String),
    #[error("{0}")]
    TransportDisconnected(String),
    #[error("{0}")]
    SubscriptionUnavailable(String),
}

#[derive(Default)]
struct JsonlEventParser {
    buffer: Vec<u8>,
    discarding_oversized_line: bool,
}

enum StreamItem {
    Acknowledged,
    Event(Box<HerdrEvent>),
    ServerError(String),
}

impl JsonlEventParser {
    fn push(&mut self, bytes: &[u8]) -> Vec<StreamItem> {
        let mut items = Vec::new();
        for byte in bytes {
            if self.discarding_oversized_line {
                if *byte == b'\n' {
                    self.discarding_oversized_line = false;
                }
                continue;
            }
            if *byte == b'\n' {
                let mut line = std::mem::take(&mut self.buffer);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                if let Some(item) = parse_stream_line(&line) {
                    items.push(item);
                }
                continue;
            }
            self.buffer.push(*byte);
            if self.buffer.len() > MAX_EVENT_LINE_BYTES {
                self.buffer.clear();
                self.discarding_oversized_line = true;
                items.push(StreamItem::Event(Box::new(HerdrEvent::ProtocolInvalid {
                    raw_event: "event_stream".to_owned(),
                    reason: format!("event line exceeds {MAX_EVENT_LINE_BYTES} bytes"),
                })));
            }
        }
        items
    }

    fn end(&mut self) {
        self.buffer.clear();
        self.discarding_oversized_line = false;
    }
}

fn parse_stream_line(bytes: &[u8]) -> Option<StreamItem> {
    let line = String::from_utf8_lossy(bytes);
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let message = value.as_object()?;
    if let Some(error) = message.get("error") {
        let error = match object(error, "event error") {
            Ok(error) => error,
            Err(reason) => return Some(StreamItem::ServerError(reason)),
        };
        let code = required_string(error, "code", "error.code")
            .unwrap_or_else(|_| "protocol_error".to_owned());
        let message = required_string(error, "message", "error.message")
            .unwrap_or_else(|_| "Herdr event subscription failed".to_owned());
        return Some(StreamItem::ServerError(if message.is_empty() {
            code
        } else {
            message
        }));
    }
    if let Some(result) = message.get("result") {
        let response_id = match required_string(message, "id", "id") {
            Ok(response_id) => response_id,
            Err(reason) => return Some(StreamItem::ServerError(reason)),
        };
        if response_id != SUBSCRIPTION_REQUEST_ID {
            return Some(StreamItem::ServerError(format!(
                "event subscription response id must be {SUBSCRIPTION_REQUEST_ID}"
            )));
        }
        let result = match object(result, "subscription result") {
            Ok(result) => result,
            Err(reason) => return Some(StreamItem::ServerError(reason)),
        };
        let result_type = match required_string(result, "type", "result.type") {
            Ok(result_type) => result_type,
            Err(reason) => return Some(StreamItem::ServerError(reason)),
        };
        return Some(if result_type == "subscription_started" {
            StreamItem::Acknowledged
        } else {
            StreamItem::ServerError(format!(
                "Herdr returned {result_type} for events.subscribe, expected subscription_started"
            ))
        });
    }
    let (raw_event, data) = match message.get("event") {
        Some(Value::String(event)) => (event.as_str(), message.get("data").unwrap_or(&Value::Null)),
        Some(Value::Object(event)) => match event.get("event") {
            Some(Value::String(kind)) => (kind.as_str(), event.get("data").unwrap_or(&Value::Null)),
            _ => return None,
        },
        _ => return None,
    };
    Some(StreamItem::Event(Box::new(decode_event(raw_event, data))))
}

fn normalize_event_kind(raw_event: &str) -> Option<HerdrEventKind> {
    HerdrEventKind::parse(raw_event).or_else(|| {
        (!raw_event.contains('.'))
            .then(|| raw_event.replacen('_', ".", 1))
            .and_then(|event| HerdrEventKind::parse(&event))
    })
}

fn decode_event(raw_event: &str, value: &Value) -> HerdrEvent {
    let Some(kind) = normalize_event_kind(raw_event) else {
        return HerdrEvent::ProtocolUnknown {
            raw_event: raw_event.to_owned(),
        };
    };
    match decode_known_event(kind, value) {
        Ok(event) => event,
        Err(reason) => HerdrEvent::ProtocolInvalid {
            raw_event: raw_event.to_owned(),
            reason,
        },
    }
}

fn validate_discriminator(data: &Map<String, Value>, kind: HerdrEventKind) -> Result<(), String> {
    let Some(value) = data.get("type") else {
        return Ok(());
    };
    let expected = kind.as_str().replacen('.', "_", 1);
    if value.as_str() == Some(expected.as_str()) {
        Ok(())
    } else {
        Err(format!("type must be {expected}"))
    }
}

fn optional_decoded<T>(
    data: &Map<String, Value>,
    key: &str,
    label: &str,
    decode: impl FnOnce(&Value, &str) -> Result<T, String>,
) -> Result<Option<T>, String> {
    data.get(key).map(|value| decode(value, label)).transpose()
}

fn required_id(data: &Map<String, Value>, key: &str) -> Result<String, String> {
    non_empty_string_value(required(data, key, key)?, key)
}

fn decoded_array<T>(
    value: &Value,
    label: &str,
    decode: impl Fn(&Value, &str) -> Result<T, String>,
) -> Result<Vec<T>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("{label} must be an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| decode(value, &format!("{label}[{index}]")))
        .collect()
}

fn decode_known_event(kind: HerdrEventKind, value: &Value) -> Result<HerdrEvent, String> {
    let data = object(value, "event data")?;
    validate_discriminator(data, kind)?;
    Ok(match kind {
        HerdrEventKind::WorkspaceCreated => HerdrEvent::WorkspaceCreated {
            workspace: workspace(required(data, "workspace", "workspace")?, "workspace")?,
        },
        HerdrEventKind::WorkspaceUpdated => HerdrEvent::WorkspaceUpdated {
            workspace: workspace(required(data, "workspace", "workspace")?, "workspace")?,
        },
        HerdrEventKind::WorkspaceMetadataUpdated => HerdrEvent::WorkspaceMetadataUpdated {
            workspace: workspace(required(data, "workspace", "workspace")?, "workspace")?,
        },
        HerdrEventKind::WorkspaceClosed => HerdrEvent::WorkspaceClosed {
            workspace_id: required_id(data, "workspace_id")?,
            workspace: optional_decoded(data, "workspace", "workspace", workspace)?,
        },
        HerdrEventKind::WorkspaceRenamed => HerdrEvent::WorkspaceRenamed {
            workspace_id: required_id(data, "workspace_id")?,
            label: required_string(data, "label", "label")?,
        },
        HerdrEventKind::WorkspaceMoved => HerdrEvent::WorkspaceMoved {
            workspace_id: required_id(data, "workspace_id")?,
            insert_index: non_negative_number(
                required(data, "insert_index", "insert_index")?,
                "insert_index",
            )?,
            workspaces: decoded_array(
                required(data, "workspaces", "workspaces")?,
                "workspaces",
                workspace,
            )?,
        },
        HerdrEventKind::WorkspaceReordered => HerdrEvent::WorkspaceReordered {
            workspace_ids: string_array(
                required(data, "workspace_ids", "workspace_ids")?,
                "workspace_ids",
            )?
            .into_iter()
            .enumerate()
            .map(|(index, id)| {
                if id.is_empty() {
                    Err(format!("workspace_ids[{index}] must not be empty"))
                } else {
                    Ok(id)
                }
            })
            .collect::<Result<Vec<_>, _>>()?,
            workspaces: decoded_array(
                required(data, "workspaces", "workspaces")?,
                "workspaces",
                workspace,
            )?,
            before_workspace_id: optional_string(
                data,
                "before_workspace_id",
                "before_workspace_id",
            )?,
        },
        HerdrEventKind::WorkspaceFocused => HerdrEvent::WorkspaceFocused {
            workspace_id: required_id(data, "workspace_id")?,
        },
        HerdrEventKind::WorktreeCreated => HerdrEvent::WorktreeCreated {
            workspace: workspace(required(data, "workspace", "workspace")?, "workspace")?,
            worktree: worktree(required(data, "worktree", "worktree")?, "worktree")?,
        },
        HerdrEventKind::WorktreeOpened => HerdrEvent::WorktreeOpened {
            workspace: workspace(required(data, "workspace", "workspace")?, "workspace")?,
            worktree: worktree(required(data, "worktree", "worktree")?, "worktree")?,
            already_open: bool_value(
                required(data, "already_open", "already_open")?,
                "already_open",
            )?,
        },
        HerdrEventKind::WorktreeRemoved => HerdrEvent::WorktreeRemoved {
            workspace_id: required_id(data, "workspace_id")?,
            workspace: optional_decoded(data, "workspace", "workspace", workspace)?,
            worktree: worktree(required(data, "worktree", "worktree")?, "worktree")?,
            forced: bool_value(required(data, "forced", "forced")?, "forced")?,
        },
        HerdrEventKind::TabCreated => HerdrEvent::TabCreated {
            tab: tab(required(data, "tab", "tab")?, "tab")?,
        },
        HerdrEventKind::TabClosed => HerdrEvent::TabClosed {
            workspace_id: required_id(data, "workspace_id")?,
            tab_id: required_id(data, "tab_id")?,
        },
        HerdrEventKind::TabFocused => HerdrEvent::TabFocused {
            workspace_id: required_id(data, "workspace_id")?,
            tab_id: required_id(data, "tab_id")?,
        },
        HerdrEventKind::TabRenamed => HerdrEvent::TabRenamed {
            workspace_id: required_id(data, "workspace_id")?,
            tab_id: required_id(data, "tab_id")?,
            label: required_string(data, "label", "label")?,
        },
        HerdrEventKind::TabMoved => HerdrEvent::TabMoved {
            workspace_id: required_id(data, "workspace_id")?,
            tab_id: required_id(data, "tab_id")?,
            insert_index: non_negative_number(
                required(data, "insert_index", "insert_index")?,
                "insert_index",
            )?,
            tabs: decoded_array(required(data, "tabs", "tabs")?, "tabs", tab)?,
        },
        HerdrEventKind::PaneCreated => HerdrEvent::PaneCreated {
            pane: pane(required(data, "pane", "pane")?, "pane")?,
        },
        HerdrEventKind::PaneUpdated => HerdrEvent::PaneUpdated {
            pane: pane(required(data, "pane", "pane")?, "pane")?,
        },
        HerdrEventKind::PaneClosed => HerdrEvent::PaneClosed {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
        },
        HerdrEventKind::PaneFocused => HerdrEvent::PaneFocused {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
        },
        HerdrEventKind::PaneExited => HerdrEvent::PaneExited {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
        },
        HerdrEventKind::PaneMoved => HerdrEvent::PaneMoved {
            previous_pane_id: required_id(data, "previous_pane_id")?,
            previous_workspace_id: required_id(data, "previous_workspace_id")?,
            previous_tab_id: required_id(data, "previous_tab_id")?,
            pane: pane(required(data, "pane", "pane")?, "pane")?,
            created_workspace: optional_decoded(
                data,
                "created_workspace",
                "created_workspace",
                workspace,
            )?,
            created_tab: optional_decoded(data, "created_tab", "created_tab", tab)?,
            closed_workspace_id: optional_string(
                data,
                "closed_workspace_id",
                "closed_workspace_id",
            )?,
            closed_tab_id: optional_string(data, "closed_tab_id", "closed_tab_id")?,
        },
        HerdrEventKind::PaneOutputChanged => HerdrEvent::PaneOutputChanged {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
            revision: non_negative_number(required(data, "revision", "revision")?, "revision")?,
        },
        HerdrEventKind::PaneScrollChanged => HerdrEvent::PaneScrollChanged {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
            scroll: pane_scroll(required(data, "scroll", "scroll")?, "scroll")?,
        },
        HerdrEventKind::PaneAgentDetected => HerdrEvent::PaneAgentDetected {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
            agent: optional_string(data, "agent", "agent")?,
            released: match data.get("released") {
                Some(value) => bool_value(value, "released")?,
                None => false,
            },
            final_status: data
                .get("final_status")
                .map(|value| agent_status(value, "final_status"))
                .transpose()?,
        },
        HerdrEventKind::PaneAgentStatusChanged => HerdrEvent::PaneAgentStatusChanged {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
            agent_status: agent_status(
                required(data, "agent_status", "agent_status")?,
                "agent_status",
            )?,
            agent: optional_string(data, "agent", "agent")?,
            title: optional_string(data, "title", "title")?,
            display_agent: optional_string(data, "display_agent", "display_agent")?,
            state_labels: data
                .get("state_labels")
                .map(|value| string_map(value, "state_labels"))
                .transpose()?,
        },
        HerdrEventKind::LayoutUpdated => HerdrEvent::LayoutUpdated {
            layout: pane_layout(required(data, "layout", "layout")?, "layout")?,
        },
    })
}

#[derive(Serialize)]
struct SubscribeRequest<'a> {
    id: &'a str,
    method: &'a str,
    params: SubscribeParams<'a>,
}

#[derive(Serialize)]
struct SubscribeParams<'a> {
    subscriptions: Vec<Subscription<'a>>,
}

#[derive(Serialize)]
struct Subscription<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pane_id: Option<&'a str>,
}

fn subscription_request(protocol: u32, pane_ids: &[String]) -> Result<Vec<u8>, HerdrEventError> {
    herdr_codec::validate_protocol(protocol)
        .map_err(|error| HerdrEventError::UnsupportedProtocol(error.to_string()))?;
    let mut subscriptions = HerdrEventKind::ALL
        .iter()
        .copied()
        .filter(|kind| {
            kind.subscription() == SubscriptionKind::Lifecycle && protocol >= kind.min_protocol()
        })
        .map(|kind| Subscription {
            kind: kind.as_str(),
            pane_id: None,
        })
        .collect::<Vec<_>>();
    let mut pane_ids = pane_ids.to_vec();
    pane_ids.sort();
    pane_ids.dedup();
    subscriptions.extend(pane_ids.iter().flat_map(|pane_id| {
        HerdrEventKind::ALL
            .iter()
            .copied()
            .filter(move |kind| {
                kind.subscription() == SubscriptionKind::PerPane && protocol >= kind.min_protocol()
            })
            .map(move |kind| Subscription {
                kind: kind.as_str(),
                pane_id: Some(pane_id),
            })
    }));
    let mut bytes = serde_json::to_vec(&SubscribeRequest {
        id: SUBSCRIPTION_REQUEST_ID,
        method: "events.subscribe",
        params: SubscribeParams { subscriptions },
    })
    .map_err(|error| {
        HerdrEventError::SubscriptionUnavailable(format!(
            "failed to serialize event subscription: {error}"
        ))
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

struct EventSubscription {
    id: u64,
    client_key: String,
    stream: Mutex<Option<Arc<HerdrStream>>>,
    parser: Mutex<JsonlEventParser>,
    acknowledgement: Mutex<Option<oneshot::Sender<Result<(), HerdrEventError>>>>,
}

impl EventSubscription {
    fn finish_acknowledgement(&self, result: Result<(), HerdrEventError>) {
        if let Some(sender) = self.acknowledgement.lock().take() {
            let _ = sender.send(result);
        }
    }

    fn close_stream(&self) {
        if let Some(stream) = self.stream.lock().take() {
            let _ = stream.close();
        }
    }
}

#[derive(Default)]
struct Registry {
    by_id: HashMap<u64, Arc<EventSubscription>>,
    by_client: HashMap<String, u64>,
}

static NEXT_SUBSCRIPTION_ID: AtomicU64 = AtomicU64::new(1);
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
static EVENT_SINK: OnceLock<RwLock<Option<Arc<dyn HerdrEventSink>>>> = OnceLock::new();
// Tracks sink calls that bridge teardown must wait for; see `sink_calls`.
static EVENT_SINK_CALLS: SinkCalls = SinkCalls::new();

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}
fn event_sink() -> &'static RwLock<Option<Arc<dyn HerdrEventSink>>> {
    EVENT_SINK.get_or_init(|| RwLock::new(None))
}
fn subscription(id: u64) -> Option<Arc<EventSubscription>> {
    registry().lock().by_id.get(&id).cloned()
}

fn remove_subscription(id: u64) {
    let mut registry = registry().lock();
    registry.by_client.retain(|_, current| *current != id);
    registry.by_id.remove(&id);
}

fn transport_frame(id: u64, bytes: Vec<u8>) {
    let Some(subscription) = subscription(id) else {
        return;
    };
    let items = subscription.parser.lock().push(&bytes);
    let mut events = Vec::new();
    for item in items {
        match item {
            StreamItem::Acknowledged => subscription.finish_acknowledgement(Ok(())),
            StreamItem::Event(event) => events.push(*event),
            StreamItem::ServerError(reason) => {
                forward_events(&subscription.client_key, std::mem::take(&mut events));
                fail_subscription(&subscription, reason);
                break;
            }
        }
    }
    forward_events(&subscription.client_key, events);
}

fn forward_events(client_key: &str, events: Vec<HerdrEvent>) {
    let Some(events) = crate::host_runtime::deliver_herdr_events(client_key, events) else {
        return;
    };
    let _sink_call = EVENT_SINK_CALLS.enter();
    if let Some(sink) = event_sink().read().clone() {
        for event in events {
            sink.event(client_key.to_owned(), event);
        }
    }
}

fn transport_closed(id: u64, reason: String) {
    let Some(subscription) = subscription(id) else {
        return;
    };
    subscription.parser.lock().end();
    subscription.finish_acknowledgement(Err(HerdrEventError::TransportDisconnected(format!(
        "Herdr event subscription closed before acknowledgement: {reason}"
    ))));
    {
        let _sink_call = EVENT_SINK_CALLS.enter();
        if !crate::host_runtime::event_subscription_closed(&subscription.client_key, reason.clone())
            && let Some(sink) = event_sink().read().clone()
        {
            sink.closed(subscription.client_key.clone(), reason);
        }
    }
    remove_subscription(id);
}

fn fail_subscription(subscription: &EventSubscription, reason: String) {
    subscription.finish_acknowledgement(Err(HerdrEventError::SubscriptionUnavailable(
        reason.clone(),
    )));
    {
        let _sink_call = EVENT_SINK_CALLS.enter();
        if !crate::host_runtime::event_subscription_closed(&subscription.client_key, reason.clone())
            && let Some(sink) = event_sink().read().clone()
        {
            sink.closed(subscription.client_key.clone(), reason);
        }
    }
    subscription.close_stream();
    remove_subscription(subscription.id);
}

pub(crate) async fn start_on_runtime(
    connection: Arc<HerdrConnection>,
    protocol: u32,
    pane_ids: Vec<String>,
) -> Result<(), HerdrEventError> {
    let client_key = connection.client_key().to_owned();
    if registry().lock().by_client.contains_key(&client_key) {
        return Ok(());
    }
    let request = subscription_request(protocol, &pane_ids)?;
    let id = NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed);
    let (acknowledgement_sender, acknowledgement_receiver) = oneshot::channel();
    let subscription = Arc::new(EventSubscription {
        id,
        client_key: client_key.clone(),
        stream: Mutex::new(None),
        parser: Mutex::new(JsonlEventParser::default()),
        acknowledgement: Mutex::new(Some(acknowledgement_sender)),
    });
    {
        let mut registry = registry().lock();
        registry.by_id.insert(id, subscription.clone());
        registry.by_client.insert(client_key.clone(), id);
    }
    let frame = Arc::new(move |bytes| transport_frame(id, bytes));
    let closed = Arc::new(move |reason| transport_closed(id, reason));
    let stream = match connection
        .open_stream(
            HerdrStreamKind::Events,
            HerdrStreamFraming::Raw,
            EVENT_READ_CHUNK_BYTES,
            frame,
            closed,
        )
        .await
    {
        Ok(stream) => stream,
        Err(error) => {
            remove_subscription(id);
            return Err(HerdrEventError::TransportDisconnected(error.to_string()));
        }
    };
    *subscription.stream.lock() = Some(stream.clone());
    if let Err(error) = stream.write(request) {
        subscription.close_stream();
        remove_subscription(id);
        return Err(HerdrEventError::TransportDisconnected(error.to_string()));
    }
    match stream
        .wait_current(tokio::time::timeout(
            SUBSCRIPTION_ACK_TIMEOUT,
            acknowledgement_receiver,
        ))
        .await
    {
        Ok(Ok(Ok(result))) => result,
        Ok(Ok(Err(_))) => Err(HerdrEventError::SubscriptionUnavailable(
            "Herdr event subscription acknowledgement was cancelled".to_owned(),
        )),
        Ok(Err(_)) => {
            remove_subscription(id);
            subscription.close_stream();
            Err(HerdrEventError::SubscriptionUnavailable(
                "timed out waiting for Herdr event subscription acknowledgement".to_owned(),
            ))
        }
        Err(error) => {
            remove_subscription(id);
            subscription.close_stream();
            Err(HerdrEventError::TransportDisconnected(error.to_string()))
        }
    }
}

#[uniffi::export]
pub fn set_herdr_event_sink(sink: Arc<dyn HerdrEventSink>) {
    *event_sink().write() = Some(sink);
}

#[uniffi::export]
pub fn clear_herdr_event_sink() {
    *event_sink().write() = None;
    EVENT_SINK_CALLS.drain_for_teardown("Herdr event");
}

#[uniffi::export]
pub async fn start_herdr_event_subscription(
    client_key: String,
    socket_path: String,
    protocol: u32,
    pane_ids: Vec<String>,
) -> Result<(), HerdrEventError> {
    let runtime = crate::runtime().map_err(HerdrEventError::TransportDisconnected)?;
    let connection = HerdrConnection::registered(client_key, socket_path)
        .map_err(|error| HerdrEventError::TransportDisconnected(error.to_string()))?;
    runtime
        .spawn(start_on_runtime(connection, protocol, pane_ids))
        .await
        .map_err(|error| {
            HerdrEventError::SubscriptionUnavailable(format!(
                "Herdr event runtime task failed: {error}"
            ))
        })?
}

#[uniffi::export]
pub fn close_herdr_event_subscription(client_key: String) {
    let subscription = {
        let registry = registry().lock();
        registry
            .by_client
            .get(&client_key)
            .and_then(|id| registry.by_id.get(id))
            .cloned()
    };
    if let Some(subscription) = subscription {
        subscription.finish_acknowledgement(Err(HerdrEventError::SubscriptionUnavailable(
            "Herdr event subscription was closed before acknowledgement".to_owned(),
        )));
        remove_subscription(subscription.id);
        subscription.close_stream();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event_kind(event: &HerdrEvent) -> Option<HerdrEventKind> {
        match event {
            HerdrEvent::WorkspaceCreated { .. } => Some(HerdrEventKind::WorkspaceCreated),
            HerdrEvent::WorkspaceUpdated { .. } => Some(HerdrEventKind::WorkspaceUpdated),
            HerdrEvent::WorkspaceMetadataUpdated { .. } => {
                Some(HerdrEventKind::WorkspaceMetadataUpdated)
            }
            HerdrEvent::WorkspaceClosed { .. } => Some(HerdrEventKind::WorkspaceClosed),
            HerdrEvent::WorkspaceRenamed { .. } => Some(HerdrEventKind::WorkspaceRenamed),
            HerdrEvent::WorkspaceMoved { .. } => Some(HerdrEventKind::WorkspaceMoved),
            HerdrEvent::WorkspaceReordered { .. } => Some(HerdrEventKind::WorkspaceReordered),
            HerdrEvent::WorkspaceFocused { .. } => Some(HerdrEventKind::WorkspaceFocused),
            HerdrEvent::WorktreeCreated { .. } => Some(HerdrEventKind::WorktreeCreated),
            HerdrEvent::WorktreeOpened { .. } => Some(HerdrEventKind::WorktreeOpened),
            HerdrEvent::WorktreeRemoved { .. } => Some(HerdrEventKind::WorktreeRemoved),
            HerdrEvent::TabCreated { .. } => Some(HerdrEventKind::TabCreated),
            HerdrEvent::TabClosed { .. } => Some(HerdrEventKind::TabClosed),
            HerdrEvent::TabFocused { .. } => Some(HerdrEventKind::TabFocused),
            HerdrEvent::TabRenamed { .. } => Some(HerdrEventKind::TabRenamed),
            HerdrEvent::TabMoved { .. } => Some(HerdrEventKind::TabMoved),
            HerdrEvent::PaneCreated { .. } => Some(HerdrEventKind::PaneCreated),
            HerdrEvent::PaneUpdated { .. } => Some(HerdrEventKind::PaneUpdated),
            HerdrEvent::PaneClosed { .. } => Some(HerdrEventKind::PaneClosed),
            HerdrEvent::PaneFocused { .. } => Some(HerdrEventKind::PaneFocused),
            HerdrEvent::PaneExited { .. } => Some(HerdrEventKind::PaneExited),
            HerdrEvent::PaneMoved { .. } => Some(HerdrEventKind::PaneMoved),
            HerdrEvent::PaneOutputChanged { .. } => Some(HerdrEventKind::PaneOutputChanged),
            HerdrEvent::PaneScrollChanged { .. } => Some(HerdrEventKind::PaneScrollChanged),
            HerdrEvent::PaneAgentDetected { .. } => Some(HerdrEventKind::PaneAgentDetected),
            HerdrEvent::PaneAgentStatusChanged { .. } => {
                Some(HerdrEventKind::PaneAgentStatusChanged)
            }
            HerdrEvent::LayoutUpdated { .. } => Some(HerdrEventKind::LayoutUpdated),
            HerdrEvent::ProtocolUnknown { .. } | HerdrEvent::ProtocolInvalid { .. } => None,
        }
    }

    fn events(items: Vec<StreamItem>) -> Vec<HerdrEvent> {
        items
            .into_iter()
            .filter_map(|item| match item {
                StreamItem::Event(event) => Some(*event),
                StreamItem::Acknowledged | StreamItem::ServerError(_) => None,
            })
            .collect()
    }

    fn workspace_fixture() -> Value {
        serde_json::json!({
            "workspace_id": "w1", "number": 1, "label": "work", "focused": true,
            "pane_count": 1, "tab_count": 1, "active_tab_id": "t1", "agent_status": "idle"
        })
    }

    fn worktree_fixture() -> Value {
        serde_json::json!({
            "branch": "main", "is_bare": false, "is_detached": false,
            "is_linked_worktree": true, "is_prunable": false, "label": "work", "path": "/repo"
        })
    }

    fn tab_fixture() -> Value {
        serde_json::json!({
            "tab_id": "t1", "workspace_id": "w1", "number": 1, "label": "shell",
            "focused": true, "pane_count": 1, "agent_status": "idle"
        })
    }

    fn pane_fixture() -> Value {
        serde_json::json!({
            "pane_id": "p1", "terminal_id": "term1", "workspace_id": "w1", "tab_id": "t1",
            "focused": true, "agent_status": "idle", "revision": 1
        })
    }

    fn layout_fixture() -> Value {
        serde_json::json!({
            "workspace_id": "w1", "tab_id": "t1", "zoomed": false,
            "area": {"x": 0, "y": 0, "width": 80, "height": 24},
            "focused_pane_id": "p1",
            "panes": [{
                "pane_id": "p1", "focused": true,
                "rect": {"x": 0, "y": 0, "width": 80, "height": 24}
            }],
            "splits": []
        })
    }

    #[test]
    fn every_supported_event_kind_decodes_to_its_typed_variant() {
        let workspace = workspace_fixture();
        let worktree = worktree_fixture();
        let tab = tab_fixture();
        let pane = pane_fixture();
        let layout = layout_fixture();
        let fixtures = vec![
            (
                HerdrEventKind::WorkspaceCreated,
                serde_json::json!({"workspace": workspace}),
            ),
            (
                HerdrEventKind::WorkspaceUpdated,
                serde_json::json!({"workspace": workspace}),
            ),
            (
                HerdrEventKind::WorkspaceMetadataUpdated,
                serde_json::json!({"workspace": workspace}),
            ),
            (
                HerdrEventKind::WorkspaceClosed,
                serde_json::json!({"workspace_id": "w1", "workspace": workspace}),
            ),
            (
                HerdrEventKind::WorkspaceRenamed,
                serde_json::json!({"workspace_id": "w1", "label": "new"}),
            ),
            (
                HerdrEventKind::WorkspaceMoved,
                serde_json::json!({"workspace_id": "w1", "insert_index": 0, "workspaces": [workspace]}),
            ),
            (
                HerdrEventKind::WorkspaceReordered,
                serde_json::json!({"workspace_ids": ["w1"], "workspaces": [workspace]}),
            ),
            (
                HerdrEventKind::WorkspaceFocused,
                serde_json::json!({"workspace_id": "w1"}),
            ),
            (
                HerdrEventKind::WorktreeCreated,
                serde_json::json!({"workspace": workspace, "worktree": worktree}),
            ),
            (
                HerdrEventKind::WorktreeOpened,
                serde_json::json!({"workspace": workspace, "worktree": worktree, "already_open": false}),
            ),
            (
                HerdrEventKind::WorktreeRemoved,
                serde_json::json!({"workspace_id": "w1", "worktree": worktree, "forced": true}),
            ),
            (HerdrEventKind::TabCreated, serde_json::json!({"tab": tab})),
            (
                HerdrEventKind::TabClosed,
                serde_json::json!({"workspace_id": "w1", "tab_id": "t1"}),
            ),
            (
                HerdrEventKind::TabFocused,
                serde_json::json!({"workspace_id": "w1", "tab_id": "t1"}),
            ),
            (
                HerdrEventKind::TabRenamed,
                serde_json::json!({"workspace_id": "w1", "tab_id": "t1", "label": "new"}),
            ),
            (
                HerdrEventKind::TabMoved,
                serde_json::json!({"workspace_id": "w1", "tab_id": "t1", "insert_index": 0, "tabs": [tab]}),
            ),
            (
                HerdrEventKind::PaneCreated,
                serde_json::json!({"pane": pane}),
            ),
            (
                HerdrEventKind::PaneUpdated,
                serde_json::json!({"pane": pane}),
            ),
            (
                HerdrEventKind::PaneClosed,
                serde_json::json!({"workspace_id": "w1", "pane_id": "p1"}),
            ),
            (
                HerdrEventKind::PaneFocused,
                serde_json::json!({"workspace_id": "w1", "pane_id": "p1"}),
            ),
            (
                HerdrEventKind::PaneExited,
                serde_json::json!({"workspace_id": "w1", "pane_id": "p1"}),
            ),
            (
                HerdrEventKind::PaneMoved,
                serde_json::json!({
                    "previous_pane_id": "p0", "previous_workspace_id": "w0", "previous_tab_id": "t0", "pane": pane
                }),
            ),
            (
                HerdrEventKind::PaneOutputChanged,
                serde_json::json!({"workspace_id": "w1", "pane_id": "p1", "revision": 2}),
            ),
            (
                HerdrEventKind::PaneAgentDetected,
                serde_json::json!({"workspace_id": "w1", "pane_id": "p1"}),
            ),
            (
                HerdrEventKind::PaneScrollChanged,
                serde_json::json!({"workspace_id": "w1", "pane_id": "p1", "scroll": {
                    "offset_from_bottom": 3, "max_offset_from_bottom": 100, "viewport_rows": 30
                }}),
            ),
            (
                HerdrEventKind::PaneAgentStatusChanged,
                serde_json::json!({
                    "workspace_id": "w1", "pane_id": "p1", "agent_status": "working"
                }),
            ),
            (
                HerdrEventKind::LayoutUpdated,
                serde_json::json!({"layout": layout}),
            ),
        ];
        assert_eq!(fixtures.len(), HerdrEventKind::ALL.len());
        for (kind, data) in fixtures {
            let decoded = decode_event(kind.as_str(), &data);
            assert_eq!(
                event_kind(&decoded),
                Some(kind),
                "failed to decode {kind:?}"
            );
        }
    }

    #[test]
    fn subscription_request_matches_typescript_and_protocol_17_difference() {
        let line = String::from_utf8(
            subscription_request(20, &["w1:p2".into(), "w1:p1".into(), "w1:p2".into()]).unwrap(),
        )
        .unwrap();
        assert!(line.starts_with("{\"id\":\"android_events\",\"method\":\"events.subscribe\",\"params\":{\"subscriptions\":[{\"type\":\"workspace.created\"}"));
        assert!(line.contains("{\"type\":\"workspace.reordered\"}"));
        let request: Value = serde_json::from_str(&line).unwrap();
        let subscriptions = request["params"]["subscriptions"].as_array().unwrap();
        assert_eq!(
            &subscriptions[subscriptions.len() - 4..],
            &[
                serde_json::json!({"type": "pane.agent_status_changed", "pane_id": "w1:p1"}),
                serde_json::json!({"type": "pane.scroll_changed", "pane_id": "w1:p1"}),
                serde_json::json!({"type": "pane.agent_status_changed", "pane_id": "w1:p2"}),
                serde_json::json!({"type": "pane.scroll_changed", "pane_id": "w1:p2"}),
            ]
        );
        let v17 = String::from_utf8(subscription_request(17, &[]).unwrap()).unwrap();
        assert!(!v17.contains("workspace.reordered"));
    }

    #[test]
    fn subscription_started_response_is_an_explicit_acknowledgement() {
        assert!(matches!(
            parse_stream_line(
                br#"{"id":"android_events","result":{"type":"subscription_started"}}"#
            ),
            Some(StreamItem::Acknowledged)
        ));
    }

    #[test]
    fn acknowledgement_and_following_event_survive_fragmented_frames() {
        let mut parser = JsonlEventParser::default();
        assert!(
            parser
                .push(br#"{"id":"android_events","result":{"type":"subscription_"#)
                .is_empty()
        );
        let items = parser.push(
            b"started\"}}\n{\"event\":\"pane.focused\",\"data\":{\"workspace_id\":\"w1\",\"pane_id\":\"p1\"}}\n",
        );
        assert!(matches!(items.first(), Some(StreamItem::Acknowledged)));
        assert!(
            matches!(items.get(1), Some(StreamItem::Event(event)) if event_kind(event) == Some(HerdrEventKind::PaneFocused))
        );
    }

    #[test]
    fn malformed_subscription_acknowledgements_fail_the_handshake() {
        assert!(matches!(
            parse_stream_line(
                br#"{"id":"other","result":{"type":"subscription_started"}}"#
            ),
            Some(StreamItem::ServerError(reason)) if reason.contains("response id")
        ));
        assert!(matches!(
            parse_stream_line(br#"{"id":"android_events","result":{"type":"ok"}}"#),
            Some(StreamItem::ServerError(reason)) if reason.contains("expected subscription_started")
        ));
    }

    #[test]
    fn frames_complete_multiple_fragmented_blank_and_crlf_lines() {
        let mut parser = JsonlEventParser::default();
        assert!(
            parser
                .push(br#"{"event":"tab.focused","data":{"workspace_id":"w1","tab_id":"t"#)
                .is_empty()
        );
        let parsed = events(parser.push(b"2"));
        assert!(parsed.is_empty());
        let parsed = events(parser.push(b"\"}}\r\n\n{\"event\":\"pane.focused\",\"data\":{\"workspace_id\":\"w1\",\"pane_id\":\"p2\"}}\n"));
        assert_eq!(parsed.len(), 2);
        assert_eq!(event_kind(&parsed[0]), Some(HerdrEventKind::TabFocused));
        assert_eq!(event_kind(&parsed[1]), Some(HerdrEventKind::PaneFocused));
    }

    #[test]
    fn parser_reset_drops_partial_previous_subscription() {
        let mut first = JsonlEventParser::default();
        assert!(first.push(br#"{"event":"tab.focused""#).is_empty());
        first.end();
        let mut next = JsonlEventParser::default();
        let parsed = events(next.push(
            b"{\"event\":\"pane.focused\",\"data\":{\"workspace_id\":\"w1\",\"pane_id\":\"p1\"}}\n",
        ));
        assert_eq!(parsed.len(), 1);
        assert_eq!(event_kind(&parsed[0]), Some(HerdrEventKind::PaneFocused));
    }

    #[test]
    fn direct_legacy_and_underscore_envelopes_normalize_identically() {
        let direct = parse_stream_line(
            br#"{"event":"pane.focused","data":{"workspace_id":"w1","pane_id":"p1"}}"#,
        )
        .unwrap();
        let legacy = parse_stream_line(br#"{"subscription_id":"events","event":{"event":"pane_focused","data":{"workspace_id":"w1","pane_id":"p1"}}}"#).unwrap();
        let StreamItem::Event(direct) = direct else {
            panic!("event")
        };
        let StreamItem::Event(legacy) = legacy else {
            panic!("event")
        };
        assert_eq!(direct, legacy);
    }

    #[test]
    fn unknown_and_malformed_known_events_are_distinct() {
        assert!(matches!(
            decode_event("future.created", &serde_json::json!({})),
            HerdrEvent::ProtocolUnknown { raw_event } if raw_event == "future.created"
        ));
        let invalid = decode_event("tab.focused", &Value::Null);
        assert!(matches!(
            invalid,
            HerdrEvent::ProtocolInvalid { reason, .. }
                if reason == "event data must be an object"
        ));
    }

    #[test]
    fn agent_focus_layout_and_nested_validation_match_typescript() {
        let agent = decode_event(
            "pane.agent_status_changed",
            &serde_json::json!({
                "workspace_id":"w1", "pane_id":"p1", "agent_status":"done", "state_labels":{"phase":"review"}
            }),
        );
        let HerdrEvent::PaneAgentStatusChanged {
            agent_status,
            state_labels,
            ..
        } = agent
        else {
            panic!("agent status event")
        };
        assert_eq!(agent_status, HerdrAgentStatus::Done);
        assert_eq!(
            state_labels.unwrap().get("phase").map(String::as_str),
            Some("review")
        );
        let invalid_layout = decode_event(
            "layout.updated",
            &serde_json::json!({"layout":{"workspace_id":"w1"}}),
        );
        assert!(matches!(invalid_layout, HerdrEvent::ProtocolInvalid { .. }));
        let invalid_pane = decode_event(
            "pane.updated",
            &serde_json::json!({"pane":{"pane_id":"p1"}}),
        );
        assert!(matches!(
            invalid_pane,
            HerdrEvent::ProtocolInvalid { reason, .. }
                if reason.contains("pane.terminal_id")
        ));
    }

    #[test]
    fn malformed_json_and_invalid_utf8_do_not_stop_later_events() {
        let mut parser = JsonlEventParser::default();
        let mut bytes = b"not-json\n{\"event\":\"future.created\",\"data\":{\"label\":\"".to_vec();
        bytes.push(0xff);
        bytes.extend_from_slice(
            b"\"}}\n{\"event\":\"workspace.focused\",\"data\":{\"workspace_id\":\"w1\"}}\n",
        );
        let parsed = events(parser.push(&bytes));
        assert_eq!(
            parsed.last().and_then(event_kind),
            Some(HerdrEventKind::WorkspaceFocused)
        );
    }

    #[test]
    fn oversized_line_is_reported_and_parser_recovers() {
        let mut parser = JsonlEventParser::default();
        let mut input = vec![b'x'; MAX_EVENT_LINE_BYTES + 1];
        input.extend_from_slice(
            b"\n{\"event\":\"workspace.focused\",\"data\":{\"workspace_id\":\"w1\"}}\n",
        );
        let parsed = events(parser.push(&input));
        assert!(matches!(parsed[0], HerdrEvent::ProtocolInvalid { .. }));
        assert_eq!(
            event_kind(&parsed[1]),
            Some(HerdrEventKind::WorkspaceFocused)
        );
    }

    #[test]
    fn arbitrary_malformed_values_never_panic() {
        for value in [
            Value::Null,
            Value::Bool(true),
            serde_json::json!([]),
            serde_json::json!({"type": 1}),
        ] {
            let event = decode_event("pane.agent_status_changed", &value);
            assert!(matches!(event, HerdrEvent::ProtocolInvalid { .. }));
        }
    }

    #[test]
    fn scroll_event_decoder_rejects_invalid_metadata() {
        for scroll in [
            Value::Null,
            serde_json::json!({"offset_from_bottom": -1, "max_offset_from_bottom": 100, "viewport_rows": 30}),
            serde_json::json!({"offset_from_bottom": 3, "max_offset_from_bottom": 100}),
        ] {
            assert!(matches!(
                decode_event(
                    "pane.scroll_changed",
                    &serde_json::json!({
                        "pane_id": "p1", "workspace_id": "w1", "scroll": scroll
                    })
                ),
                HerdrEvent::ProtocolInvalid { .. }
            ));
        }
    }
}
