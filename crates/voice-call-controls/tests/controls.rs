use std::time::{Duration, Instant};
use voice_call_controls::{Acknowledgement, Context, MAX_ARGUMENTS, Policy, Request, parameters};

fn active(call_id: u64) -> Context {
    Context {
        call_id,
        current: true,
        provider_ready: true,
        suspended: false,
    }
}

#[test]
fn strict_bounded_requests_and_wire_acknowledgements() -> Result<(), String> {
    for (arguments, expected) in [
        (r#"{"muted":true}"#, None),
        (r#"{"muted":false}"#, None),
        (
            r#"{"muted":true,"duration_minutes":0.5}"#,
            Some(Duration::from_secs(30)),
        ),
        (
            r#"{"muted":true,"duration_minutes":60}"#,
            Some(Duration::from_mins(60)),
        ),
    ] {
        let request = Request::parse(arguments)?;
        let duration = request.duration()?;
        assert_eq!(duration, expected);
        let ack = serde_json::to_value(Acknowledgement::new(request.muted, duration))
            .map_err(|error| error.to_string())?;
        assert_eq!(ack["muted"], request.muted);
        assert_eq!(
            ack["duration_minutes"],
            serde_json::json!(expected.map(|d| d.as_secs_f64() / 60.0))
        );
    }
    for arguments in [
        r#"{"muted":true,"duration_minutes":0}"#,
        r#"{"muted":true,"duration_minutes":-1}"#,
        r#"{"muted":true,"duration_minutes":60.01}"#,
        r#"{"muted":true,"duration_minutes":1e-300}"#,
        r#"{"muted":true,"duration_minutes":1e400}"#,
        r#"{"muted":true,"duration_minutes":NaN}"#,
        r#"{"muted":true,"duration_minutes":Infinity}"#,
        r#"{"muted":true,"duration_minutes":"10"}"#,
        r#"{"muted":true,"duration_minutes":null}"#,
        r#"{"muted":false,"duration_minutes":10}"#,
        r#"{"muted":true,"duration_seconds":10}"#,
        r#"{"muted":"true"}"#,
        r#"{"duration_minutes":10}"#,
        r#"{"muted":true,"muted":false}"#,
        r#"{"muted":true,"duration_minutes":1,"duration_minutes":2}"#,
        r#"{"muted":true} {}"#,
        "[]",
        "[true]",
        "[true,10]",
        "null",
        "{",
    ] {
        assert!(Request::parse(arguments).is_err(), "Accepted {arguments}");
    }
    let padded = format!("{}{{\"muted\":true}}", " ".repeat(MAX_ARGUMENTS));
    assert!(Request::parse(&padded).is_err());
    let schema = parameters();
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["required"], serde_json::json!(["muted"]));
    assert_eq!(schema["properties"]["duration_minutes"]["maximum"], 60);
    Ok(())
}

#[test]
fn explicit_changes_replace_deadlines_even_without_a_mute_edge() -> Result<(), &'static str> {
    let now = Instant::now();
    let context = active(1);
    let mut policy = Policy::new(1, false);
    assert!(policy.set(context, true, Some(Duration::from_mins(1)), now)?);
    let first = now + Duration::from_mins(1);
    assert!(!policy.set(context, true, Some(Duration::from_mins(10)), now)?);
    assert!(!policy.expire(context, first));
    assert!(policy.muted());
    assert!(!policy.set(context, true, None, now)?);
    assert_eq!(policy.deadline(), None);
    assert!(!policy.expire(context, now + Duration::from_mins(20)));
    assert!(policy.set(context, false, None, now)?);
    assert!(policy.set(context, true, Some(Duration::from_secs(1)), now)?);
    assert!(!policy.expire(context, now));
    assert!(policy.expire(context, now + Duration::from_secs(1)));
    assert!(!policy.muted());
    assert!(!policy.expire(context, now + Duration::from_secs(2)));
    Ok(())
}

