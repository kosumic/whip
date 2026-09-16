//! Product-specific Herdr terminal bridge lifecycle.

use std::collections::HashMap;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use parking_lot::{Mutex, RwLock};
use tokio::sync::oneshot;

use crate::herdr_codec::{
    self, CodecError, HerdrTerminalEncoding, MAX_FRAME_BYTES, ServerMessage, decode,
    validate_protocol,
};
use crate::herdr_connection::{HerdrConnection, HerdrStream, HerdrStreamFraming, HerdrStreamKind};

pub use crate::herdr_codec::{HerdrTerminalAttachLaunchMode, HerdrTerminalNotificationKind};

const WELCOME_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrTerminalControlEvent {
    Closed {
        reason: Option<String>,
    },
    Notify {
        kind: HerdrTerminalNotificationKind,
        text: String,
        body: Option<String>,
    },
    Clipboard {
        text: String,
    },
    Title {
        title: Option<String>,
    },
    ReloadSoundConfig,
    MouseCapture {
        enabled: bool,
    },
    KittyKeyboardReportAll {
        enabled: bool,
    },
    PrefixInputSource {
        enabled: bool,
    },
    TerminalBell {
        count: u16,
    },
    Ignored,
}

#[uniffi::export(with_foreign)]
pub trait HerdrTerminalEventSink: Send + Sync {
    #[allow(
        clippy::too_many_arguments,
        reason = "the UniFFI event callback mirrors the terminal frame wire fields"
    )]
    fn terminal_frame(
        &self,
        client_key: String,
        terminal_id: String,
        sequence: u64,
        width: u16,
        height: u16,
        full: bool,
        base64_bytes: String,
    );
    fn graphics_frame(&self, client_key: String, terminal_id: String, bytes: Vec<u8>);
    fn control(&self, client_key: String, terminal_id: String, event: HerdrTerminalControlEvent);
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum HerdrBridgeError {
    #[error("{0}")]
    UnsupportedProtocol(String),
    #[error("{0}")]
    MalformedServerFrame(String),
    #[error("{0}")]
    WelcomeTimeout(String),
    #[error("{0}")]
    WelcomeProtocolMismatch(String),
    #[error("{0}")]
    UnsupportedEncoding(String),
    #[error("{0}")]
    ServerRejectedWelcome(String),
    #[error("{0}")]
    ClosedBeforeHandshake(String),
    #[error("{0}")]
    BridgeUnavailable(String),
    #[error("Herdr bridge SSH transport is unavailable")]
    TransportUnavailable,
    #[error("{0}")]
    BridgeClosed(String),
}

impl From<CodecError> for HerdrBridgeError {
    fn from(error: CodecError) -> Self {
        match error {
            CodecError::UnsupportedProtocol(_) => Self::UnsupportedProtocol(error.to_string()),
            _ => Self::MalformedServerFrame(error.to_string()),
        }
    }
}

#[derive(Clone, Debug)]
enum ProtocolState {
    AwaitingWelcome,
    Ready,
    Attached(String),
    Closing,
    Closed,
}

struct Bridge {
    id: u64,
    client_key: String,
    stream: Mutex<Option<Arc<HerdrStream>>>,
    protocol: u32,
    state: Mutex<ProtocolState>,
    welcomed: Mutex<Option<oneshot::Sender<Result<(), HerdrBridgeError>>>>,
}

pub(crate) type HerdrBridgeId = u64;

#[derive(Default)]
struct Registry {
    bridges: HashMap<u64, Arc<Bridge>>,
    prepared: HashMap<String, u64>,
    active: HashMap<String, HashMap<String, u64>>,
}

impl Registry {
    fn active_id(&self, client_key: &str, terminal_id: &str) -> Option<u64> {
        self.active.get(client_key)?.get(terminal_id).copied()
    }

    fn insert_active(&mut self, client_key: String, terminal_id: String, bridge_id: u64) {
        self.active
            .entry(client_key)
            .or_default()
            .insert(terminal_id, bridge_id);
    }

    fn remove_active(&mut self, client_key: &str, terminal_id: &str) -> Option<u64> {
        let (removed, client_is_empty) = {
            let terminals = self.active.get_mut(client_key)?;
            let removed = terminals.remove(terminal_id);
            (removed, terminals.is_empty())
        };
        if client_is_empty {
            self.active.remove(client_key);
        }
        removed
    }
}

