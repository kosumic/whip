//! Stateful, bounded syntax colors. No parsing runs on the React Native thread.
use std::path::Path;
use std::sync::LazyLock;

use syntect::easy::HighlightLines;
use syntect::highlighting::{FontStyle, Style, Theme, ThemeSet};
use syntect::parsing::{SyntaxReference, SyntaxSet};

use crate::remote_ops::{GitDiffRow, GitDiffRowKind};

const MAX_BYTES: usize = 512 * 1024;
const MAX_LINES: usize = 10_000;
const MAX_LINE_BYTES: usize = 4_096;
const MAX_SPANS: usize = 50_000;
const DARK_THEME: &str = "base16-ocean.dark";
const LIGHT_THEME: &str = "InspiredGitHub";
static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(two_face::syntax::extra_newlines);
static THEMES: LazyLock<ThemeSet> = LazyLock::new(ThemeSet::load_defaults);

#[derive(Clone, Debug, Default, PartialEq, Eq, uniffi::Record)]
pub struct GitDiffSyntax {
    pub dark: Vec<GitDiffSyntaxLine>,
    pub light: Vec<GitDiffSyntaxLine>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitDiffSyntaxLine {
    pub key: String,
    pub spans: Vec<SyntaxSpan>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct SyntaxSpan {
    /// UTF-16 offsets into the original source, before expanding tabs.
    pub start: u32,
    pub end: u32,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, uniffi::Record)]
pub struct CodeSyntax {
    pub dark: Vec<SyntaxSpan>,
    pub light: Vec<SyntaxSpan>,
}

#[uniffi::export]
pub async fn highlight_code(content: String, language: String) -> CodeSyntax {
    let Ok(runtime) = crate::runtime() else {
        return CodeSyntax::default();
    };
    runtime
        .spawn_blocking(move || highlight_source(&content, &language))
        .await
        .unwrap_or_default()
}

fn find_syntax(language: &str) -> Option<&'static SyntaxReference> {
    let language = match language {
        "plaintext" | "text" | "txt" => return None,
        "shell" | "bash" | "zsh" => "sh",
        "javascriptreact" => "jsx",
        "typescriptreact" => "tsx",
        other => other,
    };
    let name = Path::new(language).file_name()?.to_str()?;
    SYNTAXES.find_syntax_by_token(name).or_else(|| {
        Path::new(name)
            .extension()
            .and_then(|ext| ext.to_str())
            .and_then(|ext| SYNTAXES.find_syntax_by_extension(ext))
    })
}

fn highlight_source(content: &str, language: &str) -> CodeSyntax {
    if content.is_empty()
        || content.len() > MAX_BYTES
        || content.lines().count() > MAX_LINES
        || content.lines().any(|line| line.len() > MAX_LINE_BYTES)
    {
        return CodeSyntax::default();
    }
    let Some(syntax) = find_syntax(language) else {
        return CodeSyntax::default();
    };
    let mut budget = MAX_SPANS;
    let for_theme = |name: &str, budget: &mut usize| {
        let mut highlighter = HighlightLines::new(syntax, THEMES.themes.get(name)?);
        let mut spans = Vec::new();
        let mut offset = 0;
        for line in content.split_inclusive('\n') {
            let ranges = highlighter.highlight_line(line, &SYNTAXES).ok()?;
            let length = u32::try_from(line.encode_utf16().count()).ok()?;
            append_spans(&mut spans, ranges, length, offset, budget)?;
            offset += length;
        }
        Some(spans)
    };
    match (
        for_theme(DARK_THEME, &mut budget),
        for_theme(LIGHT_THEME, &mut budget),
    ) {
        (Some(dark), Some(light)) => CodeSyntax { dark, light },
        _ => CodeSyntax::default(),
    }
}

