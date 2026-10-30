#[derive(Clone, Copy, uniffi::Enum)]
pub enum GithubCommentFormat {
    Bold,
    Italic,
    Code,
    Quote,
    BulletList,
    TaskList,
    Link,
}

#[derive(uniffi::Record)]
pub struct GithubCommentEdit {
    pub text: String,
    pub selection_start: u32,
    pub selection_end: u32,
}

fn units(text: &str) -> u32 {
    u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
}

fn byte_offset(text: &str, offset: u32) -> usize {
    let mut length = 0;
    for (index, character) in text.char_indices() {
        if length >= offset {
            return index;
        }
        length += u32::try_from(character.len_utf16()).unwrap_or(2);
    }
    text.len()
}

/// Native text-input selections use UTF-16 offsets; Rust slicing uses bytes.
#[uniffi::export]
pub fn format_github_comment(
    text: String,
    start: u32,
    end: u32,
    format: GithubCommentFormat,
) -> GithubCommentEdit {
    let start = byte_offset(&text, start.min(end));
    let end = byte_offset(&text, end).max(start);
    match format {
        GithubCommentFormat::Quote => prefix_lines(&text, start, end, "> "),
        GithubCommentFormat::BulletList => prefix_lines(&text, start, end, "- "),
        GithubCommentFormat::TaskList => prefix_lines(&text, start, end, "- [ ] "),
        GithubCommentFormat::Bold => wrap(&text, start, end, "**", "**"),
        GithubCommentFormat::Italic => wrap(&text, start, end, "_", "_"),
        GithubCommentFormat::Code => wrap(&text, start, end, "`", "`"),
        GithubCommentFormat::Link => {
            let mut edit = wrap(&text, start, end, "[", "](url)");
            edit.selection_start = units(&text[..end]) + 3;
            edit.selection_end = edit.selection_start + 3;
            edit
        }
    }
}

fn wrap(text: &str, start: usize, end: usize, prefix: &str, suffix: &str) -> GithubCommentEdit {
    let before = &text[..start];
    let selected = &text[start..end];
    let after = &text[end..];
    if let (Some(before), Some(after)) = (before.strip_suffix(prefix), after.strip_prefix(suffix)) {
        return GithubCommentEdit {
            text: format!("{before}{selected}{after}"),
            selection_start: units(before),
            selection_end: units(before) + units(selected),
        };
    }
    GithubCommentEdit {
        text: format!("{before}{prefix}{selected}{suffix}{after}"),
        selection_start: units(before) + units(prefix),
        selection_end: units(before) + units(prefix) + units(selected),
    }
}

fn prefix_lines(text: &str, start: usize, end: usize, prefix: &str) -> GithubCommentEdit {
    let start = text[..start].rfind('\n').map_or(0, |index| index + 1);
    let before = &text[..start];
    let selected = &text[start..end];
    let replacement = if selected.is_empty() {
        prefix.to_owned()
    } else {
        selected
            .split_inclusive('\n')
            .fold(String::new(), |mut output, line| {
                output.push_str(prefix);
                output.push_str(line);
                output
            })
    };
    GithubCommentEdit {
        text: format!("{before}{replacement}{}", &text[end..]),
        selection_start: units(before) + units(prefix),
        selection_end: units(before) + units(&replacement),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_toggles_selection_without_losing_unicode() {
        let edit = format_github_comment("Hi 👋 world".to_owned(), 3, 5, GithubCommentFormat::Bold);
        assert_eq!(edit.text, "Hi **👋** world");
        assert_eq!((edit.selection_start, edit.selection_end), (5, 7));
        let edit = format_github_comment(
            edit.text,
            edit.selection_start,
            edit.selection_end,
            GithubCommentFormat::Bold,
        );
        assert_eq!(edit.text, "Hi 👋 world");
        assert_eq!((edit.selection_start, edit.selection_end), (3, 5));
    }

    #[test]
    fn supports_empty_cursor_multiline_lists_and_link_destinations() {
        let edit = format_github_comment(String::new(), 0, 0, GithubCommentFormat::Italic);
        assert_eq!(edit.text, "__");
        assert_eq!((edit.selection_start, edit.selection_end), (1, 1));
        let edit = format_github_comment(
            "one\ntwo\nthree".to_owned(),
            0,
            7,
            GithubCommentFormat::TaskList,
        );
        assert_eq!(edit.text, "- [ ] one\n- [ ] two\nthree");
        let edit = format_github_comment("👋 docs".to_owned(), 3, 7, GithubCommentFormat::Link);
        assert_eq!(edit.text, "👋 [docs](url)");
        assert_eq!((edit.selection_start, edit.selection_end), (10, 13));
        let edit = format_github_comment(
            "a".to_owned(),
            u32::MAX,
            u32::MAX,
            GithubCommentFormat::Code,
        );
        assert_eq!(edit.text, "a``");
    }
}
