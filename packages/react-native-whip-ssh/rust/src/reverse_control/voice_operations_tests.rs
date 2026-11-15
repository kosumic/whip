use super::super::{
    AGENTS_PROMPT, DEVICE_LOCATION, HOSTS_LIST, HashSet, MAX_RESULT, Mutex, WhipAppControl,
    WhipToolPermit, set_whip_app_control,
};
use super::*;
use tokio::sync::Notify;

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct Platform {
    calls: Mutex<Vec<String>>,
    suspended: AtomicBool,
    changed: Notify,
    location: Mutex<Value>,
}
impl Default for Platform {
    fn default() -> Self {
        Self {
            calls: Mutex::default(),
            suspended: AtomicBool::new(false),
            changed: Notify::new(),
            location: Mutex::new(json!({"error":"permission_denied"})),
        }
    }
}
#[async_trait::async_trait]
impl WhipAppControl for Platform {
    async fn execute(&self, _: Arc<WhipToolPermit>, action: String, _: String) -> String {
        self.calls.lock().push(action.clone());
        match action.as_str() {
            WATCH => {
                let changed = self.changed.notified();
                if !self.suspended.load(Ordering::Acquire) {
                    changed.await;
                }
                json!({"error":"cancelled"})
            }
            "device.location" => self.location.lock().clone(),
            _ => json!({"foreground":true}),
        }
        .to_string()
    }
    fn cancel(&self, _: String) {
        self.suspended.store(true, Ordering::Release);
        self.changed.notify_waiters();
    }
}

type Fixture = (
    Arc<WhipToolSession>,
    Arc<hosts::HostActionCoordinator>,
    Arc<hosts::tests::Platform>,
    Arc<Platform>,
);

fn setup() -> Result<Fixture, Box<dyn std::error::Error>> {
    let host = Arc::new(hosts::tests::Platform::default());
    let coordinator = hosts::HostActionCoordinator::new(host.clone());
    coordinator.update_context(hosts::tests::context());
    let platform = Arc::new(Platform::default());
    set_whip_app_control(platform.clone());
    Ok((WhipToolSession::new(false)?, coordinator, host, platform))
}

#[test]
fn operation_catalog_requires_explicit_targets_and_keeps_privileges_allowlisted() -> TestResult {
    let tools = super::super::schemas(false);
    let mut names = HashSet::new();
    for tool in &tools {
        assert!(names.insert(tool["name"].as_str().ok_or("No name")?));
        if recognizes(tool["name"].as_str().ok_or("No name")?) {
            assert!(
                tool["parameters"]["required"]
                    .as_array()
                    .ok_or("No required")?
                    .contains(&json!("host_id"))
            );
            assert_eq!(tool["parameters"]["additionalProperties"], false);
        }
    }
    for name in REMOTE {
        assert!(
            names.contains(name.replacen('.', "_", 1).as_str()),
            "{name}"
        );
    }
    for name in [
        "terminal_exec",
        "terminal_read",
        "terminal_cancel",
        "device_location",
    ] {
        assert!(names.contains(name));
    }
    for name in [
        "hosts_save",
        "hosts_delete",
        "herdr_request",
        "terminal_input",
        "panes_send_keys",
        "device_shizuku_exec",
    ] {
        assert!(!names.contains(name));
    }
    for (name, args) in [
        (
            "agents.start",
            json!({"host_id":"host","pane_id":"p","kind":"codex","name":"worker","args":[],"approved":true}),
        ),
        (
            "agents.stop",
            json!({"host_id":"host","terminal_id":"terminal"}),
        ),
        ("agents.restart", json!({"host_id":"host","pane_id":"p"})),
        (
            "agents.inspect",
            json!({"host_id":"host","target":"focused"}),
        ),
        (
            "agents.wait",
            json!({"host_id":"host","pane_id":"p","target":"other"}),
        ),
        ("tabs.create", json!({"host_id":"host","workspace_id":"w"})),
        (
            "panes.split",
            json!({"host_id":"host","pane_id":"p","direction":"down","cwd":""}),
        ),
        ("hosts.connect", json!({"host_id":""})),
        ("hosts.connect", json!({"host_id":"host","approved":true})),
        ("hosts.connect", json!({})),
    ] {
        assert!(parse(name, &args).is_err(), "Accepted {name}: {args}");
    }
    for (name, args) in [
        (
            "agents.start",
            json!({"host_id":"host","pane_id":"p","kind":"codex","name":"worker","args":[]}),
        ),
        (
            "agents.stop",
            json!({"host_id":"host","pane_id":"p","terminal_id":"t"}),
        ),
        ("agents.inspect", json!({"host_id":"host","pane_id":"p"})),
        (
            "agents.wait",
            json!({"host_id":"host","pane_id":"p","timeout_ms":300_000}),
        ),
        (
            "tabs.create",
            json!({"host_id":"host","workspace_id":"w","cwd":"/repo"}),
        ),
    ] {
        parse(name, &args)?;
    }
    Ok(())
}

