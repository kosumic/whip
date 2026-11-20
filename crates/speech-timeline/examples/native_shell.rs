//! Minimal plain-text native shell consumer, with no Whip or mobile SDK imports.
use speech_timeline::{ReadAloud, SAMPLE_RATE, byte_offset, word_at};

fn main() {
    const PREFIX: &str = "Coach: ";
    const RESPONSE: &str = "Hello 你好 👋 world.";
    let rate = SAMPLE_RATE as usize;
    let mut timeline = ReadAloud::default();
    timeline.start(
        &format!("{PREFIX}{RESPONSE}"),
        PREFIX.encode_utf16().count(),
    );

    // The producer separately synthesizes the prefix and response and reports
    // first audible response PCM. Neither event means the device played it.
    timeline.response_start = Some(rate);
    timeline.generated_samples = Some(rate * 3);
    assert_eq!(timeline.progress(0, rate * 3, true), 0);
    assert_eq!(timeline.progress(rate, rate * 3, true), 0);

    // The device acknowledged two seconds. Project the response cursor into
    // native byte ranges, as a GymAmi/Native Shell UI could do with plain text.
    let position = timeline.progress(rate * 2, rate * 3, true);
    let cursor = position.saturating_sub(timeline.prefix_utf16);
    if let Some(word) = word_at(RESPONSE, cursor) {
        let bytes = byte_offset(RESPONSE, word.start)..byte_offset(RESPONSE, word.end);
        println!(
            "heard through UTF-16 {cursor}; current word: {}",
            &RESPONSE[bytes]
        );
    }
}
