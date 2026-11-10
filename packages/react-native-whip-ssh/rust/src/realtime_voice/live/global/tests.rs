use super::*;
use serde_json::{Value, json};

#[test]
fn a_rejected_create_releases_only_its_pending_request_without_automatic_retry() {
    let mut backend = Backend::default();
    backend.request();
    assert!(backend.take_continuation());
    backend.request_sent("whip-live:1".into());
    assert!(!backend.rejected(Some("whip-live:0")));
    assert!(!backend.rejected(None));
    assert!(backend.busy());
    assert!(backend.rejected(Some("whip-live:1")));
    assert!(!backend.busy());
    assert!(
        !backend.take_continuation(),
        "rejection must not replay the create"
    );
    backend.request();
    assert!(
        backend.take_continuation(),
        "a new explicit request must remain available"
    );
}

fn lifecycle(id: &str, event: &str) -> Result<ResponseEvent, serde_json::Error> {
    ResponseEvent::decode(json!({"type":event,"sequence_number":0,"response":{
        "id":id,"created_at":1,"output":[]
    }}))
}
fn tool(id: &str, index: i64) -> Result<ResponseEvent, serde_json::Error> {
    ResponseEvent::decode(
        json!({"type":"response.output_item.done","sequence_number":1,
            "output_index":index,"item":{"type":"function_call","id":format!("item_{id}"),
                "call_id":id,"name":"hosts_list","arguments":"{}","status":"completed"}
        }),
    )
}

#[test]
fn global_live_uses_responses_with_the_same_tools_and_saved_guidance()
-> Result<(), Box<dyn std::error::Error>> {
    let mut config: Config =
        serde_json::from_value(json!({"live":true,"global":true,"voice":"quartz"}))?;
    for shizuku in [false, true] {
        config.global_shizuku_access = shizuku;
        let mut session = super::super::LiveVoiceAdapter::session(&config)?;
        configure(&config, &mut session, "Saved global AGENTS guidance".into())?;
        let wire: Value = serde_json::from_str(
            &super::super::codec()
                .encode(&api::ClientEvent::new(api::Command::Start { session }))?,
        )?;
        assert_eq!(wire["session"]["model"], "gpt-live-1");
        assert_eq!(wire["session"]["audio"]["output"]["voice"], "quartz");
        assert_eq!(wire["session"]["store"], false);
        assert_eq!(wire["session"]["delegation"]["type"], "responses");
        let backend = &wire["session"]["delegation"]["responses"];
        assert_eq!(backend["model"], super::super::catalog()?.backend_model);
        assert_eq!(backend["tools"], json!(voice::schemas(shizuku)));
        assert_eq!(backend["instructions"], "Saved global AGENTS guidance");
        assert!(
            wire["session"]["instructions"]
                .as_str()
                .ok_or("No voice instructions")?
                .contains("Saved global AGENTS guidance")
        );
        assert!(wire["session"].get("tools").is_none());
    }
    config.preview = true;
    assert!(super::super::LiveVoiceAdapter::validate(&config).is_err());
    config.preview = false;
    config.target = Some(serde_json::from_value(
        json!({"runtimeId":"host","terminalId":"terminal","paneId":"pane","bindingToken":"binding"}),
    )?);
    assert!(super::super::LiveVoiceAdapter::validate(&config).is_err());
    Ok(())
}

#[test]
fn tools_wait_for_response_completion_and_duplicates_cannot_dispatch_again()
-> Result<(), Box<dyn std::error::Error>> {
    let mut backend = Backend::default();
    assert!(
        backend
            .observe(
                Some("delegation"),
                &lifecycle("response", "response.created")?
            )?
            .is_none()
    );
    let first = tool("one", 0)?;
    assert!(backend.observe(Some("delegation"), &first)?.is_none());
    assert!(backend.observe(Some("delegation"), &first)?.is_none());
    assert!(
        backend
            .observe(Some("delegation"), &tool("two", 1)?)?
            .is_none()
    );
    let completed = lifecycle("response", "response.completed")?;
    let batch = backend
        .observe(Some("delegation"), &completed)?
        .ok_or("No ready tools")?;
    assert_eq!(
        batch
            .calls
            .iter()
            .map(|call| call.call_id.as_str())
            .collect::<Vec<_>>(),
        ["one", "two"]
    );
    assert!(backend.observe(Some("delegation"), &completed)?.is_none());
    backend.request(); // a typed message while tools are pending must wait, too
    assert!(!backend.take_continuation());
    let results = Results {
        key: batch.key,
        items: vec![],
    };
    backend.finished(&results)?;
    assert!(backend.take_continuation());
    assert!(!backend.take_continuation());
    assert!(backend.finished(&results).is_err());
    backend.request();
    assert!(!backend.take_continuation()); // no repeated response.create before acknowledgement
    Ok(())
}

