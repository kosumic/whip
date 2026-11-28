//! Resolve the exact conversation reported by the Antigravity hook.
use super::{AgentSessionError, parse_uuid_bytes, shell_quote};
use std::path::Path;

const LOGS: &str = ".system_generated/logs";
const FULL: &str = "transcript_full.jsonl";
const COMPACT: &str = "transcript.jsonl";

pub(crate) fn conversation_id(reference: &str) -> Option<&str> {
    let id = if reference.starts_with('/') {
        if reference.chars().any(char::is_control)
            || reference.split('/').any(|part| matches!(part, "." | ".."))
        {
            return None;
        }
        let path = Path::new(reference);
        if !matches!(path.file_name()?.to_str()?, FULL | COMPACT) {
            return None;
        }
        let logs = path.parent()?;
        if !logs.ends_with(LOGS) {
            return None;
        }
        logs.ancestors().nth(2)?.file_name()?.to_str()?
    } else {
        reference
    };
    parse_uuid_bytes(id).map(|_| id)
}

pub(super) fn validate(reference: &str) -> Result<(), AgentSessionError> {
    conversation_id(reference).map(|_| ()).ok_or_else(|| {
        AgentSessionError::InvalidSession(
            "Antigravity CLI requires a conversation UUID or its absolute transcript path".into(),
        )
    })
}

use super::{
    AgentSessionCore, AgentSessionManager, FILE_SOURCE_POLL_DELAY, SessionFailureKind, SessionId,
    TranscriptKey, current_session_mut, diagnostics,
};
use agent_transcript_core::AgyLog;
use sha2::{Digest, Sha256};
use std::time::Instant;

const NAMES: [&str; 2] = [COMPACT, FULL];
const READ_BYTES: u64 = 1024 * 1024;

/// Hash exactly the observed prefix so concurrent appends can be read next poll.
/// Linux and macOS ship different SHA-256 commands.
fn manifest_command(reference: &str) -> String {
    let dir = if let Some((dir, _)) = reference.rsplit_once('/') {
        shell_quote(dir)
    } else {
        format!(
            "\"$HOME\"/.gemini/antigravity-cli/brain/{}/{LOGS}",
            shell_quote(reference)
        )
    };
    let script = format!(
        r#"set -e
dir={dir}
printf '%s\n' "$dir"
if command -v sha256sum >/dev/null 2>&1; then digest() {{ sha256sum; }}
else digest() {{ shasum -a 256; }}; fi
for name in {COMPACT} {FULL}; do
    path="$dir/$name"
    if [ ! -f "$path" ]; then printf '%s\n' -; continue; fi
    size=$(wc -c < "$path")
    hash=$(head -c "$size" "$path" | digest)
    printf '%s %s\n' "$size" "${{hash%% *}}"
done"#
    );
    format!("sh -c {}", shell_quote(&script))
}

#[derive(Debug, Clone, PartialEq)]
struct Stamp {
    size: u64,
    hash: String,
}

#[derive(Debug, PartialEq)]
struct Manifest {
    dir: String,
    stamps: [Option<Stamp>; 2],
}

fn parse_manifest(output: &str, reference: &str) -> Result<Manifest, AgentSessionError> {
    let invalid =
        || AgentSessionError::ReadFailed("Invalid Antigravity transcript manifest".into());
    let mut lines = output.lines();
    let dir = lines.next().ok_or_else(invalid)?;
    let path = format!("{dir}/{FULL}");
    if !dir.starts_with('/')
        || conversation_id(&path) != conversation_id(reference)
        || (reference.starts_with('/') && Path::new(reference).parent() != Some(Path::new(dir)))
    {
        return Err(invalid());
    }
    let mut stamps = [None, None];
    for stamp in &mut stamps {
        let line = lines.next().ok_or_else(invalid)?;
        if line == "-" {
            continue;
        }
        let mut fields = line.split_ascii_whitespace();
        let size = fields
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or_else(invalid)?;
        let hash = fields
            .next()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(invalid)?;
        if fields.next().is_some() {
            return Err(invalid());
        }
        *stamp = Some(Stamp {
            size,
            hash: hash.into(),
        });
    }
    if lines.next().is_some() {
        return Err(invalid());
    }
    if stamps == [None, None] {
        return Err(AgentSessionError::SourceUnavailable(
            "Antigravity has not created this transcript yet".into(),
        ));
    }
    Ok(Manifest {
        dir: dir.into(),
        stamps,
    })
}

