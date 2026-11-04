#![allow(clippy::unwrap_used, reason = "test assertions")]
use super::super::{AccountingStatus, VoicePriceSnapshot};
use super::*;
use std::sync::Arc;

fn identity(id: &str) -> VoiceUsageIdentity {
    VoiceUsageIdentity {
        session_id: id.into(),
        provider: VoiceUsageProvider::Openai,
        mode: VoiceUsageMode::Tts,
        scope: VoiceUsageScope::Speech,
        model: Some("gpt-4o-mini-tts".into()),
        voice: Some("marin".into()),
        started_at_ms: 90,
    }
}

fn item(cost: Option<f64>, finalized: bool) -> VoiceUsageItem {
    VoiceUsageItem {
        revision: 0,
        reported_usage: vec![],
        estimated_usd: cost,
        price_snapshot: cost.map(|_| VoicePriceSnapshot {
            version: 1,
            id: "rate-test".into(),
            source_url: "https://developers.openai.com/api/docs/models/gpt-4o-mini-tts".into(),
            effective_at_ms: 0,
            rates: vec![],
        }),
        finalized,
    }
}

#[test]
fn native_tts_records_one_request_and_does_not_lose_its_cost_after_reopen_or_replay() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let mut session = NativeVoiceUsageSession::new(
        identity("tts-one"),
        Box::new(move |event| sink.lock().push(event)),
    );
    session.record("speech".into(), item(None, false));
    session.record("speech".into(), item(Some(0.00246), true));
    drop(session);
    let events = events.lock();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("usage.db");
    let mut store = Store::open(&path, crate::runtime().unwrap()).unwrap();
    store.write(vec![], true).unwrap();
    let recovered = AtomicBool::new(false);
    for event in events.iter().cloned() {
        commit_recovered(&mut store, event, &recovered).unwrap();
    }
    drop(store);
    let mut store = Store::open(&path, crate::runtime().unwrap()).unwrap();
    let recovered = AtomicBool::new(false);
    for event in events.iter().cloned() {
        commit_recovered(&mut store, event, &recovered).unwrap();
    }
    let ledger = Ledger::load(&store).unwrap();
    assert_eq!(ledger.calls.len(), 1);
    let call = &ledger.calls["tts-one"];
    assert_eq!(call.estimated_usd(), Some(0.00246));
    assert_eq!(call.status(), AccountingStatus::ProviderUsageFinalized);
    assert_eq!(call.items["speech"].revision, 2);
    assert!(call.ended_at_ms.is_some());
}

#[test]
fn opening_the_js_ledger_does_not_recover_an_active_native_call_twice() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("usage.db"), crate::runtime().unwrap()).unwrap();
    store.write(vec![], true).unwrap();
    super::super::record(
        &mut store,
        VoiceUsageEvent::Started {
            call: identity("old-process"),
        },
    )
    .unwrap();
    let recovered = AtomicBool::new(false);
    commit_recovered(
        &mut store,
        VoiceUsageEvent::Started {
            call: identity("new-process"),
        },
        &recovered,
    )
    .unwrap();
    commit_recovered(&mut store, VoiceUsageEvent::Recover, &recovered).unwrap();
    let ledger = Ledger::load(&store).unwrap();
    assert!(!ledger.calls["old-process"].view().active);
    assert!(ledger.calls["new-process"].view().active);
}

#[tokio::test]
async fn a_failed_write_retains_native_reports_in_order_until_retry() {
    let queue = Mutex::new(VecDeque::from([
        VoiceUsageEvent::Started {
            call: identity("retry"),
        },
        VoiceUsageEvent::Usage {
            session_id: "retry".into(),
            item_id: "speech".into(),
            item: item(Some(0.25), true),
        },
        VoiceUsageEvent::Ended {
            session_id: "retry".into(),
            ended_at_ms: 100,
        },
    ]));
    let mut ledger = Ledger::default();
    let mut writes = 0;
    assert!(
        drain_queue(&queue, |event| {
            writes += 1;
            std::future::ready(if writes == 2 {
                Err(AppStorageError::Unavailable("test".into()))
            } else {
                ledger.apply(event)
            })
        })
        .await
        .is_err()
    );
    assert!(ledger.calls["retry"].view().active);
    drain_queue(&queue, |event| std::future::ready(ledger.apply(event)))
        .await
        .unwrap();
    assert_eq!(ledger.calls["retry"].estimated_usd(), Some(0.25));
    assert!(!ledger.calls["retry"].view().active);
    assert!(queue.lock().is_empty());
}