static NEXT_BRIDGE_ID: AtomicU64 = AtomicU64::new(1);
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
static EVENT_SINK: OnceLock<RwLock<Option<Arc<dyn HerdrTerminalEventSink>>>> = OnceLock::new();

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

fn event_sink() -> &'static RwLock<Option<Arc<dyn HerdrTerminalEventSink>>> {
    EVENT_SINK.get_or_init(|| RwLock::new(None))
}

fn bridge_for_id(id: u64) -> Option<Arc<Bridge>> {
    registry().lock().bridges.get(&id).cloned()
}

fn active_bridge(client_key: &str, terminal_id: &str) -> Option<Arc<Bridge>> {
    let registry = registry().lock();
    registry
        .active_id(client_key, terminal_id)
        .and_then(|id| registry.bridges.get(&id))
        .cloned()
}

pub(crate) fn active_herdr_terminal_bridge_id(
    client_key: &str,
    terminal_id: &str,
) -> Option<HerdrBridgeId> {
    registry().lock().active_id(client_key, terminal_id)
}

fn remove_bridge(id: u64) {
    let mut registry = registry().lock();
    registry.prepared.retain(|_, bridge_id| *bridge_id != id);
    registry.active.retain(|_, terminals| {
        terminals.retain(|_, bridge_id| *bridge_id != id);
        !terminals.is_empty()
    });
    registry.bridges.remove(&id);
}

fn transport_frame(id: u64, bytes: Vec<u8>) {
    let Some(bridge) = bridge_for_id(id) else {
        return;
    };
    bridge.handle_frame(&bytes);
}

fn transport_closed(id: u64, reason: String) {
    let Some(bridge) = bridge_for_id(id) else {
        return;
    };
    bridge.transport_closed(reason);
}

impl Bridge {
    fn stream(&self) -> Result<Arc<HerdrStream>, HerdrBridgeError> {
        self.stream
            .lock()
            .clone()
            .ok_or(HerdrBridgeError::TransportUnavailable)
    }

    fn close_stream(&self) {
        if let Some(stream) = self.stream.lock().take() {
            let _ = stream.close();
        }
    }

    fn terminal_id(&self) -> Option<String> {
        match &*self.state.lock() {
            ProtocolState::Attached(terminal_id) => Some(terminal_id.clone()),
            _ => None,
        }
    }

    fn finish_welcome(&self, result: Result<(), HerdrBridgeError>) {
        if let Some(sender) = self.welcomed.lock().take() {
            let _ = sender.send(result);
        }
    }

    fn handle_frame(&self, bytes: &[u8]) {
        let message = match decode(bytes, self.protocol) {
            Ok(message) => message,
            Err(error) => {
                self.protocol_failure(error.into());
                return;
            }
        };
        let state = self.state.lock().clone();
        match state {
            ProtocolState::AwaitingWelcome => self.handle_welcome(message),
            ProtocolState::Ready | ProtocolState::Closing | ProtocolState::Closed => {
                // A prepared bridge has negotiated but is not attached yet.
                // Herdr should not send normal traffic in this state.
            }
            ProtocolState::Attached(terminal_id) => {
                if !matches!(message, ServerMessage::Welcome { .. }) {
                    self.dispatch(&terminal_id, message);
                }
            }
        }
    }

    fn handle_welcome(&self, message: ServerMessage) {
        let ServerMessage::Welcome {
            protocol,
            encoding,
            error,
        } = message
        else {
            self.protocol_failure(HerdrBridgeError::MalformedServerFrame(
                "Herdr bridge did not send Welcome first".to_owned(),
            ));
            return;
        };
        let result = if let Some(error) = error {
            Err(HerdrBridgeError::ServerRejectedWelcome(format!(
                "Herdr bridge rejected protocol {}: {error}",
                self.protocol
            )))
        } else if protocol != self.protocol {
            Err(HerdrBridgeError::WelcomeProtocolMismatch(format!(
                "Herdr bridge negotiation mismatch (protocol {protocol}, encoding {encoding})"
            )))
        } else {
            HerdrTerminalEncoding::try_from(encoding)
                .map(|HerdrTerminalEncoding::TerminalAnsi| ())
                .map_err(|encoding| {
                    HerdrBridgeError::UnsupportedEncoding(format!(
                        "Herdr bridge negotiation mismatch (protocol {protocol}, encoding {encoding})"
                    ))
                })
        };
        match result {
            Ok(()) => {
                *self.state.lock() = ProtocolState::Ready;
                self.finish_welcome(Ok(()));
            }
            Err(error) => self.protocol_failure(error),
        }
    }