#[derive(Default)]
struct LogReader {
    log: AgyLog,
    stamp: Option<Stamp>,
    hash: Sha256,
    received: u64,
}

impl LogReader {
    async fn refresh<F, Fut>(
        &mut self,
        stamp: Option<&Stamp>,
        mut read: F,
    ) -> Result<bool, AgentSessionError>
    where
        F: FnMut(u64, u64) -> Fut,
        Fut: std::future::Future<Output = Result<Vec<u8>, AgentSessionError>>,
    {
        if self.stamp.as_ref() == stamp {
            return Ok(false);
        }
        let Some(stamp) = stamp else {
            *self = Self::default();
            return Ok(true);
        };
        let mut replaced = false;
        if self.stamp.is_some() && self.received >= stamp.size {
            *self = Self::default();
            replaced = true;
        }
        loop {
            let resumed = self.received > 0;
            while self.received < stamp.size {
                let length = (stamp.size - self.received).min(READ_BYTES);
                let bytes = read(self.received, length).await?;
                if bytes.len() as u64 != length {
                    return Err(AgentSessionError::ReadFailed(
                        "Antigravity transcript changed during read".into(),
                    ));
                }
                self.log
                    .ingest(&bytes)
                    .map_err(|e| AgentSessionError::ReadFailed(e.to_string()))?;
                self.received += length;
                self.hash.update(bytes);
            }
            if format!("{:x}", self.hash.clone().finalize()) == stamp.hash {
                self.stamp = Some(stamp.clone());
                return Ok(replaced);
            }
            if !resumed {
                return Err(AgentSessionError::ReadFailed(
                    "Antigravity transcript changed during read".into(),
                ));
            }
            // A growing file can also rewrite its prefix. Discard the staged
            // parse and verify a fresh read before publishing anything.
            *self = Self::default();
            replaced = true;
        }
    }
}