#[test]
fn a_tool_identity_cannot_be_replayed_in_a_new_backend_response_after_denial()
-> Result<(), Box<dyn std::error::Error>> {
    let mut backend = Backend::default();
    backend.observe(Some("first"), &lifecycle("first", "response.created")?)?;
    backend.observe(Some("first"), &tool("denied", 0)?)?;
    let batch = backend
        .observe(Some("first"), &lifecycle("first", "response.completed")?)?
        .ok_or("No batch")?;
    // The protected action was denied; a later response cannot replay its ID.
    backend.finished(&Results {
        key: batch.key,
        items: vec![],
    })?;
    backend.observe(Some("second"), &lifecycle("second", "response.created")?)?;
    backend.observe(Some("second"), &tool("denied", 0)?)?;
    assert!(
        backend
            .observe(Some("second"), &lifecycle("second", "response.completed")?)
            .is_err()
    );
    Ok(())
}

#[test]
fn overlapping_responses_require_every_tool_batch_before_continuation()
-> Result<(), Box<dyn std::error::Error>> {
    let mut backend = Backend::default();
    let mut batches = Vec::new();
    for id in ["first", "second"] {
        backend.observe(Some(id), &lifecycle(id, "response.created")?)?;
        backend.observe(Some(id), &tool(id, 0)?)?;
        batches.push(
            backend
                .observe(Some(id), &lifecycle(id, "response.completed")?)?
                .ok_or("No batch")?,
        );
    }
    let mut batches = batches.into_iter();
    let first = batches.next().ok_or("No first batch")?;
    backend.finished(&Results {
        key: first.key,
        items: vec![],
    })?;
    assert!(!backend.take_continuation());
    let second = batches.next().ok_or("No second batch")?;
    backend.finished(&Results {
        key: second.key,
        items: vec![],
    })?;
    assert!(backend.take_continuation());
    Ok(())
}

#[test]
fn unattributed_ambiguous_failed_and_incomplete_responses_never_dispatch()
-> Result<(), Box<dyn std::error::Error>> {
    let mut backend = Backend::default();
    backend.observe(Some("delegation"), &lifecycle("one", "response.created")?)?;
    assert!(backend.observe(None, &tool("one", 0)?).is_err());
    let mut backend = Backend::default();
    for id in ["one", "two"] {
        backend.observe(Some("delegation"), &lifecycle(id, "response.created")?)?;
    }
    assert!(
        backend
            .observe(Some("delegation"), &tool("one", 0)?)
            .is_err()
    );
    for terminal in ["response.failed", "response.incomplete"] {
        let mut backend = Backend::default();
        backend.observe(Some("delegation"), &lifecycle("one", "response.created")?)?;
        backend.observe(Some("delegation"), &tool("one", 0)?)?;
        assert!(
            backend
                .observe(Some("delegation"), &lifecycle("one", terminal)?)
                .is_err()
        );
    }
    let mut backend = Backend::default();
    assert!(
        backend
            .observe(Some("delegation"), &lifecycle("one", "response.completed")?)
            .is_err()
    );
    Ok(())
}

#[test]
fn startup_cannot_switch_global_live_back_to_agent_delegation()
-> Result<(), Box<dyn std::error::Error>> {
    let config: Config =
        serde_json::from_value(json!({"live":true,"global":true,"voice":"quartz"}))?;
    let mut snapshot: api::SessionSnapshot = serde_json::from_value(json!({
        "id":"session","expires_at":1234,"model":"gpt-live-1","status":"active",
        "delegation":{"type":"responses","responses":{"model":super::super::catalog()?.backend_model}}
    }))?;
    let mut state = super::super::State::default();
    state.pin_session(&snapshot, &config)?;
    snapshot.delegation = Field::Value(api::DelegationConfig::Client);
    assert!(state.pin_session(&snapshot, &config).is_err());
    Ok(())
}
