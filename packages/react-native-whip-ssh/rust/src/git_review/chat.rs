//! Prepare immutable transcript changes with the same renderer as repository diffs.
use std::fmt::Write;

use crate::agent_transcript::AgentFileDiff;
use crate::host_runtime::HostRuntimeError;
use crate::remote_ops::{
    GIT_DIFF_MAX_BYTES, GIT_DIFF_MAX_ROWS, GitDiffContext, GitDiffRowKind, parse_chat_diff,
};

use super::{GitDiffReview, review_file};

#[uniffi::export]
pub async fn prepare_chat_diff(file: AgentFileDiff) -> Result<GitDiffReview, HostRuntimeError> {
    crate::runtime()
        .map_err(HostRuntimeError::GitFailure)?
        .spawn_blocking(move || prepare(&file).map_err(HostRuntimeError::GitFailure))
        .await
        .map_err(|error| HostRuntimeError::GitFailure(error.to_string()))?
}

fn prepare(file: &AgentFileDiff) -> Result<GitDiffReview, String> {
    let patch = file.patch.clone().unwrap_or_else(|| {
        let mut patch = String::new();
        let mut rows = 0;
        for (marker, content) in [('-', file.before.as_deref()), ('+', file.after.as_deref())] {
            for line in content.unwrap_or_default().lines() {
                if patch.len() > GIT_DIFF_MAX_BYTES || rows > GIT_DIFF_MAX_ROWS {
                    return patch;
                }
                let _ = writeln!(patch, "{marker}{line}");
                rows += 1;
            }
        }
        patch
    });
    let mut diff = parse_chat_diff(patch.as_bytes())?;
    diff.rows.retain(|row| {
        !matches!(row.kind, GitDiffRowKind::Header | GitDiffRowKind::Meta)
            || !row.content.starts_with("*** ")
    });
    Ok(review_file(diff, GitDiffContext::Full, &[], &file.file))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_ops::GitDiffRowKind;

    fn file(patch: Option<&str>, before: Option<&str>, after: Option<&str>) -> AgentFileDiff {
        AgentFileDiff::normalized(
            "src/file.ts".into(),
            patch.map(str::to_owned),
            before.map(str::to_owned),
            after.map(str::to_owned),
            None,
            None,
        )
    }

    #[test]
    fn numbered_patches_keep_source_lines_and_syntax_separate_from_signs() {
        let result = crate::runtime().unwrap().block_on(prepare_chat_diff(file(
            Some("--- a/src/file.ts\n+++ b/src/file.ts\n@@ -40 +40 @@\n-const value = 1;\n+const value = 2;\n"), None, None))).unwrap();
        let added = result
            .diff
            .rows
            .iter()
            .find(|row| row.kind == GitDiffRowKind::Addition)
            .unwrap();
        assert_eq!(added.content, "const value = 2;");
        assert_eq!(added.new_line, Some(40));
        for lines in [&result.syntax.dark, &result.syntax.light] {
            let spans = &lines
                .iter()
                .find(|line| line.key == added.key)
                .unwrap()
                .spans;
            assert!(spans.len() > 1);
            assert_eq!(spans.first().unwrap().start, 0);
            assert_eq!(spans.last().unwrap().end, 16);
        }
    }

    #[test]
    fn apply_patch_fragments_preserve_multiline_comments_without_fake_line_numbers() {
        let result = prepare(&file(Some("@@ function example()\n /*\n-*/\n-const removed = true;\n+const comment = true;\n+*/\n const code = true;\n*** End Patch\n"), None, None)).unwrap();
        assert_eq!((result.diff.additions, result.diff.deletions), (2, 2));
        assert!(
            result
                .diff
                .rows
                .iter()
                .all(|row| row.old_line.is_none() && row.new_line.is_none())
        );
        assert!(
            !result
                .diff
                .rows
                .iter()
                .any(|row| row.content.starts_with("*** "))
        );
        let row = result
            .diff
            .rows
            .iter()
            .find(|row| row.content == "const comment = true;")
            .unwrap();
        assert_eq!(
            result
                .syntax
                .dark
                .iter()
                .find(|line| line.key == row.key)
                .unwrap()
                .spans
                .len(),
            1
        );
    }

    #[test]
    fn before_after_and_pure_additions_have_no_phantom_trailing_lines() {
        for value in [
            file(None, Some("const old = 1;\n"), Some("const new = 2;\n")),
            file(Some("-const old = 1;\n+const new = 2;\n"), None, None),
        ] {
            let result = prepare(&value).unwrap();
            assert_eq!((result.diff.additions, result.diff.deletions), (1, 1));
            assert_eq!(result.diff.rows.len(), 2);
            assert_eq!(result.syntax.dark.len(), 2);
        }
        let added = prepare(&file(None, Some(""), Some("const new = 2;\n"))).unwrap();
        assert_eq!((added.diff.additions, added.diff.deletions), (1, 0));
        assert_eq!(added.diff.rows.len(), 1);
        assert_eq!(added.syntax.light.len(), 1);
    }

    #[test]
    fn snippet_prefixes_and_unknown_file_metadata_are_preserved() {
        let mut value = file(
            Some("--- a/file\n+++ b/file\n- --old;\n+++counter;\n"),
            None,
            None,
        );
        value.file = "file.unknown".into();
        let result = prepare(&value).unwrap();
        assert_eq!((result.diff.additions, result.diff.deletions), (1, 1));
        assert_eq!(result.diff.rows.last().unwrap().content, "++counter;");
        assert!(result.syntax.dark.is_empty());
        let mode = prepare(&file(
            Some("old mode 100644\nnew mode 100755\n"),
            None,
            None,
        ))
        .unwrap();
        assert_eq!(mode.diff.rows.len(), 2);
    }
}
