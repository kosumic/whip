use super::*;
use std::future::ready;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn creation_preserves_focus_and_requires_a_directory() -> TestResult {
    for mut value in [
        json!({"action":"workspace_create"}),
        json!({"action":"tab_create","workspace_id":"w1"}),
        json!({"action":"pane_split","pane_id":"w1:p1","direction":"right"}),
    ] {
        assert!(Request::parse(value.clone()).is_err());
        value["cwd"] = json!("/repo/with spaces");
        let background = Request::parse(value.clone())?;
        assert_eq!(background.params["focus"], false);
        assert_eq!(background.params["cwd"], "/repo/with spaces");
        value["focus"] = json!(true);
        assert_eq!(Request::parse(value)?.params["focus"], true);
    }
    Ok(())
}

#[test]
fn read_options_control_the_wire_without_changing_ui_defaults() -> TestResult {
    for mut value in [
        json!({"action":"pane_read","pane_id":"w1:p1"}),
        json!({"action":"agent_read","target":"reviewer"}),
    ] {
        let defaults = Request::parse(value.clone())?;
        assert_eq!(defaults.params["source"], "recent_unwrapped");
        assert_eq!(defaults.params["format"], "text");
        assert_eq!(defaults.params["strip_ansi"], true);
        assert_eq!(defaults.params["lines"], 120);
        value["source"] = json!("visible");
        value["format"] = json!("ansi");
        value["lines"] = json!(8);
        let styled = Request::parse(value)?;
        assert_eq!(styled.params["source"], "visible");
        assert_eq!(styled.params["format"], "ansi");
        assert_eq!(styled.params["strip_ansi"], false);
        assert_eq!(styled.params["lines"], 8);
    }
    Ok(())
}

#[test]
fn invalid_options_are_rejected_before_input() {
    for value in [
        json!({"action":"pane_read","pane_id":"w1:p1","lines":0}),
        json!({"action":"pane_read","pane_id":"w1:p1","source":"wrong"}),
        json!({"action":"agent_read","target":"reviewer","lines":16_001}),
        json!({"action":"agent_wait","target":"reviewer","timeout_ms":300_001}),
        json!({"action":"agent_wait","target":"reviewer","until":["ready"]}),
        json!({"action":"agent_prompt","target":"reviewer","text":"work","wait":{"timeout_ms":0}}),
        json!({"action":"agent_prompt","target":"reviewer","text":"work","wait":{"extra":true}}),
        json!({"action":"agent_send_keys","target":"reviewer","keys":[]}),
        json!({"action":"agent_get","target":""}),
        json!({"action":"agent_get","target":"reviewer","text":"ignored"}),
        json!({"action":"pane_send_text","pane_id":"w1:p1","text":"work","focus":true}),
        json!({"action":"agent_start","name":"UPPER","kind":"codex","pane_id":"w1:p1","args":[]}),
        json!({"action":"agent_start","name":"worker","kind":"codex","pane_id":"w1:p1","args":[],"timeout_ms":3000}),
    ] {
        assert!(Request::parse(value.clone()).is_err(), "accepted {value}");
    }
}

#[test]
fn lifecycle_features_are_gated_before_any_network_request() -> TestResult {
    let runtime = crate::runtime()?;
    for value in [
        json!({"action":"agent_get","target":"worker"}),
        json!({"action":"agent_read","target":"worker"}),
        json!({"action":"agent_wait","target":"worker"}),
        json!({"action":"agent_send_keys","target":"worker","keys":["esc"]}),
        json!({"action":"agent_prompt","target":"worker","text":"hello","wait":{}}),
        json!({"action":"agent_start","name":"worker","kind":"codex","pane_id":"w1:p1","args":[]}),
        json!({"action":"tab_create","workspace_id":"w1","cwd":"/repo"}),
        json!({"action":"pane_split","pane_id":"w1:p1","direction":"down","cwd":"/repo"}),
    ] {
        let request = Request::parse(value)?;
        for protocol in 17..22 {
            let mut calls = 0;
            let error = runtime
                .block_on(request.run(protocol, |_| {
                    calls += 1;
                    ready(Ok(Value::Null))
                }))
                .err()
                .ok_or("accepted unsupported protocol")?;
            assert!(
                matches!(error, HerdrControlError::ProtocolError(code, _) if code == "unsupported_feature")
            );
            assert_eq!(calls, 0);
        }
    }
    let ping = Request::parse(json!({"action":"ping"}))?;
    for protocol in 17..=22 {
        runtime.block_on(ping.run(protocol, |_| {
            ready(Ok(json!({"type":"pong","protocol":protocol})))
        }))?;
    }
    Ok(())
}

