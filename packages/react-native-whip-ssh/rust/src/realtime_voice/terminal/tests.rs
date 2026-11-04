use super::*;
use crate::host_runtime::{
    realtime_terminal::{shell_fixture, shell_fixture_with_ssh},
    terminal_delivery_test_guard,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

async fn wait_for_output(session: &Session, id: &str) -> Result<(), tokio::time::error::Elapsed> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let arguments = json!({"job_id":id}).to_string();
        while session.execute("observe", READ, &arguments).await["stdout"] != "started" {
            tokio::task::yield_now().await;
        }
    })
    .await
}

#[test]
fn realtime_session_exposes_only_the_selected_scope_tools() -> TestResult {
    let mut config = json!({"voice":"cedar","vad":{"type":"server_vad","threshold":0.5,"prefix_padding_ms":300,"silence_duration_ms":500},
        "terminalTarget":{"runtimeId":"runtime","runtimeIncarnation":1,"connectionGeneration":1,"terminalId":"shell"}});
    let terminal: super::super::Config = serde_json::from_value(config.clone())?;
    let update = serde_json::to_value(terminal.session_update()?)?;
    let names: Vec<_> = update["session"]["tools"]
        .as_array()
        .ok_or("missing tools")?
        .iter()
        .map(|tool| tool["name"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        names,
        vec![EXEC, READ, INPUT, CANCEL, super::super::REMAIN_SILENT]
    );
    config["target"] = json!({"runtimeId":"runtime","terminalId":"terminal","paneId":"pane","bindingToken":"binding"});
    let mixed: super::super::Config = serde_json::from_value(config.clone())?;
    assert!(mixed.session_update().is_err());
    config
        .as_object_mut()
        .ok_or("invalid config")?
        .remove("terminalTarget");
    let agent: super::super::Config = serde_json::from_value(config)?;
    let update = serde_json::to_value(agent.session_update()?)?;
    let names: Vec<_> = update["session"]["tools"]
        .as_array()
        .ok_or("missing tools")?
        .iter()
        .map(|tool| tool["name"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        names,
        vec![super::super::BACKGROUND_AGENT, super::super::REMAIN_SILENT]
    );
    Ok(())
}

#[test]
fn jobs_return_immediately_stream_real_output_and_report_completion_once() -> TestResult {
    let _guard = terminal_delivery_test_guard();
    crate::runtime()?.block_on(async {
        let fixture = crate::ssh::ReverseForwardFixture::with_commands(true, Duration::ZERO, Some(std::collections::BTreeMap::new())).await?;
        let pinned = shell_fixture_with_ssh("voice-job-stream", fixture.shared_ssh())?;
        let session = Session::new(pinned);
        assert!(session.admit("command-1")?);
        assert!(!session.admit("command-1")?);
        let directory = tempfile::tempdir()?;
        let release = directory.path().join("release");
        let command = format!("printf 'started'; while [ ! -e {} ]; do sleep 0.01; done; printf ' done'; printf 'warning' >&2; exit 7", crate::remote_ops::shell_quote(&release.to_string_lossy()));
        let result = session.execute("command-1", EXEC, &json!({"command":command}).to_string()).await;
        assert_eq!(result["completion"], "running");
        assert_eq!(result["job_id"], "command-1");
        let busy = session.execute("command-2", EXEC, r#"{"command":"printf duplicate"}"#).await;
        assert_eq!(busy["error"], "command_running");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let result = session.execute("read", READ, r#"{"job_id":"command-1"}"#).await;
                if result["stdout"].as_str().is_some_and(|text| text.contains("started")) { break; }
                tokio::task::yield_now().await;
            }
        }).await?;
        session.jobs.lock().get_mut("command-1").ok_or("missing job")?.last_notice = Instant::now() - PROGRESS_INTERVAL;
        let updates = session.feedback();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0]["stdout"], "started");
        assert_eq!(updates[0]["completion"], "running");
        std::fs::write(release, b"done")?;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if session.jobs.lock()["command-1"].state.lock().result.is_some() { break; }
                tokio::task::yield_now().await;
            }
        }).await?;
        let updates = session.feedback();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0]["result"]["exit_status"], 7);
        assert_eq!(updates[0]["stdout"], "started done");
        assert_eq!(updates[0]["stderr"], "warning");
        assert!(session.feedback().is_empty());
        Ok(())
    })
}

