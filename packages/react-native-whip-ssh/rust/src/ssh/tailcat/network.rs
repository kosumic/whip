//! Process-owned native signals. UI runtimes do not own transport recovery.
use std::{sync::OnceLock, time::Duration};

use parking_lot::Mutex;

use crate::host_runtime::diagnostics::log_lifecycle;

const COALESCE_WINDOW: Duration = Duration::from_millis(500);

#[derive(Default)]
struct Signals {
    pending: bool,
    running: bool,
}

impl Signals {
    fn signal(&mut self) -> bool {
        self.pending = true;
        if self.running {
            false
        } else {
            self.running = true;
            true
        }
    }

    fn next_batch(&mut self) -> bool {
        if std::mem::take(&mut self.pending) {
            true
        } else {
            self.running = false;
            false
        }
    }
}

static SIGNALS: OnceLock<Mutex<Signals>> = OnceLock::new();

/// Called by Android ConnectivityManager and iOS Network.framework, also on
/// native foreground resume. No identity, address, or route metadata crosses FFI.
#[unsafe(no_mangle)]
pub extern "C" fn whip_tailcat_network_changed() {
    let Some(clients) = super::CLIENTS.get() else {
        return;
    };
    let Ok(runtime) = crate::runtime() else {
        return;
    };
    let signals = SIGNALS.get_or_init(Mutex::default);
    if !signals.lock().signal() {
        return;
    }
    log_lifecycle(format_args!("Tailcat network change: refresh scheduled"));
    runtime.spawn(async move {
        loop {
            tokio::time::sleep(COALESCE_WINDOW).await;
            if !signals.lock().next_batch() {
                break;
            }
            let report = clients.network_changed().await;
            log_lifecycle(format_args!(
                "Tailcat transport rebind: rebound={} failed={} direct_to_derp={} derp_reconnects={}",
                report.rebound_clients, report.failed_clients, report.direct_fallbacks, report.rebound_clients,
            ));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bursts_coalesce_and_events_during_rebind_get_a_followup() {
        let mut signals = Signals::default();
        assert!(signals.signal());
        for _ in 0..100 {
            assert!(!signals.signal());
        }
        assert!(signals.next_batch());
        // An event arriving while network I/O runs must not be lost.
        assert!(!signals.signal());
        assert!(!signals.signal());
        assert!(signals.next_batch());
        assert!(!signals.next_batch());
        assert!(signals.signal());
        assert!(signals.next_batch());
        assert!(!signals.next_batch());
    }
}
