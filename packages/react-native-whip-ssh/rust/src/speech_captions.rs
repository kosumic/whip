//! Shared caption pacing for native read-aloud. Only consumed PCM advances time.
use parking_lot::Mutex;
use std::{
    collections::VecDeque,
    ffi::{CStr, c_char},
    sync::LazyLock,
};

mod presentation;
pub use presentation::{chat_speech_presentation, speech_caption_snapshot};

#[derive(Default)]
struct Caption {
    id: u64,
    timeline: speech_timeline::ReadAloud,
}
const MAX_CAPTIONS: usize = 16;
#[derive(Default)]
struct Captions {
    sequence: u64,
    presentation: Option<presentation::Snapshot>,
    pending: VecDeque<Caption>,
}
static CAPTIONS: LazyLock<Mutex<Captions>> = LazyLock::new(Mutex::default);

/// # Safety
/// `text` must be a live, NUL-terminated UTF-8 string for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_speech_caption_start(
    text: *const c_char,
    prefix_utf16: usize,
) -> u64 {
    if text.is_null() {
        return 0;
    }
    // SAFETY: the caller guarantees a live NUL-terminated string for this call.
    let text = unsafe { CStr::from_ptr(text) }.to_string_lossy();
    let mut captions = CAPTIONS.lock();
    captions.sequence = captions.sequence.saturating_add(1);
    let mut caption = Caption {
        id: captions.sequence,
        ..Caption::default()
    };
    caption.timeline.start(&text, prefix_utf16);
    let id = caption.id;
    captions.pending.push_back(caption);
    if captions.pending.len() > MAX_CAPTIONS {
        captions.pending.pop_front();
    }
    id
}