#[test]
fn global_agent_start_negotiates_protocol_and_reports_readiness_after_one_submission() -> TestResult
{
    use std::future::ready;
    let action = parse(
        "agents.start",
        &json!({"host_id":"host","pane_id":"pane","kind":"codex","name":"worker","args":[]}),
    )?;
    let application::Action::Herdr {
        operation: application::HerdrOperation::AgentRequest(request),
        ..
    } = action
    else {
        return Err("Expected shared agent request".into());
    };
    let mut methods = Vec::new();
    let unsupported = crate::runtime()?.block_on(request.run(21, |call| {
        methods.push(call.method);
        ready(Ok(Value::Null))
    }));
    assert!(
        matches!(unsupported, Err(crate::herdr_api::HerdrControlError::ProtocolError(code, _)) if code == "unsupported_feature")
    );
    assert!(methods.is_empty());
    let mut polls = 0;
    let result = crate::runtime()?.block_on(request.run(22, |call| {
        methods.push(call.method.clone());
        let value = match call.method.as_str() {
            "pane.get" => json!({"type":"pane_info","pane":{"terminal_id":"terminal"}}),
            "agent.start" => json!({"type":"agent_started","agent":{"terminal_id":"terminal","name":"worker"}}),
            "agent.get" => {
                polls += 1;
                json!({"type":"agent_info","agent":{"terminal_id":"terminal","name":"worker","agent":"codex","agent_status":if polls == 1 { "working" } else { "idle" },"interactive_ready":polls > 1,"launch_pending":true}})
            },
            _ => Value::Null,
        };
        ready(Ok(value))
    }))?;
    assert_eq!(
        methods,
        ["pane.get", "agent.start", "agent.get", "agent.get"]
    );
    assert_eq!(result["ready"], true);
    assert_eq!(result["agent"]["terminal_id"], "terminal");
    Ok(())
}

#[test]
fn global_creation_passes_original_cwd_and_preserves_focus_by_default() -> TestResult {
    use std::future::ready;
    for (name, args) in [
        (
            "workspaces.create",
            json!({"host_id":"host","cwd":"/repo 'quoted"}),
        ),
        (
            "tabs.create",
            json!({"host_id":"host","workspace_id":"space","cwd":"/repo 'quoted"}),
        ),
        (
            "panes.split",
            json!({"host_id":"host","pane_id":"pane","direction":"down","cwd":"/repo 'quoted"}),
        ),
    ] {
        let application::Action::Herdr {
            operation: application::HerdrOperation::AgentRequest(request),
            ..
        } = parse(name, &args)?
        else {
            return Err("Expected shared creation request".into());
        };
        let mut submitted = Vec::new();
        let _ = crate::runtime()?.block_on(request.run(22, |call| {
            submitted.push(call.params);
            ready(Err(crate::herdr_api::HerdrControlError::RequestCancelled(
                "fixture".into(),
            )))
        }));
        assert_eq!(submitted.len(), 1);
        assert_eq!(submitted[0]["cwd"], args["cwd"]);
        assert_eq!(submitted[0]["focus"], false);
    }
    Ok(())
}

#[test]
fn saved_host_connect_disconnect_runs_without_approval_and_never_ends_the_call() -> TestResult {
    crate::runtime()?.block_on(async {
        let (session, coordinator, host, platform) = setup()?;
        let args = r#"{"host_id":"host"}"#;
        assert!(session.admit("connect-once")?);
        assert!(!session.admit("connect-once")?);
        let connected = session.execute("hosts_connect", args).await;
        assert_eq!(
            connected["structuredContent"]["value"]["host_id"], "host",
            "{connected}"
        );
        assert_eq!(
            *host.calls.lock(),
            ["authenticate", "read_credential", "connect"]
        );
        session.execute("hosts_connect", args).await;
        assert_eq!(
            host.calls.lock().len(),
            3,
            "already connected must not reconnect"
        );
        let disconnected = session.execute("hosts_disconnect", args).await;
        assert_eq!(
            disconnected["structuredContent"]["value"]["completed"], true,
            "{disconnected}"
        );
        assert_eq!(
            host.calls.lock().last().map(String::as_str),
            Some("disconnect")
        );
        session.check()?;
        assert_eq!(
            session.execute(HOSTS_LIST, "{}").await["connections"],
            json!([])
        );
        assert!(platform.calls.lock().iter().all(|action| action == WATCH));
        session.close();
        coordinator.close();
        Ok(())
    })
}

