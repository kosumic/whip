//! Runtime diagnostics and latency observability.

use super::*;
use crate::host_state::now_ms;
use std::time::Instant;

const MAX_DIAGNOSTIC_BYTES: u64 = 128 * 1024;
const MAX_DIAGNOSTIC_CHARACTERS: usize = 1024;
static DIAGNOSTIC_LOG: OnceLock<Mutex<Option<DiagnosticLog>>> = OnceLock::new();

struct DiagnosticLog {
    path: std::path::PathBuf,
}

impl DiagnosticLog {
    fn append(&self, message: &str) -> std::io::Result<()> {
        use std::io::Write;
        let message: String = message
            .chars()
            .take(MAX_DIAGNOSTIC_CHARACTERS)
            .map(|ch| if ch.is_control() { ' ' } else { ch })
            .collect();
        let line = format!("{} {message}\n", now_ms());
        if std::fs::metadata(&self.path)
            .is_ok_and(|metadata| metadata.len() + line.len() as u64 > MAX_DIAGNOSTIC_BYTES)
        {
            std::fs::rename(&self.path, self.path.with_extension("previous.log"))?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(line.as_bytes())
    }
}

#[cfg(test)]
mod diagnostic_log_tests {
    use super::*;

    #[test]
    fn reconnect_log_survives_reopening_and_rotates_with_bounded_records() -> std::io::Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("whip-runtime.log");
        DiagnosticLog { path: path.clone() }
            .append("SSH reconnect: runtime=test generation=1 reason=probe timeout")?;
        let reopened = DiagnosticLog { path: path.clone() };
        assert!(std::fs::read_to_string(&path)?.contains("reason=probe timeout"));
        let oversized = format!(
            "{}\nforged log entry",
            "x".repeat(MAX_DIAGNOSTIC_CHARACTERS * 2)
        );
        for _ in 0..150 {
            reopened.append(&oversized)?;
        }
        reopened.append("new\nreason")?;
        for file in [&path, &path.with_extension("previous.log")] {
            assert!(std::fs::metadata(file)?.len() <= MAX_DIAGNOSTIC_BYTES);
        }
        assert!(std::fs::read_to_string(&path)?.ends_with("new reason\n"));
        Ok(())
    }
}

/// Configure a bounded, private diagnostic file independently of React events.
///
/// # Safety
/// `path` must point to a live NUL-terminated UTF-8 path for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_set_runtime_diagnostic_path(path: *const std::ffi::c_char) {
    if path.is_null() {
        return;
    }
    // SAFETY: The native caller keeps its JNI UTF-8 string alive until return.
    let path = unsafe { std::ffi::CStr::from_ptr(path) };
    if let Ok(path) = path.to_str() {
        *DIAGNOSTIC_LOG.get_or_init(|| Mutex::new(None)).lock() =
            Some(DiagnosticLog { path: path.into() });
    }
}

/// Lifecycle diagnostics remain available when no React event sink is attached.
pub(super) fn log_lifecycle(message: std::fmt::Arguments<'_>) {
    let message = message.to_string();
    if let Some(log) = DIAGNOSTIC_LOG.get()
        && let Some(log) = log.lock().as_ref()
    {
        let _ = log.append(&message);
    }
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
        if let Ok(message) = CString::new(message) {
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
