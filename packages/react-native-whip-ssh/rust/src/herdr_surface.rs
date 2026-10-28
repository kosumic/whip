//! Experimental active Endpoint v1 renderer. Independent of direct terminals and agent_view.
mod input;
mod model;
#[cfg(test)]
mod tests;

use crate::herdr_codec::{self, Encoder, ServerMessage};
use crate::herdr_connection::{HerdrConnection, HerdrStream, HerdrStreamFraming, HerdrStreamKind};
use parking_lot::Mutex;
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const GENERATION: u32 = 1;
const WELCOME: &str = "endpoint.welcome.v1";
const SNAPSHOT: &str = "shell.snapshot.v1";
const SURFACE: &str = "shell.surface.v1";
const INPUT: &str = "shell.input.semantic.v1";
const BLOB: &str = "shell.blob.v1";
const MAX_SURFACE_BYTES: usize = 2 * 1024 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum HerdrSurfaceError {
    #[error("Experimental Herdr renderer: {reason}")]
    Unavailable { reason: String },
}
fn error(reason: impl ToString) -> HerdrSurfaceError {
    HerdrSurfaceError::Unavailable {
        reason: reason.to_string(),
    }
}

#[derive(Deserialize)]
struct Welcome {
    generation: u32,
    snapshot_codec: String,
    surface_codec: String,
    input_codec: String,
    blob_codec: String,
    error: Option<serde_json::Value>,
}
fn validate_welcome(data: &str) -> Result<(), String> {
    let welcome: Welcome = serde_json::from_str(data).map_err(|e| e.to_string())?;
    if welcome.error.is_some()
        || welcome.generation != GENERATION
        || welcome.snapshot_codec != SNAPSHOT
        || welcome.surface_codec != SURFACE
        || welcome.input_codec != INPUT
        || welcome.blob_codec != BLOB
    {
        return Err("server rejected Endpoint generation 1 or required codecs".into());
    }
    Ok(())
}
#[derive(Deserialize)]
struct Snapshot {
    boot_id: String,
    revision: u64,
    focused_pane_id: Option<String>,
}

#[derive(Default)]
struct State {
    epoch: u64,
    stream: Option<Arc<HerdrStream>>,
    welcomed: bool,
    boot: String,
    projection: u64,
    screen: model::Screen,
    error: Option<String>,
    ready: Option<oneshot::Sender<Result<(), String>>>,
    bytes: u64,
    frames: u64,
    patches: u64,
    decode_us: u64,
    first_frame_us: Option<u64>,
    started: Option<Instant>,
}
impl State {
    fn fail(&mut self, reason: String) {
        self.error = Some(reason.clone());
        if let Some(ready) = self.ready.take() {
            let _ = ready.send(Err(reason));
        }
    }
}

#[derive(uniffi::Object)]
pub struct HerdrSurface {
    connection: Arc<HerdrConnection>,
    pane_id: String,
    state: Mutex<State>,
}

#[uniffi::export]
pub fn create_herdr_surface(
    runtime_id: String,
    pane_id: String,
) -> Result<Arc<HerdrSurface>, HerdrSurfaceError> {
    if pane_id.is_empty() || pane_id.len() > 256 {
        return Err(error("missing stable Herdr pane ID"));
    }
    let connection = crate::host_runtime::surface_connection(runtime_id)
        .ok_or_else(|| error("host runtime unavailable"))?;
    Ok(Arc::new(HerdrSurface {
        connection,
        pane_id,
        state: Mutex::new(State::default()),
    }))
}

fn hello(cols: u16, rows: u16, cell_width_px: u32, cell_height_px: u32) -> Vec<u8> {
    let data = serde_json::json!({
        "generation": GENERATION, "cell_width_px": cell_width_px, "cell_height_px": cell_height_px,
        "surface_size": {"cols":cols,"rows":rows}, "surface_active":true,
        "pixel_mouse":false,"direct_graphics":false,"endpoint_keybindings":false,"mouse_capture":false,
        "snapshot_codecs":[SNAPSHOT],"surface_codecs":[SURFACE],"input_codecs":[INPUT],"blob_codecs":[BLOB]
    });
    herdr_codec::endpoint_control("endpoint.hello.v1", &data.to_string())
}