pub(super) async fn follow(
    manager: AgentSessionManager,
    key: TranscriptKey,
    epoch: u64,
    id: SessionId,
) {
    let command = manifest_command(id.as_str());
    let mut readers = [LogReader::default(), LogReader::default()];
    let mut previously_settled = false;
    loop {
        let result = async {
            let output = diagnostics::execute(
                &manager.inner,
                &key,
                epoch,
                diagnostics::StartupStage::Metadata,
                command.clone(),
            )
            .await?;
            let manifest = parse_manifest(&output, id.as_str())?;
            let mut changed = false;
            let mut replaced = false;
            for ((reader, stamp), name) in readers.iter_mut().zip(&manifest.stamps).zip(NAMES) {
                if reader.stamp.as_ref() == stamp.as_ref() {
                    continue;
                }
                changed = true;
                let path = format!("{}/{name}", manifest.dir);
                replaced |= reader
                    .refresh(stamp.as_ref(), |offset, length| {
                        diagnostics::execute_bytes(
                            &manager.inner,
                            &key,
                            epoch,
                            diagnostics::StartupStage::BoundedRead,
                            super::codex_history::prefix_command(&path, offset, length),
                        )
                    })
                    .await?;
            }
            Ok::<_, AgentSessionError>((changed, replaced))
        }
        .await;
        let (changed, replaced) = match result {
            Ok(pair) => pair,
            Err(error) => {
                let kind = if matches!(error, AgentSessionError::SourceUnavailable(_)) {
                    SessionFailureKind::SourceUnavailable
                } else {
                    SessionFailureKind::Transient
                };
                manager.fail_session(key, epoch, error.to_string(), kind);
                return;
            }
        };
        let (update, delay) = {
            let mut state = manager.inner.state.lock();
            let Some(session) = current_session_mut(&mut state, &key, epoch) else {
                return;
            };
            if session.terminals.is_empty() {
                return;
            }
            let AgentSessionCore::Agy(core) = &mut session.core else {
                return;
            };
            if changed {
                session.activity.touch(Instant::now());
            }
            session.activity.pause_if_quiet(Instant::now());
            let settled = session.activity.done && session.activity.paused;
            let update = if changed || settled != previously_settled {
                previously_settled = settled;
                core.publish_logs(&readers[0].log, &readers[1].log, settled)
            } else {
                None
            };
            let checkpoint = if update.is_some() && manager.inner.database.is_some() {
                core.cache_blob()
                    .ok()
                    .map(|blob| (core.source_generation(), core.committable_offset(), blob))
            } else {
                None
            };
            if update.is_some() && replaced {
                session.invalidate_continuity();
            }
            // Background reports can land after the foreground turn is done.
            let delay = session.activity.poll_delay(FILE_SOURCE_POLL_DELAY);
            if let Some((generation, offset, blob)) = checkpoint {
                session.pending_cache_offset = Some(offset);
                super::queue_checkpoint(&manager.inner, &mut state, &key, generation, offset, blob);
            }
            (update, delay)
        };
        if let Some(update) = update {
            super::emit(&manager.inner, key.clone(), epoch, update);
        }
        tokio::time::sleep(delay).await;
        if current_session_mut(&mut manager.inner.state.lock(), &key, epoch).is_none() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_transcript_core::{
        AgentTranscriptKind, AgentTranscriptPart, AgySessionCore, decode_cached_transcript,
    };
    use std::{fs, process::Command};
    const ID: &str = "f25351e5-1822-457d-a5e7-888b5137a000";

    #[tokio::test]
    async fn agy_follows_both_logs_across_rewrites_and_reconnects()
    -> Result<(), Box<dyn std::error::Error>> {
        let home = tempfile::tempdir()?;
        let dir = home
            .path()
            .join(".gemini/antigravity-cli/brain")
            .join(ID)
            .join(LOGS);
        fs::create_dir_all(&dir)?;
        let manifest = |reference: &str| -> Result<_, Box<dyn std::error::Error>> {
            let out = Command::new("sh")
                .args(["-c", &manifest_command(reference)])
                .env("HOME", home.path())
                .output()?;
            assert!(out.status.success());
            Ok(parse_manifest(
                std::str::from_utf8(&out.stdout)?,
                reference,
            )?)
        };
        let compact = dir.join(COMPACT);
        let full = dir.join(FULL);
        assert!(manifest(ID).is_err());
        let prompt = r#"{"step_index":0,"type":"USER_INPUT","content":"question"}"#;
        let reply = |text| {
            format!(
                r#"{{"step_index":1,"type":"PLANNER_RESPONSE","source":"MODEL","content":"{text}"}}"#
            )
        };
        fs::write(&compact, format!("{prompt}\n{}\n", reply("compact")))?;
        let mut readers = [LogReader::default(), LogReader::default()];
        let mut core = AgySessionCore::new(ID);
        for (i, expected) in [
            "compact",
            "compact",
            "draft",
            "final",
            "final reply",
            "compact",
        ]
        .into_iter()
        .enumerate()
        {
            match i {
                1 => fs::write(&full, reply("draft"))?,
                2 => fs::write(&full, format!("{}\n", reply("draft")))?,
                3 => fs::write(&full, format!("{}\n", reply("final")))?,
                4 => fs::write(&full, format!("{}\n", reply("final reply")))?,
                5 => fs::remove_file(&full)?,
                _ => {}
            }
            let m = manifest(full.to_str().ok_or("invalid path")?)?;
            assert_eq!(m, manifest(ID)?);
            for ((reader, stamp), name) in readers.iter_mut().zip(m.stamps.iter()).zip(NAMES) {
                let path = dir.join(name);
                reader
                    .refresh(stamp.as_ref(), |offset, len| {
                        let command = super::super::codex_history::prefix_command(
                            &path.to_string_lossy(),
                            offset,
                            len,
                        );
                        let output = Command::new("sh").args(["-c", &command]).output();
                        std::future::ready(
                            output
                                .map(|o| o.stdout)
                                .map_err(|e| AgentSessionError::ReadFailed(e.to_string())),
                        )
                    })
                    .await?;
            }
            core.publish_logs(&readers[0].log, &readers[1].log, false);
            let state = core.state();
            assert_eq!(state.messages.len(), 2);
            assert!(
                matches!(&state.messages[1].parts[0], AgentTranscriptPart::Text{text,..} if text == expected)
            );
            if i == 1 {
                let cache = core.cache_blob()?;
                assert_eq!(
                    decode_cached_transcript(AgentTranscriptKind::Agy, ID, &cache)?.messages,
                    state.messages
                );
                core = AgySessionCore::new(ID);
                core.restore_cache(&cache)?;
                readers = Default::default();
            }
        }
        assert!(validate("../other").is_err());
        assert!(parse_manifest("/other\n-\n-\n", ID).is_err());
        Ok(())
    }
}
