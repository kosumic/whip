//! Runtime diagnostics and latency observability.

use super::*;
use std::time::Instant;

/// Lifecycle diagnostics remain available when no React event sink is attached.
pub(super) fn log_lifecycle(message: std::fmt::Arguments<'_>) {
    #[cfg(target_os = "android")]
    {
        use std::ffi::{CString, c_char, c_int};
        #[link(name = "log")]
        unsafe extern "C" {
            fn __android_log_write(
                priority: c_int,
                tag: *const c_char,
                text: *const c_char,
            ) -> c_int;
        }
        const ANDROID_LOG_INFO: c_int = 4;
        if let Ok(message) = CString::new(message.to_string()) {
            // SAFETY: Both pointers reference live NUL-terminated strings;
            // Android's synchronous logger does not retain them.
            unsafe {
                __android_log_write(
                    ANDROID_LOG_INFO,
                    c"WhipHostRuntime".as_ptr(),
                    message.as_ptr(),
                );
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    eprintln!("[WhipSsh] {message}");
}

pub(super) fn elapsed_ms(started_at: Instant) -> f64 {
    started_at.elapsed().as_secs_f64() * 1_000.0
}

pub(super) fn emit_diagnostic(
    inner: &RuntimeInner,
    operation: RuntimeDiagnosticOperation,
    started_at: Instant,
    transport_duration_ms: Option<f64>,
    terminal_id: Option<String>,
    error: Option<String>,
) {
    let event = HostRuntimeEvent::Diagnostic {
        runtime_id: inner.id.clone(),
        diagnostic: RuntimeDiagnostic {
            operation,
            duration_ms: elapsed_ms(started_at),
            transport_duration_ms,
            outcome: if error.is_some() {
                RuntimeDiagnosticOutcome::Failed
            } else {
                RuntimeDiagnosticOutcome::Succeeded
            },
            terminal_id,
            error,
        },
    };
    // Diagnostics are best-effort observability. A faulty foreign listener
    // must not turn a completed transport operation into a runtime failure.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emit(event)));
}

pub(super) fn emit_diagnostic_started(
    inner: &RuntimeInner,
    operation: RuntimeDiagnosticOperation,
    terminal_id: Option<String>,
) {
    let event = HostRuntimeEvent::Diagnostic {
        runtime_id: inner.id.clone(),
        diagnostic: RuntimeDiagnostic {
            operation,
            duration_ms: 0.0,
            transport_duration_ms: None,
            outcome: RuntimeDiagnosticOutcome::Started,
            terminal_id,
            error: None,
        },
    };
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emit(event)));
}

pub(super) fn emit_slow_or_failed_diagnostic(
    inner: &RuntimeInner,
    operation: RuntimeDiagnosticOperation,
    started_at: Instant,
    error: Option<String>,
) {
    if error.is_some() || elapsed_ms(started_at) >= SLOW_RUNTIME_DIAGNOSTIC_MS {
        emit_diagnostic(inner, operation, started_at, None, None, error);
    }
}
#[uniffi::export]
impl HostRuntime {
    pub async fn measure_host_latency(&self) -> Result<HostLatencyMeasurement, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(measure_host_latency_inner(inner))
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("SSH latency task failed: {error}"))
            })?
    }
}

pub(super) async fn measure_host_latency_inner(
    inner: Arc<RuntimeInner>,
) -> Result<HostLatencyMeasurement, HostRuntimeError> {
    let started_at = Instant::now();
    let result = match current_ssh(&inner) {
        Ok(ssh) => ssh.latency_ms().await.map_err(HostRuntimeError::from),
        Err(error) => Err(error),
    };
    match result {
        Ok(ssh_rtt_ms) => {
            let total_ms = elapsed_ms(started_at);
            if total_ms >= SLOW_RUNTIME_DIAGNOSTIC_MS {
                emit_diagnostic(
                    &inner,
                    RuntimeDiagnosticOperation::HostLatencyProbe,
                    started_at,
                    Some(ssh_rtt_ms),
                    None,
                    None,
                );
            }
            Ok(HostLatencyMeasurement {
                ssh_rtt_ms,
                total_ms,
                runtime_overhead_ms: (total_ms - ssh_rtt_ms).max(0.0),
            })
        }
        Err(error) => {
            emit_diagnostic(
                &inner,
                RuntimeDiagnosticOperation::HostLatencyProbe,
                started_at,
                None,
                None,
                Some(error.to_string()),
            );
            Err(error)
        }
    }
}
