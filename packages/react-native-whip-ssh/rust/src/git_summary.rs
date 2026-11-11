//! Branch and bounded recent history for the remote Git review.

use crate::remote_ops::{GIT_DIFF_MAX_BYTES, GitStatusEntry, join_remote_path, shell_quote};

const RECENT_COMMIT_LIMIT: u32 = 3;

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitCommit {
    pub id: String,
    pub short_id: String,
    pub subject: String,
    pub author: String,
    pub committed_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitHistoryCursor {
    pub head: String,
    pub skip: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitSummary {
    pub branch: Option<String>,
    pub commits: Vec<GitCommit>,
    pub next: Option<GitHistoryCursor>,
}

pub(crate) fn git_summary_command(
    root: &str,
    cursor: Option<&GitHistoryCursor>,
) -> Result<String, String> {
    let (head, skip) = if let Some(cursor) = cursor {
        validate_commit(&cursor.head)?;
        (format!("head={}", shell_quote(&cursor.head)), cursor.skip)
    } else {
        ("head=$(git rev-parse --verify --quiet HEAD) || { code=$?; [ \"$code\" -eq 1 ] || exit \"$code\"; head=; }".to_owned(), 0)
    };
    let fetch_limit = RECENT_COMMIT_LIMIT + 1;
    // A symbolic branch still exists before the first commit. Detached HEAD
    // returns 1 from symbolic-ref; other failures must reach the caller.
    let script = format!(
        "cd {} || exit $?\nbranch=$(git symbolic-ref --quiet --short HEAD) || {{ code=$?; [ \"$code\" -eq 1 ] || exit \"$code\"; }}\n{head}\nprintf '%s\\0%s\\0' \"$branch\" \"$head\"\n[ -n \"$head\" ] || exit 0\ngit --no-pager -c i18n.logOutputEncoding=UTF-8 log --no-decorate --no-show-signature -{fetch_limit} --skip={skip} -z --format='%H%x00%h%x00%s%x00%an%x00%cI' \"$head\" --",
        shell_quote(root),
    );
    Ok(format!("sh -c {}", shell_quote(&script)))
}

pub(crate) fn parse_git_summary(bytes: &[u8], skip: u32) -> Result<GitSummary, String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| "Git summary output was not UTF-8".to_owned())?;
    let text = text
        .strip_suffix('\0')
        .ok_or_else(|| "Git summary output was incomplete".to_owned())?;
    let mut fields = text.split('\0');
    let branch = fields
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let head = fields.next().ok_or("Git summary returned no HEAD")?;
    if !head.is_empty() {
        validate_commit(head)?;
    }
    let mut commits = Vec::new();
    while let Some(id) = fields.next() {
        let mut next = || {
            fields
                .next()
                .map(str::to_owned)
                .ok_or_else(|| "Git commit output was incomplete".to_owned())
        };
        commits.push(GitCommit {
            id: id.to_owned(),
            short_id: next()?,
            subject: next()?,
            author: next()?,
            committed_at: next()?,
        });
    }
    let next = if commits.len() > RECENT_COMMIT_LIMIT as usize {
        commits.truncate(RECENT_COMMIT_LIMIT as usize);
        Some(GitHistoryCursor {
            head: head.to_owned(),
            skip: skip
                .checked_add(RECENT_COMMIT_LIMIT)
                .ok_or("Git history offset exceeded the limit")?,
        })
    } else {
        None
    };
    Ok(GitSummary {
        branch,
        commits,
        next,
    })
}

fn validate_commit(commit: &str) -> Result<(), String> {
    if !matches!(commit.len(), 40 | 64) || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Git commit ID is invalid".to_owned());
    }
    Ok(())
}

pub(crate) fn git_commit_files_command(root: &str, commit: &str) -> Result<String, String> {
    validate_commit(commit)?;
    Ok(format!(
        "git -C {} diff-tree --root --no-commit-id --name-status --diff-merges=first-parent -r -z -M {} --",
        shell_quote(root),
        shell_quote(commit),
    ))
}

