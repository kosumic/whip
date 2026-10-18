//! Per-host probe-only SSH transport, separate from application traffic.

use super::*;

pub(super) struct LatencyTransport {
    generation: u64,
    ssh: Arc<SshSession>,
    jumps: Vec<Arc<SshSession>>,
}

impl Drop for LatencyTransport {
    fn drop(&mut self) {
        let mut sessions = std::mem::take(&mut self.jumps);
        sessions.push(self.ssh.clone());
        if let Ok(runtime) = crate::runtime() {
            runtime.spawn(disconnect_sessions(sessions));
        }
    }
}

pub(super) async fn clear_latency_transport(inner: &RuntimeInner) {
    inner.latency_transport.lock().await.take();
}

async fn isolated_ssh(inner: &RuntimeInner) -> Result<Arc<SshSession>, HostRuntimeError> {
    let mut cancellation = inner.cancellation.subscribe();
    let mut cached = inner.latency_transport.lock().await;
    let (epoch, generation) = {
        let state = inner.state.lock();
        if state.connection != HostConnectionState::Connected {
            return Err(HostRuntimeError::SshTransportFailure(
                "host is not connected".into(),
            ));
        }
        (state.epoch, state.generation)
    };
    if let Some(transport) = cached.as_ref()
        && transport.generation == generation
        && transport.ssh.is_alive()
        && transport.jumps.iter().all(|jump| jump.is_alive())
    {
        return Ok(transport.ssh.clone());
    }
    *cached = None;
    if *cancellation.borrow_and_update() != epoch {
        return Err(HostRuntimeError::StaleOperation(
            "isolated latency lifecycle changed".into(),
        ));
    }
    // Build a fresh chain even for jump hosts: reusing an application's jump
    // transport would retain the same ordered-stream queue at that hop.
    let Some(result) = connect_chain_until_cancelled(inner, &mut cancellation).await else {
        return Err(HostRuntimeError::StaleOperation(
            "isolated latency connection was cancelled".into(),
        ));
    };
    let (ssh, jumps) = result?;
    let transport = LatencyTransport {
        generation,
        ssh: ssh.clone(),
        jumps,
    };
    let current = {
        let state = inner.state.lock();
        state.epoch == epoch
            && state.generation == generation
            && state.connection == HostConnectionState::Connected
    };
    if !current {
        return Err(HostRuntimeError::StaleOperation(
            "isolated latency connection was replaced".into(),
        ));
    }
    log_lifecycle(format_args!(
        "isolated latency transport connected: {} generation={generation}",
        inner.id
    ));
    *cached = Some(transport);
    drop(cached);
    Ok(ssh)
}

pub(super) async fn measure_host_latency_inner(
    inner: Arc<RuntimeInner>,
) -> Result<HostLatencyMeasurement, HostRuntimeError> {
    let ssh = isolated_ssh(&inner).await;
    let probed = ssh.as_ref().ok().cloned();
    let result = measure_latency_on(
        inner.clone(),
        ssh,
        RuntimeDiagnosticOperation::HostLatencyProbe,
    )
    .await;
    if result.is_err()
        && let Some(probed) = probed
    {
        let mut cached = inner.latency_transport.lock().await;
        if cached
            .as_ref()
            .is_some_and(|transport| Arc::ptr_eq(&transport.ssh, &probed))
        {
            *cached = None;
        }
    }
    result
}

pub(super) async fn measure_application_latency_inner(inner: Arc<RuntimeInner>) {
    let ssh = current_ssh(&inner);
    let _ = measure_latency_on(
        inner,
        ssh,
        RuntimeDiagnosticOperation::ApplicationLatencyProbe,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_latency_uses_the_probe_connection_even_when_application_transport_is_dead() {
        let _sink_lock = super::super::tests::EVENT_SINK_TEST_LOCK.lock();
        crate::runtime().unwrap().block_on(async {
            let (inner, _) = super::super::tests::agent_view_test_core();
            let application = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO)
                .await
                .unwrap();
            let isolated = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO)
                .await
                .unwrap();
            let generation = inner.state.lock().generation;
            inner.herdr.install(generation, application.shared_ssh());
            application.ssh.disconnect().await;
            assert!(!application.ssh.is_alive());
            let probe = isolated.shared_ssh();
            *inner.latency_transport.lock().await = Some(LatencyTransport {
                generation,
                ssh: probe.clone(),
                jumps: Vec::new(),
            });
            let measurement = measure_host_latency_inner(inner.clone()).await.unwrap();
            assert!(measurement.ssh_rtt_ms.is_finite());
            assert!(Arc::ptr_eq(&isolated_ssh(&inner).await.unwrap(), &probe));
            // A failed shared-transport diagnostic must not tear down the probe
            // or alter recovery/status. Only the isolated probe owns health.
            let before = inner.state.lock().status();
            measure_application_latency_inner(inner.clone()).await;
            assert_eq!(inner.state.lock().status(), before);
            assert!(probe.is_alive());
            clear_latency_transport(&inner).await;
            assert!(inner.latency_transport.lock().await.is_none());
        });
    }

    #[test]
    fn replacing_the_host_generation_retires_the_old_probe() {
        crate::runtime().unwrap().block_on(async {
            let (inner, _) = super::super::tests::agent_view_test_core();
            let isolated = crate::ssh::ReverseForwardFixture::new(true, Duration::ZERO)
                .await
                .unwrap();
            let generation = inner.state.lock().generation;
            let probe = isolated.shared_ssh();
            *inner.latency_transport.lock().await = Some(LatencyTransport {
                generation,
                ssh: probe.clone(),
                jumps: Vec::new(),
            });
            inner.state.lock().generation += 1;
            // Cancel the fresh connection attempt; the old one cannot be reused.
            inner.cancellation.send_replace(u64::MAX);
            assert!(isolated_ssh(&inner).await.is_err());
            assert!(inner.latency_transport.lock().await.is_none());
            tokio::time::timeout(Duration::from_secs(1), async {
                while probe.is_alive() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        });
    }
}