pub(crate) fn highlight_diff(rows: &[GitDiffRow], path: &str) -> GitDiffSyntax {
    if rows.is_empty()
        || rows.len() > MAX_LINES
        || rows.iter().map(|row| row.content.len()).sum::<usize>() > MAX_BYTES
        || rows.iter().any(|row| row.content.len() > MAX_LINE_BYTES)
    {
        return GitDiffSyntax::default();
    }
    let Some(syntax) = find_syntax(path) else {
        return GitDiffSyntax::default();
    };
    let mut budget = MAX_SPANS;
    let Some(dark) = THEMES
        .themes
        .get(DARK_THEME)
        .and_then(|theme| highlight_theme(rows, syntax, theme, &mut budget))
    else {
        return GitDiffSyntax::default();
    };
    let Some(light) = THEMES
        .themes
        .get(LIGHT_THEME)
        .and_then(|theme| highlight_theme(rows, syntax, theme, &mut budget))
    else {
        return GitDiffSyntax::default();
    };
    GitDiffSyntax { dark, light }
}

fn highlight_theme(
    rows: &[GitDiffRow],
    syntax: &syntect::parsing::SyntaxReference,
    theme: &Theme,
    budget: &mut usize,
) -> Option<Vec<GitDiffSyntaxLine>> {
    let mut old = HighlightLines::new(syntax, theme);
    let mut new = HighlightLines::new(syntax, theme);
    let mut result = Vec::new();
    for row in rows {
        if row.kind == GitDiffRowKind::Hunk {
            old = HighlightLines::new(syntax, theme);
            new = HighlightLines::new(syntax, theme);
            continue;
        }
        let source = format!("{}\n", row.content);
        let ranges = match row.kind {
            GitDiffRowKind::Addition => new.highlight_line(&source, &SYNTAXES).ok()?,
            GitDiffRowKind::Deletion => old.highlight_line(&source, &SYNTAXES).ok()?,
            GitDiffRowKind::Context => {
                old.highlight_line(&source, &SYNTAXES).ok()?;
                new.highlight_line(&source, &SYNTAXES).ok()?
            }
            _ => continue,
        };
        let length = u32::try_from(row.content.encode_utf16().count()).ok()?;
        let mut spans = Vec::new();
        append_spans(&mut spans, ranges, length, 0, budget)?;
        result.push(GitDiffSyntaxLine {
            key: row.key.clone(),
            spans,
        });
    }
    Some(result)
}