fn agent(status: &str, interactive: bool) -> Value {
    json!({"terminal_id":"term-opaque","name":"worker","agent":"codex","agent_status":status,"interactive_ready":interactive,"launch_pending":true})
}

#[test]
fn startup_pins_identity_and_waits_past_launch_admission() -> TestResult {
    let request = Request::parse(
        json!({"action":"agent_start","name":"worker","kind":"codex","pane_id":"w1:p1","args":[]}),
    )?;
    let mut calls = Vec::new();
    let mut polls = 0;
    let result = crate::runtime()?.block_on(request.run(22, |call| {
        calls.push(call.method.clone());
        let value = match call.method.as_str() {
            "pane.get" => json!({"type":"pane_info","pane":{"terminal_id":"term-opaque"}}),
            "agent.start" => json!({"type":"agent_started","agent":agent("unknown", false),"argv":["codex"]}),
            "agent.get" => { polls += 1; json!({"type":"agent_info","agent":agent(if polls == 1 {"working"} else {"idle"}, polls > 1)}) },
            _ => Value::Null,
        };
        ready(Ok(value))
    }))?;
    assert_eq!(calls, ["pane.get", "agent.start", "agent.get", "agent.get"]);
    assert_eq!(result["ready"], true);
    assert_eq!(result["agent"]["agent_status"], "idle");
    Ok(())
}

#[test]
fn startup_rejects_replacements_blockers_and_early_exit() {
    for (changed, code) in [
        (
            json!({"terminal_id":"replacement","name":"worker"}),
            "agent_name_lost",
        ),
        (
            json!({"terminal_id":"term-opaque","name":"renamed"}),
            "agent_name_lost",
        ),
        (
            json!({"terminal_id":"term-opaque","name":"worker","agent":"claude"}),
            "agent_kind_mismatch",
        ),
        (agent("blocked", false), "agent_not_ready"),
        (
            json!({"terminal_id":"term-opaque","name":"worker","agent":"codex","agent_status":"done","interactive_ready":false}),
            "agent_start_failed",
        ),
    ] {
        assert!(
            matches!(startup_ready(&changed, "term-opaque", "worker", "codex"), Err(HerdrControlError::ProtocolError(actual, _)) if actual == code)
        );
    }
}

#[test]
fn prompt_wait_is_atomic_and_reports_submission_separately() -> TestResult {
    for wait in [false, true] {
        let mut value =
            json!({"action":"agent_prompt","target":"worker","text":"literal\n$(never-execute)"});
        if wait {
            value["wait"] = json!({"timeout_ms":300_000});
        }
        let request = Request::parse(value)?;
        let mut calls = 0;
        let result = crate::runtime()?.block_on(request.run(22, |call| {
            calls += 1;
            assert_eq!(call.method, "agent.prompt");
            assert_eq!(call.params["text"], "literal\n$(never-execute)");
            assert_eq!(call.params["wait"].is_object(), wait);
            if wait {
                assert_eq!(call.params["wait"]["timeout_ms"], 300_000);
                assert!(call.timeout_ms > 300_000);
            }
            ready(Ok(
                json!({"type":"agent_prompted","agent":agent("idle", true)}),
            ))
        }))?;
        assert_eq!(calls, 1);
        assert_eq!(
            result["completion"],
            if wait {
                "lifecycle_wait_satisfied"
            } else {
                "submitted"
            }
        );
    }
    Ok(())
}

#[test]
fn ambiguous_writes_and_blocked_prompts_are_never_replayed() -> TestResult {
    for error in [
        HerdrControlError::ProtocolError("agent_blocked".into(), "Waiting for approval".into()),
        HerdrControlError::ProtocolError("agent_prompt_stalled".into(), "No activity".into()),
        HerdrControlError::TransportDisconnected("connection lost".into()),
        HerdrControlError::RequestTimeout("deadline exceeded".into()),
    ] {
        let request = Request::parse(
            json!({"action":"agent_prompt","target":"worker","text":"only once","wait":{}}),
        )?;
        let mut calls = 0;
        let actual = crate::runtime()?.block_on(request.run(22, |_| {
            calls += 1;
            ready(Err(error.clone()))
        }));
        assert_eq!(actual, Err(error));
        assert_eq!(calls, 1);
    }
    Ok(())
}
