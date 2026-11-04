//! Semantic tokens for the native Markdown renderers, sharing Syntect's grammars.
use std::{ffi::c_void, panic::catch_unwind, sync::LazyLock};
use syntect::parsing::{ParseState, Scope, ScopeStack};

use super::{MAX_LINE_BYTES, MAX_SPANS, SYNTAXES, find_syntax};

// Match the native renderer's synchronous highlighting limits.
const MAX_BYTES: usize = 50 * 1024;
const MAX_LINES: usize = 2_000;
const MAX_LANGUAGE_BYTES: usize = 256;

// Ordinals match EnrichedMarkdown's HighlightTokenType on both platforms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
enum Kind {
    Keyword,
    Operator,
    Punctuation,
    String,
    Number,
    Constant,
    Comment,
    Function,
    Type,
    Variable,
    Property,
    Tag,
    Attribute,
    Embedded,
}

#[derive(Debug, PartialEq, Eq)]
struct Token {
    start: u32,
    end: u32,
    kind: Kind,
}

static SCOPES: LazyLock<Vec<(Scope, Kind)>> = LazyLock::new(|| {
    [
        ("keyword.operator", Kind::Operator),
        ("keyword", Kind::Keyword),
        ("storage", Kind::Keyword),
        ("comment", Kind::Comment),
        ("constant.numeric", Kind::Number),
        ("constant.character", Kind::String),
        ("constant", Kind::Constant),
        ("string", Kind::String),
        ("entity.name.function", Kind::Function),
        ("support.function", Kind::Function),
        ("entity.name.tag", Kind::Tag),
        ("entity.other.attribute-name", Kind::Attribute),
        ("entity.name", Kind::Type),
        ("support.type", Kind::Type),
        ("support.class", Kind::Type),
        ("variable.other.property", Kind::Property),
        ("variable.other.member", Kind::Property),
        ("variable", Kind::Variable),
        ("punctuation", Kind::Punctuation),
        ("meta.embedded", Kind::Embedded),
    ]
    .into_iter()
    .filter_map(|(name, kind)| Scope::new(name).ok().map(|scope| (scope, kind)))
    .collect()
});

fn kind(stack: &ScopeStack) -> Option<Kind> {
    stack.scopes.iter().rev().find_map(|scope| {
        SCOPES
            .iter()
            .find_map(|(prefix, kind)| prefix.is_prefix_of(*scope).then_some(*kind))
    })
}

fn append(tokens: &mut Vec<Token>, text: &str, stack: &ScopeStack, offset: &mut u32) -> Option<()> {
    let start = *offset;
    *offset += u32::try_from(text.encode_utf16().count()).ok()?;
    if start == *offset {
        return Some(());
    }
    let Some(kind) = kind(stack) else {
        return Some(());
    };
    if let Some(last) = tokens
        .last_mut()
        .filter(|last| last.end == start && last.kind == kind)
    {
        last.end = *offset;
    } else {
        if tokens.len() >= MAX_SPANS {
            return None;
        }
        tokens.push(Token {
            start,
            end: *offset,
            kind,
        });
    }
    Some(())
}

fn highlight(code: &str, language: &str) -> Option<Vec<Token>> {
    if code.is_empty()
        || code.len() > MAX_BYTES
        || code.lines().count() > MAX_LINES
        || code.lines().any(|line| line.len() > MAX_LINE_BYTES)
    {
        return None;
    }
    let language = language
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let language = match language.as_str() {
        "golang" => "go",
        // TSX also accepts ordinary JSX; the Babel grammar is excluded by fancy-regex.
        "jsx" | "javascriptreact" => "tsx",
        "csharp" => "cs",
        other => other,
    };
    let syntax = find_syntax(language)?;
    let mut parser = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut tokens = Vec::new();
    let mut offset = 0;
    for line in code.split_inclusive('\n') {
        let mut start = 0;
        for (end, operation) in parser.parse_line(line, &SYNTAXES).ok()? {
            append(&mut tokens, line.get(start..end)?, &stack, &mut offset)?;
            stack.apply(&operation).ok()?;
            start = end;
        }
        append(&mut tokens, line.get(start..)?, &stack, &mut offset)?;
    }
    Some(tokens)
}

type Callback = unsafe extern "C" fn(*mut c_void, u32, u32, u32) -> bool;