#[test]
fn biometric_cancel_missing_credentials_and_trust_failure_stop_at_the_correct_boundary()
-> TestResult {
    crate::runtime()?.block_on(async {
        for scenario in ["biometric", "missing", "trust"] {
            let (session, coordinator, host, _) = setup()?;
            match scenario {
                "biometric" => host.authenticated.store(false, Ordering::Release),
                "missing" => host.missing_credential.store(true, Ordering::Release),
                _ => *host.fail.lock() = Some("connect"),
            }
            let value = session
                .execute("hosts_connect", r#"{"host_id":"host"}"#)
                .await;
            assert!(value.get("error").is_some(), "{scenario}: {value}");
            let calls = host.calls.lock().clone();
            match scenario {
                "biometric" => assert_eq!(calls, ["authenticate"]),
                "missing" => assert_eq!(calls, ["authenticate", "read_credential"]),
                _ => assert_eq!(calls, ["authenticate", "read_credential", "connect"]),
            }
            session.close();
            coordinator.close();
        }
        Ok(())
    })
}

#[test]
fn revoked_rights_background_and_concurrent_actions_cannot_submit() -> TestResult {
    crate::runtime()?.block_on(async {
        for reason in ["lock", "hangup", "background", "busy"] {
            let (session, coordinator, host, platform) = setup()?;
            let serial = if reason == "busy" {
                Some(session.delegation.lock().await)
            } else {
                None
            };
            match reason {
                "lock" => {
                    let mut context = hosts::tests::context();
                    context.locked = true;
                    coordinator.update_context(context);
                }
                "hangup" => session.close(),
                "background" => platform.cancel(session.id.clone()),
                _ => {}
            }
            for (name, args) in [
                ("hosts_connect", r#"{"host_id":"host"}"#),
                (
                    AGENTS_PROMPT,
                    r#"{"host_id":"host","pane_id":"pane","prompt":"Check status"}"#,
                ),
            ] {
                let value = session.execute(name, args).await;
                assert!(value.get("error").is_some(), "{reason}: {name}: {value}");
                if reason != "busy" {
                    let expected = if reason == "lock" {
                        "permission_denied"
                    } else {
                        "cancelled"
                    };
                    assert_eq!(value["error"], expected, "{reason}: {name}: {value}");
                }
            }
            assert!(host.calls.lock().is_empty(), "{reason}");
            drop(serial);
            session.close();
            coordinator.close();
        }
        Ok(())
    })
}

async fn read_until(
    session: &Arc<WhipToolSession>,
    job: &Value,
    expected: &str,
) -> Result<Value, Box<dyn std::error::Error>> {
    Ok(tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = session.execute(terminal::READ, &job.to_string()).await;
            if value["stdout"] == expected || value["result"]["error"] == expected {
                break value;
            }
            tokio::task::yield_now().await;
        }
    })
    .await?)
}

#[test]
fn global_jobs_run_without_approval_with_real_output_cwd_exit_status_and_host_owned_cancellation()
-> TestResult {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    crate::runtime()?.block_on(async {
        let fixture = crate::ssh::ReverseForwardFixture::with_commands(
            true,
            Duration::ZERO,
            Some(std::collections::BTreeMap::new()),
        )
        .await?;
        let _pinned = crate::host_runtime::realtime_terminal::shell_fixture_with_ssh(
            "host",
            fixture.shared_ssh(),
        )?;
        let (session, coordinator, _, platform) = setup()?;
        let directory = tempfile::tempdir()?;
        let cwd = directory.path().join("with a 'quote");
        std::fs::create_dir(&cwd)?;
        let request =
            json!({"host_id":"host","cwd":cwd,"command":"pwd; printf warning >&2; exit 7"});
        let value = session.execute(terminal::EXEC, &request.to_string()).await;
        assert_eq!(value["completion"], "running", "{value}");
        let job = json!({"host_id":"host","job_id":value["job_id"]});
        let observed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let value = session.execute(terminal::READ, &job.to_string()).await;
                if value["completion"] == "finished" {
                    break value;
                }
                tokio::task::yield_now().await;
            }
        })
        .await?;
        assert_eq!(observed["stdout"], format!("{}\n", cwd.display()));
        assert_eq!(observed["stderr"], "warning");
        assert_eq!(observed["result"]["exit_status"], 7);
        assert!(platform.calls.lock().iter().all(|action| action == WATCH));
        assert!(
            session
                .execute(
                    terminal::READ,
                    &json!({"host_id":"mini","job_id":value["job_id"]}).to_string()
                )
                .await
                .get("error")
                .is_some()
        );
        let output = session.execute(terminal::EXEC, r#"{"host_id":"host","command":"i=0; while [ $i -lt 6000 ]; do printf '\\n'; i=$((i + 1)); done; exit 9"}"#).await;
        let output_job = json!({"host_id":"host","job_id":output["job_id"]});
        let bounded = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let value = session.execute(terminal::READ, &output_job.to_string()).await;
                if value["completion"] == "finished" { break value; }
                tokio::task::yield_now().await;
            }
        }).await?;
        assert_eq!(bounded["result"]["exit_status"], 9);
        assert_eq!(bounded["stdout"].as_str().ok_or("missing stdout")?.len(), MAX_STREAM_RESULT);
        assert_eq!(bounded["truncated"], true);
        assert!(bounded.to_string().len() < MAX_RESULT);
        let long = session
            .execute(
                terminal::EXEC,
                r#"{"host_id":"host","command":"printf started; cat"}"#,
            )
            .await;
        let job = json!({"host_id":"host","job_id":long["job_id"]});
        read_until(&session, &job, "started").await?;
        let cancelled = session.execute(terminal::CANCEL, &job.to_string()).await;
        assert_eq!(cancelled["result"]["error"], "outcome_unknown");
        assert!(
            session
                .execute(
                    terminal::EXEC,
                    r#"{"host_id":"host","command":"echo retry"}"#
                )
                .await
                .get("error")
                .is_some()
        );
        assert!(platform.calls.lock().iter().all(|action| action == WATCH));
        assert!(fixture.shared_ssh().is_alive());
        session.close();
        coordinator.close();
        Ok(())
    })
}

