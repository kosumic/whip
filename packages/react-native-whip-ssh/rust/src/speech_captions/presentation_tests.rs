use super::*;
use crate::speech_captions::{Caption, Captions};
use serde_json::{Value, json};

fn send(state: &mut Captions, command: Value) -> Value {
    serde_json::from_str(&apply(
        state,
        serde_json::from_value(command).unwrap_or_else(|error| panic!("{error}")),
    ))
    .unwrap_or_else(|error| panic!("{error}"))
}
fn bind(state: &mut Captions, text: &str, start: usize) -> u64 {
    state.sequence += 1;
    let id = state.sequence;
    let mut caption = Caption {
        id,
        ..Caption::default()
    };
    caption.start(text, 0);
    state.pending.push_back(caption);
    send(
        state,
        json!({"action":"bind", "id":id, "lease":1, "owner":"reader", "source": {
            "hostId":"host", "paneId":"pane", "bindingTokens":["binding"], "messageId":"reply", "partId":"text", "text":text, "startUtf16":start
        }}),
    );
    id
}

#[test]
fn new_caption_without_a_marker_keeps_the_boundary_and_upcoming_presentation() {
    let mut state = Captions::default();
    let first = bind(&mut state, "Hello", 0);
    let speaking = send(
        &mut state,
        json!({"action":"range", "id":first, "start":0, "end":5}),
    );
    assert_eq!(speaking["spokenEndUtf16"], 0);
    assert_eq!(
        speaking["currentWordRangeUtf16"],
        json!({"start":0,"end":5})
    );
    let waiting = send(&mut state, json!({"action":"buffer", "id":first}));
    assert_eq!(waiting["spokenEndUtf16"], 5);
    let next = bind(&mut state, " world", 5);
    let snapshot = state
        .presentation
        .as_ref()
        .unwrap_or_else(|| panic!("missing caption"));
    assert_eq!(snapshot.phase, Phase::Preparing);
    assert_eq!(snapshot.spoken_end_utf16, 5);
    assert_eq!(
        snapshot.current_word_range_utf16,
        Some(WordRange { start: 0, end: 5 })
    );
    // The old highlighter returns unchanged Markdown at this cursor. Explicit
    // presentation still dims the suffix, with independent heard/current ranges.
    assert_eq!(
        crate::speech_captions::chat_speech_highlight("Hello world".into(), 11, " world".into(), 5),
        "Hello world"
    );
    let projected: Value = serde_json::from_str(&chat_speech_presentation(
        "Hello world".into(),
        serde_json::to_string(snapshot).unwrap_or_else(|error| panic!("{error}")),
    ))
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(projected["spokenEnd"], 5);
    assert_eq!(
        send(
            &mut state,
            json!({"action":"clear", "id":first,"reason":"stopped"})
        ),
        Value::Null
    );
    assert_eq!(
        state
            .presentation
            .as_ref()
            .unwrap_or_else(|| panic!("missing caption"))
            .id,
        next
    );
}

#[test]
fn duplicate_backward_invalid_and_late_ranges_cannot_advance_or_replace_the_source() {
    let mut state = Captions::default();
    let id = bind(&mut state, "One two three", 0);
    send(
        &mut state,
        json!({"action":"range","id":id,"start":4,"end":7}),
    );
    let before = state.presentation.clone();
    send(
        &mut state,
        json!({"action":"range","id":id,"start":0,"end":3}),
    );
    assert_eq!(state.presentation, before);
    for (start, end) in [(4, 7), (7, 4), (0, 999), (999, 1000)] {
        send(
            &mut state,
            json!({"action":"range","id":id,"start":start,"end":end}),
        );
        assert_eq!(state.presentation, before);
    }
    send(
        &mut state,
        json!({"action":"clear","id":id,"reason":"shake"}),
    );
    assert_eq!(
        state
            .presentation
            .as_ref()
            .unwrap_or_else(|| panic!("missing caption"))
            .phase,
        Phase::Cancelled
    );
    assert_eq!(
        send(
            &mut state,
            json!({"action":"range","id":id,"start":8,"end":13})
        ),
        Value::Null
    );
}

