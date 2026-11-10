use super::*;
use std::ffi::CString;

const RATE: usize = 24_000;
const RESPONSE: &str = "One two three.";
// Exercise the process-wide native API without races between test cases.
static SERIAL: Mutex<()> = Mutex::new(());

fn start(prefix: &str, response: &str) -> (u64, String, usize) {
    let spoken = format!("{prefix}{response}");
    let units = prefix.encode_utf16().count();
    let text = CString::new(spoken.clone()).unwrap_or_else(|error| panic!("{error}"));
    // SAFETY: text is live and NUL-terminated for this synchronous call.
    let id = unsafe { whip_speech_caption_start(text.as_ptr(), units) };
    (id, spoken, units)
}

#[test]
fn pcm_handoff_waits_for_played_prefix_and_response_silence_at_every_rate() {
    let _serial = SERIAL.lock();
    for prefix in [
        "A tab: ",
        "A very long, paused… debug tab: ",
        "调试 👋 tab: ",
    ] {
        for prefix_frames in [RATE / 4, RATE * 12] {
            // Frames consumed per 40 ms tick at 0.5x, 1x and 2x playback.
            for step in [RATE / 50, RATE / 25, RATE * 2 / 25] {
                let (id, spoken, units) = start(prefix, RESPONSE);
                let silence = RATE / 2;
                let mut response = vec![0.0; silence];
                response.extend(vec![0.2; RATE * 2]);
                let mut output = Vec::new();
                let mut segments = Vec::new();
                let result = synthesize(
                    id,
                    &spoken,
                    |text, sink| {
                        segments.push(text.to_owned());
                        let pcm = if text == prefix {
                            vec![0.1; prefix_frames]
                        } else {
                            response.clone()
                        };
                        i32::from(pcm.chunks(RATE / 25).all(sink))
                    },
                    |pcm| {
                        output.extend_from_slice(pcm);
                        // Consume the prefix during generation, before the
                        // response boundary or total duration is even known.
                        if output.len() <= prefix_frames {
                            assert_eq!(
                                whip_speech_caption_progress(id, output.len(), output.len(), false),
                                0
                            );
                        }
                        true
                    },
                );
                assert_eq!(result, 1);
                assert_eq!(segments, [prefix, RESPONSE]);
                assert_eq!(segments.concat(), spoken);
                assert_eq!(&output[..prefix_frames], vec![0.1; prefix_frames]);
                assert_eq!(&output[prefix_frames..], response);

                let onset = prefix_frames + silence;
                for played in (0..=onset).step_by(step) {
                    assert_eq!(
                        whip_speech_caption_progress(id, played, output.len(), true),
                        0
                    );
                }
                assert_eq!(
                    whip_speech_caption_progress(id, onset, output.len(), true),
                    0
                );
                let first = whip_speech_caption_progress(id, onset + 1, output.len(), true);
                assert_eq!(
                    first, units,
                    "First response frame must select its first word"
                );
                assert_eq!(
                    chat_speech_highlight(
                        RESPONSE.into(),
                        u32::try_from(first - units).unwrap_or_else(|error| panic!("{error}")),
                        RESPONSE.into(),
                        0
                    ),
                    "==One== two three."
                );
                let mut previous = first;
                for played in (onset + 1..output.len()).step_by(step) {
                    let progress = whip_speech_caption_progress(id, played, output.len(), true);
                    assert!(progress >= previous && progress <= spoken.encode_utf16().count());
                    previous = progress;
                }
                assert_eq!(
                    whip_speech_caption_progress(id, output.len(), output.len(), true),
                    units + RESPONSE.len()
                );
            }
        }
    }
}

#[test]
fn streaming_response_clock_starts_from_zero_after_a_slow_prefix() {
    let _serial = SERIAL.lock();
    let prefix = "Slow tab: ";
    let (id, spoken, units) = start(prefix, RESPONSE);
    let mut played = 0;
    let mut positions = Vec::new();
    assert_eq!(
        synthesize(
            id,
            &spoken,
            |text, sink| {
                let duration = if text == prefix { RATE * 10 } else { RATE };
                i32::from(
                    (0..duration)
                        .step_by(RATE / 25)
                        .all(|_| sink(&[0.2; RATE / 25])),
                )
            },
            |pcm| {
                played += pcm.len();
                let position = whip_speech_caption_progress(id, played, played, false);
                if played <= RATE * 10 {
                    assert_eq!(position, 0);
                } else {
                    positions.push(position);
                }
                true
            },
        ),
        1
    );
    assert_eq!(positions[0], units);
    assert!(positions.windows(2).all(|pair| pair[0] <= pair[1]));
    assert!(
        positions
            .last()
            .is_some_and(|position| *position > units && *position < units + RESPONSE.len())
    );
}

