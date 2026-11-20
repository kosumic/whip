//! Whip presentation word boundaries, separate from its weighted pacing units.
use std::ops::Range;

/// Convert a UTF-16 position to a UTF-8 byte boundary, rounding a position inside
/// a surrogate pair down to the scalar start and clamping beyond the text.
pub fn byte_offset(text: &str, utf16: usize) -> usize {
    let mut units = 0;
    for (at, ch) in text.char_indices() {
        if units + ch.len_utf16() > utf16 {
            return at;
        }
        units += ch.len_utf16();
    }
    text.len()
}

/// Convert a byte offset to UTF-16, rounding down to a UTF-8 scalar boundary
/// and clamping beyond the text.
pub fn utf16_offset(text: &str, byte: usize) -> usize {
    text[..text.floor_char_boundary(byte.min(text.len()))]
        .encode_utf16()
        .count()
}

/// UTF-16 word ranges using Whip's presentation rules: CJK scalars are separate
/// words; apostrophes and U+0300–U+036F marks join lexical runs. Emoji and other
/// punctuation separate words. This deliberately preserves Whip's rules rather
/// than substituting a different Unicode segmentation algorithm.
pub fn word_ranges(text: &str) -> impl Iterator<Item = Range<usize>> + '_ {
    let mut position = 0;
    let mut begin = None;
    text.chars().chain(std::iter::once(' ')).flat_map(move |c| {
        let end = position + c.len_utf16();
        let cjk = matches!(u32::from(c), 0x3040..=0x30ff | 0x3400..=0x9fff | 0xac00..=0xd7ff | 0x2_0000..=0x3_134f);
        let lexical = c.is_alphanumeric() || matches!(c, '\'' | '’' | '\u{0300}'..='\u{036f}');
        let mut words = [None, None];
        if cjk || !lexical {
            if let Some(start) = begin.take() {
                words[0] = Some(start..position);
            }
            if cjk {
                words[1] = Some(position..end);
            }
        } else if begin.is_none() {
            begin = Some(position);
        }
        position = end;
        words.into_iter().flatten()
    })
}

/// Word containing a UTF-16 cursor; punctuation/whitespace returns `None`.
pub fn word_at(text: &str, cursor: usize) -> Option<Range<usize>> {
    word_ranges(text).find(|word| word.contains(&cursor))
}

/// Word containing or following a UTF-16 cursor, as used by Whip's Markdown
/// highlight projection. Unlike [`word_at`], whitespace selects the next word.
pub fn word_after(text: &str, cursor: usize) -> Option<Range<usize>> {
    word_ranges(text).find(|word| word.end > cursor)
}
