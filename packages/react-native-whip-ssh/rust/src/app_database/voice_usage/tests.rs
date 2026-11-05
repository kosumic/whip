#![allow(clippy::unwrap_used, reason = "test assertions")]
use super::*;
fn started(id: &str, time: u64, local: bool) -> VoiceUsageEvent {
    VoiceUsageEvent::Started {
        call: VoiceUsageIdentity {
            session_id: id.into(),
            provider: if local {
                VoiceUsageProvider::Local
            } else {
                VoiceUsageProvider::Openai
            },
            mode: if local {
                VoiceUsageMode::TurnBased
            } else {
                VoiceUsageMode::Realtime
            },
            model: None,
            voice: None,
            scope: VoiceUsageScope::Agent,
            started_at_ms: time,
        },
    }
}
fn usage(
    id: &str,
    item_id: &str,
    revision: u64,
    cost: Option<f64>,
    finalized: bool,
) -> VoiceUsageEvent {
    VoiceUsageEvent::Usage {
        session_id: id.into(),
        item_id: item_id.into(),
        item: VoiceUsageItem {
            revision,
            reported_usage: vec![UsageQuantity {
                metric: UsageMetric::InputAudio,
                unit: UsageUnit::Tokens,
                amount: 500.0,
            }],
            estimated_usd: cost,
            finalized,
            price_snapshot: cost.map(|_| VoicePriceSnapshot {
                version: 1,
                id: "test-rate-v1".into(),
                source_url: "https://example.com/pricing".into(),
                effective_at_ms: 0,
                rates: vec![],
            }),
        },
    }
}
fn query() -> Query {
    Query {
        now_ms: 100,
        today_ms: 90,
        week_ms: 80,
        month_ms: 50,
        provider: None,
        mode: None,
        scope: None,
        chart_boundaries_ms: vec![],
    }
}

#[test]
fn chart_buckets_keep_start_boundaries_unknown_costs_and_filters_consistent() {
    let mut ledger = Ledger::default();
    for (id, time, local) in [
        ("before", 49, false),
        ("first", 50, false),
        ("second", 80, false),
        ("unknown", 90, false),
        ("local", 95, true),
        ("end", 100, false),
        ("future", 101, false),
    ] {
        ledger.apply(started(id, time, local)).unwrap();
        if !local && id != "unknown" {
            ledger
                .apply(usage(id, "response", 1, Some(0.25), true))
                .unwrap();
        }
    }
    let chart_query = Query {
        chart_boundaries_ms: vec![50, 80, 90, 100],
        ..query()
    };
    let summary = ledger.summary(&chart_query).unwrap();
    assert_eq!(summary.chart_buckets.len(), 3);
    assert_eq!(summary.chart_buckets[0].calls, 1);
    assert_eq!(summary.chart_buckets[0].known_estimated_usd, 0.25);
    assert_eq!(summary.chart_buckets[1].known_estimated_usd, 0.25);
    assert_eq!(summary.chart_buckets[2].calls, 2);
    assert_eq!(summary.chart_buckets[2].unknown_cost_calls, 1);
    assert_eq!(summary.chart_buckets[2].incomplete_calls, 1);
    let filtered = ledger
        .summary(&Query {
            provider: Some(VoiceUsageProvider::Openai),
            ..chart_query
        })
        .unwrap();
    assert_eq!(filtered.chart_buckets[2].calls, 1);
    assert_eq!(filtered.chart_buckets[2].unknown_cost_calls, 1);
    assert_eq!(filtered.chart_buckets[2].known_estimated_usd, 0.0);
    assert_eq!(filtered.totals["month"].calls, 4);
}