#[test]
fn background_and_hangup_cancel_global_jobs_but_leave_ssh_alive_and_report_unknown_outcomes()
-> TestResult {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    crate::runtime()?.block_on(async {
        for reason in ["background", "hangup", "disconnect", "deadline"] {
            let fixture = crate::ssh::ReverseForwardFixture::with_commands(
                true,
                Duration::ZERO,
                Some(std::collections::BTreeMap::new()),
            )
            .await?;
            let _pinned = crate::host_runtime::realtime_terminal::shell_fixture_with_ssh(
                "host",
                fixture.shared_ssh(),
            )?;
            let (session, coordinator, _, platform) = setup()?;
            let long = session
                .execute(
                    terminal::EXEC,
                    r#"{"host_id":"host","command":"printf started; cat","timeout_seconds":1}"#,
                )
                .await;
            let job = json!({"host_id":"host","job_id":long["job_id"]});
            read_until(&session, &job, "started").await?;
            match reason {
                "background" => platform.cancel(session.id.clone()),
                "hangup" => session.close(),
                "disconnect" => {
                    session
                        .execute("hosts_disconnect", r#"{"host_id":"host"}"#)
                        .await;
                    session.check()?;
                }
                _ => {
                    read_until(&session, &job, "outcome_unknown").await?;
                }
            }
            tokio::time::timeout(Duration::from_secs(5), async {
                while session.commands.lock().iter().any(|job| job.session.busy()) {
                    tokio::task::yield_now().await;
                }
            })
            .await?;
            assert!(session.commands.lock()[0].session.outcome_unknown());
            assert!(fixture.shared_ssh().is_alive());
            session.close();
            coordinator.close();
        }
        Ok(())
    })
}

#[test]
fn location_denial_and_invalid_exec_requests_remain_errors_without_confirmation() -> TestResult {
    crate::runtime()?.block_on(async {
        let (session, coordinator, _, platform) = setup()?;
        assert_eq!(
            session.execute(DEVICE_LOCATION, "{}").await["error"],
            "permission_denied"
        );
        for (platform_error, code) in [("location_unavailable", "device_unavailable"), ("timeout", "timeout")] {
            *platform.location.lock() = json!({"error":platform_error});
            let result = session.execute(DEVICE_LOCATION, "{}").await;
            assert_eq!(result["error"], code);
            assert_eq!(result["details"]["platform_error"], platform_error);
        }
        *platform.location.lock() = json!({"latitude":10.0,"longitude":20.0,"accuracy_m":1000.0,"timestamp_ms":1.0,"private":"omit"});
        let location = session.execute(DEVICE_LOCATION, "{}").await;
        assert_eq!(location["structuredContent"]["value"]["accuracy_m"], 1000.0);
        assert!(location["structuredContent"]["value"].get("private").is_none());
        for args in [
            json!({}),
            json!({"host_id":"host","command":""}),
            json!({"host_id":"host","command":"pwd","timeout_seconds":301}),
            json!({"host_id":"host","command":"pwd","cwd":"/repo\nmalicious"}),
            json!({"host_id":"host","command":"pwd","approved":true}),
        ] {
            assert_eq!(
                session.execute(terminal::EXEC, &args.to_string()).await["error"],
                "invalid_argument"
            );
        }
        assert!(platform.calls.lock().iter().all(|action| action == WATCH || action == "device.location"));
        session.close();
        coordinator.close();
        Ok(())
    })
}
