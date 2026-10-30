//! Drive a real NSH engine's Rust task and compare its runtime with Whip's.
use nsh_core::prelude::*;
use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

static DISPOSED: AtomicUsize = AtomicUsize::new(0);
static STARTED: AtomicUsize = AtomicUsize::new(0);
static CANCELLED: AtomicUsize = AtomicUsize::new(0);

struct PendingNetwork;
struct PendingRequest;
impl nsh_engine::Network for PendingNetwork {
    fn fetch(
        &self,
        _: nsh_engine::HttpRequest,
        _: nsh_engine::FetchEvents,
    ) -> Box<dyn nsh_engine::FetchTask> {
        STARTED.fetch_add(1, Ordering::SeqCst);
        Box::new(PendingRequest)
    }
}
impl nsh_engine::FetchTask for PendingRequest {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {
        CANCELLED.fetch_add(1, Ordering::SeqCst);
    }
}

struct SurfaceResource;
impl Drop for SurfaceResource {
    fn drop(&mut self) {
        DISPOSED.fetch_add(1, Ordering::SeqCst);
    }
}

#[component]
fn Probe() -> impl IntoElement {
    let runtime = signal(String::new());
    let resource = SurfaceResource;
    // NSH intentionally frees owners without invoking user cleanup code at VM
    // shutdown. Values captured by those cleanups must still be released.
    cleanup(move || drop(resource));
    let probe = spawn(async move {
        let id = background(async { tokio::runtime::Handle::current().id().to_string() })
            .await
            .expect("runtime probe completes");
        runtime.set(id);
    });
    cleanup(move || drop(probe));
    let request = spawn(async {
        let _ = fetch("https://api.github.com/repos/kosumic/whip/releases/latest").await;
    });
    cleanup(move || drop(request));
    view().child(text(move || runtime.get()))
}

#[test]
fn every_surface_uses_whips_existing_runtime_and_stops_on_drop() -> Result<(), String> {
    let handle = whip_core::shared_runtime_handle()?;
    nsh_engine::set_shared_runtime(handle.clone()).expect("first NSH engine in this test process");
    let id = handle.id().to_string();
    for count in 1..=2 {
        let mut config = EngineConfig::new(Root::of::<Probe>());
        config.network = Some(Arc::new(PendingNetwork));
        let mut app = Headless::start(config).map_err(|error| error.to_string())?;
        app.wait_for(&id)?;
        assert_eq!(STARTED.load(Ordering::SeqCst), count);
        drop(app);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while DISPOSED.load(Ordering::SeqCst) < count && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(DISPOSED.load(Ordering::SeqCst), count);
        assert_eq!(CANCELLED.load(Ordering::SeqCst), count);
        assert_eq!(whip_core::shared_runtime_handle()?.id(), handle.id());
    }
    Ok(())
}
