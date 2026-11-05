//! Export the actual wire configuration for the explicitly billable API probe.
use super::*;

#[test]
#[ignore = "used by scripts/test-voice-api-tools.cjs with an explicitly authorized API key"]
fn export_voice_api_contracts() -> Result<(), Box<dyn std::error::Error>> {
    let realtime: Config = serde_json::from_value(json!({
        "global":true,"globalShizukuAccess":true,"voice":"marin",
        "vad":{"type":"server_vad","threshold":0.5,"prefix_padding_ms":300,"silence_duration_ms":500}
    }))?;
    let live: Config = serde_json::from_value(json!({
        "live":true,"global":true,"globalShizukuAccess":true,"voice":"quartz"
    }))?;
    let contract = json!({
        "realtime":realtime.session_update()?,
        "live":{"type":"session.start","session":live::LiveVoiceAdapter::session(&live)?},
    });
    let path = std::env::var("WHIP_VOICE_API_CONTRACT")?;
    std::fs::write(path, serde_json::to_vec_pretty(&contract)?)?;
    Ok(())
}