    fn dispatch(&self, terminal_id: &str, message: ServerMessage) {
        if let ServerMessage::KittyKeyboardReportAll { enabled } = &message {
            crate::host_runtime::terminal_kitty_keyboard_report_all_changed(
                &self.client_key,
                terminal_id,
                self.id,
                *enabled,
            );
        }
        let sink = event_sink().read().clone();
        let Some(sink) = sink else {
            if matches!(message, ServerMessage::Closed { .. }) {
                self.close_transport();
            }
            return;
        };
        self.dispatch_to(terminal_id, message, sink.as_ref());
    }

    fn dispatch_to(
        &self,
        terminal_id: &str,
        message: ServerMessage,
        sink: &dyn HerdrTerminalEventSink,
    ) {
        match message {
            ServerMessage::Terminal {
                sequence,
                width,
                height,
                full,
                bytes,
            } => sink.terminal_frame(
                self.client_key.clone(),
                terminal_id.to_owned(),
                sequence,
                width,
                height,
                full,
                STANDARD.encode(bytes),
            ),
            ServerMessage::Graphics { bytes } => {
                sink.graphics_frame(self.client_key.clone(), terminal_id.to_owned(), bytes);
            }
            ServerMessage::Closed { reason } => {
                self.emit_control(
                    sink,
                    terminal_id,
                    HerdrTerminalControlEvent::Closed { reason },
                );
                self.close_transport();
            }
            ServerMessage::Notify { kind, text, body } => self.emit_control(
                sink,
                terminal_id,
                HerdrTerminalControlEvent::Notify { kind, text, body },
            ),
            ServerMessage::Clipboard { text } => self.emit_control(
                sink,
                terminal_id,
                HerdrTerminalControlEvent::Clipboard { text },
            ),
            ServerMessage::Title { title } => self.emit_control(
                sink,
                terminal_id,
                HerdrTerminalControlEvent::Title { title },
            ),
            ServerMessage::ReloadSoundConfig => self.emit_control(
                sink,
                terminal_id,
                HerdrTerminalControlEvent::ReloadSoundConfig,
            ),
            ServerMessage::MouseCapture { enabled } => self.emit_control(
                sink,
                terminal_id,
                HerdrTerminalControlEvent::MouseCapture { enabled },
            ),
            ServerMessage::KittyKeyboardReportAll { enabled } => self.emit_control(
                sink,
                terminal_id,
                HerdrTerminalControlEvent::KittyKeyboardReportAll { enabled },
            ),
            ServerMessage::PrefixInputSource { enabled } => self.emit_control(
                sink,
                terminal_id,
                HerdrTerminalControlEvent::PrefixInputSource { enabled },
            ),
            ServerMessage::TerminalBell { count } => self.emit_control(
                sink,
                terminal_id,
                HerdrTerminalControlEvent::TerminalBell { count },
            ),
            ServerMessage::Ignored { .. } => {
                self.emit_control(sink, terminal_id, HerdrTerminalControlEvent::Ignored);
            }
            ServerMessage::Welcome { .. } => {}
        }
    }

    fn emit_control(
        &self,
        sink: &dyn HerdrTerminalEventSink,
        terminal_id: &str,
        event: HerdrTerminalControlEvent,
    ) {
        sink.control(self.client_key.clone(), terminal_id.to_owned(), event);
    }

    fn emit_closed(&self, reason: String) {
        let Some(terminal_id) = self.terminal_id() else {
            return;
        };
        if crate::host_runtime::terminal_bridge_closed(
            &self.client_key,
            &terminal_id,
            self.id,
            reason.clone(),
        ) {
            return;
        }
        if let Some(sink) = event_sink().read().clone() {
            self.emit_control(
                sink.as_ref(),
                &terminal_id,
                HerdrTerminalControlEvent::Closed {
                    reason: Some(reason),
                },
            );
        }
    }