impl HerdrSurface {
    fn frame(&self, epoch: u64, bytes: &[u8]) {
        let started = Instant::now();
        let mut state = self.state.lock();
        if state.epoch != epoch || state.error.is_some() {
            return;
        }
        state.bytes += bytes.len() as u64;
        let result = self.message(&mut state, bytes);
        state.decode_us += u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
        if let Err(reason) = result {
            state.fail(reason);
        }
    }
    fn message(&self, state: &mut State, bytes: &[u8]) -> Result<(), String> {
        let message = model::decode(bytes).map_err(|e| e.to_string())?;
        match message {
            model::SurfaceMessage::Other => match herdr_codec::decode(bytes, 22)
                .map_err(|e| e.to_string())?
            {
                ServerMessage::EndpointControl { kind, data } if kind == WELCOME => {
                    if state.welcomed {
                        return Err("duplicate endpoint welcome".into());
                    }
                    validate_welcome(&data)?;
                    state.welcomed = true;
                }
                ServerMessage::EndpointControl { kind, data } if kind == SNAPSHOT => {
                    if !state.welcomed {
                        return Err("snapshot before endpoint welcome".into());
                    }
                    let snapshot: Snapshot =
                        serde_json::from_str(&data).map_err(|e| e.to_string())?;
                    if snapshot.boot_id.is_empty()
                        || snapshot.focused_pane_id.as_deref() != Some(self.pane_id.as_str())
                    {
                        return Err(
                            "select the server's focused single pane before attaching Skia".into(),
                        );
                    }
                    if !state.boot.is_empty()
                        && (state.boot != snapshot.boot_id || snapshot.revision < state.projection)
                    {
                        return Err(
                            "endpoint snapshot identity or revision changed unexpectedly".into(),
                        );
                    }
                    state.boot = snapshot.boot_id;
                    state.projection = snapshot.revision;
                }
                ServerMessage::Closed { reason } => {
                    return Err(reason.unwrap_or_else(|| "endpoint closed".into()));
                }
                ServerMessage::Welcome { .. } => {
                    return Err("server does not support Endpoint v1".into());
                }
                ServerMessage::Ignored { variant: 15 } => {
                    return Err("server reported a client-shell error".into());
                }
                _ => {} // Optional controls never mutate management state.
            },
            message => {
                if !state.welcomed || state.boot.is_empty() {
                    return Err("surface before endpoint snapshot".into());
                }
                if matches!(message, model::SurfaceMessage::Patch(_)) {
                    state.patches += 1;
                } else {
                    state.frames += 1;
                }
                state
                    .screen
                    .apply(message, &self.pane_id, &state.boot, state.projection)
                    .map_err(|e| e.to_string())?;
                if state.first_frame_us.is_none() {
                    state.first_frame_us = state
                        .started
                        .map(|s| u64::try_from(s.elapsed().as_micros()).unwrap_or(u64::MAX));
                }
                if let Some(ready) = state.ready.take() {
                    let _ = ready.send(Ok(()));
                }
            }
        }
        Ok(())
    }
    fn write(&self, bytes: Vec<u8>) -> Result<(), HerdrSurfaceError> {
        let state = self.state.lock();
        if let Some(reason) = &state.error {
            return Err(error(reason));
        }
        state
            .stream
            .as_ref()
            .ok_or_else(|| error("surface detached"))?
            .write(bytes)
            .map_err(error)
    }
    async fn open(
        self: Arc<Self>,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> Result<(), HerdrSurfaceError> {
        let (sender, receiver) = oneshot::channel();
        let epoch = {
            let mut state = self.state.lock();
            let epoch = state.epoch + 1;
            if let Some(stream) = state.stream.take() {
                let _ = stream.close();
            }
            *state = State {
                epoch,
                ready: Some(sender),
                started: Some(Instant::now()),
                ..State::default()
            };
            epoch
        };
        let frame = Arc::downgrade(&self);
        let closed = Arc::downgrade(&self);
        let stream = self
            .connection
            .open_stream(
                HerdrStreamKind::Surface,
                HerdrStreamFraming::LengthPrefixed,
                MAX_SURFACE_BYTES,
                Arc::new(move |bytes| {
                    if let Some(surface) = frame.upgrade() {
                        surface.frame(epoch, &bytes);
                    }
                }),
                Arc::new(move |reason| {
                    if let Some(surface) = closed.upgrade() {
                        let mut state = surface.state.lock();
                        if state.epoch == epoch {
                            state.fail(reason);
                        }
                    }
                }),
            )
            .await
            .map_err(error)?;
        {
            let mut state = self.state.lock();
            if state.epoch != epoch {
                let _ = stream.close();
                return Err(error("surface attach superseded"));
            }
            state.stream = Some(stream.clone());
        }
        let result = async {
            stream
                .write(hello(cols, rows, cell_width_px, cell_height_px))
                .map_err(error)?;
            let ready = tokio::time::timeout(READY_TIMEOUT, stream.wait_current(receiver))
                .await
                .map_err(|_| error("initial surface timed out"))?
                .map_err(error)?
                .map_err(error)?
                .map_err(error);
            ready
        }
        .await;
        if let Err(reason) = &result {
            let mut state = self.state.lock();
            if state.epoch == epoch {
                state.fail(reason.to_string());
            }
            let _ = stream.close();
        }
        result
    }
}

#[uniffi::export]
impl HerdrSurface {
    /// Reconnects only this renderer channel; never replaces the pane/session.
    pub async fn connect(
        self: Arc<Self>,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> Result<(), HerdrSurfaceError> {
        model::dimensions(cols, rows).map_err(error)?;
        if cell_width_px > 1024 || cell_height_px > 1024 {
            return Err(error("invalid cell dimensions"));
        }
        crate::runtime()
            .map_err(error)?
            .spawn(self.open(cols, rows, cell_width_px, cell_height_px))
            .await
            .map_err(error)?
    }
    /// Synchronous JSI pull: at most once per presentation tick. Only dirty rows cross the bridge.
    pub fn take_update(&self) -> Result<Option<String>, HerdrSurfaceError> {
        let mut state = self.state.lock();
        if state
            .stream
            .as_ref()
            .is_some_and(|stream| !stream.is_current())
        {
            state.fail("SSH generation changed; reconnect surface".into());
        }
        if let Some(reason) = &state.error {
            return Err(error(reason));
        }
        state.screen.take().map_err(error)
    }
    pub fn input(&self, text: String, paste: bool) -> Result<(), HerdrSurfaceError> {
        self.write(input::encode(&self.pane_id, &text, paste).map_err(error)?)
    }
    pub fn resize(
        &self,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> Result<(), HerdrSurfaceError> {
        model::dimensions(cols, rows).map_err(error)?;
        if cell_width_px > 1024 || cell_height_px > 1024 {
            return Err(error("invalid cell dimensions"));
        }
        let mut e = Encoder::default();
        e.unsigned(12);
        e.unsigned(u64::from(cell_width_px));
        e.unsigned(u64::from(cell_height_px));
        e.unsigned(u64::from(cols));
        e.unsigned(u64::from(rows));
        e.boolean(false);
        self.write(e.finish())
    }
    pub fn metrics(&self) -> String {
        let s = self.state.lock();
        serde_json::json!({"payloadBytes":s.bytes,"fullFrames":s.frames,"patches":s.patches,"decodeApplyUs":s.decode_us,
            "firstModelFrameUs":s.first_frame_us,"epoch":s.epoch}).to_string()
    }
    pub fn close(&self) {
        let stream = {
            let mut state = self.state.lock();
            state.epoch += 1;
            state.fail("surface detached".into());
            state.screen = model::Screen::default();
            state.stream.take()
        };
        if let Some(stream) = stream {
            let _ = stream.write(herdr_codec::detach());
            let _ = stream.close();
        }
    }
}
impl Drop for HerdrSurface {
    fn drop(&mut self) {
        self.close();
    }
}