#[test]
fn chart_rejects_invalid_boundaries_and_supports_unequal_calendar_days() {
    let ledger = Ledger::default();
    for boundaries in [
        vec![10],
        vec![20, 10],
        vec![10, 10],
        vec![0; MAX_CHART_BUCKETS + 2],
    ] {
        assert!(
            ledger
                .summary(&Query {
                    chart_boundaries_ms: boundaries,
                    ..query()
                })
                .is_err()
        );
    }
    let summary = ledger
        .summary(&Query {
            chart_boundaries_ms: vec![0, 23, 48, 72],
            ..query()
        })
        .unwrap();
    assert_eq!(summary.chart_buckets.len(), 3);
    assert!(summary.chart_buckets.iter().all(|bucket| bucket.calls == 0));
}
fn open(path: &std::path::Path) -> Store {
    Store::open(path, crate::runtime().unwrap()).unwrap()
}
#[test]
fn upgrades_existing_app_storage_and_preserves_history_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.db");
    let mut store = open(&path);
    store
        .write(
            vec![AppStorageEntry {
                key: "herdr.device.preferences.v3".into(),
                value: Some("{}".into()),
            }],
            true,
        )
        .unwrap();
    assert!(Ledger::load(&store).unwrap().calls.is_empty());
    record(&mut store, started("local", 10, true)).unwrap();
    record(
        &mut store,
        VoiceUsageEvent::Ended {
            session_id: "local".into(),
            ended_at_ms: 20,
        },
    )
    .unwrap();
    drop(store);
    let store = open(&path);
    assert_eq!(Ledger::load(&store).unwrap().calls.len(), 1);
    assert_eq!(
        store
            .read(vec!["herdr.device.preferences.v3".into()])
            .unwrap()[0]
            .value
            .as_deref(),
        Some("{}")
    );
}
#[test]
fn unsupported_or_corrupt_ledger_is_preserved_instead_of_reset() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("app.db"));
    store.write(vec![], true).unwrap();
    for raw in ["{\"version\":99,\"calls\":{}}", "broken"] {
        store
            .write(
                vec![AppStorageEntry {
                    key: KEY.into(),
                    value: Some(raw.into()),
                }],
                false,
            )
            .unwrap();
        assert!(record(&mut store, started("x", 1, true)).is_err());
        assert_eq!(
            store.read(vec![KEY.into()]).unwrap()[0].value.as_deref(),
            Some(raw)
        );
    }
}
#[test]
fn duplicates_revisions_and_reconnect_replay_never_double_bill() {
    let mut ledger = Ledger::default();
    ledger.apply(started("call", 90, false)).unwrap();
    ledger
        .apply(usage("call", "response", 1, Some(0.1), false))
        .unwrap();
    ledger
        .apply(usage("call", "response", 2, Some(0.2), true))
        .unwrap();
    ledger
        .apply(VoiceUsageEvent::Ended {
            session_id: "call".into(),
            ended_at_ms: 100,
        })
        .unwrap();
    ledger = serde_json::from_str(&serde_json::to_string(&ledger).unwrap()).unwrap();
    ledger.apply(started("call", 99, false)).unwrap();
    for (rev, cost) in [(1, 0.1), (2, 0.2), (3, 99.0)] {
        ledger
            .apply(usage("call", "response", rev, Some(cost), true))
            .unwrap();
    }
    ledger
        .apply(usage("call", "second-response", 1, Some(0.3), true))
        .unwrap();
    let summary = ledger.summary(&query()).unwrap();
    assert_eq!(summary.calls.len(), 1);
    assert_eq!(summary.calls[0].identity.started_at_ms, 90);
    assert_eq!(
        summary.calls[0].status,
        AccountingStatus::ProviderUsageFinalized
    );
    assert_eq!(summary.totals["lifetime"].known_estimated_usd, 0.5);
}
#[test]
fn unknown_billing_and_interruption_are_never_presented_as_zero_or_active() {
    let mut ledger = Ledger::default();
    ledger.apply(started("call", 90, false)).unwrap();
    ledger
        .apply(usage("call", "response", 1, None, true))
        .unwrap();
    let summary = ledger.summary(&query()).unwrap();
    assert_eq!(summary.calls[0].estimated_usd, None);
    assert_eq!(summary.calls[0].status, AccountingStatus::Incomplete);
    ledger
        .apply(VoiceUsageEvent::Ended {
            session_id: "call".into(),
            ended_at_ms: 100,
        })
        .unwrap();
    assert_eq!(
        ledger.calls["call"].status(),
        AccountingStatus::ProviderUsageFinalized
    );
    ledger.apply(started("interrupted", 95, false)).unwrap();
    ledger.apply(VoiceUsageEvent::Recover).unwrap();
    let call = ledger.calls["interrupted"].view();
    assert!(!call.active);
    assert_eq!(call.ended_at_ms, None);
    assert_eq!(call.status, AccountingStatus::Incomplete);
    assert_eq!(call.remote_agent_estimated_usd, None);
}

