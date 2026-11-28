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

pub(super) fn find_command(reference: &str) -> String {
    if reference.starts_with('/') {
        return format!("printf '%s\\n' {}", shell_quote(reference));
    }
    let script = format!(
        r#"dir="$HOME/.gemini/antigravity-cli/brain/$1/{LOGS}"
if [ -s "$dir/{FULL}" ]; then printf '%s\n' "$dir/{FULL}"
elif [ -f "$dir/{COMPACT}" ]; then printf '%s\n' "$dir/{COMPACT}"
elif [ -f "$dir/{FULL}" ]; then printf '%s\n' "$dir/{FULL}"
fi"#
    );
    format!(
        "sh -c {} whip-agy {}",
        shell_quote(&script),
        shell_quote(reference)
    )
}

pub(super) fn resolve_path(
    output: &str,
    reference: &str,
) -> Result<Option<String>, AgentSessionError> {
    validate(reference)?;
    let path = output.trim_end_matches('\n');
    if path.is_empty() {
        return Ok(None);
    }
    if path.starts_with('/')
        && conversation_id(path) == conversation_id(reference)
        && (!reference.starts_with('/') || path == reference)
    {
        return Ok(Some(path.to_owned()));
    }
    Err(AgentSessionError::SourceUnavailable(
        "Antigravity transcript did not match the reported conversation".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};
    const ID: &str = "f25351e5-1822-457d-a5e7-888b5137a000";

    #[test]
    fn agy_selects_only_the_reported_conversation() -> Result<(), Box<dyn std::error::Error>> {
        let home = tempfile::tempdir()?;
        let dir = home
            .path()
            .join(".gemini/antigravity-cli/brain")
            .join(ID)
            .join(LOGS);
        fs::create_dir_all(&dir)?;
        let discover = || -> Result<_, Box<dyn std::error::Error>> {
            let output = Command::new("sh")
                .args(["-c", &find_command(ID)])
                .env("HOME", home.path())
                .output()?;
            assert!(output.status.success());
            Ok(resolve_path(std::str::from_utf8(&output.stdout)?, ID)?)
        };
        assert_eq!(discover()?, None);
        for filename in [COMPACT, FULL] {
            let path = dir.join(filename);
            fs::write(&path, b"{}\n")?;
            assert_eq!(discover()?.as_deref(), path.to_str());
        }
        assert!(resolve_path("/other/log.jsonl", ID).is_err());
        assert!(validate("../other").is_err());
        Ok(())
    }
}
