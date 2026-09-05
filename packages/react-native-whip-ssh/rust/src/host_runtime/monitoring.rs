//! Foreground-aware health, latency, and reconciliation policy.

use super::*;
use std::time::Instant;

const MONITOR_TICK: Duration = Duration::from_secs(1);
const HEALTH_INTERVAL: Duration = Duration::from_secs(15);
const RECONCILE_INTERVAL: Duration = Duration::from_secs(120);
const VISIBLE_LATENCY_INTERVAL: Duration = Duration::from_secs(3);
const RECOVERY_FAILURE_THRESHOLD: u32 = 3;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, uniffi::Enum)]
pub enum BackgroundMonitoringMode {
    #[default]
    Continuous,
    PowerSaving,
    Off,
}

#[derive(Debug)]
pub(super) struct MonitoringState {
    pub(super) app_active: bool,
    pub(super) hosts_visible: bool,
    pub(super) access_locked: bool,
    pub(super) background_mode: BackgroundMonitoringMode,
    pub(super) network_available: bool,
    pub(super) recovery_revision: u64,
    network_revision: u32,
    worker_running: bool,
    latency_failures: u32,
}

impl Default for MonitoringState {
    fn default() -> Self {
        Self {
            app_active: false,
            hosts_visible: false,
            access_locked: false,
            background_mode: BackgroundMonitoringMode::Continuous,
            network_available: true,
            recovery_revision: 0,
            network_revision: 0,
            worker_running: false,
            latency_failures: 0,
        }
    }
}

pub(super) fn set_monitoring_policy(
    inner: &Arc<RuntimeInner>,
    mode: BackgroundMonitoringMode,
    network_available: bool,
    network_revision: u32,
) {
    let mut state = inner.monitoring.lock();
    if state.background_mode == mode
        && state.network_available == network_available
        && state.network_revision == network_revision
    {
        return;
    }
    if (network_available
        && (!state.network_available || state.network_revision != network_revision))
        || state.background_mode != mode
    {
        state.recovery_revision = state.recovery_revision.saturating_add(1);
    }
    state.background_mode = mode;
    state.network_available = network_available;
    state.network_revision = network_revision;
    drop(state);
    inner.reconnect_wakeup.notify_one();
    inner.monitoring_changed.notify_waiters();
}

pub(super) fn set_monitoring_state(
    inner: &Arc<RuntimeInner>,
    app_active: bool,
    hosts_visible: bool,
    access_locked: bool,
) {
    let (start_worker, became_active) = {
        let mut monitoring = inner.monitoring.lock();
        let became_active = app_active && !monitoring.app_active;
        if became_active {
            monitoring.recovery_revision = monitoring.recovery_revision.saturating_add(1);
        }
        monitoring.app_active = app_active;
        monitoring.hosts_visible = hosts_visible;
        monitoring.access_locked = access_locked;
        let start_worker = if monitoring.worker_running {
            false
        } else {
            monitoring.worker_running = true;
            true
        };
        drop(monitoring);
        (start_worker, became_active)
    };
    let transcript_active =
        app_active && !access_locked && inner.monitoring.lock().network_available;
    inner.agents.set_foreground(transcript_active);
    inner.monitoring_changed.notify_waiters();
    if became_active {
        inner.reconnect_wakeup.notify_one();
    }
    if !start_worker {
        return;
    }
    let weak = Arc::downgrade(inner);
    let changed = inner.monitoring_changed.clone();
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            let now = Instant::now();
            let mut last_health = now.checked_sub(HEALTH_INTERVAL).unwrap_or(now);
            let mut last_reconcile = now.checked_sub(RECONCILE_INTERVAL).unwrap_or(now);
            let mut last_visible_latency = now.checked_sub(VISIBLE_LATENCY_INTERVAL).unwrap_or(now);
            loop {
                // Register before reading state so a foreground transition
                // cannot be lost between the check and the background wait.
                let notified = changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let active = {
                    let state = inner.monitoring.lock();
                    state.app_active && state.network_available
                };
                drop(inner);
                if !active {
                    notified.await;
                    continue;
                }
                tokio::select! {
                    () = tokio::time::sleep(MONITOR_TICK) => {}
                    () = notified => {}
                }
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let (active, visible) = {
                    let monitoring = inner.monitoring.lock();
                    (
                        monitoring.app_active && monitoring.network_available,
                        monitoring.hosts_visible && !monitoring.access_locked,
                    )
                };
                if !active {
                    continue;
                }
                let health_due = last_health.elapsed() >= HEALTH_INTERVAL;
                let visible_latency_due =
                    visible && last_visible_latency.elapsed() >= VISIBLE_LATENCY_INTERVAL;
                if visible_latency_due || health_due {
                    if visible_latency_due {
                        last_visible_latency = Instant::now();
                    }
                    if health_due {
                        last_health = Instant::now();
                    }
                    if foreground_work(&inner, probe(inner.clone()))
                        .await
                        .is_none()
                    {
                        continue;
                    }
                }
                if !monitoring_active(&inner) {
                    continue;
                }
                let reconcile_due = last_reconcile.elapsed() >= RECONCILE_INTERVAL;
                let needs_reconcile = {
                    let state = inner.state.lock();
                    state.connection == HostConnectionState::Connected
                        && (reconcile_due
                            || (health_due
                                && (state.host_state.projection().needs_resync
                                    || state.host_state.projection().freshness
                                        != crate::host_state::HostFreshness::Fresh)))
                };
                if needs_reconcile {
                    if reconcile_due {
                        last_reconcile = Instant::now();
                    }
                    let _ = refresh_host_state_inner(inner).await;
                }
            }
        });
    } else {
        inner.monitoring.lock().worker_running = false;
    }
}

