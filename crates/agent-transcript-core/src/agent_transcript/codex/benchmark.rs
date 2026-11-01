//! Opt-in allocation benchmark of the production adapter, JSONL ingestion, and
//! full raw-cache restoration. Fixtures and correctness checks are not measured.

use std::hint::black_box;

use super::*;
use crate::test_allocations::measured_with_peak;

const SAMPLES: usize = 5;
const CHUNK_BYTES: usize = 64 * 1024;
const STEADY_RECORDS: usize = 1_000;
const SESSION_ID: &str = "thread";

fn sample<T>(mut operation: impl FnMut() -> T, mut validate: impl FnMut(&T)) -> Value {
    // Warm the same operation before recording allocations and timings.
    validate(&black_box(operation()));
    let mut samples = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let (value, ns, allocations, bytes, peak) = measured_with_peak(&mut operation);
        validate(black_box(&value));
        samples.push((ns, allocations, bytes, peak));
    }
    samples.sort_unstable();
    let (ns, allocations, bytes, peak) = samples[SAMPLES / 2];
    serde_json::json!({
        "ns": ns, "minNs": samples[0].0, "maxNs": samples[SAMPLES - 1].0,
        "allocations": allocations, "allocatedBytes": bytes, "peakAllocatedBytes": peak
    })
}

fn fixture(turns: usize, mode: CodexHistoryMode) -> Vec<u8> {
    let mut bytes = tests::history_header(Some(serde_json::json!(mode)));
    for turn in 0..turns {
        // Repeated context is common; the directory is unchanged after the header.
        serde_json::to_writer(
            &mut bytes,
            &serde_json::json!({
                "type":"turn_context", "payload":{
                    "turn_id":format!("turn-{turn}"), "cwd":"/repo", "model":"fixture-model"
                }
            }),
        )
        .unwrap();
        bytes.push(b'\n');
        bytes.extend(tests::history_turn(turn, mode));
    }
    bytes
}

fn ingest(bytes: &[u8]) -> CodexSessionCore {
    let mut core = CodexSessionCore::new(SESSION_ID);
    let binding = core.bind_source("/rollout".into(), "1:2".into(), bytes.len() as u64);
    for chunk in bytes.chunks(CHUNK_BYTES) {
        let result = core
            .ingest(binding.source_generation, black_box(chunk))
            .unwrap();
        assert_eq!(result.malformed_records, 0);
        black_box(result);
    }
    core
}

#[test]
#[ignore = "run via npm run benchmark:codex-ingestion; release microbenchmark"]
fn ingestion_benchmark() {
    let mut results = Vec::new();
    for mode in [CodexHistoryMode::Legacy, CodexHistoryMode::Paginated] {
        for turns in [100, 1_000, 2_500] {
            let bytes = fixture(turns, mode);
            let records: Vec<Value> = bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .map(|line| serde_json::from_slice(line).unwrap())
                .collect();
            let mut core = ingest(&bytes);
            let expected = core.state();
            assert_eq!(expected.messages.len(), turns * 2);
            assert_eq!(expected.turns.len(), turns);
            assert_eq!(
                expected.info.as_ref().unwrap().title.as_deref(),
                Some("question 0")
            );
            let cache = core.cache_blob().unwrap();

            // An irrelevant top-level record with no payload isolates metadata
            // comparisons: decoding/projection themselves need no allocations.
            let neutral = serde_json::json!({"type":"realtime_item"});
            let steady = sample(
                || {
                    for _ in 0..STEADY_RECORDS {
                        black_box(core.adapter.accept_incremental(black_box(&neutral)));
                    }
                },
                |()| {},
            );
            let replay = sample(
                || {
                    let mut adapter = CodexTranscriptAdapter::new(SESSION_ID);
                    for record in &records {
                        black_box(adapter.accept_incremental(black_box(record)));
                    }
                    adapter
                },
                |adapter| {
                    let actual = adapter.snapshot(0, AgentTranscriptStatus::Live, None);
                    assert_eq!(actual.messages, expected.messages);
                    assert_eq!(actual.turns, expected.turns);
                    assert_eq!(actual.info, expected.info);
                },
            );
            let ingestion = sample(
                || ingest(black_box(&bytes)),
                |actual| {
                    let actual_state = actual.state();
                    assert_eq!(actual_state, expected);
                    assert_eq!(actual.committable_offset(), bytes.len() as u64);
                },
            );
            let restoration = sample(
                || {
                    let mut restored = CodexSessionCore::new(SESSION_ID);
                    let state = restored.restore_cache(black_box(&cache)).unwrap();
                    // Keep both the core and the returned snapshot alive, as the
                    // production restore API does at its handoff to the owner.
                    (restored, state)
                },
                |(restored, state)| {
                    assert_eq!(state.messages, expected.messages);
                    assert_eq!(state.turns, expected.turns);
                    assert_eq!(state.info, expected.info);
                    assert_eq!(restored.committed_offset(), bytes.len() as u64);
                },
            );
            results.push(serde_json::json!({
                "historyMode":mode, "turns":turns, "records":records.len(),
                "jsonlBytes":bytes.len(), "cacheBytes":cache.len(),
                "steadyRecords":STEADY_RECORDS, "steadyRecord":steady,
                "adapterReplay":replay, "ingest":ingestion, "restoreCache":restoration
            }));
        }
    }
    println!(
        "CODEX_INGESTION_BENCH={}",
        serde_json::json!({
            "samples":SAMPLES, "chunkBytes":CHUNK_BYTES, "results":results
        })
    );
}
