//! Resolve Codex's immutable history prefixes before opening the live tail.

use std::collections::HashSet;
use std::future::Future;
use std::path::Path;

use serde_json::Value;

use crate::agent_transcript::CodexInheritedHistory;
use crate::codex::rollout_wire::{CodexHistoryMode, HistoryPosition, SessionMeta};

use super::{AgentSessionError, parse_rollout_filename, parse_uuid_bytes, shell_quote};

const MAX_HISTORY_DEPTH: usize = 256;
// Stay below the SSH exec output cap, without splitting UTF-8 during decoding.
const PREFIX_CHUNK_BYTES: u64 = 1024 * 1024;

fn invalid(message: impl Into<String>) -> AgentSessionError {
    AgentSessionError::ReadFailed(format!("Codex referenced history: {}", message.into()))
}

fn metadata(header: &Value) -> Result<SessionMeta, AgentSessionError> {
    if header.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Err(invalid("missing SessionMeta"));
    }
    serde_json::from_value(header["payload"].clone()).map_err(|error| invalid(error.to_string()))
}

fn reference_find_command(rollout_id: &str) -> String {
    let ordinary = shell_quote(&format!("rollout-*-{rollout_id}.jsonl*"));
    let reverted = shell_quote(&format!("rollout-*_{rollout_id}.jsonl*"));
    // Archives can own a fork's immutable base even while the child is active.
    format!(
        "find \"$HOME/.codex/sessions\" \"$HOME/.codex/archived_sessions\" -type f \\( -name {ordinary} -o -name {reverted} \\) -print 2>/dev/null; true"
    )
}

fn reference_path(output: &str, rollout_id: &str) -> Result<String, AgentSessionError> {
    let expected = parse_uuid_bytes(rollout_id).ok_or_else(|| invalid("invalid rollout UUID"))?;
    let mut paths = output
        .lines()
        .filter(|path| {
            let decoded = path.strip_suffix(".zst").unwrap_or(path);
            path.starts_with('/')
                && !path.chars().any(char::is_control)
                && !path.split('/').any(|part| part == "..")
                && parse_rollout_filename(decoded).is_some_and(|(_, _, id)| id == expected)
        })
        .collect::<Vec<_>>();
    // Prefer the materialized file if both representations exist.
    paths.sort_by_key(|path| (compressed(path), *path));
    paths
        .first()
        .map(|path| (*path).to_owned())
        .ok_or_else(|| invalid(format!("missing base rollout {rollout_id}")))
}

fn prefix_command(path: &str, offset: u64, length: u64) -> String {
    let quoted = shell_quote(path);
    if compressed(path) {
        format!(
            "zstd -dc -- {quoted} | head -c {} | tail -c {length}",
            offset + length
        )
    } else {
        format!("tail -c +{} {quoted} | head -c {length}", offset + 1)
    }
}

fn compressed(path: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|extension| extension == "zst")
}

fn parse_prefix(bytes: &str, base: &HistoryPosition) -> Result<Vec<Value>, AgentSessionError> {
    if bytes.len() as u64 != base.end_byte_offset || !bytes.ends_with('\n') {
        return Err(invalid(
            "base prefix is truncated or does not end at a record boundary",
        ));
    }
    let records = bytes
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str::<Value>(line).map_err(|error| invalid(error.to_string())))
        .collect::<Result<Vec<_>, _>>()?;
    let header = records
        .first()
        .ok_or_else(|| invalid("empty base prefix"))?;
    let meta = metadata(header)?;
    if meta.history_mode != CodexHistoryMode::Paginated {
        return Err(invalid("base rollout is not paginated"));
    }
    let mut ordinal = meta
        .history_base
        .as_ref()
        .map_or(0, |base| base.end_ordinal_exclusive);
    for record in &records {
        if record.get("ordinal").and_then(Value::as_u64) != Some(ordinal) {
            return Err(invalid("base prefix has inconsistent ordinals"));
        }
        ordinal = ordinal
            .checked_add(1)
            .ok_or_else(|| invalid("ordinal overflow"))?;
    }
    if ordinal != base.end_ordinal_exclusive {
        return Err(invalid(
            "base prefix does not match the retained ordinal boundary",
        ));
    }
    Ok(records)
}

