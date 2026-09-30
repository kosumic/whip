//! Bounded review presentation, computed on a blocking Rust worker rather than the UI thread.
use crate::remote_ops::{GitDiff, GitDiffContext, GitDiffRow, GitDiffRowKind};
use sha2::{Digest, Sha256};

const EXPANSION_STEP: u32 = 20;
const MAX_EXPANSION: u32 = 2_000;
const MAX_WORD_LINE_BYTES: usize = 4_096;
const MAX_TOKENS: usize = 256;
const WORD_WORK_BUDGET: usize = 1_000_000;

// Source rows and tokens are bounded before reaching the FFI representation.
fn ffi_offset(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitDiffExpansion {
    pub key: String,
    pub before: u32,
    pub after: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitDiffSpan {
    /// UTF-16 offsets into the original (unexpanded-tab) source text.
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitDiffHighlight {
    pub row: u32,
    pub spans: Vec<GitDiffSpan>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitDiffGap {
    pub before_row: u32,
    /// None at the end of a bounded patch, where EOF is not yet known.
    pub hidden_lines: Option<u32>,
    pub expansion: GitDiffExpansion,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitDiffReview {
    pub diff: GitDiff,
    pub highlights: Vec<GitDiffHighlight>,
    pub gaps: Vec<GitDiffGap>,
    pub revision: String,
}

pub(crate) fn context_lines(context: GitDiffContext) -> u32 {
    match context {
        GitDiffContext::Compact => 3,
        GitDiffContext::Expanded => 20,
        GitDiffContext::Full => i32::MAX as u32,
    }
}

pub(crate) fn fetch_context(
    context: GitDiffContext,
    expansions: &[GitDiffExpansion],
) -> Result<u32, String> {
    if expansions.len() > 500
        || expansions
            .iter()
            .any(|entry| entry.before > MAX_EXPANSION || entry.after > MAX_EXPANSION)
    {
        return Err("Context expansion limit reached; use Full file instead".into());
    }
    let extra = expansions
        .iter()
        .map(|entry| entry.before.max(entry.after))
        .max()
        .unwrap_or(0);
    Ok(context_lines(context)
        .saturating_add(extra)
        .min(i32::MAX as u32))
}

struct Block {
    start: usize,
    end: usize,
    expansion: GitDiffExpansion,
}

fn changed(row: &GitDiffRow) -> bool {
    matches!(
        row.kind,
        GitDiffRowKind::Addition | GitDiffRowKind::Deletion
    )
}

fn blocks(rows: &[GitDiffRow], expansions: &[GitDiffExpansion]) -> Vec<Block> {
    let mut result = Vec::new();
    let mut index = 0;
    while index < rows.len() {
        if !changed(&rows[index]) {
            index += 1;
            continue;
        }
        let start = index;
        while index < rows.len() && changed(&rows[index]) {
            index += 1;
        }
        let row = &rows[start];
        let key = match row.old_line {
            Some(line) => format!("old:{line}"),
            None => format!("new:{}", row.new_line.unwrap_or(0)),
        };
        let expansion = expansions
            .iter()
            .find(|item| item.key == key)
            .cloned()
            .unwrap_or(GitDiffExpansion {
                key,
                before: 0,
                after: 0,
            });
        result.push(Block {
            start,
            end: index,
            expansion,
        });
    }
    result
}

pub(crate) fn review(
    mut diff: GitDiff,
    context: GitDiffContext,
    expansions: &[GitDiffExpansion],
) -> GitDiffReview {
    let source = &diff.rows;
    let blocks = blocks(source, expansions);
    let mut keep = source
        .iter()
        .map(|row| row.kind != GitDiffRowKind::Context)
        .collect::<Vec<_>>();
    let base = context_lines(context) as usize;
    for block in &blocks {
        for index in (0..block.start)
            .rev()
            .take(base.saturating_add(block.expansion.before as usize))
        {
            if source[index].kind != GitDiffRowKind::Context {
                break;
            }
            keep[index] = true;
        }
        for index in
            (block.end..source.len()).take(base.saturating_add(block.expansion.after as usize))
        {
            if source[index].kind != GitDiffRowKind::Context {
                break;
            }
            keep[index] = true;
        }
    }
    // Metadata-only changes must remain readable.
    if blocks.is_empty() {
        keep.fill(true);
    }
    let mut gaps = Vec::new();
    let mut rows: Vec<GitDiffRow> = Vec::new();
    let mut old = 0u32;
    let mut new = 0u32;
    let mut previous_code: Option<usize> = None;
    for (index, row) in source.iter().enumerate().filter(|(index, _)| keep[*index]) {
        let missing = row
            .old_line
            .map(|line| line.saturating_sub(old.saturating_add(1)))
            .or_else(|| {
                row.new_line
                    .map(|line| line.saturating_sub(new.saturating_add(1)))
            })
            .unwrap_or(0);
        // A replacement can begin with deleted lines and no leading context.
        // Do not mistake its first added line for a second hidden gap.
        let discontinuity = previous_code.is_none_or(|previous| {
            source[previous + 1..index]
                .iter()
                .any(|row| matches!(row.kind, GitDiffRowKind::Context | GitDiffRowKind::Hunk))
        });
        if missing > 0
            && discontinuity
            && context != GitDiffContext::Full
            && let Some(block) = blocks.iter().find(|block| block.end > index)
        {
            let mut expansion = block.expansion.clone();
            expansion.before = expansion.before.saturating_add(EXPANSION_STEP);
            let before_row = if rows
                .last()
                .is_some_and(|row| row.kind == GitDiffRowKind::Hunk)
            {
                rows.len() - 1
            } else {
                rows.len()
            };
            gaps.push(GitDiffGap {
                before_row: ffi_offset(before_row),
                hidden_lines: Some(missing),
                expansion,
            });
        }
        if let Some(line) = row.old_line {
            old = line;
        }
        if let Some(line) = row.new_line {
            new = line;
        }
        if row.old_line.is_some() || row.new_line.is_some() {
            previous_code = Some(index);
        }
        rows.push(row.clone());
    }
    if context != GitDiffContext::Full
        && !diff.truncated
        && let Some(block) = blocks.last()
    {
        let trailing = source[block.end..]
            .iter()
            .take_while(|row| row.kind == GitDiffRowKind::Context)
            .count();
        let fetched = fetch_context(context, expansions).unwrap_or(context_lines(context)) as usize;
        let shown = base + block.expansion.after as usize;
        if trailing > shown || trailing == fetched {
            let mut expansion = block.expansion.clone();
            expansion.after = expansion.after.saturating_add(EXPANSION_STEP);
            gaps.push(GitDiffGap {
                before_row: ffi_offset(rows.len()),
                hidden_lines: if trailing < fetched {
                    Some(ffi_offset(trailing - shown))
                } else {
                    None
                },
                expansion,
            });
        }
    }
    // Expanding a gap can merge Git's patch hunks; change navigation must still
    // reach each replacement rather than collapsing to a single destination.
    diff.hunk_rows = self::blocks(&rows, &[])
        .iter()
        .map(|block| ffi_offset(block.start))
        .collect();
    diff.rows = rows;
    let mut hash = Sha256::new();
    for row in &diff.rows {
        hash.update(row.old_line.unwrap_or(0).to_le_bytes());
        hash.update(row.new_line.unwrap_or(0).to_le_bytes());
        hash.update(row.marker.as_bytes());
        hash.update(row.content.as_bytes());
        hash.update([0]);
    }
    hash.update([u8::from(diff.truncated)]);
    let revision = crate::lower_hex(&hash.finalize());
    let highlights = highlights(&diff.rows);
    GitDiffReview {
        diff,
        highlights,
        gaps,
        revision,
    }
}

struct Token<'a> {
    text: &'a str,
    start: u32,
    end: u32,
}

fn tokens(text: &str) -> Option<Vec<Token<'_>>> {
    if text.len() > MAX_WORD_LINE_BYTES {
        return None;
    }
    let mut result = Vec::new();
    let mut iter = text.char_indices().peekable();
    let mut offset = 0u32;
    while let Some((start, ch)) = iter.next() {
        let from = offset;
        offset += ffi_offset(ch.len_utf16());
        let word = ch.is_alphanumeric() || ch == '_';
        let space = ch.is_whitespace();
        while let Some(&(_, next)) = iter.peek() {
            if !(word && (next.is_alphanumeric() || next == '_') || space && next.is_whitespace()) {
                break;
            }
            offset += ffi_offset(next.len_utf16());
            iter.next();
        }
        let end = iter.peek().map_or(text.len(), |(index, _)| *index);
        result.push(Token {
            text: &text[start..end],
            start: from,
            end: offset,
        });
        if result.len() > MAX_TOKENS {
            return None;
        }
    }
    Some(result)
}

fn word_spans(
    before: &str,
    after: &str,
    budget: &mut usize,
) -> Option<(Vec<GitDiffSpan>, Vec<GitDiffSpan>)> {
    let a = tokens(before)?;
    let b = tokens(after)?;
    let work = (a.len() + 1) * (b.len() + 1);
    *budget = budget.checked_sub(work)?;
    let width = b.len() + 1;
    let mut table = vec![0u16; work];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            table[i * width + j] = if a[i].text == b[j].text {
                1 + table[(i + 1) * width + j + 1]
            } else {
                table[(i + 1) * width + j].max(table[i * width + j + 1])
            };
        }
    }
    let mut removed = Vec::new();
    let mut added = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i].text == b[j].text {
            i += 1;
            j += 1;
        } else if i < a.len()
            && (j == b.len() || table[(i + 1) * width + j] >= table[i * width + j + 1])
        {
            push_span(&mut removed, &a[i]);
            i += 1;
        } else {
            push_span(&mut added, &b[j]);
            j += 1;
        }
    }
    Some((removed, added))
}

