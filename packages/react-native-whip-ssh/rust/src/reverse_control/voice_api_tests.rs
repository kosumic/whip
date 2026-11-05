//! Replay API-generated arguments through the actual native dispatcher.
use super::*;

struct ProbePlatform;

#[async_trait::async_trait]
impl WhipAppControl for ProbePlatform {
    async fn execute(&self, _: Arc<WhipToolPermit>, _: String, _: String) -> String {
        "{}".into()
    }
    fn cancel(&self, _: String) {}
}

#[test]
#[ignore = "used by scripts/test-voice-api-tools.cjs after explicitly authorized API calls"]
fn validate_voice_api_arguments() -> Result<(), Box<dyn std::error::Error>> {
    crate::runtime()?.block_on(async {
        let report: Value = serde_json::from_slice(&std::fs::read(
            std::env::var("WHIP_VOICE_API_REPORT")?,
        )?)?;
        let coordinator = hosts::HostActionCoordinator::new(Arc::new(hosts::tests::Platform::default()));
        coordinator.update_context(hosts::tests::context());
        set_whip_app_control(Arc::new(ProbePlatform));
        let session = WhipToolSession::new(true)?;
        let mut rejected = Vec::new();
        let calls = report["calls"].as_array().ok_or("Missing captured API calls")?;
        assert!(!calls.is_empty(), "The probe did not capture any API-generated tool calls");
        for call in calls {
            let name = call["name"].as_str().ok_or("Missing tool name")?;
            let arguments = call["arguments"].to_string();
            let result = session.execute(name, &arguments).await;
            if result["error"] == "invalid_argument" {
                rejected.push(json!({"provider":call["provider"],"scenario":call["scenario"],"name":name,"arguments":call["arguments"],"result":result}));
            }
        }
        session.close();
        coordinator.close();
        assert!(rejected.is_empty(), "Native parsers rejected API-generated arguments: {rejected:?}");
        eprintln!("Validated {} API-generated calls through Whip's native dispatcher", calls.len());
        Ok::<(), Box<dyn std::error::Error>>(())
    })
}
