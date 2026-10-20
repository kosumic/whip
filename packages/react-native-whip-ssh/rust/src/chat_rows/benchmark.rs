//! Opt-in microbenchmark. Counts real allocations on the measured thread;
//! transport, canonical reconciliation and UI painting are deliberately excluded.
use super::*;
use crate::test_allocations::measured;

fn wire_bytes(update: AgentChatRowUpdate) -> usize {
    let mut bytes = Vec::new();
    <AgentChatRowUpdate as uniffi::Lower<crate::UniFfiTag>>::write(update, &mut bytes);
    bytes.len()
}

#[test]
#[ignore = "run via npm run benchmark:chat-rows; release microbenchmark"]
fn projection_benchmark() {
    const ITERATIONS: u64 = 500;
    let mut results = Vec::new();
    for turns in [100, 1_000, 2_500] {
        let mut state = super::tests::fixture(turns);
        let ((mut projection, initial), initial_ns, initial_allocs, initial_allocated_bytes) =
            measured(|| {
                let mut projection = RowProjection::default();
                projection.restore(&state);
                let initial = projection.poll(0, true, vec![]);
                (projection, initial)
            });
        let mut after = initial.revision;
        let initial_row_revision = after;
        let initial_wire_bytes = wire_bytes(initial);
        let mut stream_ns = 0;
        let mut stream_allocs = 0;
        let mut stream_bytes = 0;
        let mut stream_wire_bytes = 0;
        for revision in 1..=ITERATIONS {
            let last = state.messages.last_mut().unwrap();
            let AgentTranscriptPart::Text { text, .. } = &mut last.parts[0] else {
                panic!("text fixture");
            };
            text.push_str(" growing");
            let update = AgentTranscriptUpdate {
                revision,
                deltas: vec![AgentTranscriptDelta::MessageUpserted {
                    index: row_index(turns - 1),
                    message: last.clone(),
                }],
            };
            let (patch, ns, allocs, bytes) = measured(|| {
                projection.accept(&update);
                projection.poll(after, true, vec![])
            });
            after = patch.revision;
            assert_eq!(
                after, initial_row_revision,
                "text updates must not advance row revisions"
            );
            stream_ns += ns;
            stream_allocs += allocs;
            stream_bytes += bytes;
            stream_wire_bytes += wire_bytes(patch);
        }
        let stream_row_revision = after;
        let turn = state.turns.last_mut().unwrap();
        turn.diffs = (0..16)
            .map(|index| {
                AgentFileDiff::normalized(
                    format!("file{index}.rs"),
                    Some("+content".into()),
                    None,
                    None,
                    None,
                    None,
                )
            })
            .collect();
        projection.accept(&AgentTranscriptUpdate {
            revision: ITERATIONS + 1,
            deltas: vec![AgentTranscriptDelta::TurnUpserted {
                index: row_index(turns - 1),
                turn: turn.clone(),
            }],
        });
        let section = row_id(&[&turn.id, "changes"]);
        after = projection.poll(after, true, vec![]).revision;
        let (expanded, expand_ns, expand_allocs, _) =
            measured(|| projection.poll(after, true, vec![section]));
        let (collapsed, collapse_ns, collapse_allocs, _) =
            measured(|| projection.poll(expanded.revision, true, vec![]));
        results.push(serde_json::json!({ "turns": turns, "rows": turns * 2, "iterations": ITERATIONS,
            "initialNs": initial_ns, "initialAllocations": initial_allocs, "initialAllocatedBytes": initial_allocated_bytes,
            "initialWireBytes": initial_wire_bytes, "streamNs": stream_ns / u128::from(ITERATIONS),
            "streamAllocations": stream_allocs / ITERATIONS, "streamAllocatedBytes": stream_bytes / ITERATIONS,
            "streamRowRevision": stream_row_revision, "initialRowRevision": initial_row_revision,
            "streamWireBytes": stream_wire_bytes / usize::try_from(ITERATIONS).unwrap(), "expandNs": expand_ns, "collapseNs": collapse_ns,
            "expandAllocations": expand_allocs, "collapseAllocations": collapse_allocs,
            "expandWireBytes": wire_bytes(expanded), "collapseWireBytes": wire_bytes(collapsed) }));
    }
    println!("CHAT_ROWS_BENCH={}", serde_json::json!(results));
}