#[test]
fn partial_call_keeps_known_charges_through_recovery_and_late_usage() {
    let mut ledger = Ledger::default();
    ledger.apply(started("partial", 90, false)).unwrap();
    ledger
        .apply(usage("partial", "response", 1, Some(0.25), true))
        .unwrap();
    ledger
        .apply(usage("partial", "caption", 1, None, false))
        .unwrap();
    ledger.apply(VoiceUsageEvent::Recover).unwrap();
    ledger = serde_json::from_str(&serde_json::to_string(&ledger).unwrap()).unwrap();
    let chart_query = Query {
        chart_boundaries_ms: vec![80, 100],
        ..query()
    };
    let summary = ledger.summary(&chart_query).unwrap();
    let call = &summary.calls[0];
    assert_eq!(call.estimated_usd, None);
    assert_eq!(call.known_estimated_usd, Some(0.25));
    assert_eq!(call.status, AccountingStatus::Incomplete);
    assert!(!call.active);
    assert_eq!(summary.totals["lifetime"].known_estimated_usd, 0.25);
    assert_eq!(summary.totals["lifetime"].unknown_cost_calls, 1);
    assert_eq!(summary.chart_buckets[0].known_estimated_usd, 0.25);
    assert_eq!(summary.chart_buckets[0].unknown_cost_calls, 1);
    ledger
        .apply(usage("partial", "caption", 2, Some(0.05), true))
        .unwrap();
    ledger
        .apply(usage("partial", "caption", 2, Some(0.05), true))
        .unwrap();
    let summary = ledger.summary(&chart_query).unwrap();
    assert_eq!(summary.calls[0].estimated_usd, Some(0.3));
    assert_eq!(summary.totals["lifetime"].known_estimated_usd, 0.3);
    assert_eq!(summary.totals["lifetime"].unknown_cost_calls, 0);
    assert_eq!(summary.totals["lifetime"].incomplete_calls, 1);
}
#[test]
fn local_cost_is_zero_but_remote_agent_cost_is_unknown_and_local_cannot_accept_billing() {
    let mut ledger = Ledger::default();
    ledger.apply(started("local", 90, true)).unwrap();
    assert!(
        ledger
            .apply(usage("local", "x", 1, Some(2.0), true))
            .is_err()
    );
    let call = ledger.calls["local"].view();
    assert_eq!(call.estimated_usd, Some(0.0));
    assert_eq!(call.remote_agent_estimated_usd, None);
}
#[test]
fn periods_use_inclusive_call_start_boundaries_and_filters_also_apply_to_totals() {
    let mut ledger = Ledger::default();
    for (id, time, local) in [
        ("old", 49, false),
        ("month", 50, false),
        ("week", 80, false),
        ("today", 90, false),
        ("local", 91, true),
        ("future", 101, false),
    ] {
        ledger.apply(started(id, time, local)).unwrap();
        if !local {
            ledger
                .apply(usage(id, "response", 1, Some(1.0), true))
                .unwrap();
        }
    }
    ledger.apply(started("unknown", 95, false)).unwrap();
    let summary = ledger.summary(&query()).unwrap();
    for (period, cost, calls) in [
        ("today", 1.0, 3),
        ("week", 2.0, 4),
        ("month", 3.0, 5),
        ("lifetime", 4.0, 6),
    ] {
        let total = &summary.totals[period];
        assert_eq!(total.calls, calls);
        assert_eq!(total.known_estimated_usd, cost);
        assert_eq!(total.unknown_cost_calls, 1);
    }
    let summary = ledger
        .summary(&Query {
            provider: Some(VoiceUsageProvider::Local),
            ..query()
        })
        .unwrap();
    assert_eq!(summary.totals["lifetime"].calls, 1);
    assert_eq!(summary.totals["lifetime"].unknown_cost_calls, 0);
    let summary = ledger
        .summary(&Query {
            mode: Some(VoiceUsageMode::Live),
            ..query()
        })
        .unwrap();
    assert_eq!(summary.totals["lifetime"].calls, 0);
    let VoiceUsageEvent::Started { mut call } = started("global", 95, false) else {
        panic!("Expected start");
    };
    call.scope = VoiceUsageScope::Global;
    ledger.apply(VoiceUsageEvent::Started { call }).unwrap();
    ledger
        .apply(usage("global", "response", 1, Some(2.0), true))
        .unwrap();
    let global = ledger
        .summary(&Query {
            scope: Some(VoiceUsageScope::Global),
            ..query()
        })
        .unwrap();
    assert_eq!(global.calls.len(), 1);
    assert_eq!(global.calls[0].identity.session_id, "global");
    assert_eq!(global.totals["lifetime"].calls, 1);
    assert_eq!(global.totals["lifetime"].known_estimated_usd, 2.0);
    let agents = ledger
        .summary(&Query {
            scope: Some(VoiceUsageScope::Agent),
            ..query()
        })
        .unwrap();
    assert!(
        !agents
            .calls
            .iter()
            .any(|call| call.identity.session_id == "global")
    );
}
#[test]
fn rejects_sensitive_fields_invalid_quantities_and_unversioned_estimates() {
    assert!(
        serde_json::from_str::<VoiceUsageEvent>(
            r#"{"kind":"ended","session_id":"x","ended_at_ms":2,"transcript":"private"}"#
        )
        .is_err()
    );
    let mut ledger = Ledger::default();
    ledger.apply(started("x", 1, false)).unwrap();
    assert!(ledger.apply(usage("x", "r", 1, Some(-1.0), true)).is_err());
    let VoiceUsageEvent::Usage { mut item, .. } = usage("x", "r", 1, Some(1.0), true) else {
        unreachable!()
    };
    item.price_snapshot = None;
    assert!(
        ledger
            .apply(VoiceUsageEvent::Usage {
                session_id: "x".into(),
                item_id: "r".into(),
                item
            })
            .is_err()
    );
}