/// Synthesize the announcement and response separately on the same PCM sink.
/// Count source frames, not wall time: native playback rates and buffering then
/// cannot move the handoff. No audio or extra silence is inserted by this layer.
pub(crate) fn synthesize(
    id: u64,
    text: &str,
    mut generate: impl FnMut(&str, &mut dyn FnMut(&[f32]) -> bool) -> i32,
    mut sink: impl FnMut(&[f32]) -> bool,
) -> i32 {
    let prefix = {
        CAPTIONS
            .lock()
            .pending
            .iter()
            .find(|caption| id != 0 && caption.id == id && caption.timeline.spoken == text)
            .map(|caption| caption.timeline.prefix_bytes)
    };
    let Some(prefix) = prefix else {
        return generate(text, &mut sink);
    };
    let mut frames = 0;
    if prefix > 0 {
        let result = generate(&text[..prefix], &mut |pcm| {
            frames += pcm.len();
            sink(pcm)
        });
        if result <= 0 || text[prefix..].is_empty() {
            return result;
        }
    }
    let mut aligned = prefix == 0;
    let mut cancelled = false;
    let result = generate(&text[prefix..], &mut |pcm| {
        // Some voices start the response with silence. Keep that silence on the
        // prefix side of the boundary, without trimming or changing playback.
        const AUDIBLE_SAMPLE: f32 = 0.001;
        if !aligned
            && let Some(offset) = pcm.iter().position(|sample| sample.abs() >= AUDIBLE_SAMPLE)
        {
            let mut captions = CAPTIONS.lock();
            if let Some(caption) = captions.pending.iter_mut().find(|caption| caption.id == id) {
                caption.timeline.response_start = Some(frames + offset);
            }
            drop(captions);
            aligned = true;
        }
        frames += pcm.len();
        let accepted = sink(pcm);
        cancelled |= !accepted;
        accepted
    });
    if result > 0 && frames > 0 && !cancelled {
        // Native queues may still be writing this audio for several seconds.
        // Publish the full duration now, before their final-frame callback.
        let mut captions = CAPTIONS.lock();
        if let Some(caption) = captions.pending.iter_mut().find(|caption| caption.id == id) {
            caption.timeline.generated_samples = Some(frames);
        }
    }
    result
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_speech_caption_progress(
    id: u64,
    played: usize,
    samples: usize,
    complete: bool,
) -> usize {
    let mut state = CAPTIONS.lock();
    let Captions {
        pending,
        presentation,
        ..
    } = &mut *state;
    let Some(caption) = pending.iter_mut().find(|c| id != 0 && c.id == id) else {
        return 0;
    };
    if played > samples {
        return 0;
    }
    let position = caption.timeline.progress(played, samples, complete);
    if let Some(snapshot) = presentation
        && crate::speech_playback::is_current(snapshot.lease)
    {
        presentation::pcm(snapshot, caption, position, played, samples);
    }
    drop(state);
    position
}

/// Mark only the current word in the original Markdown; speech offsets refer to
/// the same normalized prose used by the reader, never URLs or fenced code.
#[uniffi::export]
pub fn chat_speech_highlight(
    markdown: String,
    spoken_utf16: u32,
    expected: String,
    start_utf16: u32,
) -> String {
    let (prose, spans) = crate::chat_speech::mapped_prose(&markdown);
    let start = start_utf16 as usize;
    let units = prose.encode_utf16().collect::<Vec<_>>();
    let expected = expected.encode_utf16().collect::<Vec<_>>();
    if units.get(start..start.saturating_add(expected.len())) != Some(expected.as_slice()) {
        return markdown;
    }
    let cursor = spoken_utf16 as usize;
    if cursor < start || cursor >= start.saturating_add(expected.len()) {
        return markdown;
    }
    if let Some(word) = speech_timeline::word_after(&prose, cursor) {
        return mark_word(markdown, &spans, word.start, word.end);
    }
    markdown
}

fn mark_word(
    mut markdown: String,
    spans: &[std::ops::Range<usize>],
    begin: usize,
    end: usize,
) -> String {
    let (Some(first), Some(last)) = (spans.get(begin), spans.get(end.saturating_sub(1))) else {
        return markdown;
    };
    let mut range = first.start..last.end;
    let before = &markdown[..range.start];
    if before
        .rfind('<')
        .is_some_and(|opening| before.rfind('>').is_none_or(|closing| closing < opening))
        || before.ends_with(['\\', '='])
    {
        return markdown;
    }
    // Keep math and multi-word code examples intact. Markdown highlight markers
    // inside these literals would become visible content or change the formula.
    if open_delimiter(before, '$').is_some() {
        return markdown;
    }
    if let Some((begin, length)) = open_delimiter(before, '`') {
        let delimiter = "`".repeat(length);
        if begin + length != range.start || !markdown[range.end..].starts_with(&delimiter) {
            return markdown;
        }
        range.start = begin;
        range.end += length;
    }
    // Do not change the Markdown tree when a word crosses formatting boundaries.
    if markdown[range.clone()].contains(['\n', '*', '_', '[', ']']) {
        return markdown;
    }
    markdown.insert_str(range.end, "==");
    markdown.insert_str(range.start, "==");
    markdown
}

fn open_delimiter(text: &str, marker: char) -> Option<(usize, usize)> {
    let mut opening = None;
    let mut chars = text.char_indices().peekable();
    while let Some((index, character)) = chars.next() {
        if character != marker
            || text[..index]
                .bytes()
                .rev()
                .take_while(|byte| *byte == b'\\')
                .count()
                % 2
                != 0
        {
            continue;
        }
        let mut length = 1;
        while chars.peek().is_some_and(|(_, c)| *c == marker) {
            chars.next();
            length += 1;
        }
        match opening {
            Some((_, count)) if count == length => opening = None,
            None => opening = Some((index, length)),
            _ => {}
        }
    }
    opening
}

#[cfg(test)]
mod pcm_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_markdown_highlights_the_spoken_occurrence_and_preserves_links_and_code() {
        let markdown =
            "# Title\n**Hello** [world](https://secret/world). Hello `again`.\n```sh\nHello\n```";
        let prose = crate::chat_speech::spoken_prose(markdown);
        let render = |cursor| chat_speech_highlight(markdown.into(), cursor, prose.clone(), 0);
        assert!(render(7).contains("**==Hello==**"));
        assert!(render(13).contains("[==world==](https://secret/world)"));
        assert!(render(20).contains(". ==Hello== `again`"));
        assert!(render(26).contains("==`again`=="));
        assert_eq!(
            chat_speech_highlight(markdown.into(), 7, "rewritten".into(), 0),
            markdown
        );
    }
    #[test]
    fn bilingual_and_surrogate_offsets_preserve_the_original_response() {
        let markdown = "Hello 你好 👋 world";
        let result = chat_speech_highlight(markdown.into(), 7, markdown.into(), 0);
        assert_eq!(result, "Hello 你==好== 👋 world");
    }

    #[test]
    fn caption_markers_never_become_literal_code_or_change_math() {
        for markdown in [
            "Read `two words` here",
            "Read $some formula$ here",
            "Read $$some formula$$ here",
        ] {
            let prose = crate::chat_speech::spoken_prose(markdown);
            assert_eq!(
                chat_speech_highlight(markdown.into(), 6, prose, 0),
                markdown
            );
        }
        for markdown in ["<p>Hello</p>", "\\hello", "==hello=="] {
            let prose = crate::chat_speech::spoken_prose(markdown);
            assert_eq!(
                chat_speech_highlight(markdown.into(), 1, prose, 0),
                markdown
            );
        }
    }
}
