//! Resolve Pi's authoritative session path or exact session ID.
use super::{AgentSessionError, shell_quote};

pub(super) fn validate_pi_session(value: &str) -> Result<(), AgentSessionError> {
    let valid = if value.starts_with('/') {
        std::path::Path::new(value)
            .extension()
            .is_some_and(|extension| extension == "jsonl")
            && !value.chars().any(char::is_control)
            && !value.split('/').any(|part| matches!(part, "." | ".."))
    } else {
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    };
    if valid {
        Ok(())
    } else {
        Err(AgentSessionError::InvalidSession(
            "Pi requires a session ID or absolute JSONL session path".into(),
        ))
    }
}

pub(super) fn pi_transcript_find_command(session: &str) -> String {
    if session.starts_with('/') {
        // The path comes from Herdr, including custom SDK/session directories.
        return format!("printf '%s\\n' {}", shell_quote(session));
    }
    let name = shell_quote(&format!("*_{session}.jsonl"));
    format!(
        r#"find "${{PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}/sessions" -type f -name {name} -exec sh -c 'for p do t=$(stat -c %Y "$p" 2>/dev/null || stat -f %m "$p") || continue; printf "%s\t%s\n" "$t" "$p"; done' sh {{}} +"#
    )
}

pub(super) fn resolve_pi_path(
    output: &str,
    session: &str,
) -> Result<Option<String>, AgentSessionError> {
    validate_pi_session(session)?;
    if session.starts_with('/') {
        return if output.trim_end_matches('\n') == session {
            Ok(Some(session.into()))
        } else {
            Err(AgentSessionError::SourceUnavailable(
                "Pi session path did not match the host identity".into(),
            ))
        };
    }
    let suffix = format!("_{session}.jsonl");
    let candidate = output
        .lines()
        .filter_map(|line| {
            let (mtime, path) = line.split_once('\t')?;
            let mtime = mtime.parse::<i64>().ok()?;
            if validate_pi_session(path).is_err()
                || !path.starts_with('/')
                || !path.rsplit('/').next()?.ends_with(&suffix)
            {
                return None;
            }
            Some((mtime, path))
        })
        .max();
    if candidate.is_none() && !output.trim().is_empty() {
        return Err(AgentSessionError::SourceUnavailable(
            "Pi returned no exact session file".into(),
        ));
    }
    Ok(candidate.map(|(_, path)| path.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_exact_ids_and_authoritative_custom_paths() {
        let output = "1\t/home/me/.pi/agent/sessions/project/2026_session.jsonl\n2\t/home/me/custom/2027_session.jsonl\n9\t/home/me/.pi/agent/sessions/project/2026_other.jsonl\n";
        assert_eq!(
            resolve_pi_path(output, "session").unwrap().as_deref(),
            Some("/home/me/custom/2027_session.jsonl")
        );
        let path = "/custom sessions/it's a session.jsonl";
        assert_eq!(
            resolve_pi_path(&format!("{path}\n"), path)
                .unwrap()
                .as_deref(),
            Some(path)
        );
        assert!(resolve_pi_path("/wrong.jsonl\n", path).is_err());
        assert!(resolve_pi_path("", "session").unwrap().is_none());
        for invalid in [
            "../x",
            "x; echo hi",
            "x*",
            "/tmp/../secret.jsonl",
            "/tmp/a\nb.jsonl",
            "/tmp/file",
        ] {
            assert!(validate_pi_session(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn shell_discovery_handles_spaces_and_quotes_without_executing_paths() {
        let path = "/custom sessions/it's a session.jsonl";
        let output = std::process::Command::new("sh")
            .args(["-c", &pi_transcript_find_command(path)])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            resolve_pi_path(std::str::from_utf8(&output.stdout).unwrap(), path)
                .unwrap()
                .as_deref(),
            Some(path)
        );
    }
}
