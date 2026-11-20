//! Public API contracts, independent of Whip and mobile SDKs.
use speech_timeline::{
    Clock, Pace, ReadAloud, SAMPLE_RATE, SourceClock, StreamPace, Text, byte_offset, utf16_offset,
    word_after, word_at, word_ranges,
};

const RATE: usize = SAMPLE_RATE as usize;

#[test]
fn presentation_words_preserve_whip_unicode_and_punctuation_rules() {
    for (text, expected) in [
        ("Hello你好world", vec!["Hello", "你", "好", "world"]),
        (
            "cafe\u{301} can't don’t",
            vec!["cafe\u{301}", "can't", "don’t"],
        ),
        (
            "👋 Привет、かな 한글!",
            vec!["Привет", "か", "な", "한", "글"],
        ),
        ("a𠀀b 😀 123.", vec!["a", "𠀀", "b", "123"]),
    ] {
        let words: Vec<_> = word_ranges(text)
            .map(|r| &text[byte_offset(text, r.start)..byte_offset(text, r.end)])
            .collect();
        assert_eq!(words, expected);
    }
    assert_eq!(word_at("one two", 3), None);
    assert_eq!(word_after("one two", 3), Some(4..7));
    assert_eq!(word_after("one two", 7), None);
    assert_eq!(word_at("a𠀀b", 2), Some(1..3));
}

#[test]
fn offsets_clamp_and_never_split_utf8_or_surrogate_pairs() {
    let text = "👋e\u{301}你好𠀀";
    for (byte, _) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        let units = text[..byte].encode_utf16().count();
        assert_eq!(byte_offset(text, units), byte);
        assert_eq!(utf16_offset(text, byte), units);
    }
    assert_eq!(byte_offset(text, 1), 0);
    assert_eq!(utf16_offset(text, 3), 0);
    assert_eq!(byte_offset(text, usize::MAX), text.len());
    assert_eq!(utf16_offset(text, usize::MAX), text.encode_utf16().count());
}

#[test]
fn streaming_fragments_use_the_original_weighted_mapping() {
    let mut text = Text::default();
    for (fragment, units) in [
        ("e", 1),
        ("e\u{301}", 1),
        ("e\u{301}你", 4),
        ("e\u{301}你1!", 8),
    ] {
        text.update(fragment);
        assert_eq!(text.units, units);
    }
    let mut clock = Clock::new(Pace::default());
    assert_eq!(clock.advance_measured(&text, RATE / 8, RATE), 2);
    assert_eq!(clock.advance_measured(&text, RATE / 2, RATE), 3);
    assert_eq!(clock.advance_measured(&text, RATE, RATE), 5);
}

#[test]
fn generated_queued_and_delivered_audio_cannot_cross_the_prefix() {
    let prefix = "调试 👋 tab: ";
    let response = "One two three four five six.";
    let mut timeline = ReadAloud::default();
    timeline.start(
        &format!("{prefix}{response}"),
        prefix.encode_utf16().count(),
    );
    assert_eq!(timeline.prefix_bytes, prefix.len());
    timeline.generated_samples = Some(RATE * 4);
    // Even all audio delivered and generation finished supplies no played frames.
    assert_eq!(timeline.progress(0, RATE * 4, true), 0);
    assert_eq!(timeline.progress(RATE, RATE * 4, true), 0);
    timeline.response_start = Some(RATE * 2); // Includes response leading silence.
    assert_eq!(timeline.progress(RATE * 2, RATE * 4, true), 0);
    let first = timeline.progress(RATE * 2 + 1, RATE * 4, true);
    assert_eq!(first, prefix.encode_utf16().count());
    let half = timeline.progress(RATE * 3, RATE * 4, false);
    assert!(half > first && half < timeline.spoken.encode_utf16().count());
    assert_eq!(timeline.progress(RATE * 3, RATE * 4, true), half);
    assert_eq!(timeline.progress(RATE * 2 + 1, RATE * 4, true), half);
}

#[test]
fn measured_duration_and_rate_learning_need_further_playback() {
    let mut timeline = ReadAloud::default();
    timeline.start(&"word ".repeat(40), 0);
    let before = timeline.progress(RATE, RATE * 4, false);
    timeline.generated_samples = Some(RATE * 4);
    assert_eq!(timeline.progress(RATE, RATE * 4, true), before);
    assert!(timeline.progress(RATE + RATE / 50, RATE * 4, true) > before);
    let mut learning = StreamPace::new(Pace::default());
    assert!(learning.observe(10, RATE).is_none());
    assert!(learning.observe(24, RATE * 2).is_some());
    assert!(learning.observe(24, RATE * 20).is_none());
    // Counter resets start a fresh observation window rather than underflowing.
    assert!(learning.observe(1, RATE).is_none());
}

#[test]
fn interruption_keeps_old_clock_and_restart_resets_prefix_and_duration() {
    let mut old = ReadAloud::default();
    old.start("Old tab: Hello world.", 9);
    old.response_start = Some(RATE);
    old.generated_samples = Some(RATE * 3);
    let heard = old.progress(RATE * 2, RATE * 3, true);
    let mut next = ReadAloud::default();
    next.start("Next chunk.", 0);
    assert_eq!(next.progress(0, RATE, false), 0);
    // Hosts retain one state per utterance and fence late callbacks by identity.
    old.progress(RATE * 3, RATE * 3, true);
    assert_eq!(next.progress(0, RATE, false), 0);
    assert!(heard > 9);
    old.start("Fresh", 0);
    assert_eq!(old.generated_samples, None);
    assert_eq!(old.response_start, Some(0));
    assert_eq!(old.progress(0, RATE, false), 0);
    old.start("👋 text", 1); // Invalid surrogate prefix uses Whip's fallback.
    assert_eq!(old.prefix_bytes, 0);
}

#[test]
fn source_clock_backlog_is_bounded_and_flush_starts_a_new_timeline() {
    let mut clock = SourceClock::default();
    assert_eq!(clock.played(0), None);
    for n in 0..4096 {
        clock.record(n, 1, Some((n * 4) as u32)).unwrap();
    }
    assert!(clock.record(4096, 1, Some(16384)).is_err());
    let mut restarted = SourceClock::default();
    restarted.record(0, RATE, Some(100)).unwrap();
    assert_eq!(restarted.played(RATE), Some(RATE));
}
