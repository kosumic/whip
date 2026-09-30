//! Whip-level remote operation policy layered over the product-neutral SSH transport.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use tokio::sync::{Notify, watch};

pub(crate) const REMOTE_TEXT_MAX_BYTES: u64 = 512 * 1024;
pub(crate) const GIT_DIFF_MAX_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const GIT_DIFF_MAX_ROWS: usize = 12_000;
pub(crate) const MAX_ACTIVE_TRANSFERS: usize = 4;
pub(crate) const MAX_ACTIVE_PREVIEWS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum RemoteFileKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub kind: RemoteFileKind,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
    pub permissions: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct RemoteDirectoryListing {
    pub path: String,
    pub entries: Vec<RemoteFileEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TransferState {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub bytes_transferred: u64,
    pub total_bytes: Option<u64>,
    pub state: TransferState,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TransferResult {
    pub transfer_id: String,
    pub local_path: Option<String>,
    pub remote_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitRepository {
    pub root: String,
    pub has_head: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitStatusEntry {
    pub index_status: String,
    pub worktree_status: String,
    pub path: String,
    pub original_path: Option<String>,
    pub absolute_path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum GitDiffKind {
    Text,
    Binary,
    Empty,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum GitDiffRowKind {
    Header,
    Hunk,
    Context,
    Addition,
    Deletion,
    Meta,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitDiffRow {
    pub key: String,
    pub kind: GitDiffRowKind,
    pub content: String,
    pub marker: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct GitDiff {
    pub kind: GitDiffKind,
    pub rows: Vec<GitDiffRow>,
    pub additions: u32,
    pub deletions: u32,
    pub hunk_rows: Vec<u32>,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum PreviewKind {
    WebForward,
    Html,
    RemoteFile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum PreviewState {
    Running,
    Disconnected,
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct PreviewInfo {
    pub preview_id: String,
    pub kind: PreviewKind,
    pub state: PreviewState,
    pub local_url: String,
    pub display_url: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct HtmlServerProcess {
    pub pid: u32,
    pub port: u16,
    pub port_file: String,
    pub log_file: String,
}

#[derive(Clone, Debug)]
pub(crate) enum PreviewResource {
    Forward {
        local_port: u16,
    },
    Html {
        local_port: u16,
        process: HtmlServerProcess,
    },
    RemoteFile {
        local_port: u16,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct ManagedPreview {
    pub generation: u64,
    pub resource: PreviewResource,
}

#[derive(Debug)]
pub(crate) struct TransferSlot {
    pub generation: u64,
    pub cancel: watch::Sender<bool>,
    pub progress: TransferProgress,
    pub result: Option<Result<TransferResult, String>>,
    pub notify: Arc<Notify>,
}

#[derive(Debug, Default)]
pub(crate) struct RemoteOperationManager {
    next_id: AtomicU64,
    pub transfers: Mutex<HashMap<String, TransferSlot>>,
    pub previews: Mutex<HashMap<String, ManagedPreview>>,
}

impl RemoteOperationManager {
    pub fn next_id(&self, prefix: &str) -> String {
        format!(
            "{prefix}-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        )
    }

    pub fn begin_transfer(
        &self,
        generation: u64,
    ) -> Result<(String, watch::Receiver<bool>, Arc<Notify>), String> {
        let mut transfers = self.transfers.lock();
        let active = transfers
            .values()
            .filter(|slot| {
                matches!(
                    slot.progress.state,
                    TransferState::Pending | TransferState::Running
                )
            })
            .count();
        if active >= MAX_ACTIVE_TRANSFERS {
            return Err(format!(
                "at most {MAX_ACTIVE_TRANSFERS} remote transfers may run at once"
            ));
        }
        let transfer_id = self.next_id("transfer");
        let (cancel, receiver) = watch::channel(false);
        let notify = Arc::new(Notify::new());
        transfers.insert(
            transfer_id.clone(),
            TransferSlot {
                generation,
                cancel,
                progress: TransferProgress {
                    transfer_id: transfer_id.clone(),
                    bytes_transferred: 0,
                    total_bytes: None,
                    state: TransferState::Pending,
                },
                result: None,
                notify: notify.clone(),
            },
        );
        drop(transfers);
        Ok((transfer_id, receiver, notify))
    }

    pub fn cancel_transfer(&self, transfer_id: &str) -> bool {
        let mut transfers = self.transfers.lock();
        let Some(slot) = transfers.get_mut(transfer_id) else {
            return false;
        };
        if matches!(
            slot.progress.state,
            TransferState::Completed | TransferState::Failed | TransferState::Cancelled
        ) {
            return false;
        }
        slot.progress.state = TransferState::Cancelled;
        let _ = slot.cancel.send(true);
        drop(transfers);
        true
    }

    pub fn cancel_generation(&self, generation: u64, reason: &str) {
        let mut transfers = self.transfers.lock();
        for slot in transfers
            .values_mut()
            .filter(|slot| slot.generation == generation)
        {
            if matches!(
                slot.progress.state,
                TransferState::Pending | TransferState::Running
            ) {
                let _ = slot.cancel.send(true);
                slot.progress.state = TransferState::Failed;
                slot.result = Some(Err(reason.to_owned()));
                slot.notify.notify_one();
            }
        }
    }

    pub fn disconnect_previews(&self, generation: u64) -> Vec<(String, ManagedPreview)> {
        let mut previews = self.previews.lock();
        previews
            .extract_if(|_, preview| preview.generation == generation)
            .collect()
    }
}

pub(crate) fn normalize_remote_path(path: Option<&str>, home: &str) -> Result<String, String> {
    let home = normalize_absolute(home)?;
    let requested = path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&home);
    let expanded = if requested == "~" {
        home
    } else if let Some(rest) = requested.strip_prefix("~/") {
        join_remote_path(&home, rest)?
    } else if requested.starts_with('/') {
        requested.to_owned()
    } else {
        join_remote_path(&home, requested)?
    };
    normalize_absolute(&expanded)
}

pub(crate) fn normalize_absolute(path: &str) -> Result<String, String> {
    if path.contains('\0') {
        return Err("remote path contains a NUL byte".to_owned());
    }
    if path.contains('\\') {
        return Err("remote paths must use Unix separators".to_owned());
    }
    if !path.starts_with('/') {
        return Err("remote path must be absolute".to_owned());
    }
    let mut components = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            value => components.push(value),
        }
    }
    Ok(format!("/{}", components.join("/")))
}

pub(crate) fn join_remote_path(directory: &str, name: &str) -> Result<String, String> {
    if name.contains('\0') || name.contains('\\') {
        return Err("remote path contains an invalid separator or NUL byte".to_owned());
    }
    let directory = normalize_absolute(directory)?;
    normalize_absolute(&format!(
        "{}/{}",
        directory.trim_end_matches('/'),
        name.trim_matches('/')
    ))
}

pub(crate) fn remote_filename(path: &str) -> Result<String, String> {
    let normalized = normalize_absolute(path)?;
    normalized
        .rsplit('/')
        .find(|component| !component.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "remote path has no filename".to_owned())
}

pub(crate) fn remote_parent(path: &str) -> Result<String, String> {
    let normalized = normalize_absolute(path)?;
    let Some(index) = normalized.rfind('/') else {
        return Ok("/".to_owned());
    };
    Ok(if index == 0 {
        "/".to_owned()
    } else {
        normalized[..index].to_owned()
    })
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub(crate) fn git_repository_command(path: &str) -> String {
    let script = format!(
        "if ! command -v git >/dev/null 2>&1; then printf 'WHIP_GIT_ERROR:missing\\n'; exit 0; fi\nrepo_root=$(git -C {} rev-parse --show-toplevel 2>/dev/null) || {{ printf 'WHIP_GIT_ERROR:not-repository\\n'; exit 0; }}\nif git -C \"$repo_root\" rev-parse --verify HEAD >/dev/null 2>&1; then has_head=1; else has_head=0; fi\nprintf 'WHIP_GIT_ROOT:%s\\nWHIP_GIT_HEAD:%s\\n' \"$repo_root\" \"$has_head\"",
        shell_quote(path)
    );
    format!("sh -c {}", shell_quote(&script))
}

pub(crate) fn parse_git_repository(output: &str) -> Result<Option<GitRepository>, String> {
    if output.lines().any(|line| line == "WHIP_GIT_ERROR:missing") {
        return Err("Git executable is unavailable on the remote host".to_owned());
    }
    if output
        .lines()
        .any(|line| line == "WHIP_GIT_ERROR:not-repository")
    {
        return Ok(None);
    }
    let root = output
        .lines()
        .find_map(|line| line.strip_prefix("WHIP_GIT_ROOT:"));
    let Some(root) = root.filter(|root| !root.is_empty()) else {
        return Ok(None);
    };
    let has_head = output
        .lines()
        .find_map(|line| line.strip_prefix("WHIP_GIT_HEAD:"))
        == Some("1");
    Ok(Some(GitRepository {
        root: root.to_owned(),
        has_head,
    }))
}

pub(crate) fn git_status_command(root: &str) -> String {
    format!(
        "git -C {} -c core.quotepath=false status --porcelain=v1 -z --untracked-files=all",
        shell_quote(root)
    )
}

pub(crate) fn parse_git_status(bytes: &[u8], root: &str) -> Result<Vec<GitStatusEntry>, String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| "Git status output was not UTF-8".to_owned())?;
    let mut records = text.split('\0');
    let mut entries = Vec::new();
    while let Some(record) = records.next() {
        let chars = record.as_bytes();
        if chars.len() < 4 || chars[2] != b' ' {
            continue;
        }
        let index_status = char::from(chars[0]).to_string();
        let worktree_status = char::from(chars[1]).to_string();
        let renamed = matches!(chars[0], b'R' | b'C') || matches!(chars[1], b'R' | b'C');
        let original_path = if renamed {
            records
                .next()
                .filter(|path| !path.is_empty())
                .map(str::to_owned)
        } else {
            None
        };
        let path = record[3..].to_owned();
        let absolute_path = join_remote_path(root, &path)?;
        entries.push(GitStatusEntry {
            index_status,
            worktree_status,
            path,
            original_path,
            absolute_path,
        });
    }
    entries.sort_by(|left, right| {
        left.path
            .to_lowercase()
            .cmp(&right.path.to_lowercase())
            .then(left.path.cmp(&right.path))
    });
    Ok(entries)
}

pub(crate) fn git_diff_command(
    repository: &GitRepository,
    status: &GitStatusEntry,
) -> Result<String, String> {
    if status.path.is_empty() || status.path.contains('\0') {
        return Err("Git path is invalid".to_owned());
    }
    let root = shell_quote(&repository.root);
    let path = shell_quote(&status.path);
    let common = "--no-ext-diff --no-textconv --no-color --unified=3";
    let untracked = status.index_status == "?" && status.worktree_status == "?";
    let command = if untracked {
        format!("git -C {root} diff --no-index {common} -- /dev/null {path} 2>/dev/null")
    } else if repository.has_head {
        format!("git -C {root} diff {common} HEAD -- {path}")
    } else {
        format!("git -C {root} diff {common} --cached -- {path}")
    };
    Ok(format!("{command} | head -c {}", GIT_DIFF_MAX_BYTES + 1))
}

pub(crate) fn parse_git_diff(bytes: &[u8]) -> Result<GitDiff, String> {
    let byte_limited = bytes.len() > GIT_DIFF_MAX_BYTES;
    let bytes = &bytes[..bytes.len().min(GIT_DIFF_MAX_BYTES)];
    let text =
        std::str::from_utf8(bytes).map_err(|_| "Git diff output was not UTF-8".to_owned())?;
    if text.trim().is_empty() {
        return Ok(GitDiff {
            kind: GitDiffKind::Empty,
            rows: Vec::new(),
            additions: 0,
            deletions: 0,
            hunk_rows: Vec::new(),
            truncated: false,
        });
    }
    if text.lines().any(|line| {
        line.starts_with("Binary files ") && line.ends_with(" differ") || line == "GIT binary patch"
    }) {
        return Ok(GitDiff {
            kind: GitDiffKind::Binary,
            rows: Vec::new(),
            additions: 0,
            deletions: 0,
            hunk_rows: Vec::new(),
            truncated: byte_limited,
        });
    }
    let mut rows = Vec::new();
    let mut additions = 0;
    let mut deletions = 0;
    let mut hunk_rows = Vec::new();
    let mut old_line = 0u32;
    let mut new_line = 0u32;
    let mut in_hunk = false;
    let mut row_limited = false;
    for line in text.replace("\r\n", "\n").lines() {
        if rows.len() >= GIT_DIFF_MAX_ROWS {
            row_limited = true;
            break;
        }
        if let Some((old, new)) = parse_hunk_header(line) {
            hunk_rows.push(u32::try_from(rows.len()).map_err(|_| "Too many diff rows")?);
            old_line = old;
            new_line = new;
            in_hunk = true;
            rows.push(diff_row(
                rows.len(),
                GitDiffRowKind::Hunk,
                line,
                "",
                None,
                None,
            ));
        } else if !in_hunk {
            rows.push(diff_row(
                rows.len(),
                GitDiffRowKind::Header,
                line,
                "",
                None,
                None,
            ));
        } else if let Some(content) = line.strip_prefix('+') {
            additions += 1;
            rows.push(diff_row(
                rows.len(),
                GitDiffRowKind::Addition,
                content,
                "+",
                None,
                Some(new_line),
            ));
            new_line = new_line.saturating_add(1);
        } else if let Some(content) = line.strip_prefix('-') {
            deletions += 1;
            rows.push(diff_row(
                rows.len(),
                GitDiffRowKind::Deletion,
                content,
                "-",
                Some(old_line),
                None,
            ));
            old_line = old_line.saturating_add(1);
        } else if let Some(content) = line.strip_prefix(' ') {
            rows.push(diff_row(
                rows.len(),
                GitDiffRowKind::Context,
                content,
                " ",
                Some(old_line),
                Some(new_line),
            ));
            old_line = old_line.saturating_add(1);
            new_line = new_line.saturating_add(1);
        } else {
            rows.push(diff_row(
                rows.len(),
                GitDiffRowKind::Meta,
                line,
                "",
                None,
                None,
            ));
        }
    }
    Ok(GitDiff {
        kind: GitDiffKind::Text,
        rows,
        additions,
        deletions,
        hunk_rows,
        truncated: byte_limited || row_limited,
    })
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(' ')?;
    let rest = rest.strip_prefix('+')?;
    let (new, _) = rest.split_once(' ')?;
    Some((
        old.split(',').next()?.parse().ok()?,
        new.split(',').next()?.parse().ok()?,
    ))
}

fn diff_row(
    index: usize,
    kind: GitDiffRowKind,
    content: &str,
    marker: &str,
    old_line: Option<u32>,
    new_line: Option<u32>,
) -> GitDiffRow {
    GitDiffRow {
        key: format!(
            "{index}-{}",
            match kind {
                GitDiffRowKind::Header => "header",
                GitDiffRowKind::Hunk => "hunk",
                GitDiffRowKind::Context => "context",
                GitDiffRowKind::Addition => "addition",
                GitDiffRowKind::Deletion => "deletion",
                GitDiffRowKind::Meta => "meta",
            }
        ),
        kind,
        content: content.to_owned(),
        marker: marker.to_owned(),
        old_line,
        new_line,
    }
}

pub(crate) fn attachment_filename(source: &str) -> Result<String, String> {
    let mut token = [0u8; 12];
    russh::keys::ssh_key::getrandom::fill(&mut token)
        .map_err(|error| format!("could not create a unique attachment name: {error}"))?;
    let suffix = crate::lower_hex(&token);
    attachment_filename_with_suffix(source, &suffix)
}

fn attachment_filename_with_suffix(source: &str, suffix: &str) -> Result<String, String> {
    let source = source
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "local attachment path has no filename".to_owned())?;
    let (stem, extension) = source
        .rsplit_once('.')
        .filter(|(stem, _)| !stem.is_empty())
        .unwrap_or((source, ""));
    let clean = stem
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(100)
        .collect::<String>();
    let clean = if clean.is_empty() {
        "attachment"
    } else {
        &clean
    };
    let extension = extension
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(16)
        .collect::<String>();
    Ok(if extension.is_empty() {
        format!("{clean}-{suffix}")
    } else {
        format!("{clean}-{suffix}.{extension}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_are_unix_normalized_and_root_bounded() {
        assert_eq!(
            normalize_remote_path(Some("project/../space here/文件"), "/home/me").unwrap(),
            "/home/me/space here/文件"
        );
        assert_eq!(
            normalize_remote_path(Some("~/a//./b"), "/home/me").unwrap(),
            "/home/me/a/b"
        );
        assert_eq!(
            normalize_remote_path(Some("/../../"), "/home/me").unwrap(),
            "/"
        );
        assert_eq!(
            join_remote_path("/tmp", "-leading;$HOME'").unwrap(),
            "/tmp/-leading;$HOME'"
        );
        assert!(normalize_absolute("C:\\temp").is_err());
    }

    #[test]
    fn shell_quote_blocks_metacharacter_interpretation() {
        let value = "a b'$(touch /tmp/pwn);$HOME";
        assert_eq!(shell_quote(value), "'a b'\"'\"'$(touch /tmp/pwn);$HOME'");
        let command = git_status_command(value);
        assert!(command.contains("'a b'\"'\"'$(touch /tmp/pwn);$HOME'"));
    }

    #[test]
    fn parses_ordinary_modified_git_status_entries() {
        let entries = parse_git_status(b" M src/App.tsx\0M  Cargo.toml\0", "/repo").unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "Cargo.toml");
        assert_eq!(entries[0].index_status, "M");
        assert_eq!(entries[0].worktree_status, " ");
        assert_eq!(entries[1].path, "src/App.tsx");
        assert_eq!(entries[1].index_status, " ");
        assert_eq!(entries[1].worktree_status, "M");
    }

    #[test]
    fn parses_renamed_and_copied_git_status_entries() {
        let entries = parse_git_status(
            b"R  new-name.ts\0old-name.ts\0C  copied-name.ts\0source-name.ts\0",
            "/repo",
        )
        .unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "copied-name.ts");
        assert_eq!(entries[0].original_path.as_deref(), Some("source-name.ts"));
        assert_eq!(entries[1].path, "new-name.ts");
        assert_eq!(entries[1].original_path.as_deref(), Some("old-name.ts"));
        assert_eq!(entries[1].absolute_path, "/repo/new-name.ts");
    }

    #[test]
    fn truncated_rename_records_keep_the_entry_without_an_original_path() {
        let entries = parse_git_status(b"R  new-name.ts", "/repo").unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "new-name.ts");
        assert_eq!(entries[0].original_path, None);
    }

    #[test]
    fn rename_records_with_an_empty_original_path_are_kept_and_parsing_continues() {
        let entries = parse_git_status(b"R  new-name.ts\0\0 M src/App.tsx\0", "/repo").unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "new-name.ts");
        assert_eq!(entries[0].original_path, None);
        assert_eq!(entries[1].path, "src/App.tsx");
    }

    #[test]
    fn empty_records_are_skipped_in_git_status_output() {
        let entries = parse_git_status(b"\0 M src/App.tsx\0\0?? new.txt\0", "/repo").unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "new.txt");
        assert_eq!(entries[1].path, "src/App.tsx");
    }

    #[test]
    fn parses_git_diff_fixture_and_bounds_rows() {
        let diff = parse_git_diff(
            b"diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -10,2 +10,2 @@\n-old\n+new\n same\n",
        )
        .unwrap();
        assert_eq!(diff.kind, GitDiffKind::Text);
        assert_eq!(diff.rows[4].old_line, Some(10));
        assert_eq!(diff.rows[5].new_line, Some(10));
        assert_eq!(diff.rows[6].old_line, Some(11));
        assert_eq!(diff.additions, 1);
        assert_eq!(diff.deletions, 1);
        assert_eq!(diff.hunk_rows, vec![3]);
    }

    #[test]
    fn diff_review_counts_and_hunk_indexes_follow_displayed_rows() {
        let diff = parse_git_diff(
            b"--- a/file\n+++ b/file\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n same\n@@ -50 +51 @@\n-before\n+after\n\\ No newline at end of file\n",
        )
        .unwrap();
        assert_eq!((diff.additions, diff.deletions), (3, 2));
        assert_eq!(diff.hunk_rows, vec![2, 7]);
        assert_eq!(diff.rows[8].old_line, Some(50));
        assert_eq!(diff.rows[9].new_line, Some(51));

        let patch = format!(
            "@@ -0,0 +1,{} @@\n{}",
            GIT_DIFF_MAX_ROWS,
            "+line\n".repeat(GIT_DIFF_MAX_ROWS)
        );
        let limited = parse_git_diff(patch.as_bytes()).unwrap();
        assert!(limited.truncated);
        assert_eq!(limited.rows.len(), GIT_DIFF_MAX_ROWS);
        assert_eq!(limited.additions as usize, GIT_DIFF_MAX_ROWS - 1);
        assert_eq!(limited.deletions, 0);
        assert_eq!(limited.hunk_rows, vec![0]);
    }

    #[test]
    fn non_text_diffs_have_no_review_hunks_or_line_totals() {
        for patch in [
            b"".as_slice(),
            b"Binary files a/image.png and b/image.png differ\n".as_slice(),
        ] {
            let diff = parse_git_diff(patch).unwrap();
            assert_eq!((diff.additions, diff.deletions), (0, 0));
            assert!(diff.hunk_rows.is_empty());
        }
    }

    #[test]
    fn attachment_names_preserve_extension_without_path_concatenation() {
        assert_eq!(
            attachment_filename_with_suffix("/tmp/Screen shot (final).PNG", "attachment-7")
                .unwrap(),
            "Screen-shot-final-attachment-7.PNG"
        );
        assert_eq!(
            attachment_filename_with_suffix("/tmp/name.$(bad);png", "secure").unwrap(),
            "name-secure.badpng"
        );
    }

    #[test]
    fn cancellation_wins_once_requested() {
        let manager = RemoteOperationManager::default();
        let (id, _receiver, _) = manager.begin_transfer(4).unwrap();
        assert!(manager.cancel_transfer(&id));
        let transfers = manager.transfers.lock();
        assert_eq!(transfers[&id].progress.state, TransferState::Cancelled);
        drop(transfers);
    }

    #[test]
    fn independent_transfers_have_stable_ids_and_a_bounded_active_set() {
        let manager = RemoteOperationManager::default();
        let ids = (0..MAX_ACTIVE_TRANSFERS)
            .map(|_| manager.begin_transfer(2).unwrap().0)
            .collect::<Vec<_>>();
        assert_eq!(
            ids.iter().collect::<std::collections::HashSet<_>>().len(),
            ids.len()
        );
        assert!(manager.begin_transfer(2).unwrap_err().contains("at most"));
        assert!(manager.cancel_transfer(&ids[0]));
        assert!(manager.begin_transfer(2).is_ok());
    }

    #[test]
    fn generation_invalidation_fails_running_transfers_without_touching_newer_ones() {
        let manager = RemoteOperationManager::default();
        let old = manager.begin_transfer(7).unwrap().0;
        let current = manager.begin_transfer(8).unwrap().0;
        manager.cancel_generation(7, "transport disconnected");
        let transfers = manager.transfers.lock();
        assert_eq!(transfers[&old].progress.state, TransferState::Failed);
        assert_eq!(transfers[&current].progress.state, TransferState::Pending);
        assert_eq!(
            transfers[&old]
                .result
                .as_ref()
                .unwrap()
                .as_ref()
                .unwrap_err(),
            "transport disconnected"
        );
        drop(transfers);
    }

    #[test]
    fn preview_disconnect_removes_only_the_replaced_generation() {
        let manager = RemoteOperationManager::default();
        manager.previews.lock().insert(
            "old".to_owned(),
            ManagedPreview {
                generation: 3,
                resource: PreviewResource::Forward { local_port: 1234 },
            },
        );
        manager.previews.lock().insert(
            "new".to_owned(),
            ManagedPreview {
                generation: 4,
                resource: PreviewResource::Forward { local_port: 5678 },
            },
        );
        let removed = manager.disconnect_previews(3);
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].0, "old");
        assert!(manager.previews.lock().contains_key("new"));
    }

    #[test]
    fn invalid_utf8_git_status_is_an_error_not_an_empty_status() {
        assert!(parse_git_status(&[0xff, 0], "/repo").is_err());
    }
}