#[test]
fn interrupted_prefix_does_not_generate_or_highlight_response() {
    let _serial = SERIAL.lock();
    for result in [0, -1] {
        let (id, spoken, _) = start("Debug tab: ", RESPONSE);
        let mut requested = Vec::new();
        assert_eq!(
            synthesize(
                id,
                &spoken,
                |text, sink| {
                    requested.push(text.to_owned());
                    assert!(!sink(&[0.2; 100]));
                    result
                },
                |_| false,
            ),
            result
        );
        assert_eq!(requested, ["Debug tab: "]);
        assert_eq!(whip_speech_caption_progress(id, 100, 100, true), 0);
    }
}

#[test]
fn late_pcm_from_interrupted_chat_cannot_align_the_next_chat() {
    let _serial = SERIAL.lock();
    let (old_id, spoken, _) = start("Old tab: ", RESPONSE);
    let mut new_id = 0;
    synthesize(
        old_id,
        &spoken,
        |text, sink| {
            if text == "Old tab: " {
                new_id = start("Next tab: ", RESPONSE).0;
            }
            i32::from(sink(&[0.2; 100]))
        },
        |_| true,
    );
    assert_ne!(old_id, new_id);
    assert_eq!(
        whip_speech_caption_progress(old_id, 200, 200, true),
        "Old tab: ".len() + RESPONSE.len()
    );
    assert_eq!(whip_speech_caption_progress(new_id, 200, 200, true), 0);
}

#[test]
fn preparing_lookahead_keeps_each_playing_chunk_clock_independent() {
    let _serial = SERIAL.lock();
    let (first, _, _) = start("", "First sentence with several words.");
    let (second, _, _) = start("", "Second sentence with several words.");
    let first_progress = whip_speech_caption_progress(first, RATE / 2, RATE * 2, true);
    assert!(first_progress > 0);
    assert_eq!(whip_speech_caption_progress(second, 0, RATE * 2, true), 0);
    let second_progress = whip_speech_caption_progress(second, RATE / 2, RATE * 2, true);
    assert!(second_progress > 0);
    assert_eq!(
        whip_speech_caption_progress(first, RATE / 2, RATE * 2, true),
        first_progress
    );
    assert_eq!(
        whip_speech_caption_progress(first, RATE * 2, RATE * 2, true),
        "First sentence with several words.".len()
    );
}

#[test]
fn continuation_without_prefix_has_a_fresh_clock_and_original_offsets() {
    let _serial = SERIAL.lock();
    let (id, spoken, units) = start("Debug tab: ", RESPONSE);
    synthesize(
        id,
        &spoken,
        |_, sink| i32::from(sink(&[0.2; 100])),
        |_| true,
    );
    assert_eq!(
        whip_speech_caption_progress(id, 200, 200, true),
        units + RESPONSE.len()
    );
    let (next, continuation, _) = start("", "Next chunk.");
    let mut requested = Vec::new();
    synthesize(
        next,
        &continuation,
        |text, _| {
            requested.push(text.to_owned());
            1
        },
        |_| true,
    );
    assert_eq!(requested, ["Next chunk."]);
    assert_eq!(whip_speech_caption_progress(next, 0, RATE, false), 0);
    assert_eq!(
        whip_speech_caption_progress(next, RATE, RATE, true),
        continuation.len()
    );
}

#[test]
fn prefix_only_audio_never_highlights_a_response() {
    let _serial = SERIAL.lock();
    let (id, spoken, _) = start("Debug tab: ", "");
    synthesize(
        id,
        &spoken,
        |_, sink| i32::from(sink(&[0.2; 100])),
        |_| true,
    );
    assert_eq!(whip_speech_caption_progress(id, 100, 100, true), 0);
}
