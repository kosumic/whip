//! Shared caption pacing for native read-aloud. Only consumed PCM advances time.
use crate::speech_pacing::{Clock, Pace, Text};
use parking_lot::Mutex;
use std::{
    ffi::{CStr, c_char},
    sync::LazyLock,
};

struct Caption {
    id: u64,
    text: Text,
    clock: Clock,
}

impl Default for Caption {
    fn default() -> Self {
        Self {
            id: 0,
            text: Text::default(),
            clock: Clock::new(Pace::default()),
        }
    }
}
static CAPTION: LazyLock<Mutex<Caption>> = LazyLock::new(Mutex::default);

/// # Safety
/// `text` must be a live, NUL-terminated UTF-8 string for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_speech_caption_start(text: *const c_char) -> u64 {
    if text.is_null() {
        return 0;
    }
    // SAFETY: the caller guarantees a live NUL-terminated string for this call.
    let text = unsafe { CStr::from_ptr(text) }.to_string_lossy();
    let mut caption = CAPTION.lock();
    caption.id = caption.id.saturating_add(1);
    caption.text.update(&text);
    caption.clock = Clock::new(Pace::default());
    caption.id
}

#[unsafe(no_mangle)]
pub extern "C" fn whip_speech_caption_progress(
    id: u64,
    played: usize,
    samples: usize,
    complete: bool,
) -> usize {
    let mut caption = CAPTION.lock();
    if caption.id != id || id == 0 {
        return 0;
    }
    let Caption { text, clock, .. } = &mut *caption;
    let progress = clock.advance(text, played.min(samples), samples, complete);
    drop(caption);
    progress
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
    let mut position = 0;
    let mut word = None;
    for character in prose.chars().chain(std::iter::once(' ')) {
        let end = position + character.len_utf16();
        let cjk = matches!(u32::from(character), 0x3040..=0x30ff | 0x3400..=0x9fff | 0xac00..=0xd7ff | 0x2_0000..=0x3_134f);
        let lexical = character.is_alphanumeric()
            || matches!(character, '\'' | '’' | '\u{0300}'..='\u{036f}');
        if cjk || !lexical {
            if let Some(begin) = word.take()
                && position > cursor
            {
                return mark_word(markdown, &spans, begin, position);
            }
            if cjk && end > cursor {
                return mark_word(markdown, &spans, position, end);
            }
        } else if word.is_none() {
            word = Some(position);
        }
        position = end;
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
