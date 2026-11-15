#![allow(clippy::unwrap_used, reason = "test assertions")]

use super::*;

const REQUEST: &str = "like how many exercises does it have";

fn caption(id: &str, text: &str) -> Caption {
    Caption::new(id, "user", text, true, false, false, None)
}

fn payload(snapshot: &Snapshot, request: &str) -> serde_json::Value {
    let text = snapshot.request(request).unwrap();
    serde_json::from_str(text.strip_prefix(PREAMBLE).unwrap()).unwrap()
}

#[test]
fn fit3d_context_is_ordered_quoted_and_acknowledged_once() {
    let context = Context::default();
    let captions = || {
        vec![
            caption("question", "Tell me about the Fit3D dataset"),
            Caption::new(
                "answer",
                "assistant",
                "Fit3D records exercises",
                true,
                false,
                true,
                Some(5),
            ),
        ]
    };
    let first = context.capture(captions()).unwrap();
    let data = payload(&first, REQUEST);
    assert_eq!(data["request"], REQUEST);
    assert_eq!(data["voice_context"]["messages"][0]["role"], "user");
    assert_eq!(
        data["voice_context"]["messages"][0]["text"],
        "Tell me about the Fit3D dataset"
    );
    assert_eq!(data["voice_context"]["messages"][1]["role"], "assistant");
    assert_eq!(data["voice_context"]["messages"][1]["interrupted"], true);
    assert_eq!(data["voice_context"]["messages"][1]["heardUtf16"], 5);
    // Preparing a request, a failed write or uncertain admission cannot consume
    // the cursor. Only the host acknowledgment advances it.
    assert_eq!(payload(&first, REQUEST), data);
    let deferred = context.capture(captions()).unwrap();
    first.acknowledge();
    assert_eq!(deferred.request(REQUEST).unwrap(), REQUEST);
    assert_eq!(
        context
            .capture(captions())
            .unwrap()
            .request(REQUEST)
            .unwrap(),
        REQUEST
    );
}

#[test]
fn revisions_and_out_of_order_deferred_acknowledgments_do_not_replay_old_captions() {
    let context = Context::default();
    let old = context.capture(vec![caption("user", "Fit free")]).unwrap();
    let revised = context.capture(vec![caption("user", "Fit3D")]).unwrap();
    old.acknowledge();
    let data = payload(&revised, "follow up");
    assert_eq!(data["voice_context"]["messages"][0]["replacement"], true);
    assert_eq!(data["voice_context"]["messages"][0]["text"], "Fit3D");
    revised.acknowledge();
    old.acknowledge();
    assert_eq!(old.request("exact task").unwrap(), "exact task");
    assert_eq!(
        context
            .capture(vec![caption("user", "Fit3D")])
            .unwrap()
            .request(REQUEST)
            .unwrap(),
        REQUEST
    );
    // A new call/binding has a fresh cursor; nothing is acknowledged globally.
    assert!(
        Context::default()
            .capture(vec![caption("user", "Fit3D")])
            .unwrap()
            .request(REQUEST)
            .unwrap()
            .contains("Fit3D")
    );
}

#[test]
fn snapshots_freeze_deferred_input_and_bound_unicode_context() {
    let context = Context::default();
    let snapshot = context
        .capture(
            (0..100)
                .map(|index| caption(&index.to_string(), &"日本語 👋".repeat(500)))
                .collect(),
        )
        .unwrap();
    let data = payload(&snapshot, "  exact\nrequest 👋  ");
    assert_eq!(data["request"], "  exact\nrequest 👋  ");
    let messages = data["voice_context"]["messages"].as_array().unwrap();
    assert!(messages.len() <= MAX_RECORDS);
    assert!(serde_json::to_vec(messages).unwrap().len() <= MAX_TRANSCRIPT_BYTES + 2);
    assert_eq!(messages.last().unwrap()["id"], "99");
    assert!(
        messages
            .iter()
            .all(|message| message["text"].as_str().unwrap().len() <= MAX_TEXT_BYTES)
    );
    let later = context
        .capture(vec![caption("later", "unrelated newer speech")])
        .unwrap();
    later.acknowledge();
    assert_eq!(payload(&snapshot, "  exact\nrequest 👋  "), data);
}
