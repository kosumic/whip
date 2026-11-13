//! Native execution is independent of the React executor and screen lifetime.
use super::{Action, Command, Job, Result, dispatch, invalid};
use crate::{HostConnectionState, get_host_runtime};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
};
type Binding = (Arc<crate::HostRuntime>, String);
#[derive(Default)]
struct Execution {
    stopped: bool,
    binding: Option<Binding>,
}
static ACTIVE: LazyLock<parking_lot::Mutex<HashMap<String, Execution>>> =
    LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));
static EXPIRATIONS: parking_lot::Mutex<Vec<(String, bool)>> = parking_lot::Mutex::new(Vec::new());
pub(super) fn pending_expirations() -> Vec<(String, bool)> {
    EXPIRATIONS.lock().clone()
}
pub(super) fn acknowledge_expirations(count: usize) {
    EXPIRATIONS.lock().drain(..count);
}
fn cancel_execution(execution_id: &str) {
    let binding = {
        let mut executions = ACTIVE.lock();
        let execution = executions.entry(execution_id.into()).or_default();
        execution.stopped = true;
        let binding = execution.binding.clone();
        drop(executions);
        binding
    };
    if let Some((host, transfer)) = binding {
        host.cancel_download_execution(&transfer);
    }
}
fn bind_execution(execution_id: String, host: Arc<crate::HostRuntime>, transfer: &str) {
    let stopped = {
        let mut executions = ACTIVE.lock();
        let execution = executions.entry(execution_id).or_default();
        execution.binding = Some((host.clone(), transfer.into()));
        let stopped = execution.stopped;
        drop(executions);
        stopped
    };
    // An expiry can precede registration and its database flush. Preserve the
    // stop fence until teardown so admission cannot start unbounded native I/O.
    if stopped {
        host.cancel_download_execution(transfer);
    }
}

pub(super) async fn validate_external(command: &mut Command) -> Result<()> {
    match command {
        Command::Start {
            host_id,
            incarnation,
            ..
        } => {
            *incarnation = connected(host_id)?;
        }
        Command::Retry {
            id, incarnation, ..
        } => {
            let id = id.clone();
            let host = super::database()?
                .request(move |store| {
                    let manager = store
                        .downloads
                        .as_ref()
                        .ok_or_else(|| invalid("Initialize Downloads first"))?;
                    manager
                        .ledger
                        .jobs
                        .iter()
                        .find(|job| job.id == id)
                        .map(|job| job.host_id.clone())
                        .ok_or_else(|| invalid("Unknown download"))
                })
                .await?;
            *incarnation = connected(&host)?;
        }
        Command::Bound { .. } | Command::Progress { .. } | Command::Finished { .. } => {
            return Err(invalid("Native-only download event"));
        }
        _ => {}
    }
    Ok(())
}
fn connected(host: &str) -> Result<u64> {
    let runtime = get_host_runtime(host.into())
        .ok_or_else(|| invalid("Reconnect the original host before retrying this download"))?;
    if runtime.status().state != HostConnectionState::Connected {
        return Err(invalid(
            "Reconnect the original host before retrying this download",
        ));
    }
    Ok(runtime.runtime_incarnation())
}
pub(super) fn execute(action: Action) {
    let Ok(runtime) = crate::runtime() else {
        return;
    };
    match action {
        Action::Start(job) => {
            runtime.spawn(transfer(*job));
        }
        Action::Cancel(execution_id) => cancel_execution(&execution_id),
        Action::Cleanup(path) => {
            runtime.spawn(async move {
                let _ = tokio::fs::remove_dir_all(path).await;
            });
        }
        Action::ReleaseExecution(id) => {
            let released = ACTIVE.lock().remove(&id);
            drop(released);
        }
    }
}
async fn deliver(command: Command) -> super::Response {
    // A committed transfer cannot lose its terminal event when storage is
    // temporarily unavailable. Keep it pending in native memory and back off.
    loop {
        match dispatch(command.clone()).await {
            Ok(response) => return response,
            Err(error) => {
                crate::host_runtime::record_transcript_cache_failure(&format!(
                    "Downloads checkpoint: {error}"
                ));
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
}
async fn transfer(job: Job) {
    let generation = job.operation.generation;
    let id = job.id.clone();
    let result = async {
        let host = get_host_runtime(job.host_id.clone()).ok_or("The original host is no longer available".to_string())?;
        if host.runtime_incarnation() != job.operation.incarnation { return Err("Host connection was replaced; retry from the original host".into()); }
        let staging = job.operation.staging.as_ref().ok_or("Download staging path is missing".to_string())?;
        tokio::fs::create_dir_all(staging).await.map_err(|error| error.to_string())?;
        let execution = job.operation.execution_id.clone();
        let admitted_host = host.clone();
        let transfer_id = host.start_native_download(job.remote_path.clone(), staging.clone(), Box::new(move |transfer| {
            bind_execution(execution, admitted_host, transfer);
        })).map_err(|error| error.to_string())?;
        let bound = deliver(Command::Bound { id: id.clone(), generation, transfer_id: transfer_id.clone() }).await;
        if !bound.accepted { host.cancel_download_execution(&transfer_id); }
        let result = host.await_transfer(transfer_id.clone());
        tokio::pin!(result);
        let mut clock = tokio::time::interval(std::time::Duration::from_millis(250));
        loop {
            tokio::select! {
                result = &mut result => break result.map(|result| result.local_path).map_err(|error| error.to_string()),
                _ = clock.tick() => {
                    if let Some(progress) = host.transfer_progress(transfer_id.clone()) {
                        let _ = dispatch(Command::Progress { id: id.clone(), generation, bytes: progress.bytes_transferred, total: progress.total_bytes,
                            speed: progress.bytes_per_second, remaining: progress.remaining_seconds, calculating: progress.rate_calculating }).await;
                    }
                }
            }
        }
    }.await;
    let released = ACTIVE
        .lock()
        .get_mut(&job.operation.execution_id)
        .and_then(|execution| execution.binding.take());
    drop(released);
    let (source, error) = match result {
        Ok(Some(source)) => (Some(source), None),
        Ok(None) => (
            None,
            Some("Native download returned no staging path".into()),
        ),
        Err(error) => (None, Some(error)),
    };
    deliver(Command::Finished {
        id,
        generation,
        source,
        error,
    })
    .await;
}

/// Called by OS adapters before any JS notification, including expiry between
/// foreground execution admission and binding the SFTP transfer.
pub(crate) fn execution_expired(execution_id: String, cancelled: bool) {
    // Record synchronously so an acknowledgement already queued on the database
    // worker observes cancellation even before our async flush gets scheduled.
    EXPIRATIONS.lock().push((execution_id.clone(), cancelled));
    // OS deadlines cannot wait for either JS or a database checkpoint. The
    // pinned runtime fences replacement hosts sharing the same logical ID.
    cancel_execution(&execution_id);
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            deliver(Command::Snapshot).await;
        });
    }
}

/// # Safety
/// The platform supplies a live NUL-terminated execution ID.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_download_execution_expired(
    execution_id: *const std::ffi::c_char,
    cancelled: bool,
) {
    if execution_id.is_null() {
        return;
    }
    // SAFETY: The caller retains the string through this call.
    if let Ok(id) = unsafe { std::ffi::CStr::from_ptr(execution_id) }.to_str() {
        execution_expired(id.into(), cancelled);
    }
}
