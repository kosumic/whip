//! Optional Codex name metadata, carried by an existing file metadata request.

use serde::Deserialize;

use super::shell_quote;

const TITLE_SECTION: &str = "\n__WHIP_CODEX_TITLE__\n";

pub(super) struct CodexTitleMetadata {
    pub stamp: String,
    pub title: Option<String>,
}

#[derive(Deserialize)]
struct SessionIndexEntry {
    id: String,
    thread_name: String,
}

pub(super) fn with_title_read(
    command: String,
    path: &str,
    session_id: &str,
    previous_stamp: Option<&str>,
) -> String {
    let Some((home, _)) = path.rsplit_once("/sessions/") else {
        return command;
    };
    let index = shell_quote(&format!("{home}/session_index.jsonl"));
    let previous = shell_quote(previous_stamp.unwrap_or_default());
    let pattern = shell_quote(&format!(r#""id"[[:space:]]*:[[:space:]]*"{session_id}""#));
    // Use an explicit POSIX shell: the SSH login shell may be Fish. Missing or
    // unreadable optional metadata never makes the transcript request fail.
    // Stat first so unchanged indexes are not scanned on every transcript poll.
    let script = format!(
        r#"p=$1
previous=$2
pattern=$3
stamp=$(stat -c '%d:%i:%s:%y' "$p" 2>/dev/null || stat -f '%d:%i:%z:%Fm' "$p" 2>/dev/null) || stamp=missing
if [ "$stamp" != "$previous" ]; then
  if [ "$stamp" = missing ]; then
    printf '{TITLE_SECTION}%s\n' "$stamp"
  elif [ -r "$p" ]; then
    printf '{TITLE_SECTION}%s\n' "$stamp"
    LC_ALL=C grep -E -- "$pattern" "$p" 2>/dev/null | tail -n 1
  fi
fi"#
    );
    format!(
        "{command} && sh -c {} sh {index} {previous} {pattern}",
        shell_quote(&script)
    )
}

pub(super) fn split_output<'a>(
    output: &'a str,
    session_id: &str,
) -> (&'a str, Option<CodexTitleMetadata>) {
    let Some((source, section)) = output.split_once(TITLE_SECTION) else {
        return (output, None);
    };
    let Some((stamp, record)) = section.split_once('\n') else {
        return (source, None);
    };
    let title = if record.trim().is_empty() {
        None
    } else {
        let Ok(entry) = serde_json::from_str::<SessionIndexEntry>(record) else {
            // An append may still be in progress. Retry at the existing cadence.
            return (source, None);
        };
        if entry.id != session_id {
            return (source, None);
        }
        Some(entry.thread_name)
    };
    (
        source,
        Some(CodexTitleMetadata {
            stamp: stamp.to_owned(),
            title,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "11111111-1111-4111-8111-111111111111";

    fn run(path: &std::path::Path, previous: Option<&str>) -> std::process::Output {
        let command = with_title_read(
            "printf '17:23 0\\n'".into(),
            path.to_str().unwrap(),
            SESSION,
            previous,
        );
        let shell = std::env::var_os("WHIP_TEST_REMOTE_SHELL").unwrap_or_else(|| "sh".into());
        std::process::Command::new(shell)
            .args(["-c", &command])
            .output()
            .unwrap()
    }

    #[test]
    fn current_name_is_read_with_source_metadata_and_unchanged_indexes_are_skipped() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("Codex home's data");
        let path = home.join("sessions/2026/10/20/rollout.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let index = home.join("session_index.jsonl");
        let record = |title: &str| serde_json::json!({"id":SESSION,"thread_name":title,"updated_at":"today"});
        std::fs::write(
            &index,
            format!(
                "{}\n{}\n{}\n",
                record("Old"),
                record("Current $(literal) `title`"),
                serde_json::json!({"id":"other","thread_name":"Other conversation"})
            ),
        )
        .unwrap();
        let output = run(&path, None);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let output = std::str::from_utf8(&output.stdout).unwrap();
        let (source, title) = split_output(output, SESSION);
        assert_eq!(source, "17:23 0\n");
        let title = title.unwrap();
        assert_eq!(title.title.as_deref(), Some("Current $(literal) `title`"));
        let output = run(&path, Some(&title.stamp));
        assert_eq!(std::str::from_utf8(&output.stdout).unwrap(), "17:23 0\n");

        std::fs::write(&index, format!("{}\n", record("Renamed"))).unwrap();
        let output = run(&path, Some(&title.stamp));
        let (_, updated) = split_output(std::str::from_utf8(&output.stdout).unwrap(), SESSION);
        assert_eq!(updated.unwrap().title.as_deref(), Some("Renamed"));

        std::fs::write(&index, format!("{}\n", record(""))).unwrap();
        let output = run(&path, None);
        assert_eq!(
            split_output(std::str::from_utf8(&output.stdout).unwrap(), SESSION)
                .1
                .unwrap()
                .title
                .as_deref(),
            Some("")
        );
        std::fs::remove_file(&index).unwrap();
        let output = run(&path, None);
        assert!(output.status.success());
        let missing = split_output(std::str::from_utf8(&output.stdout).unwrap(), SESSION)
            .1
            .unwrap();
        assert_eq!(missing.stamp, "missing");
        assert_eq!(missing.title, None);
    }

    #[test]
    fn malformed_or_wrong_session_names_do_not_change_transcript_metadata() {
        for record in [
            "{",
            r#"{"id":"other","thread_name":"Wrong"}"#,
            r#"{"id":"a"}"#,
        ] {
            let output = format!("17:23 0\n{TITLE_SECTION}stamp\n{record}\n");
            let (source, title) = split_output(&output, SESSION);
            assert_eq!(source, "17:23 0\n");
            assert!(title.is_none());
        }
    }
}
