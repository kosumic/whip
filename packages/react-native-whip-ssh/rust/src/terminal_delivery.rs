//! Bounded renderer mailboxes. Terminal bytes stay in Rust until a renderer can
//! consume a batch; xterm completion, rather than JS callback entry, returns
//! capacity to the transport. No callback is invoked while a mailbox is locked.

use std::collections::{HashMap, VecDeque};
use std::sync::{
    Arc, OnceLock, Weak,
    atomic::{AtomicU64, Ordering},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use parking_lot::{Condvar, Mutex, RwLock};
use serde::Serialize;

const QUEUE_BYTES: usize = 1024 * 1024;
const QUEUE_FRAMES: usize = 64;
const BATCH_BYTES: usize = 64 * 1024;
// A multiple of three: independently encoded chunks concatenate to precisely
// the original byte stream without interior base64 padding.
const RAW_CHUNK_BYTES: usize = BATCH_BYTES / 4 * 3;
const BATCH_FRAMES: usize = 32;
const IN_FLIGHT_BATCHES: usize = 2;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum RendererOutput {
    Ansi {
        seq: u64,
        full: bool,
        r#final: bool,
        data: String,
    },
    Bytes {
        data: String,
    },
}

impl RendererOutput {
    fn len(&self) -> usize {
        match self {
            Self::Ansi { data, .. } | Self::Bytes { data } => data.len(),
        }
    }

    #[cfg(test)]
    fn bytes(bytes: &[u8]) -> Self {
        Self::Bytes {
            data: STANDARD.encode(bytes),
        }
    }
}

#[uniffi::export(with_foreign)]
pub trait TerminalDeliveryEventSink: Send + Sync {
    /// One already-serialized batch, built on a Rust delivery worker.
    fn ready(
        &self,
        client_key: String,
        terminal_id: String,
        generation: u64,
        batch: TerminalDeliveryBatch,
    );
}

#[derive(uniffi::Record)]
pub struct TerminalDeliveryBatch {
    pub batch_id: String,
    pub payload_bytes: u32,
    pub chunk_count: u32,
    /// A JSON literal built in Rust, safe to pass as a function argument.
    pub json: String,
}

#[derive(Default)]
struct State {
    queue: VecDeque<RendererOutput>,
    bytes: usize,
    frames: usize,
    in_flight: VecDeque<(u64, usize, usize)>,
    confirmed: bool,
    notified: bool,
    closed: bool,
    next_batch: u64,
    source: Option<(u64, u64)>,
    native_pending: bool,
    native_token: Option<u64>,
    native_paused: bool,
}

struct Mailbox {
    generation: u64,
    client_key: String,
    terminal_id: String,
    renderer_key: String,
    renderer_identity: String,
    state: Mutex<State>,
    capacity: Condvar,
}

impl State {
    fn window(&self) -> usize {
        // Until the first xterm completion, a retired generation may still be
        // writing in this WebView. Its one replacement slot must not overflow.
        if self.confirmed { IN_FLIGHT_BATCHES } else { 1 }
    }
}

impl Mailbox {
    fn new(
        generation: u64,
        client_key: String,
        terminal_id: String,
        renderer_key: String,
        renderer_identity: String,
    ) -> Self {
        Self {
            generation,
            client_key,
            terminal_id,
            renderer_key,
            renderer_identity,
            state: Mutex::new(State::default()),
            capacity: Condvar::new(),
        }
    }

    fn close(&self) {
        let mut state = self.state.lock();
        state.closed = true;
        state.queue.clear();
        state.bytes = 0;
        state.frames = 0;
        state.in_flight.clear();
        drop(state);
        self.capacity.notify_all();
    }

    #[cfg(test)]
    fn push(&self, output: RendererOutput) -> bool {
        self.push_from(output, (0, 0))
    }

    fn push_from(&self, output: RendererOutput, source: (u64, u64)) -> bool {
        let _trace =
            crate::ssh::AndroidTraceSlice::begin(c"Whip terminal renderer mailbox enqueue");
        let len = output.len();
        let mut state = self.state.lock();
        // Allow one protocol-bounded oversized frame only when otherwise empty.
        // Count both queued and already handed-off data against the budget.
        loop {
            if state.closed || state.source.is_some_and(|current| current > source) {
                return false;
            }
            if state.source != Some(source) {
                // Reconnect supersedes queued output from the old transport.
                // Keep the already-issued batch charged until xterm finishes.
                state.queue.clear();
                let (bytes, frames) = state.in_flight.iter().fold(
                    (0, 0),
                    |(bytes, frames), &(_, next_bytes, next_frames)| {
                        (bytes + next_bytes, frames + next_frames)
                    },
                );
                state.bytes = bytes;
                state.frames = frames;
                state.source = Some(source);
                self.capacity.notify_all();
            }
            if state.frames == 0
                || (state.frames < QUEUE_FRAMES && state.bytes.saturating_add(len) <= QUEUE_BYTES)
            {
                break;
            }
            let _wait =
                crate::ssh::AndroidTraceSlice::begin(c"Whip terminal renderer backpressure");
            self.capacity.wait(&mut state);
        }
        state.bytes += len;
        state.frames += 1;
        state.queue.push_back(output);
        let notify = !state.notified && state.in_flight.len() < state.window();
        if notify {
            state.notified = true;
        }
        notify
    }

    fn take(&self) -> Option<TerminalDeliveryBatch> {
        let _trace =
            crate::ssh::AndroidTraceSlice::begin(c"Whip terminal Rust batch serialization");
        let (batch_id, outputs, source) = {
            let mut state = self.state.lock();
            if state.closed
                || state.native_pending
                || state.native_paused
                || state.in_flight.len() >= state.window()
                || state.queue.is_empty()
            {
                state.notified = false;
                return None;
            }
            let mut outputs = Vec::new();
            let mut bytes = 0;
            while outputs.len() < BATCH_FRAMES {
                let Some(next) = state.queue.front() else {
                    break;
                };
                if !outputs.is_empty() && bytes + next.len() > BATCH_BYTES {
                    break;
                }
                bytes += next.len();
                if let Some(output) = state.queue.pop_front() {
                    outputs.push(output);
                }
            }
            state.next_batch += 1;
            let batch_id = state.next_batch;
            state.in_flight.push_back((batch_id, bytes, outputs.len()));
            let source = state.source.unwrap_or_default();
            drop(state);
            (batch_id, outputs, source)
        };
        let batch_id = batch_id.to_string();
        let payload_bytes = outputs
            .iter()
            .map(|output| {
                let data = match output {
                    RendererOutput::Ansi { data, .. } | RendererOutput::Bytes { data } => data,
                };
                data.len() / 4 * 3 - data.bytes().rev().take_while(|byte| *byte == b'=').count()
            })
            .sum::<usize>();
        let chunk_count = outputs.len();
        // Strings for IDs preserve all u64 bits in WebView JavaScript.
        let json = serde_json::to_string(&(
            &self.renderer_key,
            &self.renderer_identity,
            self.generation.to_string(),
            &batch_id,
            outputs,
            format!("{}:{}", source.0, source.1),
        ))
        .ok()?;
        Some(TerminalDeliveryBatch {
            batch_id,
            json,
            payload_bytes: u32::try_from(payload_bytes).ok()?,
            chunk_count: u32::try_from(chunk_count).ok()?,
        })
    }

    fn acknowledge(&self, batch_id: u64) -> bool {
        let mut state = self.state.lock();
        let Some(&(current, bytes, frames)) = state.in_flight.front() else {
            return false;
        };
        if current != batch_id || state.closed {
            return false;
        }
        state.in_flight.pop_front();
        state.confirmed = true;
        state.bytes -= bytes;
        state.frames -= frames;
        self.capacity.notify_all();
        !state.queue.is_empty()
    }

    fn schedule(&self) -> bool {
        let mut state = self.state.lock();
        if state.closed
            || state.notified
            || state.queue.is_empty()
            || state.in_flight.len() >= state.window()
        {
            return false;
        }
        state.notified = true;
        true
    }

    fn publish(&self) {
        let native = {
            let mut state = self.state.lock();
            if state.native_pending || state.native_paused {
                state.notified = false;
                return;
            }
            state.native_token
        };
        if let Some(token) = native {
            // The platform copies this borrowed UTF-8 slice before returning.
            // No UniFFI RustBuffer or JS runtime owns this allocation.
            while let Some(batch) = self.take() {
                if let Some(deliver) = *native_callback().read() {
                    let _trace =
                        crate::ssh::AndroidTraceSlice::begin(c"Whip terminal native dispatch");
                    deliver(
                        token,
                        self.generation,
                        batch.batch_id.parse().unwrap_or_default(),
                        batch.json.as_ptr(),
                        batch.json.len(),
                    );
                }
            }
            return;
        }
        let sink = sink().read().clone();
        let Some(sink) = sink else {
            return;
        };
        // `notified` admits one publisher until take() observes a full window
        // or empty queue. This serializes callbacks without locking across FFI.
        while let Some(batch) = self.take() {
            sink.ready(
                self.client_key.clone(),
                self.terminal_id.clone(),
                self.generation,
                batch,
            );
        }
    }
}

type Mailboxes = HashMap<String, HashMap<String, Arc<Mailbox>>>;
#[derive(Default)]
struct Registry {
    routes: Mailboxes,
    generations: HashMap<u64, Weak<Mailbox>>,
}
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
static SINK: OnceLock<RwLock<Option<Arc<dyn TerminalDeliveryEventSink>>>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(1);

type NativeDelivery = extern "C" fn(u64, u64, u64, *const u8, usize);
static NATIVE_CALLBACK: OnceLock<RwLock<Option<NativeDelivery>>> = OnceLock::new();
fn native_callback() -> &'static RwLock<Option<NativeDelivery>> {
    NATIVE_CALLBACK.get_or_init(RwLock::default)
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_terminal_set_native_callback(callback: NativeDelivery) {
    *native_callback().write() = Some(callback);
}

fn by_generation(generation: u64) -> Option<Arc<Mailbox>> {
    registry()
        .lock()
        .generations
        .get(&generation)
        .and_then(Weak::upgrade)
}

/// Lifecycle configuration only; output waits for the native document handshake.
#[uniffi::export]
pub fn prepare_native_terminal_delivery(generation: u64) {
    if let Some(mailbox) = by_generation(generation) {
        mailbox.state.lock().native_pending = true;
    }
}

fn resume_publisher(mailbox: Arc<Mailbox>) {
    if mailbox.schedule()
        && let Ok(runtime) = crate::runtime()
    {
        runtime.spawn_blocking(move || mailbox.publish());
    }
}

fn bind_native(token: u64, generation: u64, key: &str, identity: &str) -> bool {
    let Some(mailbox) = by_generation(generation) else {
        return false;
    };
    if mailbox.renderer_key != key || mailbox.renderer_identity != identity {
        return false;
    }
    {
        let mut state = mailbox.state.lock();
        if state.closed || !state.native_pending || token == 0 || native_callback().read().is_none()
        {
            return !state.closed && state.native_token == Some(token);
        }
        state.native_token = Some(token);
        state.native_pending = false;
    }
    resume_publisher(mailbox);
    true
}

/// # Safety
/// Both byte slices must remain readable for this call. They are borrowed UTF-8,
/// never retained or freed by Rust.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_terminal_bind_native(
    token: u64,
    generation: u64,
    key: *const u8,
    key_len: usize,
    identity: *const u8,
    identity_len: usize,
) -> bool {
    if key.is_null() || identity.is_null() {
        return false;
    }
    // SAFETY: The platform lends these readable slices for the duration of the
    // call, as required by this function's C ABI contract above.
    let key = unsafe { std::slice::from_raw_parts(key, key_len) };
    // SAFETY: Same borrowed-slice contract; neither slice escapes this call.
    let identity = unsafe { std::slice::from_raw_parts(identity, identity_len) };
    let (Ok(key), Ok(identity)) = (std::str::from_utf8(key), std::str::from_utf8(identity)) else {
        return false;
    };
    bind_native(token, generation, key, identity)
}

