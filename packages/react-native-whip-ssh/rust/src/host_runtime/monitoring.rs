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

#[derive(Debug, Default)]
pub(super) struct MonitoringState {
    pub(super) app_active: bool,
    pub(super) background_monitoring_active: bool,
    pub(super) hosts_visible: bool,
    pub(super) access_locked: bool,
    worker_running: bool,
    latency_failures: u32,
}

impl MonitoringState {
    pub(super) fn health_enabled(&self) -> bool {
        self.app_active || self.background_monitoring_active
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
        inner.monitoring_changed.notify_one();
        if active {
            inner.reconnect_wakeup.notify_one();
        }
    }
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
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                if inner.state.lock().explicit_disconnect {
                    return;
                }
                let active = inner.monitoring.lock().health_enabled();
                drop(inner);
                if !active {
                    changed.notified().await;
                    continue;
                }
                tokio::select! {
                    () = tokio::time::sleep(MONITOR_TICK) => {}
                    () = changed.notified() => {}
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
                    probe(inner.clone()).await;
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
