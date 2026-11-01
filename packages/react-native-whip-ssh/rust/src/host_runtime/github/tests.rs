use super::*;
use crate::host_runtime::tests::connected_runtime_inner;
use crate::ssh::ReverseForwardFixture;
use std::collections::BTreeMap;
use std::sync::Arc;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn github_reads_recover_channel_refusal_with_concurrent_reads_sftp_and_live_terminal() -> TestResult
{
    crate::runtime()?.block_on(async {
        let fixture =
            ReverseForwardFixture::with_commands(true, Duration::ZERO, Some(BTreeMap::new()))
                .await?;
        let inner = connected_runtime_inner("github-channel-recovery");
        inner.herdr.install(1, fixture.ssh.clone());
        let runtime = HostRuntime { inner };
        let (data, mut received) = tokio::sync::mpsc::unbounded_channel();
        fixture
            .ssh
            .open_exec(
                "terminal",
                "cat",
                Arc::new(move |bytes| {
                    let _ = data.send(bytes);
                }),
                Arc::new(|_| {}),
            )
            .await?;
        fixture.ssh.sftp_stat("/").await?;
        fixture.reject_session_channels(1);
        let (details, page) = tokio::join!(
            runtime.github_read_command(1, "test", "printf '{}'".into()),
            runtime.github_read_command(1, "test", "printf '[]'".into()),
        );
        assert_eq!(details?, b"{}");
        assert_eq!(page?, b"[]");
        assert_eq!(fixture.session_attempts(), 5); // terminal + SFTP + two reads + retry
        assert!(fixture.ssh.is_alive());
        fixture
            .ssh
            .write_exec("terminal", b"still usable\n".to_vec())?;
        let bytes = tokio::time::timeout(Duration::from_secs(3), received.recv())
            .await?
            .ok_or("terminal closed")?;
        assert_eq!(bytes, b"still usable\n");
        assert_eq!(runtime.status().generation, 1);
        fixture.ssh.close_exec("terminal")?;
        Ok(())
    })
}

#[test]
fn github_read_refusals_are_bounded_and_preserve_the_ssh_failure() -> TestResult {
    crate::runtime()?.block_on(async {
        let fixture = ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let inner = connected_runtime_inner("github-persistent-refusal");
        inner.herdr.install(1, fixture.ssh.clone());
        fixture.reject_session_channels(10);
        let runtime = HostRuntime { inner };
        let error = runtime.github_read_command(1, "test", "unused".into()).await.unwrap_err();
        assert!(matches!(error, HostRuntimeError::SshConnectionFailure { code: SshErrorCode::ChannelUnavailable, message } if !message.is_empty()));
        assert_eq!(fixture.session_attempts(), GITHUB_READ_ATTEMPTS as usize);
        assert!(fixture.ssh.is_alive());
        Ok(())
    })
}

#[test]
fn github_read_retry_cannot_cross_a_reconnect_generation() -> TestResult {
    crate::runtime()?.block_on(async {
        let fixture = ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let replacement = ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let inner = connected_runtime_inner("github-stale-read");
        inner.herdr.install(1, fixture.ssh.clone());
        fixture.reject_session_channels(10);
        let runtime = HostRuntime {
            inner: inner.clone(),
        };
        let reading = tokio::spawn(async move {
            runtime
                .github_read_command(1, "test", "unused".into())
                .await
        });
        fixture.wait_for_session_attempts(1).await;
        inner.state.lock().generation = 2;
        inner.herdr.install(2, replacement.ssh.clone());
        assert!(matches!(
            reading.await?,
            Err(HostRuntimeError::StaleOperation(_))
        ));
        assert_eq!(fixture.session_attempts(), 1);
        assert_eq!(replacement.session_attempts(), 0);
        Ok(())
    })
}

#[test]
fn github_disconnected_transport_is_not_retried() -> TestResult {
    crate::runtime()?.block_on(async {
        let fixture = ReverseForwardFixture::new(true, Duration::ZERO).await?;
        let inner = connected_runtime_inner("github-disconnected");
        inner.herdr.install(1, fixture.ssh.clone());
        fixture.ssh.disconnect().await;
        let error = execute_github_read(&inner, 1, "test", "unused")
            .await
            .err()
            .ok_or("expected a disconnected transport failure")?;
        assert!(matches!(error, HostRuntimeError::RuntimeDisconnected(_)));
        assert_eq!(fixture.session_attempts(), 0);
        Ok(())
    })
}

#[test]
fn github_cli_failures_and_unconfirmed_writes_are_not_replayed() -> TestResult {
    crate::runtime()?.block_on(async {
        let fixture = ReverseForwardFixture::with_commands(true, Duration::ZERO, Some(BTreeMap::new())).await?;
        let inner = connected_runtime_inner("github-single-attempt");
        inner.herdr.install(1, fixture.ssh.clone());
        let runtime = HostRuntime { inner };
        let error = runtime.github_read_command(1, "test", "printf 'gh auth login required' >&2; exit 1".into()).await.unwrap_err();
        assert!(matches!(error, HostRuntimeError::GitFailure(message) if message.contains("gh auth login required")));
        assert_eq!(fixture.session_attempts(), 1);

        fixture.reject_session_channels(1);
        assert!(runtime.github_write("unused".into(), Vec::new()).await.is_err());
        assert_eq!(fixture.session_attempts(), 2);

        let directory = tempfile::tempdir()?;
        let acknowledgement = directory.path().join("writes");
        let command = format!("printf x >> {}; exit 1", crate::remote_ops::shell_quote(&acknowledgement.to_string_lossy()));
        assert!(runtime.github_write(command, Vec::new()).await.is_err());
        assert_eq!(std::fs::read(acknowledgement)?, b"x");
        assert_eq!(fixture.session_attempts(), 3);
        Ok(())
    })
}