#[test]
fn generation_and_stalled_pcm_never_supply_playback_evidence() {
    let mut state = Captions::default();
    let id = bind(&mut state, "One two three", 0);
    let caption = state
        .pending
        .back_mut()
        .unwrap_or_else(|| panic!("missing caption"));
    caption.generated_samples = Some(48_000);
    let snapshot = state
        .presentation
        .as_mut()
        .unwrap_or_else(|| panic!("missing caption"));
    pcm(snapshot, caption, 13, 0, 48_000);
    assert_eq!(snapshot.spoken_end_utf16, 0);
    pcm(snapshot, caption, 4, 12_000, 48_000);
    assert_eq!(snapshot.spoken_end_utf16, 4);
    pcm(snapshot, caption, 13, 12_000, 48_000);
    pcm(snapshot, caption, 13, 6_000, 48_000);
    pcm(snapshot, caption, 13, 60_000, 48_000);
    assert_eq!(snapshot.spoken_end_utf16, 4);
    assert_eq!(snapshot.id, id);
}

#[test]
fn projection_preserves_markdown_utf16_cjk_and_streaming_extensions() {
    let mut state = Captions::default();
    let markdown = "👋 **你好** [world](https://example.com) `two words` $some math$";
    let prose = crate::chat_speech::spoken_prose(markdown);
    let id = bind(&mut state, &prose, 0);
    send(
        &mut state,
        json!({"action":"range","id":id,"start":4,"end":5}),
    );
    let snapshot = serde_json::to_string(
        &state
            .presentation
            .as_ref()
            .unwrap_or_else(|| panic!("missing caption")),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    for source in [
        markdown.to_owned(),
        format!("{markdown} more unspoken text"),
    ] {
        let plan: Value = serde_json::from_str(&chat_speech_presentation(source, snapshot.clone()))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(plan["spokenEnd"], 6);
        assert_eq!(plan["currentWord"], json!({"start":6,"end":7}));
    }
    let rewritten: Value =
        serde_json::from_str(&chat_speech_presentation("rewritten".into(), snapshot))
            .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(rewritten["spokenEnd"], 0);
    assert!(rewritten["currentWord"].is_null());
}

#[test]
fn punctuation_has_no_current_word_but_does_not_finish_presentation() {
    let mut state = Captions::default();
    bind(&mut state, "Hi... next", 0);
    let caption = state
        .pending
        .back()
        .unwrap_or_else(|| panic!("missing caption"));
    let snapshot = state
        .presentation
        .as_mut()
        .unwrap_or_else(|| panic!("missing caption"));
    pcm(snapshot, caption, 3, 100, 200);
    assert_eq!(snapshot.phase, Phase::Speaking);
    assert_eq!(snapshot.current_word_range_utf16, None);
    assert_eq!(snapshot.spoken_end_utf16, 3);
    let plan: Value = serde_json::from_str(&chat_speech_presentation(
        "Hi... next".into(),
        serde_json::to_string(snapshot).unwrap_or_else(|error| panic!("{error}")),
    ))
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(plan["spokenEnd"], 3);
    assert!(plan["currentWord"].is_null());
    // Once a word was confirmed, a punctuation/gap tick retains its emphasis
    // without changing the independently confirmed spoken boundary.
    snapshot.spoken_end_utf16 = 0;
    snapshot.played_frames = 0;
    pcm(snapshot, caption, 1, 100, 500);
    pcm(snapshot, caption, 3, 200, 500);
    assert_eq!(snapshot.spoken_end_utf16, 3);
    assert_eq!(
        snapshot.current_word_range_utf16,
        Some(WordRange { start: 0, end: 2 })
    );
}

#[test]
fn local_call_offsets_are_normalized_once_and_do_not_escape_the_chat_identity() {
    let source = json!({"localToken":"call-speech", "messageId":"local-reply", "text":"world", "startUtf16":25,
        "chat":{"hostId":"host","paneId":"pane","bindingTokens":["binding"],"messageId":"chat-reply","partId":"part","startUtf16":6}});
    let snapshot = source_snapshot(1, 7, "call-speech".into(), source)
        .unwrap_or_else(|| panic!("missing local snapshot"));
    assert_eq!(snapshot.message_id, "chat-reply");
    assert_eq!(snapshot.start_utf16, 6);
    let local = snapshot
        .local
        .as_ref()
        .unwrap_or_else(|| panic!("missing local source"));
    assert_eq!(local.message_id, "local-reply");
    assert_eq!(local.start_utf16, 25);
    assert_eq!(local.token, "call-speech");
    let mut other = snapshot.clone();
    other.lease += 1;
    assert!(!snapshot.same_source(&other));
    other = snapshot.clone();
    other.part_id = "different".into();
    assert!(!snapshot.same_source(&other));
    other = snapshot.clone();
    other.binding_tokens = vec!["different".into()];
    assert!(!snapshot.same_source(&other));
}