    fn protocol_failure(&self, error: HerdrBridgeError) {
        let was_handshaking = matches!(*self.state.lock(), ProtocolState::AwaitingWelcome);
        if was_handshaking {
            *self.state.lock() = ProtocolState::Closed;
            self.finish_welcome(Err(error));
        } else {
            self.emit_closed(error.to_string());
            *self.state.lock() = ProtocolState::Closing;
        }
        self.close_stream();
        remove_bridge(self.id);
    }

    fn transport_closed(&self, reason: String) {
        let state = self.state.lock().clone();
        match state {
            ProtocolState::AwaitingWelcome => {
                let error = HerdrBridgeError::ClosedBeforeHandshake(format!(
                    "Herdr bridge closed before Welcome: {reason}"
                ));
                *self.state.lock() = ProtocolState::Closed;
                self.finish_welcome(Err(error));
            }
            ProtocolState::Attached(_) => self.emit_closed(reason),
            ProtocolState::Ready | ProtocolState::Closing | ProtocolState::Closed => {}
        }
        *self.state.lock() = ProtocolState::Closed;
        remove_bridge(self.id);
    }

    fn close_transport(&self) {
        *self.state.lock() = ProtocolState::Closing;
        self.close_stream();
        remove_bridge(self.id);
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "bridge setup keeps protocol geometry and launch mode explicit at the transport boundary"
)]
async fn open_bridge(
    connection: Arc<HerdrConnection>,
    protocol: u32,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
    terminal_attach_launch_mode: HerdrTerminalAttachLaunchMode,
) -> Result<Arc<Bridge>, HerdrBridgeError> {
    let client_key = connection.client_key().to_owned();
    validate_protocol(protocol)?;
    let hello = herdr_codec::hello(
        protocol,
        columns,
        rows,
        cell_width_px,
        cell_height_px,
        terminal_attach_launch_mode,
    )?;
    let id = NEXT_BRIDGE_ID.fetch_add(1, Ordering::Relaxed);
    let (welcome_sender, welcome_receiver) = oneshot::channel();
    let bridge = Arc::new(Bridge {
        id,
        client_key: client_key.clone(),
        stream: Mutex::new(None),
        protocol,
        state: Mutex::new(ProtocolState::AwaitingWelcome),
        welcomed: Mutex::new(Some(welcome_sender)),
    });
    registry().lock().bridges.insert(id, bridge.clone());

    let frame = Arc::new(move |bytes| transport_frame(id, bytes));
    let closed = Arc::new(move |reason| transport_closed(id, reason));
    let stream = match connection
        .open_stream(
            HerdrStreamKind::Terminal,
            HerdrStreamFraming::LengthPrefixed,
            MAX_FRAME_BYTES,
            frame,
            closed,
        )
        .await
    {
        Ok(stream) => stream,
        Err(error) => {
            remove_bridge(id);
            return Err(HerdrBridgeError::BridgeUnavailable(error.to_string()));
        }
    };
    *bridge.stream.lock() = Some(stream.clone());
    if let Err(error) = stream.write(hello) {
        bridge.close_transport();
        return Err(HerdrBridgeError::BridgeUnavailable(error.to_string()));
    }
    match stream
        .wait_current(tokio::time::timeout(WELCOME_TIMEOUT, welcome_receiver))
        .await
    {
        Ok(Ok(Ok(Ok(())))) => Ok(bridge),
        Ok(Ok(Ok(Err(error)))) => Err(error),
        Ok(Ok(Err(_))) => Err(HerdrBridgeError::BridgeClosed(
            "Herdr Welcome wait was cancelled".to_owned(),
        )),
        Ok(Err(_)) => {
            bridge.close_transport();
            Err(HerdrBridgeError::WelcomeTimeout(
                "timed out waiting for Herdr Welcome".to_owned(),
            ))
        }
        Err(error) => {
            bridge.close_transport();
            Err(HerdrBridgeError::BridgeClosed(error.to_string()))
        }
    }
}