fn monitoring_active(inner: &RuntimeInner) -> bool {
    let state = inner.monitoring.lock();
    state.app_active && state.network_available
}

/// Poll neither a new health request nor an in-flight probe after backgrounding.
async fn foreground_work<T>(
    inner: &RuntimeInner,
    work: impl std::future::Future<Output = T>,
) -> Option<T> {
    tokio::pin!(work);
    loop {
        let changed = inner.monitoring_changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if !monitoring_active(inner) {
            return None;
        }
        tokio::select! {
            biased;
            () = changed => {}
            result = &mut work => return Some(result),
        }
    }
}

async fn probe(inner: Arc<RuntimeInner>) {
    if inner.state.lock().connection != HostConnectionState::Connected {
        return;
    }
    match measure_host_latency_inner(inner.clone()).await {
        Ok(measurement) => {
            inner.monitoring.lock().latency_failures = 0;
            emit(HostRuntimeEvent::LatencyMeasured {
                runtime_id: inner.id.clone(),
                measurement,
            });
        }
        Err(error) => {
            let failures = {
                let mut monitoring = inner.monitoring.lock();
                monitoring.latency_failures = monitoring.latency_failures.saturating_add(1);
                monitoring.latency_failures
            };
            if failures >= RECOVERY_FAILURE_THRESHOLD {
                inner.monitoring.lock().latency_failures = 0;
                begin_reconnect(
                    inner,
                    format!("host health check failed {failures} times: {error}"),
                    true,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitoring_defaults_to_background_without_polling() {
        let state = MonitoringState::default();
        assert!(!state.app_active);
        assert!(!state.hosts_visible);
        assert_eq!(state.latency_failures, 0);
    }

    #[test]
    fn background_health_work_is_not_polled_and_inflight_probe_is_cancelled() {
        crate::runtime().unwrap().block_on(async {
            let inner = super::super::tests::connected_runtime_inner("background-health-test");
            let polled = std::sync::atomic::AtomicBool::new(false);
            assert_eq!(
                foreground_work(&inner, async {
                    polled.store(true, Ordering::Relaxed);
                })
                .await,
                None
            );
            assert!(!polled.load(Ordering::Relaxed));
            inner.monitoring.lock().app_active = true;
            let waiter_inner = inner.clone();
            let (started, ready) = tokio::sync::oneshot::channel();
            let waiter = tokio::spawn(async move {
                foreground_work(&waiter_inner, async {
                    let _ = started.send(());
                    std::future::pending::<()>().await;
                })
                .await
            });
            ready.await.unwrap();
            inner.monitoring.lock().app_active = false;
            inner.monitoring_changed.notify_waiters();
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), waiter)
                    .await
                    .unwrap()
                    .unwrap(),
                None,
            );
        });
    }
}
