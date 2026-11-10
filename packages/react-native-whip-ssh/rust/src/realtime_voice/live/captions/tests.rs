use super::{Fragment, Transcript};
use crate::realtime_voice::RATE;

fn fragment(id: &str, start_ms: f64, end_ms: f64) -> Fragment {
    Fragment {
        id: id.into(),
        role: "assistant".into(),
        text: "one two three four".into(),
        start_ms,
        end_ms,
        event: None,
    }
}

#[test]
fn captions_follow_source_time_after_sparse_rtp_without_advancing_during_buffering()
-> Result<(), &'static str> {
    let mut transcript = Transcript::default();
    transcript.append(fragment("first", 1000.0, 2000.0))?;
    transcript.append(fragment("later", 4000.0, 5000.0))?;
    transcript.source_audio(0, RATE, Some(1000))?;
    transcript.audio(0, &1000_i16.to_le_bytes());
    transcript.played(RATE / 2);
    assert_eq!(transcript.messages()[0]["spokenUtf16"], 9);
    transcript.played(RATE);
    // The next RTP packet follows a two-second source silence. Merely queuing
    // it cannot move the second caption or replace the first one's clock.
    transcript.source_audio(RATE, RATE, Some(145_000))?;
    transcript.audio(RATE, &1000_i16.to_le_bytes());
    assert_eq!(transcript.messages()[1]["spokenUtf16"], 0);
    transcript.played(RATE);
    assert_eq!(transcript.messages()[1]["spokenUtf16"], 0);
    transcript.played(RATE + RATE / 2);
    let messages = transcript.messages();
    assert_eq!(messages[1]["spokenUtf16"], 9);
    assert_eq!(messages[1]["active"], true);
    let timing = transcript.timing(&messages);
    assert_eq!(timing["sourceMs"], 4500.0);
    assert_eq!(timing["heardPcmMs"], 1500);
    assert_eq!(timing["spokenUtf16"], 9);
    assert!(!timing.to_string().contains("one two three four"));
    transcript.played(RATE * 2);
    assert_eq!(transcript.messages()[1]["spokenUtf16"], 18);
    Ok(())
}

#[test]
fn leading_source_silence_and_interruptions_do_not_shift_new_speech() -> Result<(), &'static str> {
    let mut transcript = Transcript::default();
    // Quiet RTP precedes speech, including a source-clock gap at its boundary.
    transcript.source_audio(0, RATE, Some(1000))?;
    transcript.audio(0, &0_i16.to_le_bytes());
    transcript.source_audio(RATE, RATE, Some(145_000))?;
    transcript.audio(RATE, &1000_i16.to_le_bytes());
    transcript.played(RATE + RATE / 2);
    transcript.append(fragment("late", 4000.0, 5000.0))?;
    assert_eq!(transcript.messages()[0]["spokenUtf16"], 9);
    transcript.stop();
    transcript.source_audio(0, RATE, Some(625_000))?;
    transcript.audio(0, &1000_i16.to_le_bytes());
    transcript.append(fragment("new", 14000.0, 15000.0))?;
    transcript.played(RATE / 2);
    let messages = transcript.messages();
    assert_eq!(messages[0]["spokenUtf16"], 9);
    assert_eq!(messages[0]["active"], false);
    assert_eq!(messages[1]["spokenUtf16"], 9);
    assert_eq!(messages[1]["active"], true);
    Ok(())
}