#[uniffi::export]
pub fn set_herdr_terminal_event_sink(sink: Arc<dyn HerdrTerminalEventSink>) {
    *event_sink().write() = Some(sink);
}

#[uniffi::export]
pub fn clear_herdr_terminal_event_sink() {
    *event_sink().write() = None;
}

#[allow(
    clippy::too_many_arguments,
    reason = "prepared bridge state requires the complete terminal geometry from its caller"
)]
async fn prepare_bridge_on_runtime(
    connection: Arc<HerdrConnection>,
    protocol: u32,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
) -> Result<(), HerdrBridgeError> {
    let client_key = connection.client_key().to_owned();
    if registry().lock().prepared.contains_key(&client_key) {
        return Ok(());
    }
    let bridge = open_bridge(
        connection,
        protocol,
        columns,
        rows,
        cell_width_px,
        cell_height_px,
        HerdrTerminalAttachLaunchMode::LegacyTerminalAttach,
    )
    .await?;
    registry().lock().prepared.insert(client_key, bridge.id);
    Ok(())
}

#[allow(
    clippy::too_many_arguments,
    reason = "runtime bridge startup forwards the stable native terminal API without an allocation-only parameter bag"
)]
pub(crate) async fn start_bridge_on_runtime<F>(
    connection: Arc<HerdrConnection>,
    protocol: u32,
    terminal_id: String,
    takeover: bool,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
    terminal_attach_launch_mode: HerdrTerminalAttachLaunchMode,
    claim: F,
) -> Result<HerdrBridgeId, HerdrBridgeError>
where
    F: FnOnce(HerdrBridgeId) -> Result<(), HerdrBridgeError>,
{
    let client_key = connection.client_key().to_owned();
    if let Some(bridge) = active_bridge(&client_key, &terminal_id) {
        claim(bridge.id)?;
        return Ok(bridge.id);
    }
    let prepared_id = registry().lock().prepared.remove(&client_key);
    let mut bridge = prepared_id.and_then(bridge_for_id);
    if let Some(incompatible) = bridge.take_if(|bridge| bridge.protocol != protocol) {
        incompatible.close_transport();
    }
    let bridge = match bridge {
        Some(bridge) => bridge,
        None => {
            open_bridge(
                connection,
                protocol,
                columns,
                rows,
                cell_width_px,
                cell_height_px,
                terminal_attach_launch_mode,
            )
            .await?
        }
    };
    let stream = bridge.stream()?;
    if let Err(error) = claim(bridge.id) {
        bridge.close_transport();
        return Err(error);
    }
    *bridge.state.lock() = ProtocolState::Attached(terminal_id.clone());
    registry()
        .lock()
        .insert_active(client_key.clone(), terminal_id.clone(), bridge.id);
    if let Err(error) = stream.write(herdr_codec::attach(&terminal_id, takeover)) {
        bridge.close_transport();
        return Err(HerdrBridgeError::BridgeClosed(error.to_string()));
    }
    if active_herdr_terminal_bridge_id(&client_key, &terminal_id) != Some(bridge.id) {
        return Err(HerdrBridgeError::BridgeClosed(format!(
            "Herdr bridge {} closed while attaching terminal {terminal_id}",
            bridge.id
        )));
    }
    Ok(bridge.id)
}

#[uniffi::export]
pub async fn prepare_herdr_terminal_bridge(
    client_key: String,
    socket_path: String,
    protocol: u32,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
) -> Result<(), HerdrBridgeError> {
    let runtime = crate::runtime().map_err(HerdrBridgeError::BridgeUnavailable)?;
    let connection = HerdrConnection::registered(client_key, socket_path)
        .map_err(|error| HerdrBridgeError::BridgeUnavailable(error.to_string()))?;
    runtime
        .spawn(prepare_bridge_on_runtime(
            connection,
            protocol,
            columns,
            rows,
            cell_width_px,
            cell_height_px,
        ))
        .await
        .map_err(|error| {
            HerdrBridgeError::BridgeUnavailable(format!(
                "Herdr bridge runtime task failed: {error}"
            ))
        })?
}

