//! A second host with an externally driven clock and provider lifecycle.
use std::time::{Duration, Instant};
use voice_call_controls::{Acknowledgement, Context, Policy, Request};

fn main() -> Result<(), String> {
    let now = Instant::now();
    let mut context = Context {
        call_id: 42,
        current: true,
        provider_ready: true,
        suspended: false,
    };
    let mut policy = Policy::new(context.call_id, false);
    // A real adapter calls this only after its existing tool ledger admits a
    // completed successful response. Do not implement another ledger here.
    let request = Request::parse(r#"{"muted":true,"duration_minutes":0.5}"#)?;
    let duration = request.duration()?;
    if policy.set(context, request.muted, duration, now)? {
        // Host: retire queued/in-flight capture and send its provider command.
        println!("retire capture and mute provider");
    }
    println!(
        "{}",
        serde_json::to_string(&Acknowledgement::new(request.muted, duration))
            .map_err(|e| e.to_string())?
    );
    context.provider_ready = false; // Same call; provider rotates.
    assert!(!policy.expire(context, now + Duration::from_secs(30)));
    context.provider_ready = true;
    context.suspended = true; // Device focus/permission/readiness still gates it.
    assert!(!policy.expire(context, now + Duration::from_secs(40)));
    context.suspended = false;
    if policy.expire(context, now + Duration::from_secs(45)) {
        // Intent only: the host sends unmute, then waits for the matching
        // provider acknowledgement and native readiness before opening capture.
        println!("send provider unmute; keep capture gated pending acknowledgement");
    }
    policy.cancel();
    assert!(!policy.expire(context, now + Duration::from_secs(60)));
    Ok(())
}