#[test]
fn committed_finalization_replays_after_database_restart_without_duplicate_totals() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.db");
    let mut store = open(&path);
    store.write(vec![], true).unwrap();
    record(&mut store, started("call", 90, false)).unwrap();
    record(&mut store, usage("call", "response", 1, Some(0.25), true)).unwrap();
    record(
        &mut store,
        VoiceUsageEvent::Ended {
            session_id: "call".into(),
            ended_at_ms: 95,
        },
    )
    .unwrap();
    drop(store);
    let mut store = open(&path);
    record(&mut store, started("call", 99, false)).unwrap();
    record(&mut store, usage("call", "response", 1, Some(0.25), true)).unwrap();
    record(
        &mut store,
        VoiceUsageEvent::Ended {
            session_id: "call".into(),
            ended_at_ms: 100,
        },
    )
    .unwrap();
    let summary = Ledger::load(&store).unwrap().summary(&query()).unwrap();
    drop(store);
    assert_eq!(summary.totals["today"].calls, 1);
    assert_eq!(summary.totals["today"].known_estimated_usd, 0.25);
    assert_eq!(summary.calls[0].ended_at_ms, Some(95));
    assert_eq!(
        summary.calls[0].status,
        AccountingStatus::ProviderUsageFinalized
    );
}

#[test]
fn deleting_history_is_durable_and_late_usage_cannot_restore_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.db");
    let mut store = open(&path);
    store.write(vec![], true).unwrap();
    record(&mut store, started("call", 90, false)).unwrap();
    record(&mut store, started("keep", 91, false)).unwrap();
    record(&mut store, usage("call", "response", 1, Some(0.25), true)).unwrap();
    let captions = r#"[{"id":"call","model":"gpt-realtime-1.5","endedAtMs":95,"fragments":[{"id":"user","role":"user","text":"Delete me"}]},{"id":"keep","model":"gpt-live-1","endedAtMs":96,"fragments":[]}]"#;
    store
        .write(
            vec![AppStorageEntry {
                key: crate::voice_history::KEY.into(),
                value: Some(captions.into()),
            }],
            false,
        )
        .unwrap();
    delete_history_entry(&mut store, "call").unwrap();
    delete_history_entry(&mut store, "call").unwrap();
    drop(store);
    let mut store = open(&path);
    record(&mut store, started("call", 90, false)).unwrap();
    record(&mut store, usage("call", "late", 2, Some(0.5), true)).unwrap();
    record(
        &mut store,
        VoiceUsageEvent::Ended {
            session_id: "call".into(),
            ended_at_ms: 100,
        },
    )
    .unwrap();
    let summary = Ledger::load(&store).unwrap().summary(&query()).unwrap();
    assert_eq!(summary.calls.len(), 1);
    assert_eq!(summary.calls[0].identity.session_id, "keep");
    assert_eq!(summary.totals["today"].known_estimated_usd, 0.0);
    let saved = store.read(vec![crate::voice_history::KEY.into()]).unwrap();
    drop(store);
    let saved: serde_json::Value =
        serde_json::from_str(saved[0].value.as_deref().unwrap()).unwrap();
    assert_eq!(saved.as_array().unwrap().len(), 1);
    assert_eq!(saved[0]["id"], "keep");
}

#[test]
fn failed_history_deletion_does_not_partially_remove_usage() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("app.db"));
    store.write(vec![], true).unwrap();
    record(&mut store, started("call", 90, false)).unwrap();
    store
        .write(
            vec![AppStorageEntry {
                key: crate::voice_history::KEY.into(),
                value: Some("broken".into()),
            }],
            false,
        )
        .unwrap();
    assert!(delete_history_entry(&mut store, "call").is_err());
    assert!(Ledger::load(&store).unwrap().calls.contains_key("call"));
    drop(store);
}
