//! Process-owned health monitoring; UI visibility only controls fast latency probes.

use super::*;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

static BACKGROUND_MONITORING_ACTIVE: AtomicBool = AtomicBool::new(false);

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
    pub(super) background_monitoring_active: bool,
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
            background_monitoring_active: false,
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

impl MonitoringState {
    pub(super) fn health_enabled(&self) -> bool {
        self.network_available
            && (self.app_active
                || (self.background_monitoring_active
                    && self.background_mode == BackgroundMonitoringMode::Continuous))
    }

    fn visible_latency_enabled(&self) -> bool {
        self.app_active && self.hosts_visible && !self.access_locked
    }
}

// Called by the Android service, independently of a React instance. This changes
// scheduling only: stopping the service never removes or disconnects a runtime.
#[unsafe(no_mangle)]
pub extern "C" fn whip_set_background_monitoring_active(active: bool) {
    let registered = runtimes().read();
    if BACKGROUND_MONITORING_ACTIVE.swap(active, Ordering::AcqRel) == active {
        return;
    }
    log_lifecycle(format_args!(
        "background health monitoring enabled={active}"
    ));
    for inner in registered.values() {
        inner.monitoring.lock().background_monitoring_active = active;
        inner.monitoring_changed.notify_waiters();
        inner.monitoring_changed.notify_one();
        if active {
            inner.reconnect_wakeup.notify_one();
        }
    }
}

// The foreground service outlives React. Its route observer must be able to
// release offline waits even after the JS network subscription has detached.
#[unsafe(no_mangle)]
pub extern "C" fn whip_set_monitoring_network_available(available: bool) {
    for inner in runtimes().read().values() {
        update_monitoring_network(inner, available);
    }
}

fn update_monitoring_network(inner: &RuntimeInner, available: bool) {
    let transcript_active = {
        let mut state = inner.monitoring.lock();
        state.network_available = available;
        if available {
            // An available-to-available callback also represents a route change.
            state.recovery_revision = state.recovery_revision.saturating_add(1);
        }
        state.app_active && !state.access_locked && available
    };
    inner.agents.set_foreground(transcript_active);
    inner.reconnect_wakeup.notify_one();
    inner.monitoring_changed.notify_waiters();
    inner.monitoring_changed.notify_one();
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
    inner.monitoring_changed.notify_one();
}

pub(super) fn set_monitoring_state(
    inner: &Arc<RuntimeInner>,
    app_active: bool,
    hosts_visible: bool,
    access_locked: bool,
) {
    let (start_worker, became_active) = {
        let mut monitoring = inner.monitoring.lock();
        monitoring.background_monitoring_active =
            BACKGROUND_MONITORING_ACTIVE.load(Ordering::Acquire);
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
    inner.monitoring_changed.notify_one();
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
                if inner.state.lock().explicit_disconnect {
                    return;
                }
                let active = inner.monitoring.lock().health_enabled();
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
                if inner.state.lock().explicit_disconnect {
                    return;
                }
                let (active, visible) = {
                    let monitoring = inner.monitoring.lock();
                    (
                        monitoring.health_enabled(),
                        monitoring.visible_latency_enabled(),
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
                            || (health_due && inner.reverse_control.needs_resume())
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
    state.health_enabled()
}

/// Cancel health work when offline or when background policy disables it.
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
    fn background_health_requires_continuous_mode_service_and_network() {
        for mode in [
            BackgroundMonitoringMode::Continuous,
            BackgroundMonitoringMode::PowerSaving,
            BackgroundMonitoringMode::Off,
        ] {
            for app_active in [false, true] {
                for background_monitoring_active in [false, true] {
                    for network_available in [false, true] {
                        let state = MonitoringState {
                            background_mode: mode,
                            app_active,
                            background_monitoring_active,
                            network_available,
                            ..MonitoringState::default()
                        };
                        assert_eq!(
                            state.health_enabled(),
                            network_available
                                && (app_active
                                    || (background_monitoring_active
                                        && mode == BackgroundMonitoringMode::Continuous))
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn service_route_updates_restore_offline_recovery_without_a_react_bridge() {
        let inner = super::super::tests::connected_runtime_inner("native-route-recovery");
        update_monitoring_network(&inner, false);
        assert!(!inner.monitoring.lock().network_available);
        let revision = inner.monitoring.lock().recovery_revision;
        update_monitoring_network(&inner, true);
        assert!(inner.monitoring.lock().network_available);
        assert_eq!(inner.monitoring.lock().recovery_revision, revision + 1);
        update_monitoring_network(&inner, true);
        assert_eq!(inner.monitoring.lock().recovery_revision, revision + 2);
        assert!(!inner.monitoring.lock().app_active);
        assert!(!inner.state.lock().explicit_disconnect);
    }

    #[test]
    fn selecting_power_saving_cancels_a_continuous_background_probe() {
        crate::runtime().unwrap().block_on(async {
            let inner = super::super::tests::connected_runtime_inner("power-saving-probe");
            inner.monitoring.lock().background_monitoring_active = true;
            let worker_inner = inner.clone();
            let (started, ready) = tokio::sync::oneshot::channel();
            let worker = tokio::spawn(async move {
                foreground_work(&worker_inner, async {
                    let _ = started.send(());
                    std::future::pending::<()>().await;
                })
                .await
            });
            ready.await.unwrap();
            set_monitoring_policy(&inner, BackgroundMonitoringMode::PowerSaving, true, 0);
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), worker)
                    .await
                    .unwrap()
                    .unwrap(),
                None
            );
        });
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
            inner.monitoring_changed.notify_one();
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), waiter)
                    .await
                    .unwrap()
                    .unwrap(),
                None,
            );
        });
    }

    #[test]
    fn health_and_visible_latency_have_independent_policies() {
        for app_active in [false, true] {
            for background_monitoring_active in [false, true] {
                for hosts_visible in [false, true] {
                    for access_locked in [false, true] {
                        let state = MonitoringState {
                            app_active,
                            background_monitoring_active,
                            hosts_visible,
                            access_locked,
                            ..MonitoringState::default()
                        };
                        assert_eq!(
                            state.health_enabled(),
                            app_active || background_monitoring_active
                        );
                        assert_eq!(
                            state.visible_latency_enabled(),
                            app_active && hosts_visible && !access_locked
                        );
                    }
                }
            }
        }
    }
}