fn append_spans(
    spans: &mut Vec<SyntaxSpan>,
    ranges: Vec<(Style, &str)>,
    length: u32,
    base: u32,
    budget: &mut usize,
) -> Option<()> {
    let mut offset = 0u32;
    for (style, text) in ranges {
        let end = offset
            .saturating_add(u32::try_from(text.encode_utf16().count()).ok()?)
            .min(length);
        if end > offset {
            let color = format!(
                "#{:02x}{:02x}{:02x}",
                style.foreground.r, style.foreground.g, style.foreground.b
            );
            let bold = style.font_style.contains(FontStyle::BOLD);
            let italic = style.font_style.contains(FontStyle::ITALIC);
            if let Some(last) = spans.last_mut()
                && last.color == color
                && last.bold == bold
                && last.italic == italic
            {
                last.end = base + end;
            } else {
                *budget = budget.checked_sub(1)?;
                spans.push(SyntaxSpan {
                    start: base + offset,
                    end: base + end,
                    color,
                    bold,
                    italic,
                });
            }
        }
        offset = end;
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_ops::parse_git_diff;

    #[test]
    fn source_highlighting_preserves_comments_crlf_and_full_utf16_coverage() {
        let content = "/*\r\nconst comment = true;\r\n*/\nconst code = true; 😀\t中文\n\n";
        let syntax = crate::runtime()
            .unwrap()
            .block_on(highlight_code(content.into(), "typescript".into()));
        for spans in [&syntax.dark, &syntax.light] {
            assert_eq!(spans.first().unwrap().start, 0);
            assert_eq!(
                spans.last().unwrap().end as usize,
                content.encode_utf16().count()
            );
            assert!(spans.windows(2).all(|pair| pair[0].end == pair[1].start));
            let color_at = |needle: &str| {
                let offset = u32::try_from(
                    content[..content.find(needle).unwrap()]
                        .encode_utf16()
                        .count(),
                )
                .unwrap();
                &spans
                    .iter()
                    .find(|span| span.start <= offset && span.end > offset)
                    .unwrap()
                    .color
            };
            assert_ne!(color_at("const comment"), color_at("const code"));
        }
    }

    #[test]
    fn source_limits_and_unknown_languages_have_a_plain_text_fallback() {
        for content in [
            "x".repeat(MAX_LINE_BYTES + 1),
            "let x = 1;\n".repeat(MAX_LINES + 1),
        ] {
            assert_eq!(highlight_source(&content, "rust"), CodeSyntax::default());
        }
        assert_eq!(
            highlight_source("some text", "plaintext"),
            CodeSyntax::default()
        );
        assert_eq!(
            highlight_source("some text", "unknown-language"),
            CodeSyntax::default()
        );
    }

    fn spans_for<'a>(
        lines: &'a [GitDiffSyntaxLine],
        rows: &[GitDiffRow],
        content: &str,
    ) -> &'a [SyntaxSpan] {
        let key = &rows.iter().find(|row| row.content == content).unwrap().key;
        &lines.iter().find(|line| &line.key == key).unwrap().spans
    }

    #[test]
    fn preserves_multiline_state_without_mixing_deleted_and_added_sides() {
        let patch = parse_git_diff(b"@@ -1,4 +1,4 @@\n /*\n-*/\n-const removed = true;\n+const still_comment = true;\n+*/\n const code = true;\n").unwrap();
        let syntax = highlight_diff(&patch.rows, "file.ts");
        for lines in [&syntax.dark, &syntax.light] {
            let comment = spans_for(lines, &patch.rows, "const still_comment = true;");
            let code = spans_for(lines, &patch.rows, "const code = true;");
            assert_eq!(comment.len(), 1);
            assert_ne!(comment[0].color, code[0].color);
            assert!(code.len() > 1);
        }
    }

    #[test]
    fn resets_at_hunk_boundaries_and_uses_utf16_offsets() {
        let patch = parse_git_diff(
            "@@ -1 +1 @@\n+/* open\n@@ -20 +20 @@\n+😀\tconst 中文 = true;\n".as_bytes(),
        )
        .unwrap();
        let syntax = highlight_diff(&patch.rows, "file.tsx");
        let content = &patch.rows.last().unwrap().content;
        for lines in [&syntax.dark, &syntax.light] {
            let spans = spans_for(lines, &patch.rows, content);
            assert!(spans.len() > 1);
            assert_eq!(spans.first().unwrap().start, 0);
            assert_eq!(
                spans.last().unwrap().end as usize,
                content.encode_utf16().count()
            );
            assert!(spans.windows(2).all(|pair| pair[0].end == pair[1].start));
        }
    }

    #[test]
    fn falls_back_without_removing_source_for_unknown_or_large_inputs() {
        let patch = parse_git_diff(b"@@ -0,0 +1 @@\n+plain text\n").unwrap();
        assert_eq!(
            highlight_diff(&patch.rows, "file.unknown"),
            GitDiffSyntax::default()
        );
        let long = parse_git_diff(
            format!("@@ -0,0 +1 @@\n+{}\n", "x".repeat(MAX_LINE_BYTES + 1)).as_bytes(),
        )
        .unwrap();
        assert_eq!(
            highlight_diff(&long.rows, "file.rs"),
            GitDiffSyntax::default()
        );
        assert_eq!(long.rows.last().unwrap().content.len(), MAX_LINE_BYTES + 1);
    }
}