#[uniffi::export]
pub fn use_javascript_terminal_delivery(generation: u64) {
    let Some(mailbox) = by_generation(generation) else {
        return;
    };
    {
        let mut state = mailbox.state.lock();
        if state.native_token.is_some() || state.closed {
            return;
        }
        state.native_pending = false;
    }
    resume_publisher(mailbox);
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_terminal_ack_native(token: u64, generation: u64, batch: u64) {
    let Some(mailbox) = by_generation(generation) else {
        return;
    };
    if mailbox.state.lock().native_token != Some(token) {
        return;
    }
    acknowledge_terminal_delivery_batch(generation, batch);
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_terminal_unbind_native(token: u64) {
    let mailboxes: Vec<_> = registry()
        .lock()
        .generations
        .values()
        .filter_map(Weak::upgrade)
        .collect();
    for mailbox in mailboxes {
        if mailbox.state.lock().native_token == Some(token) {
            detach_terminal_delivery(
                mailbox.client_key.clone(),
                mailbox.terminal_id.clone(),
                mailbox.generation,
            );
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_terminal_release_native(token: u64, generation: u64) {
    let Some(mailbox) = by_generation(generation) else {
        return;
    };
    if mailbox.state.lock().native_token == Some(token) {
        detach_terminal_delivery(
            mailbox.client_key.clone(),
            mailbox.terminal_id.clone(),
            generation,
        );
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_terminal_pause_native(token: u64, paused: bool) {
    let mailboxes: Vec<_> = registry()
        .lock()
        .generations
        .values()
        .filter_map(Weak::upgrade)
        .collect();
    for mailbox in mailboxes {
        {
            let mut state = mailbox.state.lock();
            if state.native_token != Some(token) {
                continue;
            }
            state.native_paused = paused;
        }
        if !paused {
            resume_publisher(mailbox);
        }
    }
}

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(Mutex::default)
}
fn sink() -> &'static RwLock<Option<Arc<dyn TerminalDeliveryEventSink>>> {
    SINK.get_or_init(RwLock::default)
}
#[cfg(test)]
fn mailbox(client: &str, terminal: &str, generation: u64) -> Option<Arc<Mailbox>> {
    registry()
        .lock()
        .routes
        .get(client)?
        .get(terminal)
        .filter(|mailbox| mailbox.generation == generation)
        .cloned()
}

#[uniffi::export]
pub fn set_terminal_delivery_event_sink(value: Arc<dyn TerminalDeliveryEventSink>) {
    *sink().write() = Some(value);
}

pub(crate) fn generation(client: &str, terminal: &str) -> u64 {
    registry()
        .lock()
        .routes
        .get(client)
        .and_then(|terminals| terminals.get(terminal))
        .map_or(0, |mailbox| mailbox.generation)
}

#[uniffi::export]
pub fn attach_terminal_delivery(
    client_key: String,
    terminal_id: String,
    renderer_key: String,
    renderer_identity: String,
) -> u64 {
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
    let mailbox = Arc::new(Mailbox::new(
        generation,
        client_key.clone(),
        terminal_id.clone(),
        renderer_key,
        renderer_identity,
    ));
    let previous = {
        let mut registry = registry().lock();
        let previous = registry
            .routes
            .entry(client_key)
            .or_default()
            .insert(terminal_id, Arc::clone(&mailbox));
        if let Some(previous) = &previous {
            registry.generations.remove(&previous.generation);
        }
        registry
            .generations
            .insert(generation, Arc::downgrade(&mailbox));
        previous
    };
    if let Some(previous) = previous {
        previous.close();
    }
    generation
}

#[uniffi::export]
pub fn detach_terminal_delivery(client_key: String, terminal_id: String, generation: u64) {
    let removed = {
        let mut registry = registry().lock();
        let Some(terminals) = registry.routes.get_mut(&client_key) else {
            return;
        };
        let removed = if terminals
            .get(&terminal_id)
            .is_some_and(|mailbox| mailbox.generation == generation)
        {
            terminals.remove(&terminal_id)
        } else {
            None
        };
        if terminals.is_empty() {
            registry.routes.remove(&client_key);
        }
        if let Some(mailbox) = &removed {
            registry.generations.remove(&mailbox.generation);
        }
        removed
    };
    if let Some(mailbox) = removed {
        mailbox.close();
    }
}

#[cfg(test)]
pub(crate) fn take_terminal_delivery_batch(
    client_key: String,
    terminal_id: String,
    generation: u64,
) -> Option<TerminalDeliveryBatch> {
    mailbox(&client_key, &terminal_id, generation)?.take()
}

/// Credits contain only numeric IDs. Serialization and callback delivery of the
/// next batch run off the calling JS thread, without a polling timer.
#[uniffi::export]
pub fn acknowledge_terminal_delivery_batch(generation: u64, batch_id: u64) {
    let mailbox = registry()
        .lock()
        .generations
        .get(&generation)
        .and_then(Weak::upgrade);
    let Some(mailbox) = mailbox else {
        return;
    };
    if mailbox.acknowledge(batch_id)
        && mailbox.schedule()
        && let Ok(runtime) = crate::runtime()
    {
        runtime.spawn_blocking(move || mailbox.publish());
    }
}

/// True means this output belongs to a mailbox (including a concurrently closed
/// one). Never fall back to a replacement JS attachment after a blocked push.
pub(crate) fn deliver_bytes(
    client: &str,
    terminal: &str,
    bytes: &[u8],
    ansi: Option<(u64, bool)>,
    expected_generation: u64,
    source: (u64, u64),
) -> bool {
    let mailbox = registry()
        .lock()
        .routes
        .get(client)
        .and_then(|terminals| terminals.get(terminal))
        .cloned();
    let Some(mailbox) = mailbox else {
        return expected_generation != 0;
    };
    if mailbox.generation != expected_generation {
        return true;
    }
    let chunks = bytes.len().max(1).div_ceil(RAW_CHUNK_BYTES);
    for index in 0..chunks {
        {
            let state = mailbox.state.lock();
            if state.closed || state.source.is_some_and(|current| current > source) {
                break;
            }
        }
        let start = index * RAW_CHUNK_BYTES;
        let end = (start + RAW_CHUNK_BYTES).min(bytes.len());
        let data = {
            let _trace =
                crate::ssh::AndroidTraceSlice::begin(c"Whip terminal Rust base64 encoding");
            STANDARD.encode(&bytes[start..end])
        };
        let output = match ansi {
            Some((seq, full)) => RendererOutput::Ansi {
                seq,
                full,
                r#final: index + 1 == chunks,
                data,
            },
            None => RendererOutput::Bytes { data },
        };
        if mailbox.push_from(output, source) {
            mailbox.publish();
        }
    }
    true
}

pub(crate) fn clear() {
    let previous = {
        let mut registry = registry().lock();
        registry.generations.clear();
        std::mem::take(&mut registry.routes)
    };
    for mailbox in previous.into_values().flat_map(HashMap::into_values) {
        mailbox.close();
    }
    *sink().write() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_mailbox() -> Mailbox {
        Mailbox::new(
            1,
            "client".into(),
            "terminal".into(),
            "host/pane".into(),
            "renderer-1".into(),
        )
    }
    fn output(data: &[u8]) -> RendererOutput {
        RendererOutput::bytes(data)
    }

    #[test]
    fn native_delivery_owns_no_foreign_buffer_and_fences_credits_and_teardown() {
        let _guard = crate::host_runtime::terminal_delivery_test_guard();
        type Received = (u64, u64, u64, Vec<u8>);
        static RECEIVED: OnceLock<(Mutex<Vec<Received>>, Condvar)> = OnceLock::new();
        extern "C" fn receive(
            token: u64,
            generation: u64,
            batch: u64,
            data: *const u8,
            len: usize,
        ) {
            // Exercise the C contract: copy the borrow synchronously and retain
            // only that copy after Rust drops the batch allocation.
            // SAFETY: The native delivery callback lends a live JSON slice for
            // this invocation; copy it before returning to the publisher.
            let data = unsafe { std::slice::from_raw_parts(data, len) }.to_vec();
            let (items, wake) = RECEIVED.get_or_init(Default::default);
            items.lock().push((token, generation, batch, data));
            wake.notify_one();
        }
        whip_terminal_set_native_callback(receive);
        let client = "native-ownership-test".to_owned();
        let terminal = "pane".to_owned();
        let generation =
            attach_terminal_delivery(client.clone(), terminal.clone(), "key".into(), "old".into());
        let route = mailbox(&client, &terminal, generation).expect("route");
        prepare_native_terminal_delivery(generation);
        route.push(output(b"\x1b_G\x00\xff\x1b\\\x07"));
        route.publish();
        let (items, wake) = RECEIVED.get_or_init(Default::default);
        assert!(items.lock().is_empty());
        assert!(bind_native(17, generation, "key", "old")); // idempotent
        assert!(bind_native(17, generation, "key", "old"));
        assert!(!bind_native(18, generation, "key", "old"));
        assert!(!bind_native(17, generation, "other-host", "old"));
        assert!(!bind_native(17, generation, "key", "replacement"));
        let received = {
            let mut items = items.lock();
            if items.is_empty() {
                assert!(
                    !wake
                        .wait_for(&mut items, std::time::Duration::from_secs(2))
                        .timed_out()
                );
            }
            items.pop().expect("native callback")
        };
        assert_eq!((received.0, received.1, received.2), (17, generation, 1));
        let packet: serde_json::Value = serde_json::from_slice(&received.3).expect("retained copy");
        assert_eq!(
            packet[4][0]["data"],
            STANDARD.encode(b"\x1b_G\x00\xff\x1b\\\x07")
        );
        whip_terminal_ack_native(18, generation, 1);
        assert_eq!(route.state.lock().frames, 1);
        whip_terminal_ack_native(17, generation, 1);
        assert_eq!(route.state.lock().frames, 0);
        whip_terminal_pause_native(17, true);
        route.push(output(b"paused"));
        assert!(route.take().is_none());
        route.publish();
        assert!(items.lock().is_empty());
        whip_terminal_pause_native(17, false);
        let batch = {
            let mut items = items.lock();
            if items.is_empty() {
                assert!(
                    !wake
                        .wait_for(&mut items, std::time::Duration::from_secs(2))
                        .timed_out()
                );
            }
            items.pop().expect("resumed callback").2
        };
        whip_terminal_ack_native(17, generation, batch);
        route.push(output(&vec![0; QUEUE_BYTES]));
        let producer = Arc::clone(&route);
        let (send, receive) = std::sync::mpsc::channel();
        let worker =
            std::thread::spawn(move || send.send(producer.push(output(b"blocked"))).expect("send"));
        whip_terminal_unbind_native(17);
        assert!(
            !receive
                .recv_timeout(std::time::Duration::from_secs(1))
                .expect("wake")
        );
        worker.join().expect("producer");
        assert!(route.state.lock().closed);
        assert_eq!(route.state.lock().bytes, 0);
        let replacement = attach_terminal_delivery(
            client.clone(),
            terminal.clone(),
            "key".into(),
            "replacement".into(),
        );
        prepare_native_terminal_delivery(replacement);
        assert!(!bind_native(17, generation, "key", "old"));
        whip_terminal_release_native(17, generation);
        assert!(mailbox(&client, &terminal, replacement).is_some());
        detach_terminal_delivery(client, terminal, replacement);
    }

    #[test]
    fn batches_preserve_binary_graphics_and_frame_sequence() {
        let mailbox = new_mailbox();
        assert!(mailbox.push(RendererOutput::Ansi {
            seq: 7,
            full: true,
            r#final: true,
            data: STANDARD.encode(b"text")
        }));
        assert!(!mailbox.push(output(b"\x1b_G\x00\xff\x1b\\")));
        assert!(!mailbox.push(RendererOutput::Ansi {
            seq: 8,
            full: false,
            r#final: true,
            data: STANDARD.encode(b"after")
        }));
        let batch = mailbox.take().expect("batch");
        let value: serde_json::Value = serde_json::from_str(&batch.json).expect("json");
        assert_eq!(value[4][0]["seq"], 7);
        assert_eq!(
            value[4][1]["data"],
            STANDARD.encode(b"\x1b_G\x00\xff\x1b\\")
        );
        assert_eq!(value[4][2]["seq"], 8);
        assert!(mailbox.take().is_none());
        assert!(!mailbox.acknowledge(99));
        assert_eq!(mailbox.state.lock().frames, 3);
        assert!(!mailbox.acknowledge(1));
        assert_eq!(mailbox.state.lock().bytes, 0);
    }

    #[test]
    fn backpressure_includes_in_flight_bytes_and_close_wakes_producer() {
        let mailbox = Arc::new(new_mailbox());
        mailbox.push(output(&vec![0; QUEUE_BYTES]));
        mailbox.take().expect("oversized batch");
        let blocked = Arc::clone(&mailbox);
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            sender.send(blocked.push(output(b"next"))).expect("send");
        });
        assert!(
            receiver
                .recv_timeout(std::time::Duration::from_millis(20))
                .is_err()
        );
        mailbox.close();
        assert!(
            !receiver
                .recv_timeout(std::time::Duration::from_secs(1))
                .expect("unblocked")
        );
        worker.join().expect("producer");
        assert_eq!(mailbox.state.lock().frames, 0);
    }

    #[test]
    fn acknowledgements_resume_bounded_batches_without_duplicate_notifications() {
        let mailbox = new_mailbox();
        for index in 0..QUEUE_FRAMES {
            assert_eq!(
                mailbox.push(output(&[u8::try_from(index).expect("byte")])),
                index == 0
            );
        }
        let first = mailbox.take().expect("first");
        assert_eq!(mailbox.state.lock().frames, QUEUE_FRAMES);
        assert!(mailbox.acknowledge(first.batch_id.parse().expect("id")));
        let second = mailbox.take().expect("second");
        assert!(!mailbox.acknowledge(first.batch_id.parse().expect("id")));
        assert!(!mailbox.acknowledge(second.batch_id.parse().expect("id")));
        assert_eq!(mailbox.state.lock().frames, 0);
    }

    #[test]
    fn renderer_starts_with_one_credit_then_pipelines_two_in_order() {
        let mailbox = new_mailbox();
        mailbox.push(output(b"baseline"));
        let first = mailbox.take().expect("baseline");
        for _ in 0..IN_FLIGHT_BATCHES {
            mailbox.push(output(&vec![0; RAW_CHUNK_BYTES]));
        }
        assert!(mailbox.take().is_none());
        assert!(mailbox.acknowledge(first.batch_id.parse().expect("id")));
        let second = mailbox.take().expect("second");
        let third = mailbox.take().expect("third");
        assert!(mailbox.take().is_none());
        assert!(!mailbox.acknowledge(third.batch_id.parse().expect("id")));
        assert_eq!(mailbox.state.lock().in_flight.len(), IN_FLIGHT_BATCHES);
        assert!(!mailbox.acknowledge(second.batch_id.parse().expect("id")));
        assert!(!mailbox.acknowledge(third.batch_id.parse().expect("id")));
        assert_eq!(mailbox.state.lock().bytes, 0);
    }

    #[test]
    fn renderer_identity_is_json_escaped_and_close_discards_queued_frames() {
        let mailbox = Mailbox::new(
            u64::MAX,
            "client".into(),
            "terminal".into(),
            "\"\\\n".into(),
            "identity".into(),
        );
        mailbox.push(output(b"\x00\xff"));
        let batch = mailbox.take().expect("batch");
        let value: serde_json::Value = serde_json::from_str(&batch.json).expect("json");
        assert_eq!(value[0], "\"\\\n");
        assert_eq!(value[2], u64::MAX.to_string());
        mailbox.close();
        assert!(mailbox.take().is_none());
        assert!(!mailbox.push(output(b"late")));
    }

    #[test]
    fn reconnect_discards_queued_old_output_and_wakes_a_stale_producer() {
        let mailbox = Arc::new(new_mailbox());
        for _ in 0..QUEUE_FRAMES {
            mailbox.push_from(output(b"old"), (1, 0));
        }
        let first = mailbox.take().expect("old in-flight batch");
        let blocked = Arc::clone(&mailbox);
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            sender
                .send(blocked.push_from(output(b"stale"), (1, 0)))
                .expect("send");
        });
        assert!(
            receiver
                .recv_timeout(std::time::Duration::from_millis(20))
                .is_err()
        );
        mailbox.push_from(output(b"new"), (2, 0));
        assert!(
            !receiver
                .recv_timeout(std::time::Duration::from_secs(1))
                .expect("stale producer stopped")
        );
        worker.join().expect("producer");
        assert!(mailbox.acknowledge(first.batch_id.parse().expect("batch id")));
        let new = mailbox.take().expect("new source batch");
        let value: serde_json::Value = serde_json::from_str(&new.json).expect("packet");
        assert_eq!(value[4].as_array().expect("outputs").len(), 1);
        assert_eq!(value[4][0]["data"], STANDARD.encode(b"new"));
        assert_eq!(value[5], "2:0");
        assert!(!mailbox.push_from(output(b"late"), (1, 0)));
    }
}
