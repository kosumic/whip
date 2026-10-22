//! Opt-in native microbenchmark; excludes SSH, JS persistence, and UI work.
use std::hint::black_box;

use super::*;
use crate::herdr_api::HerdrAgentKind;
use crate::test_allocations::measured_with_peak;

const BATCHES: usize = 10;
const EVENT_APPLICATION: &str = "event_application";
const EAGER_CACHE_BURST: &str = "eager_cache_burst";
const LAZY_CACHE_BURST: &str = "lazy_cache_burst";

fn fixture(panes: usize) -> HostState {
    let mut snapshot = tests::snapshot();
    snapshot.panes = (1..=panes)
        .map(|index| tests::pane(&format!("p{index}"), "w1", "t1", HerdrAgentStatus::Idle))
        .collect();
    snapshot.agents = snapshot
        .panes
        .iter()
        .map(|pane| {
            let mut agent = tests::agent(&pane.pane_id, HerdrAgentKind::Codex, &pane.pane_id);
            agent.agent_status = pane.agent_status;
            agent
        })
        .collect();
    let mut state = HostState::default();
    state.connection_installed(1);
    let token = state.begin_sync(1);
    assert_eq!(
        state.complete_sync(token, snapshot, 1),
        ApplyResult::Applied
    );
    state.take_agent_status_transitions();
    state
}

fn events(state: &HostState, kind: &str) -> Vec<HerdrEvent> {
    let pane = state.snapshot.as_ref().unwrap().panes.last().unwrap();
    (0..BATCHES)
        .map(|index| match kind {
            "status" => HerdrEvent::PaneAgentStatusChanged {
                workspace_id: pane.workspace_id.clone(),
                pane_id: pane.pane_id.clone(),
                agent_status: if index % 2 == 0 {
                    HerdrAgentStatus::Working
                } else {
                    HerdrAgentStatus::Idle
                },
                agent: Some("codex".into()),
                title: None,
                display_agent: None,
                state_labels: None,
            },
            "focus" => HerdrEvent::PaneFocused {
                workspace_id: pane.workspace_id.clone(),
                pane_id: if index % 2 == 0 {
                    pane.pane_id.clone()
                } else {
                    "p1".into()
                },
            },
            "scroll" => HerdrEvent::PaneScrollChanged {
                workspace_id: pane.workspace_id.clone(),
                pane_id: pane.pane_id.clone(),
                scroll: tests::scroll_info(index as f64),
            },
            "structural" => {
                let mut pane = pane.clone();
                pane.label = Some(format!("updated-{index}"));
                HerdrEvent::PaneUpdated { pane }
            }
            _ => unreachable!(),
        })
        .collect()
}

fn measure<T>(panes: usize, event: &str, phase: &str, operation: impl FnOnce() -> T) {
    let (_, ns, allocations, bytes, peak) = measured_with_peak(operation);
    println!(
        "{}",
        serde_json::json!({
            "panes": panes, "event": event, "phase": phase, "batches": BATCHES,
            "ns": ns, "allocations": allocations, "allocatedBytes": bytes, "peakLiveIncreaseBytes": peak,
        })
    );
}

#[test]
#[ignore = "release microbenchmark; run host_state::benchmark with --ignored --nocapture"]
fn event_and_cache_benchmark() {
    for panes in [10, 100, 1_000] {
        let mut state = fixture(panes);
        let snapshot = state.snapshot.as_mut().unwrap();
        measure(panes, "all", "validation", || {
            for _ in 0..BATCHES {
                validate_snapshot(black_box(snapshot)).unwrap();
            }
        });
        measure(panes, "all", "normalization", || {
            for _ in 0..BATCHES {
                normalize_snapshot(black_box(snapshot));
            }
        });
        measure(panes, "all", "cache_export", || {
            for _ in 0..BATCHES {
                black_box(state.export_offline_cache(None).unwrap());
            }
        });
        measure(panes, "all", "projection", || {
            for _ in 0..BATCHES {
                black_box(state.projection());
            }
        });
        measure(panes, "all", "projection_and_uniffi", || {
            for _ in 0..BATCHES {
                let mut wire = Vec::new();
                <HostStateSnapshot as uniffi::Lower<crate::UniFfiTag>>::write(
                    state.projection(),
                    &mut wire,
                );
                black_box(wire);
            }
        });
        for kind in ["status", "focus", "scroll", "structural"] {
            for phase in [EVENT_APPLICATION, EAGER_CACHE_BURST, LAZY_CACHE_BURST] {
                let mut state = fixture(panes);
                let events = events(&state, kind);
                measure(panes, kind, phase, move || {
                    for (index, event) in events.into_iter().enumerate() {
                        assert_eq!(
                            state.apply_event(1, event, index as u64 + 2),
                            ApplyResult::Applied
                        );
                        if phase == EVENT_APPLICATION {
                            continue;
                        }
                        let projection = state.projection();
                        if phase == EAGER_CACHE_BURST {
                            // Model the previous per-revision encode plus the
                            // blob clone copied into each host-state emission.
                            let export = state.export_offline_cache(None).unwrap();
                            black_box((projection, export.blob.clone(), export));
                        } else {
                            black_box(projection);
                        }
                    }
                    if phase == LAZY_CACHE_BURST {
                        black_box(state.export_offline_cache(None).unwrap());
                    }
                });
            }
        }
    }
}