pub(crate) fn parse_git_commit_files(
    bytes: &[u8],
    root: &str,
) -> Result<Vec<GitStatusEntry>, String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| "Git commit files were not UTF-8".to_owned())?;
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let text = text
        .strip_suffix('\0')
        .ok_or("Git commit files were incomplete")?;
    let mut fields = text.split('\0');
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        let code = status.chars().next().ok_or("Git commit status was empty")?;
        let mut path = fields.next().ok_or("Git commit path was missing")?;
        let original_path = if matches!(code, 'R' | 'C') {
            let original = path.to_owned();
            path = fields
                .next()
                .ok_or("Git commit rename target was missing")?;
            Some(original)
        } else {
            None
        };
        files.push(GitStatusEntry {
            index_status: code.to_string(),
            worktree_status: " ".to_owned(),
            path: path.to_owned(),
            original_path,
            absolute_path: join_remote_path(root, path)?,
        });
    }
    Ok(files)
}

pub(crate) fn git_commit_diff_command(
    root: &str,
    commit: &str,
    status: &GitStatusEntry,
    lines: u32,
) -> Result<String, String> {
    validate_commit(commit)?;
    if status.path.is_empty()
        || status.path.contains('\0')
        || status
            .original_path
            .as_ref()
            .is_some_and(|path| path.contains('\0'))
    {
        return Err("Git path is invalid".to_owned());
    }
    let root = shell_quote(root);
    let commit = shell_quote(commit);
    let paths = match &status.original_path {
        Some(original) => format!("{} {}", shell_quote(original), shell_quote(&status.path)),
        None => shell_quote(&status.path),
    };
    let script = format!(
        "git -C {root} cat-file -e {commit}^{{commit}} || exit $?\ngit -C {root} --literal-pathspecs show --format= --root --first-parent --diff-merges=first-parent --no-ext-diff --no-textconv --no-color --find-renames --unified={lines} {commit} -- {paths} | head -c {}",
        GIT_DIFF_MAX_BYTES + 1,
    );
    Ok(format!("sh -c {}", shell_quote(&script)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_git(root: &std::path::Path, args: &[&str]) -> Vec<u8> {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args([
                "-c",
                "user.name=Whip Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn run_shell(command: &str) -> Vec<u8> {
        let output = std::process::Command::new("sh")
            .args(["-c", command])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn head(root: &std::path::Path) -> String {
        String::from_utf8(run_git(root, &["rev-parse", "HEAD"]))
            .unwrap()
            .trim()
            .to_owned()
    }

    fn commit_files(root: &std::path::Path, commit: &str) -> Vec<GitStatusEntry> {
        let root = root.to_str().unwrap();
        parse_git_commit_files(
            &run_shell(&git_commit_files_command(root, commit).unwrap()),
            root,
        )
        .unwrap()
    }

    fn commit_diff(
        root: &std::path::Path,
        commit: &str,
        status: &GitStatusEntry,
    ) -> crate::remote_ops::GitDiff {
        crate::remote_ops::parse_git_diff(&run_shell(
            &git_commit_diff_command(root.to_str().unwrap(), commit, status, 3).unwrap(),
        ))
        .unwrap()
    }

    #[test]
    fn commit_review_handles_root_commits_renames_deletions_and_ignores_worktree_edits() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        run_git(root, &["init", "--quiet", "--initial-branch=main"]);
        let original = "file [1].txt";
        std::fs::write(root.join(original), "original content\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "--quiet", "-m", "first"]);
        let first = head(root);
        std::fs::write(root.join(original), "uncommitted replacement\n").unwrap();
        let files = commit_files(root, &first);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].index_status, "A");
        let diff = commit_diff(root, &first, &files[0]);
        assert_eq!(diff.additions, 1);
        assert!(
            diff.rows
                .iter()
                .any(|row| row.content == "original content")
        );
        assert!(
            !diff
                .rows
                .iter()
                .any(|row| row.content.contains("uncommitted"))
        );

        run_git(root, &["restore", "."]);
        run_git(root, &["mv", original, "renamed.txt"]);
        run_git(root, &["commit", "--quiet", "-m", "rename"]);
        let rename = head(root);
        let files = commit_files(root, &rename);
        assert_eq!(files[0].original_path.as_deref(), Some(original));
        assert_eq!(files[0].path, "renamed.txt");
        let diff = commit_diff(root, &rename, &files[0]);
        assert!(
            diff.rows
                .iter()
                .any(|row| row.content == format!("rename from {original}"))
        );

        run_git(root, &["rm", "renamed.txt"]);
        run_git(root, &["commit", "--quiet", "-m", "delete"]);
        let deleted = head(root);
        let files = commit_files(root, &deleted);
        assert_eq!(files[0].index_status, "D");
        assert_eq!(commit_diff(root, &deleted, &files[0]).deletions, 1);
        assert!(
            commit_files(root, &first)
                .iter()
                .all(|file| file.path == original)
        );
    }

    #[test]
    fn merge_review_compares_against_the_first_parent() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        run_git(root, &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(root.join("base"), "base\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "--quiet", "-m", "base"]);
        run_git(root, &["checkout", "--quiet", "-b", "topic"]);
        std::fs::write(root.join("topic"), "topic\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "--quiet", "-m", "topic"]);
        run_git(root, &["checkout", "--quiet", "main"]);
        std::fs::write(root.join("base"), "main\n").unwrap();
        run_git(root, &["commit", "--quiet", "-am", "main"]);
        run_git(
            root,
            &["merge", "--quiet", "--no-ff", "-m", "merge", "topic"],
        );
        let commit = head(root);
        let files = commit_files(root, &commit);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "topic");
        assert_eq!(commit_diff(root, &commit, &files[0]).additions, 1);
    }

    #[test]
    fn summary_tracks_unborn_branches_recent_history_and_detached_head() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo space'$HOME");
        std::fs::create_dir(&root).unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        let summary = |cursor: Option<&GitHistoryCursor>| {
            let output = std::process::Command::new("sh")
                .args([
                    "-c",
                    &git_summary_command(root.to_str().unwrap(), cursor).unwrap(),
                ])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            parse_git_summary(&output.stdout, cursor.map_or(0, |cursor| cursor.skip)).unwrap()
        };
        git(&["init", "--quiet", "--initial-branch=feature/review"]);
        assert_eq!(
            summary(None),
            GitSummary {
                branch: Some("feature/review".to_owned()),
                commits: vec![],
                next: None,
            }
        );
        for index in 0..7 {
            git(&[
                "-c",
                "user.name=Whip 作者",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                &format!("change {index}: 引用 ' and | pipes\n\nCommit body"),
            ]);
        }
        let recent = summary(None);
        assert_eq!(recent.branch.as_deref(), Some("feature/review"));
        assert_eq!(recent.commits.len(), RECENT_COMMIT_LIMIT as usize);
        assert_eq!(recent.commits[0].subject, "change 6: 引用 ' and | pipes");
        assert_eq!(recent.commits[0].author, "Whip 作者");
        assert!(chrono::DateTime::parse_from_rfc3339(&recent.commits[0].committed_at).is_ok());
        assert_eq!(recent.commits[2].subject, "change 4: 引用 ' and | pipes");
        assert!(
            recent.commits[0]
                .id
                .starts_with(&recent.commits[0].short_id)
        );
        // New commits must not shift offsets in an already-open history.
        run_git(
            &root,
            &["commit", "--quiet", "--allow-empty", "-m", "new tip"],
        );
        let second = summary(recent.next.as_ref());
        assert_eq!(second.commits.len(), RECENT_COMMIT_LIMIT as usize);
        assert_eq!(second.commits[0].subject, "change 3: 引用 ' and | pipes");
        let last = summary(second.next.as_ref());
        assert_eq!(last.commits.len(), 1);
        assert_eq!(last.commits[0].subject, "change 0: 引用 ' and | pipes");
        assert!(last.next.is_none());
        git(&["checkout", "--quiet", "--detach", &recent.commits[1].id]);
        let detached = summary(None);
        assert_eq!(detached.branch, None);
        assert_eq!(detached.commits[0].id, recent.commits[1].id);
        let last_full_page = summary(detached.next.as_ref());
        assert_eq!(last_full_page.commits.len(), RECENT_COMMIT_LIMIT as usize);
        assert!(last_full_page.next.is_none());
    }

    #[test]
    fn summary_rejects_partial_and_invalid_output() {
        for output in [
            b"".as_slice(),
            b"main",
            b"main\0id\0short\0",
            b"main\0\xff\0",
        ] {
            assert!(parse_git_summary(output, 0).is_err());
        }
    }
}
