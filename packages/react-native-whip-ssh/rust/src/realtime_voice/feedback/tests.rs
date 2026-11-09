use super::*;

#[test]
fn pending_delegation_acknowledges_once_and_progress_is_rate_limited() {
    let now = Instant::now();
    let mut handoff = Handoff::new("call".into(), "response".into(), false, now);
    assert_eq!(handoff.notice(now), Some(Notice::Acknowledgement));
    assert_eq!(handoff.notice(now + PROGRESS_INTERVAL), None);
    handoff.progress();
    assert_eq!(handoff.notice(now + Duration::from_secs(1)), None);
    assert_eq!(
        handoff.notice(now + PROGRESS_INTERVAL),
        Some(Notice::Progress)
    );
    assert_eq!(handoff.notice(now + PROGRESS_INTERVAL * 2), None);
}

#[test]
fn model_acknowledgement_and_explicit_silence_prevent_duplicate_speech() {
    let now = Instant::now();
    let mut handoff = Handoff::new("call".into(), "response".into(), false, now);
    handoff.audio("other-response", now);
    handoff.audio("response", now);
    assert_eq!(handoff.notice(now), None);
    handoff.progress();
    handoff.silence();
    assert_eq!(handoff.notice(now + PROGRESS_INTERVAL), None);
    let mut already_spoke = Handoff::new("other-call".into(), "response".into(), true, now);
    assert_eq!(already_spoke.notice(now), None);
}