/// Synchronous semantic highlighting without a JavaScript round trip.
///
/// # Safety
/// Nonempty inputs must point to readable UTF-8 buffers of the supplied lengths.
/// `context` must remain valid for every callback. The callback must not unwind
/// and must not retain references to its inputs. Returning false cancels output.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_syntax_highlight(
    code: *const u8,
    code_len: usize,
    language: *const u8,
    language_len: usize,
    context: *mut c_void,
    callback: Callback,
) -> bool {
    if code_len == 0
        || code_len > MAX_BYTES
        || language_len == 0
        || language_len > MAX_LANGUAGE_BYTES
        || code.is_null()
        || language.is_null()
    {
        return false;
    }
    catch_unwind(|| {
        // SAFETY: The caller guarantees a readable source buffer; null and size checks precede this.
        let code = unsafe { std::slice::from_raw_parts(code, code_len) };
        // SAFETY: The caller guarantees a readable language buffer; null and size checks precede this.
        let language = unsafe { std::slice::from_raw_parts(language, language_len) };
        let (Ok(code), Ok(language)) = (std::str::from_utf8(code), std::str::from_utf8(language))
        else {
            return false;
        };
        let Some(tokens) = highlight(code, language) else {
            return false;
        };
        for token in tokens {
            // SAFETY: The synchronous caller owns context and supplies a non-unwinding callback.
            if !unsafe { callback(context, token.start, token.end, token.kind as u32) } {
                return false;
            }
        }
        true
    })
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    #[test]
    fn native_markdown_languages_and_additional_grammars_have_tokens() -> Result<(), Box<dyn Error>>
    {
        for (language, code) in [
            ("rust", "fn main() { let value = 42; }"),
            ("typescript", "const value: number = 42;"),
            ("javascript", "const value = 42;"),
            ("tsx", "const value = <div title=\"hello\" />;"),
            ("jsx", "const value = <div title=\"hello\" />;"),
            ("python", "def hello():\n    return 42\n"),
            ("bash", "echo \"hello\"\n"),
            ("json", "{\"value\": 42}"),
            ("yaml", "value: true\n"),
            ("markdown", "# Hello\n**world**\n"),
            ("c", "int main(void) { return 42; }"),
            ("cpp", "class Hello { int value = 42; };"),
            ("go", "package main\nfunc main() {}\n"),
            ("toml", "[example]\nvalue = true\n"),
            ("nix", "{ value = true; }"),
            ("sql", "SELECT value FROM example;"),
        ] {
            let started = std::time::Instant::now();
            let tokens = highlight(code, language)
                .ok_or_else(|| format!("No syntax tokens for {language}"))?;
            eprintln!("{language}: {:?}", started.elapsed());
            assert!(!tokens.is_empty(), "{language}");
            assert!(tokens.iter().all(|token| token.start < token.end
                && token.end as usize <= code.encode_utf16().count()));
            assert!(tokens.windows(2).all(|pair| pair[0].end <= pair[1].start));
        }
        Ok(())
    }

    #[test]
    fn unicode_and_multiline_comments_preserve_utf16_offsets() -> Result<(), Box<dyn Error>> {
        let code = "/* 😀 中文\r\ncomment */\r\nfn hello() { let n = 42; }\n";
        let tokens = highlight(code, "RUST").ok_or("Missing Rust syntax tokens")?;
        for (text, expected) in [
            ("comment", Kind::Comment),
            ("fn", Kind::Keyword),
            ("hello", Kind::Function),
            ("42", Kind::Number),
        ] {
            let byte_offset = code.find(text).ok_or("Missing fixture text")?;
            let start = u32::try_from(code[..byte_offset].encode_utf16().count())?;
            let end = start + u32::try_from(text.encode_utf16().count())?;
            assert!(
                tokens.iter().any(|token| token.start <= start
                    && token.end >= end
                    && token.kind == expected),
                "{text}: {tokens:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn unknown_languages_and_large_blocks_fall_back_to_plain_text() {
        for language in ["", "plaintext", "unknown-language"] {
            assert!(highlight("hello", language).is_none());
        }
        assert!(highlight(&"x".repeat(MAX_LINE_BYTES + 1), "rust").is_none());
        assert!(highlight(&"x\n".repeat(MAX_LINES + 1), "rust").is_none());
        assert!(highlight(&"let x = 1;\n".repeat(MAX_BYTES / 11 + 1), "rust").is_none());
    }

    unsafe extern "C" fn collect(context: *mut c_void, start: u32, end: u32, kind: u32) -> bool {
        // SAFETY: This test passes a live vector of token triplets as context.
        unsafe { &mut *context.cast::<Vec<(u32, u32, u32)>>() }.push((start, end, kind));
        true
    }

    #[test]
    fn ffi_returns_semantic_tokens_and_rejects_invalid_utf8() {
        let mut output = Vec::<(u32, u32, u32)>::new();
        let language = b"rust";
        let invoke = |code: &[u8], output: &mut Vec<(u32, u32, u32)>| {
            // SAFETY: Both buffers and the callback context remain alive for the synchronous call.
            unsafe {
                whip_syntax_highlight(
                    code.as_ptr(),
                    code.len(),
                    language.as_ptr(),
                    language.len(),
                    std::ptr::from_mut(output).cast(),
                    collect,
                )
            }
        };
        assert!(invoke(b"let n = 42;", &mut output));
        assert!(!output.is_empty());
        assert!(!invoke(b"\xff", &mut output));
        // SAFETY: Null is explicitly rejected before dereferencing; other inputs remain valid.
        assert!(!unsafe {
            whip_syntax_highlight(
                std::ptr::null(),
                1,
                language.as_ptr(),
                language.len(),
                std::ptr::from_mut(&mut output).cast(),
                collect,
            )
        });
    }
}