/// Read each exact immutable prefix, then replay from oldest to newest. The
/// current header comes first so inherited metadata cannot change its identity.
pub(super) async fn load<F, Fut>(
    path: &str,
    mut execute: F,
) -> Result<Option<CodexInheritedHistory>, AgentSessionError>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, AgentSessionError>>,
{
    let line = execute(format!("head -n 1 {}", shell_quote(path))).await?;
    // A file may become discoverable while its first record is being written.
    // Retry rather than opening a tail that could miss an unresolved reference.
    let header = serde_json::from_slice::<Value>(&line)
        .map_err(|error| invalid(format!("incomplete or invalid SessionMeta: {error}")))?;
    let meta = metadata(&header)?;
    if meta.history_mode != CodexHistoryMode::Paginated || meta.history_base.is_none() {
        return Ok(None);
    }
    let mut base = meta.history_base;
    let mut visited = HashSet::new();
    if let Some((_, _, id)) = parse_rollout_filename(path) {
        visited.insert(id);
    }
    let mut segments = Vec::new();
    while let Some(position) = base {
        let id =
            parse_uuid_bytes(&position.thread_id).ok_or_else(|| invalid("invalid rollout UUID"))?;
        if !visited.insert(id) || segments.len() >= MAX_HISTORY_DEPTH {
            return Err(invalid("cyclic or excessively deep history references"));
        }
        let output = execute(reference_find_command(&position.thread_id)).await?;
        let paths = std::str::from_utf8(&output).map_err(|error| invalid(error.to_string()))?;
        let ancestor = reference_path(paths, &position.thread_id)?;
        let mut bytes = Vec::new();
        let mut offset = 0;
        while offset < position.end_byte_offset {
            let length = PREFIX_CHUNK_BYTES.min(position.end_byte_offset - offset);
            let chunk = execute(prefix_command(&ancestor, offset, length)).await?;
            if chunk.len() as u64 != length {
                return Err(invalid("base prefix is truncated"));
            }
            bytes.extend(chunk);
            offset += length;
        }
        let decoded = std::str::from_utf8(&bytes).map_err(|error| invalid(error.to_string()))?;
        let records = parse_prefix(decoded, &position)?;
        base = metadata(&records[0])?.history_base;
        segments.push(records);
    }
    let records = segments
        .into_iter()
        .rev()
        .flatten()
        .filter(|record| record.get("type").and_then(Value::as_str) != Some("session_meta"))
        .collect();
    Ok(Some(CodexInheritedHistory { header, records }))
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::future::{Ready, ready};

    use crate::agent_transcript::{AgentTranscriptStatus, CodexSessionCore};

    use super::*;

    const THREAD: &str = "11111111-1111-4111-8111-111111111111";
    const FIRST_REVERT: &str = "22222222-2222-4222-8222-222222222222";
    const SECOND_REVERT: &str = "33333333-3333-4333-8333-333333333333";

    fn local_execute(root: &Path, command: String) -> Ready<Result<Vec<u8>, AgentSessionError>> {
        let command = command
            .replace(
                "\"$HOME/.codex/sessions\"",
                &shell_quote(root.join("sessions").to_str().unwrap()),
            )
            .replace(
                "\"$HOME/.codex/archived_sessions\"",
                &shell_quote(root.join("archived_sessions").to_str().unwrap()),
            );
        let shell = std::env::var_os("WHIP_TEST_REMOTE_SHELL").unwrap_or_else(|| "sh".into());
        let output = std::process::Command::new(shell)
            .args(["-c", &command])
            .output()
            .unwrap();
        let result = if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(invalid(
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ))
        };
        ready(result)
    }

    fn replacement_header(base_id: &str, ordinal: u64, byte_offset: usize) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "ordinal":ordinal,"type":"session_meta","payload":{
                    "id":THREAD,"cwd":"/child","history_mode":"paginated",
                    "history_base":{"thread_id":base_id,"end_ordinal_exclusive":ordinal,"end_byte_offset":byte_offset}
                }
            })
        )
    }

    fn directory(root: &Path, name: &str) -> std::path::PathBuf {
        let path = root.join(name).join("quoted ' $directory");
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn referenced_reverts_retain_prefix_append_live_and_survive_cache_and_nested_reverts() {
        let root = tempfile::tempdir().unwrap();
        let active = directory(root.path(), "sessions");
        let archived = directory(root.path(), "archived_sessions");
        let original = include_str!("../../test-fixtures/codex/paginated-rollout.jsonl")
            .replace("thread-current", THREAD)
            .replace("Build it", "Build 日本語");
        let prefix = original.lines().take(15).collect::<Vec<_>>().join("\n") + "\n";
        let original_path = archived.join(format!("rollout-2026-08-26T10-20-30-{THREAD}.jsonl"));
        std::fs::write(&original_path, &original).unwrap();
        let first_path = active.join(format!(
            "rollout-2026-08-26T10-21-30-{THREAD}_{FIRST_REVERT}.jsonl"
        ));
        let first_header = replacement_header(THREAD, 15, prefix.len());
        std::fs::write(&first_path, &first_header).unwrap();

        let mut core = CodexSessionCore::new(THREAD);
        let original_binding = core.bind_source(
            original_path.to_str().unwrap().into(),
            "old".into(),
            original.len() as u64,
        );
        core.ingest(original_binding.source_generation, original.as_bytes())
            .unwrap();
        assert_eq!(core.state().turns.len(), 3);

        let history = load(first_path.to_str().unwrap(), |command| {
            local_execute(root.path(), command)
        })
        .await
        .unwrap()
        .unwrap();
        let binding = core
            .bind_source_with_history(
                first_path.to_str().unwrap().into(),
                "first".into(),
                first_header.len() as u64,
                Some(history.clone()),
            )
            .unwrap();
        assert_eq!(binding.start_offset, 0);
        for chunk in first_header.as_bytes().chunks(7) {
            core.ingest(binding.source_generation, chunk).unwrap();
        }
        core.mark_live();
        assert_eq!(core.state().status, AgentTranscriptStatus::Live);
        assert_eq!(core.state().info.as_ref().unwrap().id, THREAD);
        assert_eq!(
            core.state().info.as_ref().unwrap().directory.as_deref(),
            Some("/child")
        );
        assert_eq!(core.state().turns.len(), 1);
        assert_eq!(core.state().turns[0].id, "turn-current-1");
        assert!(
            !core
                .state()
                .messages
                .iter()
                .any(|message| message.id == "user-continue-1")
        );
        assert!(
            !core
                .ingest(original_binding.source_generation, original.as_bytes())
                .unwrap()
                .changed
        );

        // New turns are physically present only in the replacement file.
        let mut suffix = String::new();
        for line in original.lines().skip(15).take(5) {
            let mut record: Value = serde_json::from_str(line).unwrap();
            record["ordinal"] = Value::from(record["ordinal"].as_u64().unwrap() + 1);
            writeln!(&mut suffix, "{record}").unwrap();
        }
        core.ingest(binding.source_generation, suffix.as_bytes())
            .unwrap();
        let first_bytes = format!("{first_header}{suffix}");
        std::fs::write(&first_path, &first_bytes).unwrap();
        assert_eq!(core.state().turns.len(), 2);
        assert_eq!(core.received_offset(), first_bytes.len() as u64);
        let saved = core.state();
        let cache = core.cache_blob().unwrap();
        let mut restored = CodexSessionCore::new(THREAD);
        restored.restore_cache(&cache).unwrap();
        assert_eq!(restored.state().messages, saved.messages);
        assert_eq!(restored.state().turns, saved.turns);
        let rebound = restored
            .bind_source_with_history(
                first_path.to_str().unwrap().into(),
                "first".into(),
                first_bytes.len() as u64,
                Some(history.clone()),
            )
            .unwrap();
        assert!(!rebound.rebuilt);
        assert_eq!(rebound.start_offset, first_bytes.len() as u64);
        restored.mark_live();
        assert_eq!(restored.state().status, AgentTranscriptStatus::Live);

        // Upgrade an old cache which persisted only the replacement's records.
        let mut old = CodexSessionCore::new(THREAD);
        let old_binding = old.bind_source(
            first_path.to_str().unwrap().into(),
            "first".into(),
            first_bytes.len() as u64,
        );
        old.ingest(old_binding.source_generation, first_bytes.as_bytes())
            .unwrap();
        let mut old_cache: Value = serde_json::from_slice(&old.cache_blob().unwrap()).unwrap();
        old_cache["schema_version"] = Value::from(3);
        old_cache
            .as_object_mut()
            .unwrap()
            .remove("inherited_history");
        restored
            .restore_cache(&serde_json::to_vec(&old_cache).unwrap())
            .unwrap();
        let upgraded = restored
            .bind_source_with_history(
                first_path.to_str().unwrap().into(),
                "first".into(),
                first_bytes.len() as u64,
                Some(history),
            )
            .unwrap();
        assert!(upgraded.rebuilt);
        assert_eq!(upgraded.start_offset, first_bytes.len() as u64);
        assert_eq!(restored.state().messages, saved.messages);
        assert_eq!(restored.state().turns, saved.turns);

        // A later revert references the first replacement by rollout ID. Its
        // header-only prefix inherits the original turn and excludes its suffix.
        let second_path = active.join(format!(
            "rollout-2026-08-26T10-22-30-{THREAD}_{SECOND_REVERT}.jsonl"
        ));
        let second_header = replacement_header(FIRST_REVERT, 16, first_header.len());
        std::fs::write(&second_path, &second_header).unwrap();
        let second_history = load(second_path.to_str().unwrap(), |command| {
            local_execute(root.path(), command)
        })
        .await
        .unwrap();
        let second = restored
            .bind_source_with_history(
                second_path.to_str().unwrap().into(),
                "second".into(),
                second_header.len() as u64,
                second_history,
            )
            .unwrap();
        restored
            .ingest(second.source_generation, second_header.as_bytes())
            .unwrap();
        restored.mark_live();
        assert_eq!(restored.state().turns.len(), 1);
        assert_eq!(restored.state().turns[0].id, "turn-current-1");
        let mut offline = CodexSessionCore::new(THREAD);
        offline
            .restore_cache(&restored.cache_blob().unwrap())
            .unwrap();
        assert_eq!(offline.state().messages, restored.state().messages);
        assert_eq!(offline.state().turns, restored.state().turns);
    }

    #[tokio::test]
    async fn large_prefix_is_read_without_transport_truncation_or_utf8_corruption() {
        let root = tempfile::tempdir().unwrap();
        let active = directory(root.path(), "sessions");
        let ancestor = active.join(format!("rollout-2026-08-26T10-20-30-{THREAD}.jsonl"));
        let header = serde_json::json!({
            "ordinal":0,"type":"session_meta","payload":{"id":THREAD,"history_mode":"paginated"}
        });
        let records = (1..=3)
            .map(|ordinal| {
                serde_json::json!({
                    "ordinal":ordinal,"type":"event_msg","payload":{
                        "type":"token_count","padding":"日本語".repeat(350_000)
                    }
                })
            })
            .collect::<Vec<_>>();
        let mut bytes = String::new();
        for record in std::iter::once(&header).chain(&records) {
            writeln!(&mut bytes, "{record}").unwrap();
        }
        assert!(bytes.len() > 8 * 1024 * 1024);
        std::fs::write(&ancestor, &bytes).unwrap();
        let child = active.join(format!(
            "rollout-2026-08-26T10-21-30-{THREAD}_{FIRST_REVERT}.jsonl"
        ));
        std::fs::write(&child, replacement_header(THREAD, 4, bytes.len())).unwrap();
        let history = load(child.to_str().unwrap(), |command| async {
            let bytes = local_execute(root.path(), command).await?;
            // Herdr's SSH exec transport rejects responses larger than 8 MiB.
            assert!(bytes.len() < 8 * 1024 * 1024);
            Ok(bytes)
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(history.records, records);
    }

    #[tokio::test]
    async fn invalid_references_fail_instead_of_publishing_partial_history() {
        let root = tempfile::tempdir().unwrap();
        let active = directory(root.path(), "sessions");
        let path = active.join(format!("rollout-2026-08-26T10-20-30-{THREAD}.jsonl"));
        std::fs::write(&path, b"{\"type\":\"session_meta\"").unwrap();
        assert!(
            load(path.to_str().unwrap(), |command| local_execute(
                root.path(),
                command
            ))
            .await
            .unwrap_err()
            .to_string()
            .contains("SessionMeta")
        );
        std::fs::write(&path, replacement_header(FIRST_REVERT, 15, 100)).unwrap();
        assert!(
            load(path.to_str().unwrap(), |command| local_execute(
                root.path(),
                command
            ))
            .await
            .unwrap_err()
            .to_string()
            .contains("missing base")
        );
        let ancestor = active.join(format!(
            "rollout-2026-08-26T10-21-30-{THREAD}_{FIRST_REVERT}.jsonl"
        ));
        // Each header has a valid prefix boundary, but the lineage cycles.
        let a = replacement_header(THREAD, 0, 1);
        std::fs::write(&ancestor, &a).unwrap();
        std::fs::write(&path, replacement_header(FIRST_REVERT, 1, a.len())).unwrap();
        assert!(
            load(path.to_str().unwrap(), |command| local_execute(
                root.path(),
                command
            ))
            .await
            .unwrap_err()
            .to_string()
            .contains("cyclic")
        );
        std::fs::write(&path, replacement_header(FIRST_REVERT, 2, a.len())).unwrap();
        assert!(
            load(path.to_str().unwrap(), |command| local_execute(
                root.path(),
                command
            ))
            .await
            .unwrap_err()
            .to_string()
            .contains("ordinal boundary")
        );
        std::fs::write(&path, replacement_header(FIRST_REVERT, 1, a.len() + 10)).unwrap();
        assert!(
            load(path.to_str().unwrap(), |command| local_execute(
                root.path(),
                command
            ))
            .await
            .unwrap_err()
            .to_string()
            .contains("truncated")
        );
    }
}