#[allow(
    clippy::too_many_arguments,
    reason = "the exported UniFFI function preserves the established native terminal API"
)]
#[uniffi::export]
pub async fn start_herdr_terminal_bridge(
    client_key: String,
    socket_path: String,
    protocol: u32,
    terminal_id: String,
    takeover: bool,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
    terminal_attach_launch_mode: HerdrTerminalAttachLaunchMode,
) -> Result<(), HerdrBridgeError> {
    let runtime = crate::runtime().map_err(HerdrBridgeError::BridgeUnavailable)?;
    let connection = HerdrConnection::registered(client_key, socket_path)
        .map_err(|error| HerdrBridgeError::BridgeUnavailable(error.to_string()))?;
    runtime
        .spawn(start_bridge_on_runtime(
            connection,
            protocol,
            terminal_id,
            takeover,
            columns,
            rows,
            cell_width_px,
            cell_height_px,
            terminal_attach_launch_mode,
            |_| Ok(()),
        ))
        .await
        .map_err(|error| {
            HerdrBridgeError::BridgeUnavailable(format!(
                "Herdr bridge runtime task failed: {error}"
            ))
        })?
        .map(|_| ())
}

fn require_active_bridge(
    client_key: &str,
    terminal_id: &str,
) -> Result<Arc<Bridge>, HerdrBridgeError> {
    active_bridge(client_key, terminal_id).ok_or_else(|| {
        HerdrBridgeError::BridgeUnavailable(format!(
            "Herdr bridge is not active for terminal {terminal_id}"
        ))
    })
}

#[uniffi::export]
pub fn herdr_terminal_input(
    client_key: String,
    terminal_id: String,
    text: String,
) -> Result<(), HerdrBridgeError> {
    let bridge = require_active_bridge(&client_key, &terminal_id)?;
    bridge
        .stream()?
        .write(herdr_codec::input(text.as_bytes()))
        .map_err(|error| HerdrBridgeError::BridgeClosed(error.to_string()))
}

#[uniffi::export]
pub fn herdr_terminal_resize(
    client_key: String,
    terminal_id: String,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
) -> Result<(), HerdrBridgeError> {
    let bridge = require_active_bridge(&client_key, &terminal_id)?;
    let payload = herdr_codec::resize(
        bridge.protocol,
        columns,
        rows,
        cell_width_px,
        cell_height_px,
    )?;
    bridge
        .stream()?
        .write(payload)
        .map_err(|error| HerdrBridgeError::BridgeClosed(error.to_string()))
}

#[allow(
    clippy::too_many_arguments,
    reason = "the exported scroll function mirrors the compact terminal input protocol"
)]
#[uniffi::export]
pub fn herdr_terminal_scroll(
    client_key: String,
    terminal_id: String,
    up: bool,
    lines: u32,
    column: Option<f64>,
    row: Option<f64>,
    modifiers: u8,
) -> Result<(), HerdrBridgeError> {
    let bridge = require_active_bridge(&client_key, &terminal_id)?;
    let payload = herdr_codec::scroll(up, lines, column, row, modifiers)?;
    bridge
        .stream()?
        .write(payload)
        .map_err(|error| HerdrBridgeError::BridgeClosed(error.to_string()))
}

#[uniffi::export]
pub fn close_herdr_terminal_bridge(client_key: String, terminal_id: String) {
    let Some(bridge) = active_bridge(&client_key, &terminal_id) else {
        return;
    };
    {
        let mut registry = registry().lock();
        registry.remove_active(&client_key, &terminal_id);
    }
    *bridge.state.lock() = ProtocolState::Closing;
    if let Ok(stream) = bridge.stream() {
        let _ = stream.write(herdr_codec::detach());
    }
    bridge.close_transport();
}

pub(crate) fn close_owned_herdr_terminal_bridge(
    client_key: &str,
    terminal_id: &str,
    bridge_id: HerdrBridgeId,
) {
    let Some(bridge) = active_bridge(client_key, terminal_id) else {
        return;
    };
    if bridge.id != bridge_id {
        return;
    }
    {
        let mut registry = registry().lock();
        if registry.active_id(client_key, terminal_id) != Some(bridge_id) {
            return;
        }
        registry.remove_active(client_key, terminal_id);
    }
    *bridge.state.lock() = ProtocolState::Closing;
    if let Ok(stream) = bridge.stream() {
        let _ = stream.write(herdr_codec::detach());
    }
    bridge.close_transport();
}