#[test]
fn cancelling_observation_prevents_replay_and_closes_only_the_command_channel() -> TestResult {
    let _guard = terminal_delivery_test_guard();
    crate::runtime()?.block_on(async {
        let fixture = crate::ssh::ReverseForwardFixture::with_commands(
            true,
            Duration::ZERO,
            Some(std::collections::BTreeMap::new()),
        )
        .await?;
        let pinned = shell_fixture_with_ssh("voice-job-cancel", fixture.shared_ssh())?;
        let closed = fixture.closed_commands();
        let session = Session::new(pinned);
        session
            .execute("long", EXEC, r#"{"command":"printf started; cat"}"#)
            .await;
        wait_for_output(&session, "long").await?;
        let result = session
            .execute("cancel", CANCEL, r#"{"job_id":"long"}"#)
            .await;
        assert_eq!(result["result"]["error"], "outcome_unknown");
        assert_eq!(result["result"]["remote_process"], "unknown");
        assert_eq!(
            session
                .execute("retry", EXEC, r#"{"command":"long-running"}"#)
                .await["error"],
            "outcome_unknown"
        );
        assert_eq!(
            session
                .execute(
                    "input",
                    INPUT,
                    r#"{"target":"selected_terminal","key":"enter"}"#
                )
                .await["error"],
            "outcome_unknown"
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.closed_commands() == closed {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        assert!(fixture.shared_ssh().is_alive());
        assert_eq!(
            fixture.shared_ssh().execute("printf alive").await?.stdout,
            b"alive"
        );
        Ok(())
    })
}

#[test]
fn terminal_tools_reject_spoofed_targets_and_agent_authority() -> TestResult {
    let _guard = terminal_delivery_test_guard();
    crate::runtime()?.block_on(async {
        let (_, pinned) = shell_fixture("voice-job-validation")?;
        let session = Session::new(pinned);
        for (tool, args) in [
            (EXEC, r#"{"command":"pwd","host_id":"other-host"}"#),
            (EXEC, r#"{"command":"pwd","timeout_seconds":301}"#),
            (INPUT, r#"{"target":"other-terminal","text":"hello"}"#),
            (INPUT, r#"{"text":"hello"}"#),
            (READ, r#"{"pane_id":"other-pane"}"#),
            (CANCEL, "{}"),
        ] {
            assert_eq!(
                session.execute("invalid", tool, args).await["error"],
                "invalid_arguments"
            );
        }
        assert_eq!(
            session
                .execute(
                    "agent",
                    super::super::BACKGROUND_AGENT,
                    r#"{"prompt":"do work"}"#
                )
                .await["error"],
            "invalid_tool"
        );
        assert_eq!(
            session
                .execute("missing", READ, r#"{"job_id":"foreign-call"}"#)
                .await["error"],
            "unknown_job"
        );
        Ok(())
    })
}

#[test]
fn hangup_drops_command_observation_without_disconnect_or_new_work() -> TestResult {
    let _guard = terminal_delivery_test_guard();
    crate::runtime()?.block_on(async {
        let fixture = crate::ssh::ReverseForwardFixture::with_commands(
            true,
            Duration::ZERO,
            Some(std::collections::BTreeMap::new()),
        )
        .await?;
        let pinned = shell_fixture_with_ssh("voice-job-hangup", fixture.shared_ssh())?;
        let closed = fixture.closed_commands();
        let session = Session::new(pinned);
        session
            .execute("long", EXEC, r#"{"command":"printf started; cat"}"#)
            .await;
        wait_for_output(&session, "long").await?;
        drop(session);
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.closed_commands() == closed {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        assert!(fixture.shared_ssh().is_alive());
        Ok(())
    })
}
