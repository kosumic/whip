use super::*;
use serde_json::{Value, json};

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
