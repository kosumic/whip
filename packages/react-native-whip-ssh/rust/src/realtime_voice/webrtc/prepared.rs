//! Local crypto material only: never retain a peer, SDP, ICE state or sockets.
//! Each real call creates its own negotiation state and uses current interfaces.
use super::api;
use parking_lot::Mutex;
use std::{
    sync::{
        Arc, LazyLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use str0m::crypto::{CryptoProvider, dtls::DtlsCert};
use tokio::sync::{Notify, watch};

const REFRESH: Duration = Duration::from_secs(60);
static REVISION: AtomicU64 = AtomicU64::new(0);
static POOL: LazyLock<Mutex<Pool>> = LazyLock::new(Mutex::default);
static REFILL: Notify = Notify::const_new();

#[derive(Default)]
struct Pool {
    stop: Option<watch::Sender<bool>>,
    spare: Option<Material>,
}
pub(super) struct Material {
    pub provider: Arc<CryptoProvider>,
    pub certificate: DtlsCert,
}

pub(in crate::realtime_voice) fn clear() {
    configure(false);
}

pub(in crate::realtime_voice) fn configure(enabled: bool) -> bool {
    let mut pool = POOL.lock();
    if enabled && pool.stop.is_some() {
        return true;
    }
    if let Some(stop) = pool.stop.take() {
        stop.send_replace(true);
    }
    pool.spare.take();
    let revision = REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    if !enabled {
        return true;
    }
    let Ok(runtime) = crate::runtime() else {
        return false;
    };
    let (stop, stopped) = watch::channel(false);
    pool.stop = Some(stop);
    drop(pool);
    runtime.spawn(maintain(revision, stopped));
    true
}

async fn maintain(revision: u64, mut stop: watch::Receiver<bool>) {
    // The reusable HTTP client is initialized without sending a request.
    let _ = api::client();
    let provider = Arc::new(str0m::crypto::from_feature_flags());
    loop {
        if REVISION.load(Ordering::Acquire) != revision {
            return;
        }
        if let Some(certificate) = provider.dtls_provider.generate_certificate() {
            let mut pool = POOL.lock();
            if REVISION.load(Ordering::Acquire) != revision {
                return;
            }
            pool.spare = Some(Material {
                provider: provider.clone(),
                certificate,
            });
        }
        tokio::select! {
            biased;
            _ = stop.changed() => return,
            () = REFILL.notified() => {},
            () = tokio::time::sleep(REFRESH) => {},
        }
    }
}

pub(super) fn take() -> Option<Material> {
    let material = POOL.lock().spare.take()?;
    REFILL.notify_one();
    Some(material)
}

#[cfg(test)]
pub(super) async fn ready() -> Result<(), &'static str> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if POOL.lock().spare.is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| "Local crypto material was not prepared")
}

#[cfg(test)]
mod tests {
    use super::{POOL, configure, ready, take};
    use std::time::Duration;

    #[tokio::test]
    async fn local_material_is_replenished_and_disabled_without_network_or_credentials()
    -> Result<(), &'static str> {
        assert!(configure(true));
        ready().await?;
        let first = take().ok_or("Missing local crypto material")?;
        ready().await?;
        let second = take().ok_or("Missing replacement local material")?;
        drop(first);
        drop(second);
        assert!(configure(false));
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(POOL.lock().spare.is_none());
        assert!(take().is_none());
        Ok(())
    }
}
