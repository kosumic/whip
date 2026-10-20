use super::*;
use std::sync::{
    Weak,
    atomic::{AtomicBool, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

const PROTOCOL: u32 = 22;
const TERMINAL_ID: &str = "test-terminal";

#[test]
fn completion_credit_publishes_next_batch_off_the_calling_thread_and_detach_stops_it() {
    use crate::terminal_delivery::{self, TerminalDeliveryBatch, TerminalDeliveryEventSink};
    struct Sink(
        std::sync::mpsc::Sender<(TerminalDeliveryBatch, std::thread::ThreadId)>,
        std::sync::mpsc::Sender<()>,
    );
    impl Drop for Sink {
        fn drop(&mut self) {
            let _ = self.1.send(());
        }
    }
    impl TerminalDeliveryEventSink for Sink {
        fn ready(&self, _: String, _: String, _: u64, batch: TerminalDeliveryBatch) {
            self.0
                .send((batch, std::thread::current().id()))
                .expect("record batch");
        }
    }
    let _guard = super::super::tests::EVENT_SINK_TEST_LOCK.lock();
    let (sender, receiver) = std::sync::mpsc::channel();
    let (released, release) = std::sync::mpsc::channel();
    let sink = Arc::new(Sink(sender, released));
    let weak = Arc::downgrade(&sink);
    terminal_delivery::set_terminal_delivery_event_sink(sink);
    let generation = terminal_delivery::attach_terminal_delivery(
        "push-host".into(),
        "push-pane".into(),
        "key".into(),
        "identity".into(),
    );
    assert!(terminal_delivery::deliver_bytes(
        "push-host",
        "push-pane",
        &vec![b'x'; 150_001],
        None,
        generation,
        (1, 0),
    ));
    let (first, _) = receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("first batch");
    assert!(receiver.try_recv().is_err());
    terminal_delivery::acknowledge_terminal_delivery_batch(
        generation,
        first.batch_id.parse().expect("batch id"),
    );
    let (next, thread) = receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("next batch");
    assert_ne!(thread, std::thread::current().id());
    let (_, thread) = receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("pipelined batch");
    assert_ne!(thread, std::thread::current().id());
    terminal_delivery::detach_terminal_delivery("push-host".into(), "push-pane".into(), generation);
    terminal_delivery::acknowledge_terminal_delivery_batch(
        generation,
        next.batch_id.parse().expect("batch id"),
    );
    assert!(receiver.try_recv().is_err());
    terminal_delivery::clear();
    release
        .recv_timeout(Duration::from_secs(2))
        .expect("sink released");
    assert!(weak.upgrade().is_none());
}

#[test]
fn renderer_mailboxes_preserve_chunks_and_isolate_replacement_and_hosts() {
    use crate::terminal_delivery::{
        acknowledge_terminal_delivery_batch, attach_terminal_delivery, deliver_bytes,
        detach_terminal_delivery, take_terminal_delivery_batch,
    };
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let _guard = super::super::tests::EVENT_SINK_TEST_LOCK.lock();
    let first = "renderer-delivery-host-a".to_owned();
    let second = "renderer-delivery-host-b".to_owned();
    let terminal = "shared-pane".to_owned();
    let generation = attach_terminal_delivery(
        first.clone(),
        terminal.clone(),
        "key-a".into(),
        "old".into(),
    );
    let other = attach_terminal_delivery(
        second.clone(),
        terminal.clone(),
        "key-b".into(),
        "other".into(),
    );
    let raw: Vec<u8> = (0..150_001)
        .map(|index| u8::try_from(index % 256).expect("byte"))
        .collect();
    assert!(deliver_bytes(
        &first,
        &terminal,
        &raw,
        Some((7, true)),
        generation,
        (1, 0)
    ));
    assert!(take_terminal_delivery_batch(second.clone(), terminal.clone(), other).is_none());
    let mut restored = Vec::new();
    let mut finals = Vec::new();
    while let Some(batch) =
        take_terminal_delivery_batch(first.clone(), terminal.clone(), generation)
    {
        let value: serde_json::Value = serde_json::from_str(&batch.json).expect("packet");
        assert!(batch.json.len() < 66_000);
        for output in value[4].as_array().expect("outputs") {
            assert_eq!(output["seq"], 7);
            assert_eq!(output["full"], true);
            finals.push(output["final"].as_bool().expect("final"));
            restored.extend(
                STANDARD
                    .decode(output["data"].as_str().expect("base64"))
                    .expect("bytes"),
            );
        }
        acknowledge_terminal_delivery_batch(generation, batch.batch_id.parse().expect("batch id"));
    }
    assert_eq!(restored, raw);
    assert_eq!(finals, [false, false, false, true]);
    let replacement = attach_terminal_delivery(
        first.clone(),
        terminal.clone(),
        "key-a".into(),
        "new".into(),
    );
    assert!(deliver_bytes(
        &first,
        &terminal,
        b"stale",
        None,
        generation,
        (1, 0)
    ));
    detach_terminal_delivery(first.clone(), terminal.clone(), generation);
    assert!(take_terminal_delivery_batch(first.clone(), terminal.clone(), replacement).is_none());
    assert!(deliver_bytes(
        &first,
        &terminal,
        b"new",
        None,
        replacement,
        (1, 0)
    ));
    let batch = take_terminal_delivery_batch(first.clone(), terminal.clone(), replacement)
        .expect("replacement batch");
    let value: serde_json::Value = serde_json::from_str(&batch.json).expect("replacement packet");
    assert_eq!(value[1], "new");
    assert_eq!(value[4][0]["data"], STANDARD.encode(b"new"));
    detach_terminal_delivery(first, terminal.clone(), replacement);
    detach_terminal_delivery(second, terminal, other);
}

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

struct TerminalFixture {
    runtime: Arc<HostRuntime>,
    ssh: crate::ssh::ReverseForwardFixture,
    listener: Arc<UnixListener>,
    _directory: tempfile::TempDir,
}

impl TerminalFixture {
    async fn new(id: &str) -> TestResult<Self> {
        let directory = tempfile::tempdir()?;
        let listener = Arc::new(UnixListener::bind(
            directory.path().join("herdr-client.sock"),
        )?);
        let ssh = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let seed = super::super::tests::connected_runtime_inner("terminal-retry-config");
        let mut config = seed.config.clone();
        config.runtime_id = id.to_owned();
        config.socket_path = Some(
            directory
                .path()
                .join("herdr.sock")
                .to_string_lossy()
                .into_owned(),
        );
        let runtime = create_host_runtime(config)?;
        {
            let mut state = runtime.inner.state.lock();
            state.connection = HostConnectionState::Connected;
            state.generation = 1;
            state.protocol = Some(PROTOCOL);
        }
        runtime.inner.herdr.install(1, ssh.ssh.clone());
        publish_lifecycle_status(&runtime.inner);
        Ok(Self {
            runtime,
            ssh,
            listener,
            _directory: directory,
        })
    }

    async fn open(&self) -> TestResult<UnixStream> {
        let listener = self.listener.clone();
        let server = tokio::spawn(async move { accept_terminal(&listener).await });
        self.runtime
            .open_terminal(TERMINAL_ID.to_owned(), true, 80, 24, 8, 16)
            .await?;
        Ok(server.await??)
    }
}

async fn read_frame(stream: &mut UnixStream) -> std::io::Result<Vec<u8>> {
    let length = stream.read_u32_le().await?;
    let mut bytes = vec![0; length as usize];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}

async fn write_frame(stream: &mut UnixStream, bytes: &[u8]) -> std::io::Result<()> {
    stream
        .write_u32_le(u32::try_from(bytes.len()).unwrap())
        .await?;
    stream.write_all(bytes).await
}

async fn close_terminal(stream: &mut UnixStream, reason: &str) -> std::io::Result<()> {
    // Protocol-22 ServerShutdown with an optional UTF-8 reason.
    let mut closed = vec![3, 1, u8::try_from(reason.len()).unwrap()];
    closed.extend_from_slice(reason.as_bytes());
    write_frame(stream, &closed).await
}

async fn accept_terminal(listener: &UnixListener) -> std::io::Result<UnixStream> {
    let (mut stream, _) = listener.accept().await?;
    let _hello = read_frame(&mut stream).await?;
    // Protocol-22 Welcome: matching protocol, ANSI encoding, no error.
    write_frame(&mut stream, &[0, u8::try_from(PROTOCOL).unwrap(), 1, 0]).await?;
    let attach = read_frame(&mut stream).await?;
    assert_eq!(attach, crate::herdr_codec::attach(TERMINAL_ID, true));
    Ok(stream)
}

#[test]
fn server_requested_terminal_retry_recovers_on_the_same_ssh_connection() -> TestResult {
    let _guard = super::super::tests::EVENT_SINK_TEST_LOCK.lock();
    clear_host_runtime_event_sink();
    crate::runtime()?.block_on(async {
        let fixture = TerminalFixture::new("server-terminal-retry").await?;
        let mut rejected = fixture.open().await?;
        // Close only after open_terminal has completed, to exercise recovery
        // rather than the initial attachment's own retry loop.
        let reason = "terminal attach failed: terminal test-terminal has a read in progress; retry";
        close_terminal(&mut rejected, reason).await?;
        assert!(fixture.ssh.ssh.is_alive());
        assert!(fixture.ssh.ssh.latency_ms().await.is_ok());
        let restored =
            tokio::time::timeout(Duration::from_secs(4), accept_terminal(&fixture.listener)).await;
        let generation = fixture.runtime.status().generation;
        fixture.runtime.disconnect().await?;
        assert_eq!(generation, 1);
        let _restored_stream =
            restored.expect("the server's explicit close must start terminal recovery")?;
        Ok(())
    })
}

#[test]
fn server_takeover_does_not_start_an_automatic_reclaim_loop() -> TestResult {
    let _guard = super::super::tests::EVENT_SINK_TEST_LOCK.lock();
    clear_host_runtime_event_sink();
    crate::runtime()?.block_on(async {
        let fixture = TerminalFixture::new("terminal-takeover").await?;
        let mut displaced = fixture.open().await?;
        close_terminal(&mut displaced, "terminal attach taken over").await?;
        tokio::time::timeout(Duration::from_secs(1), async {
            while fixture.runtime.has_terminal(TERMINAL_ID.to_owned()) {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        let state = fixture.runtime.inner.state.lock().terminals[TERMINAL_ID].clone();
        fixture.runtime.disconnect().await?;
        assert!(
            !state.retry_running,
            "client arbitration owns deliberate takeovers"
        );
        assert_eq!(state.state, HostTerminalState::Attached);
        Ok(())
    })
}

struct CloseOnAttach {
    runtime: Weak<RuntimeInner>,
    closed: AtomicBool,
}

impl HostRuntimeEventSink for CloseOnAttach {
    fn event(&self, event: HostRuntimeEvent) {
        if let HostRuntimeEvent::TerminalStateChanged {
            runtime_id,
            terminal_id,
            state: HostTerminalState::Attached,
            ..
        } = event
            && let Some(inner) = self.runtime.upgrade()
            && inner.id == runtime_id
            && !self.closed.swap(true, Ordering::SeqCst)
        {
            // A channel/input failure can arrive after the bridge is committed
            // but before the opening worker returns to its caller.
            schedule_terminal_retry(
                inner,
                terminal_id,
                None,
                "channel closed just after attach".to_owned(),
            );
        }
    }
}

#[test]
fn terminal_close_during_attached_callback_keeps_a_recovery_worker() -> TestResult {
    let _guard = super::super::tests::EVENT_SINK_TEST_LOCK.lock();
    crate::runtime()?.block_on(async {
        let fixture = TerminalFixture::new("terminal-attach-close-race").await?;
        set_host_runtime_event_sink(Arc::new(CloseOnAttach {
            runtime: Arc::downgrade(&fixture.runtime.inner),
            closed: AtomicBool::new(false),
        }));
        let _first_stream = fixture.open().await?;
        let restored =
            tokio::time::timeout(Duration::from_secs(4), accept_terminal(&fixture.listener)).await;
        clear_host_runtime_event_sink();
        assert!(fixture.ssh.ssh.latency_ms().await.is_ok());
        fixture.runtime.disconnect().await?;
        let _restored_stream =
            restored.expect("a close after attach must not lose its recovery worker")?;
        Ok(())
    })
}
