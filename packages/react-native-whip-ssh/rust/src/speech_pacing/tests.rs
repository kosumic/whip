use super::*;
use crate::realtime_voice::RATE;

fn text(value: &str) -> Text {
    let mut text = Text::default();
    text.update(value);
    text
}

#[test]
fn highlighting_starts_during_generation_and_ignores_metadata_without_playback() {
    let text =
        text("First sentence is arriving well before all of its audio. Another sentence follows.");
    let mut clock = Clock::new(Pace::default());
    assert_eq!(clock.advance(&text, 0, RATE, false), 0);
    let first = clock.advance(&text, RATE / 4, RATE, false);
    assert!(first > 0 && first <= 4);
    let next = clock.advance(&text, RATE / 2, RATE * 3, false);
    assert!(next > first && next <= 8);
    assert_eq!(clock.advance(&text, RATE / 2, RATE * 8, true), next);
    assert_eq!(clock.advance(&text, RATE / 2, RATE * 8, false), next);
}

#[test]
fn final_duration_is_reconciled_only_over_further_played_frames() {
    let text = text("One two three four five six seven eight nine ten.");
    let mut clock = Clock::new(Pace::default());
    let before = clock.advance(&text, RATE, RATE * 2, false);
    assert_eq!(clock.advance(&text, RATE, RATE * 2, true), before);
    let after = clock.advance(&text, RATE + RATE / 50, RATE * 2, true);
    assert_eq!(after, "One two three four five six ".len());
    for played in (RATE + RATE / 50..RATE * 2).step_by(RATE / 50) {
        clock.advance(&text, played, RATE * 2, true);
    }
    assert_eq!(
        clock.advance(&text, RATE * 2, RATE * 2, true),
        "One two three four five six seven eight nine ten.".len()
    );
}

#[test]
fn bilingual_text_is_paced_in_speech_units_with_valid_utf16_boundaries() {
    let value = "你好世界 Hello 👋!";
    let text = text(value);
    let mut clock = Clock::new(Pace::default());
    // One second should not consume the whole bilingual sentence.
    let position = clock.advance(&text, RATE, RATE * 8, false);
    assert!(position > 0 && position < value.encode_utf16().count());
    for played in (RATE..RATE * 8).step_by(RATE / 50) {
        let position = clock.advance(&text, played, RATE * 8, true);
        assert!(
            String::from_utf16(&value.encode_utf16().take(position).collect::<Vec<_>>()).is_ok()
        );
    }
}

#[test]
fn later_turns_learn_the_observed_voice_pace_without_retiming_existing_turns() {
    let text = text("One two three four five six seven eight nine ten.");
    let mut pace = Pace::default();
    let mut first = Clock::new(pace);
    pace.observe(text.units, RATE * 2);
    let mut next = Clock::new(pace);
    assert!(
        next.advance(&text, RATE, RATE * 3, false) > first.advance(&text, RATE, RATE * 3, false)
    );
    let first_position = first.advance(&text, RATE, RATE * 3, false);
    assert_eq!(first.advance(&text, RATE, RATE * 3, false), first_position);
}

#[test]
fn an_interrupted_current_word_retains_its_full_bright_prefix() {
    let text = text("Hello, world.");
    assert_eq!(text.freeze(0), 0);
    assert_eq!(text.freeze(2), 5);
    assert_eq!(text.freeze(7), 12);
}