#[uniffi::export]
pub fn close_all_herdr_terminal_bridges(client_key: String) {
    let bridges = {
        let registry = registry().lock();
        registry
            .bridges
            .values()
            .filter(|bridge| bridge.client_key == client_key)
            .cloned()
            .collect::<Vec<_>>()
    };
    for bridge in bridges {
        if bridge.terminal_id().is_some()
            && let Ok(stream) = bridge.stream()
        {
            let _ = stream.write(herdr_codec::detach());
        }
        bridge.close_transport();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_registry_scopes_shared_terminal_ids_and_prunes_clients() {
        let mut registry = Registry::default();
        registry.insert_active("client-a".into(), "shared".into(), 1);
        registry.insert_active("client-b".into(), "shared".into(), 2);
        registry.insert_active("client-a".into(), "other".into(), 3);
        assert_eq!(registry.active_id("client-a", "shared"), Some(1));
        assert_eq!(registry.active_id("client-b", "shared"), Some(2));

        assert_eq!(registry.remove_active("client-a", "shared"), Some(1));
        assert!(registry.active.contains_key("client-a"));
        assert_eq!(registry.remove_active("client-a", "other"), Some(3));
        assert!(!registry.active.contains_key("client-a"));
        assert_eq!(registry.active_id("client-b", "shared"), Some(2));
    }

    #[derive(Default)]
    struct RecordingSink {
        controls: Mutex<Vec<(String, String, HerdrTerminalControlEvent)>>,
        terminal_frames: Mutex<Vec<String>>,
    }

    impl HerdrTerminalEventSink for RecordingSink {
        fn terminal_frame(
            &self,
            _client_key: String,
            _terminal_id: String,
            _sequence: u64,
            _width: u16,
            _height: u16,
            _full: bool,
            base64_bytes: String,
        ) {
            self.terminal_frames.lock().push(base64_bytes);
        }

        fn graphics_frame(&self, _client_key: String, _terminal_id: String, _bytes: Vec<u8>) {}

        fn control(
            &self,
            client_key: String,
            terminal_id: String,
            event: HerdrTerminalControlEvent,
        ) {
            self.controls.lock().push((client_key, terminal_id, event));
        }
    }

    fn test_bridge(
        protocol: u32,
    ) -> (Arc<Bridge>, oneshot::Receiver<Result<(), HerdrBridgeError>>) {
        let (welcome_sender, welcome_receiver) = oneshot::channel();
        (
            Arc::new(Bridge {
                id: u64::MAX,
                client_key: "test".to_owned(),
                stream: Mutex::new(None),
                protocol,
                state: Mutex::new(ProtocolState::AwaitingWelcome),
                welcomed: Mutex::new(Some(welcome_sender)),
            }),
            welcome_receiver,
        )
    }

    fn received(
        receiver: oneshot::Receiver<Result<(), HerdrBridgeError>>,
    ) -> Result<(), HerdrBridgeError> {
        receiver.blocking_recv().expect("handshake result")
    }

    #[test]
    fn missing_bridge_transport_is_a_typed_error() {
        let (bridge, _) = test_bridge(20);
        assert!(matches!(
            bridge.stream(),
            Err(HerdrBridgeError::TransportUnavailable)
        ));
    }

    #[test]
    fn handshake_rejects_non_welcome_first_frame() {
        let (bridge, receiver) = test_bridge(20);
        bridge.handle_frame(&[8]);
        assert!(matches!(
            received(receiver),
            Err(HerdrBridgeError::MalformedServerFrame(message))
                if message == "Herdr bridge did not send Welcome first"
        ));
    }

    #[test]
    fn handshake_rejects_protocol_mismatch() {
        let (bridge, receiver) = test_bridge(20);
        bridge.handle_frame(&[0, 19, 1, 0]);
        assert!(matches!(
            received(receiver),
            Err(HerdrBridgeError::WelcomeProtocolMismatch(_))
        ));
    }

    #[test]
    fn handshake_rejects_encoding_mismatch() {
        let (bridge, receiver) = test_bridge(20);
        bridge.handle_frame(&[0, 20, 0, 0]);
        assert!(matches!(
            received(receiver),
            Err(HerdrBridgeError::UnsupportedEncoding(_))
        ));
    }

    #[test]
    fn handshake_rejects_server_error() {
        let (bridge, receiver) = test_bridge(20);
        bridge.handle_frame(&[0, 20, 1, 1, 3, b'b', b'a', b'd']);
        assert!(matches!(
            received(receiver),
            Err(HerdrBridgeError::ServerRejectedWelcome(_))
        ));
    }

    #[test]
    fn handshake_rejects_bridge_close_before_welcome() {
        let (bridge, receiver) = test_bridge(20);
        bridge.transport_closed("remote Unix socket reached EOF".to_owned());
        assert!(matches!(
            received(receiver),
            Err(HerdrBridgeError::ClosedBeforeHandshake(message))
                if message.contains("closed before Welcome")
        ));
    }

    #[test]
    fn handshake_accepts_matching_terminal_ansi_welcome() {
        let (bridge, receiver) = test_bridge(20);
        bridge.handle_frame(&[0, 20, 1, 0]);
        assert_eq!(received(receiver), Ok(()));
        assert!(matches!(*bridge.state.lock(), ProtocolState::Ready));
    }

    #[test]
    fn terminal_frames_are_base64_encoded_before_crossing_uniffi() {
        let (bridge, _) = test_bridge(20);
        let sink = RecordingSink::default();
        bridge.dispatch_to(
            "term1",
            ServerMessage::Terminal {
                sequence: 7,
                width: 80,
                height: 24,
                full: false,
                bytes: vec![0, 255, 16, 32, 127],
            },
            &sink,
        );

        assert_eq!(*sink.terminal_frames.lock(), ["AP8QIH8="]);
    }

    #[test]
    fn server_control_messages_map_to_typed_events_without_option_bags() {
        let (bridge, _) = test_bridge(20);
        *bridge.state.lock() = ProtocolState::Attached("term1".into());
        let sink = RecordingSink::default();
        let cases = [
            (
                ServerMessage::Notify {
                    kind: HerdrTerminalNotificationKind::SystemToast,
                    text: "title".into(),
                    body: Some("body".into()),
                },
                HerdrTerminalControlEvent::Notify {
                    kind: HerdrTerminalNotificationKind::SystemToast,
                    text: "title".into(),
                    body: Some("body".into()),
                },
            ),
            (
                ServerMessage::Clipboard {
                    text: "clip".into(),
                },
                HerdrTerminalControlEvent::Clipboard {
                    text: "clip".into(),
                },
            ),
            (
                ServerMessage::Title { title: None },
                HerdrTerminalControlEvent::Title { title: None },
            ),
            (
                ServerMessage::ReloadSoundConfig,
                HerdrTerminalControlEvent::ReloadSoundConfig,
            ),
            (
                ServerMessage::MouseCapture { enabled: true },
                HerdrTerminalControlEvent::MouseCapture { enabled: true },
            ),
            (
                ServerMessage::KittyKeyboardReportAll { enabled: false },
                HerdrTerminalControlEvent::KittyKeyboardReportAll { enabled: false },
            ),
            (
                ServerMessage::PrefixInputSource { enabled: true },
                HerdrTerminalControlEvent::PrefixInputSource { enabled: true },
            ),
            (
                ServerMessage::TerminalBell { count: 3 },
                HerdrTerminalControlEvent::TerminalBell { count: 3 },
            ),
            (
                ServerMessage::Ignored { variant: 99 },
                HerdrTerminalControlEvent::Ignored,
            ),
            (
                ServerMessage::Closed {
                    reason: Some("done".into()),
                },
                HerdrTerminalControlEvent::Closed {
                    reason: Some("done".into()),
                },
            ),
        ];
        for (message, _) in &cases {
            bridge.dispatch_to("term1", message.clone(), &sink);
        }
        let events = sink.controls.lock();
        assert_eq!(events.len(), cases.len());
        for ((client_key, terminal_id, event), (_, expected)) in events.iter().zip(cases) {
            assert_eq!(client_key, "test");
            assert_eq!(terminal_id, "term1");
            assert_eq!(event, &expected);
        }
    }
}