fn push_span(spans: &mut Vec<GitDiffSpan>, token: &Token<'_>) {
    if let Some(last) = spans.last_mut()
        && last.end == token.start
    {
        last.end = token.end;
    } else {
        spans.push(GitDiffSpan {
            start: token.start,
            end: token.end,
        });
    }
}

fn highlights(rows: &[GitDiffRow]) -> Vec<GitDiffHighlight> {
    let mut result = Vec::new();
    let mut budget = WORD_WORK_BUDGET;
    for block in blocks(rows, &[]) {
        let deleted = (block.start..block.end)
            .filter(|&i| rows[i].kind == GitDiffRowKind::Deletion)
            .collect::<Vec<_>>();
        let added = (block.start..block.end)
            .filter(|&i| rows[i].kind == GitDiffRowKind::Addition)
            .collect::<Vec<_>>();
        // Avoid misleading pairing when lines were inserted/deleted within a replacement.
        if deleted.len() != added.len() || deleted.len() > 50 {
            continue;
        }
        for (&old, &new) in deleted.iter().zip(&added) {
            if let Some((removed, added)) =
                word_spans(&rows[old].content, &rows[new].content, &mut budget)
            {
                if !removed.is_empty() {
                    result.push(GitDiffHighlight {
                        row: ffi_offset(old),
                        spans: removed,
                    });
                }
                if !added.is_empty() {
                    result.push(GitDiffHighlight {
                        row: ffi_offset(new),
                        spans: added,
                    });
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_ops::parse_git_diff;

    #[test]
    fn word_changes_use_utf16_offsets_and_preserve_separate_edits() {
        let mut budget = WORD_WORK_BUDGET;
        let (removed, added) =
            word_spans("😀\tcall(old, 10)", "😀\tcall(new, 20)", &mut budget).unwrap();
        assert_eq!(
            removed,
            vec![
                GitDiffSpan { start: 8, end: 11 },
                GitDiffSpan { start: 13, end: 15 }
            ]
        );
        assert_eq!(added, removed);
        assert!(word_spans(&"x".repeat(MAX_WORD_LINE_BYTES + 1), "y", &mut budget).is_none());
        assert!(word_spans("a", "b", &mut 0).is_none());
    }

    #[test]
    fn expansion_reveals_only_the_requested_gap_and_keeps_every_change() {
        // Wider Git context has merged three changes into one hunk.
        let mut patch = "@@ -1,100 +1,100 @@\n".to_owned();
        for line in 1..=100 {
            if [10, 50, 90].contains(&line) {
                patch.push_str(&format!("-old {line}\n+new {line}\n"));
            } else {
                patch.push_str(&format!(" line {line}\n"));
            }
        }
        let compact = review(
            parse_git_diff(patch.as_bytes()).unwrap(),
            GitDiffContext::Compact,
            &[],
        );
        let gap = compact
            .gaps
            .iter()
            .find(|gap| gap.expansion.key == "old:50")
            .unwrap();
        let expanded = review(
            parse_git_diff(patch.as_bytes()).unwrap(),
            GitDiffContext::Compact,
            &[gap.expansion.clone()],
        );
        assert!(
            expanded
                .diff
                .rows
                .iter()
                .any(|row| row.new_line == Some(27))
        );
        assert!(
            !expanded
                .diff
                .rows
                .iter()
                .any(|row| row.new_line == Some(26))
        );
        assert!(
            !expanded
                .diff
                .rows
                .iter()
                .any(|row| row.new_line == Some(75))
        );
        assert_eq!(expanded.diff.additions, 3);
        assert_eq!(
            expanded.diff.rows.iter().filter(|row| changed(row)).count(),
            6
        );
        assert_eq!(expanded.highlights.len(), 6);
        assert_ne!(compact.revision, expanded.revision);
        let selected =
            crate::remote_ops::git_diff_selection("file.ts".into(), expanded.diff.rows).unwrap();
        assert!(selected.contains("@@ omitted unchanged lines @@"));
    }

    #[test]
    fn gaps_account_for_unloaded_lines_and_eof() {
        let bare = review(
            parse_git_diff(b"@@ -97 +97 @@\n-old\n+new\n").unwrap(),
            GitDiffContext::Compact,
            &[],
        );
        assert_eq!(bare.gaps.len(), 1);
        let patch = "@@ -97,7 +97,7 @@\n a\n b\n c\n-old\n+new\n d\n e\n f\n";
        let view = review(
            parse_git_diff(patch.as_bytes()).unwrap(),
            GitDiffContext::Compact,
            &[],
        );
        assert_eq!(view.gaps[0].hidden_lines, Some(96));
        assert_eq!(view.gaps.last().unwrap().hidden_lines, None);
        let full = review(
            parse_git_diff(patch.as_bytes()).unwrap(),
            GitDiffContext::Full,
            &[],
        );
        assert!(full.gaps.is_empty());
        let eof = review(
            parse_git_diff(b"@@ -1 +1 @@\n-old\n+new\n").unwrap(),
            GitDiffContext::Compact,
            &[],
        );
        assert!(eof.gaps.is_empty());
        let truncated = review(
            GitDiff {
                truncated: true,
                ..parse_git_diff(patch.as_bytes()).unwrap()
            },
            GitDiffContext::Compact,
            &[],
        );
        assert!(truncated.gaps.iter().all(|gap| gap.hidden_lines.is_some()));
    }

    #[test]
    fn pure_additions_and_unequal_replacements_do_not_get_misleading_word_pairs() {
        let diff = parse_git_diff(b"@@ -1 +1,2 @@\n-old\n+new\n+extra\n").unwrap();
        assert!(
            review(diff, GitDiffContext::Compact, &[])
                .highlights
                .is_empty()
        );
        assert!(
            fetch_context(
                GitDiffContext::Compact,
                &[GitDiffExpansion {
                    key: "old:1".into(),
                    before: MAX_EXPANSION + 1,
                    after: 0
                }]
            )
            .is_err()
        );
    }
}

#[cfg(test)]
mod git_tests {
    use super::*;
    use crate::remote_ops::{
        GitRepository, GitStatusEntry, git_diff_command_lines, parse_git_diff,
    };

    #[test]
    fn real_git_expansion_keeps_other_gaps_collapsed_when_patch_hunks_merge() {
        let directory = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(directory.path())
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        let before = (1..=200)
            .map(|line| format!("let line_{line} = old;\n"))
            .collect::<String>();
        let file = directory.path().join("source space.rs");
        std::fs::write(&file, &before).unwrap();
        git(&["add", "--", "source space.rs"]);
        git(&[
            "-c",
            "user.name=Whip Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ]);
        let after = [30, 70, 160].iter().fold(before, |text, line| {
            text.replace(&format!("line_{line} = old"), &format!("line_{line} = new"))
        });
        std::fs::write(&file, after).unwrap();
        let repository = GitRepository {
            root: directory.path().to_str().unwrap().into(),
            has_head: true,
        };
        let status = GitStatusEntry {
            index_status: " ".into(),
            worktree_status: "M".into(),
            path: "source space.rs".into(),
            original_path: None,
            absolute_path: file.to_str().unwrap().into(),
        };
        let load = |expansions: &[GitDiffExpansion]| {
            let context = GitDiffContext::Compact;
            let command = git_diff_command_lines(
                &repository,
                &status,
                fetch_context(context, expansions).unwrap(),
            )
            .unwrap();
            let output = std::process::Command::new("sh")
                .args(["-c", &command])
                .output()
                .unwrap();
            assert!(output.status.success());
            review(parse_git_diff(&output.stdout).unwrap(), context, expansions)
        };
        let first = load(&[]);
        assert_eq!(first.diff.hunk_rows.len(), 3);
        let gap = first
            .gaps
            .iter()
            .find(|gap| gap.expansion.key == "old:70")
            .unwrap();
        let expansion = gap.expansion.clone();
        let expanded = load(&[expansion.clone()]);
        assert_eq!(expanded.diff.hunk_rows.len(), 3);
        assert_eq!((expanded.diff.additions, expanded.diff.deletions), (3, 3));
        assert!(
            expanded
                .diff
                .rows
                .iter()
                .any(|row| row.new_line == Some(47))
        );
        assert!(
            !expanded
                .diff
                .rows
                .iter()
                .any(|row| row.new_line == Some(140))
        );
        assert_eq!(expanded.highlights.len(), 6);
        assert_eq!(expanded.revision, load(&[expansion]).revision);
        let last = expanded.gaps.last().unwrap().expansion.clone();
        let tail = load(&[last]);
        assert!(tail.diff.rows.iter().any(|row| row.new_line == Some(183)));
        assert!(!tail.diff.rows.iter().any(|row| row.new_line == Some(47)));
    }
}
