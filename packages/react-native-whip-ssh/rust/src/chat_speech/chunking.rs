//! Put synthesis boundaries at natural pauses while retaining the hard UTF-16 cap.
const SENTENCE_ENDS: [char; 6] = ['.', '?', '!', '。', '？', '！'];
const CLAUSE_ENDS: [char; 6] = [',', ';', ':', '，', '；', '：'];
const CLOSERS: [char; 7] = ['"', '\'', '”', '’', ')', ']', '」'];

pub(crate) fn speech_chunks_with_limit(text: &str, max_units: usize) -> Vec<String> {
    // Every Unicode scalar must fit, including a UTF-16 surrogate pair.
    assert!(max_units >= 2);
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut remaining = normalized.as_str();
    let mut units = remaining.encode_utf16().count();
    let mut chunks = Vec::new();
    while units > max_units {
        let end = boundary(remaining, units, max_units);
        let (chunk, tail) = remaining.split_at(end);
        chunks.push(chunk.trim_end().to_owned());
        remaining = tail.trim_start();
        // Whitespace is already normalized to ASCII spaces.
        units -= chunk.encode_utf16().count() + tail.len() - remaining.len();
    }
    if !remaining.is_empty() {
        chunks.push(remaining.to_owned());
    }
    chunks
}

fn boundary(text: &str, units: usize, max_units: usize) -> usize {
    // Without punctuation, spread words over the required chunks so the final
    // synthesis request isn't just a few stranded words.
    let target = units.div_ceil(units.div_ceil(max_units));
    let mut used = 0;
    let mut hard_end = 0;
    let mut word = None;
    let mut balanced_word = None;
    let mut sentence = None;
    let mut clause = None;
    for (index, character) in text.char_indices() {
        if character == ' ' {
            word = Some(index);
            if used <= target {
                balanced_word = word;
            }
            let prefix = text[..index].trim_end_matches(CLOSERS);
            if prefix.ends_with(SENTENCE_ENDS) {
                sentence = word;
            } else if used >= max_units / 2 && prefix.ends_with(CLAUSE_ENDS) {
                clause = word;
            }
        }
        if used + character.len_utf16() > max_units {
            break;
        }
        used += character.len_utf16();
        hard_end = index + character.len_utf8();
        // CJK punctuation also separates sentences/clauses without whitespace.
        if matches!(character, '。' | '？' | '！' | '，' | '；' | '：')
            && !text[hard_end..].starts_with(CLOSERS)
        {
            if SENTENCE_ENDS.contains(&character) {
                sentence = Some(hard_end);
            } else if used >= max_units / 2 {
                clause = Some(hard_end);
            }
        }
    }
    sentence
        .or(clause)
        .or(balanced_word)
        .or(word)
        .unwrap_or(hard_end)
}

#[cfg(test)]
mod tests {
    use super::speech_chunks_with_limit;

    #[test]
    fn reported_paragraph_keeps_captions_and_audio_in_the_same_utterance() {
        let text = "All 73 Realtime tests and five pacing tests passed. The local probe is waiting for another Rust build to release the shared cache; I’m leaving that build undisturbed. The probe will make two calls to compare fresh and reused HTTP connections, then check that a typed request produces captions and audio packets.";
        let chunks = speech_chunks_with_limit(text, 300);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].ends_with("undisturbed."));
        assert_eq!(
            chunks[1],
            "The probe will make two calls to compare fresh and reused HTTP connections, then check that a typed request produces captions and audio packets."
        );
        assert_eq!(chunks.join(" "), text);
        assert!(
            chunks
                .iter()
                .all(|chunk| chunk.encode_utf16().count() <= 300)
        );
    }

    #[test]
    fn long_sentences_prefer_a_clause_boundary() {
        let text =
            "We can keep this whole clause together, and read the remaining words together too.";
        let chunks = speech_chunks_with_limit(text, 50);
        assert_eq!(
            chunks,
            [
                "We can keep this whole clause together,",
                "and read the remaining words together too."
            ]
        );
    }

    #[test]
    fn unpunctuated_text_does_not_leave_a_tiny_final_utterance() {
        let text = format!("{}and audio packets", "words ".repeat(49));
        let chunks = speech_chunks_with_limit(&text, 300);
        assert_eq!(chunks.len(), 2);
        assert!(
            chunks
                .iter()
                .all(|chunk| (100..=300).contains(&chunk.len()))
        );
        assert_eq!(chunks.join(" "), text);
    }

    #[test]
    fn quoted_sentences_end_after_the_closing_quote() {
        let text = "She said “It works.” The next sentence stays intact.";
        assert_eq!(
            speech_chunks_with_limit(text, 35),
            ["She said “It works.”", "The next sentence stays intact."]
        );
    }

    #[test]
    fn unicode_without_spaces_stays_within_the_cap_without_losing_text() {
        for text in ["🦀".repeat(51), "你好世界。下一句也完整！".repeat(10)] {
            let chunks = speech_chunks_with_limit(&text, 11);
            assert_eq!(chunks.concat(), text);
            assert!(
                chunks
                    .iter()
                    .all(|chunk| !chunk.is_empty() && chunk.encode_utf16().count() <= 11)
            );
        }
    }

    #[test]
    fn short_text_only_normalizes_whitespace() {
        assert_eq!(
            speech_chunks_with_limit("  Hello\n world.  ", 20),
            ["Hello world."]
        );
        assert!(speech_chunks_with_limit(" \n ", 20).is_empty());
    }
}