#[test]
fn rotation_and_suspension_keep_the_original_deadline_due_until_ready() -> Result<(), &'static str>
{
    let now = Instant::now();
    let context = active(7);
    let mut policy = Policy::new(7, false);
    policy.set(context, true, Some(Duration::from_mins(1)), now)?;
    let due = now + Duration::from_mins(1);
    for unavailable in [
        Context {
            provider_ready: false,
            ..context
        },
        Context {
            suspended: true,
            ..context
        },
        Context {
            provider_ready: false,
            suspended: true,
            ..context
        },
    ] {
        assert!(!policy.expire(unavailable, due + Duration::from_mins(5)));
        assert!(policy.muted());
        assert_eq!(policy.deadline(), Some(due));
    }
    assert!(policy.expire(context, due + Duration::from_mins(5)));
    assert!(!policy.muted());
    Ok(())
}

#[test]
fn recovery_allows_manual_controls_but_rejects_new_timers_without_mutating_intent()
-> Result<(), &'static str> {
    let now = Instant::now();
    let context = active(1);
    let recovering = Context {
        provider_ready: false,
        ..context
    };
    let mut policy = Policy::new(1, false);
    policy.set(context, true, Some(Duration::from_mins(1)), now)?;
    let due = policy.deadline();
    assert!(
        policy
            .set(recovering, true, Some(Duration::from_mins(5)), now)
            .is_err()
    );
    assert_eq!(policy.deadline(), due);
    assert!(policy.set(recovering, false, None, now)?);
    assert_eq!(policy.deadline(), None);
    assert!(!policy.expire(context, now + Duration::from_mins(10)));
    // Whip permits a timed intent while the provider is ready but device audio
    // is temporarily suspended. Its expiry still waits for native recovery.
    let suspended = Context {
        suspended: true,
        ..context
    };
    policy.set(suspended, true, Some(Duration::from_secs(1)), now)?;
    assert!(!policy.expire(suspended, now + Duration::from_secs(1)));
    assert!(policy.muted());
    Ok(())
}

#[test]
fn hangup_revocation_and_other_call_callbacks_cannot_reactivate_a_call() -> Result<(), &'static str>
{
    let now = Instant::now();
    let context = active(1);
    for explicit_hangup in [false, true] {
        let mut policy = Policy::new(1, false);
        policy.set(context, true, Some(Duration::from_secs(1)), now)?;
        if explicit_hangup {
            policy.cancel();
        } else {
            assert!(!policy.expire(
                Context {
                    current: false,
                    ..context
                },
                now
            ));
        }
        assert_eq!(policy.deadline(), None);
        assert!(policy.muted());
        assert!(!policy.expire(context, now + Duration::from_mins(2)));
        assert!(policy.set(context, false, None, now).is_err());
    }
    let mut replacement = Policy::new(2, true);
    replacement.set(active(2), true, Some(Duration::from_secs(2)), now)?;
    assert!(!replacement.expire(context, now + Duration::from_mins(1)));
    assert!(!replacement.expire(
        Context {
            current: false,
            ..context
        },
        now
    ));
    assert!(replacement.set(context, false, None, now).is_err());
    assert!(replacement.muted());
    assert_eq!(replacement.deadline(), Some(now + Duration::from_secs(2)));
    assert!(replacement.expire(active(2), now + Duration::from_secs(2)));
    Ok(())
}

#[test]
fn invalid_direct_controls_leave_the_existing_deadline_untouched() -> Result<(), &'static str> {
    let now = Instant::now();
    let context = active(1);
    let mut policy = Policy::new(1, false);
    policy.set(context, true, Some(Duration::from_mins(1)), now)?;
    let due = policy.deadline();
    for (muted, duration) in [
        (false, Duration::from_secs(1)),
        (true, Duration::ZERO),
        (true, Duration::from_mins(61)),
    ] {
        assert!(policy.set(context, muted, Some(duration), now).is_err());
        assert!(policy.muted());
        assert_eq!(policy.deadline(), due);
    }
    Ok(())
}
