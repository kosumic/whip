use super::*;
use std::sync::{
    Weak,
    atomic::{AtomicBool, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

const PROTOCOL: u32 = 22;
const TERMINAL_ID: &str = "test-terminal";

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
