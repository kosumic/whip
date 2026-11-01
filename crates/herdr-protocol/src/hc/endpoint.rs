//! Core endpoint discovery commands and interpretation, pinned to paths.rs.
//! The caller executes the command on its authenticated host; no I/O lives here.
use super::Error;

const MARKER: &[u8] = b"whip-hc-endpoint-v1\0";
const MAX_PROBE_BYTES: usize = 64 * 1024;
pub const DEFAULT_COMMAND: &str = "hc";
pub const INSTALL_COMMAND: &str = "curl -fsSL https://releases.herdr.dev/core/install.sh | sh";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnixEndpoint {
    pub command: String,
    pub session: String,
    pub socket: String,
    pub installed: bool,
}

pub fn validate_session(session: &str) -> Result<(), Error> {
    if session == "."
        || session == ".."
        || session
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
    {
        return Err(Error::InvalidMessage(
            "hc session name cannot be used as a folder name".into(),
        ));
    }
    Ok(())
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
use shell_quote as quote;

pub fn discover_command(
    command: &str,
    session: &str,
    explicit_socket: Option<&str>,
) -> Result<String, Error> {
    validate_session(session)?;
    if command.is_empty() || command.chars().any(char::is_control) {
        return Err(Error::InvalidMessage("invalid hc command".into()));
    }
    let session = if session.trim().is_empty() {
        "${HC_SESSION:-default}".into()
    } else {
        quote(session.trim())
    };
    let socket = explicit_socket.map_or_else(String::new, quote);
    let script = format!(
        r#"printf 'whip-hc-endpoint-v1\000'
whip_hc_session={session}
whip_hc_command={command}
if [ "$whip_hc_command" = hc ] && ! command -v hc >/dev/null 2>&1 && [ -x "$HOME/.local/bin/hc" ]; then whip_hc_command="$HOME/.local/bin/hc"; fi
whip_hc_socket={socket}
whip_hc_state="${{XDG_STATE_HOME:-$HOME/.local/state}}/herdr-core/$whip_hc_session"
if [ -z "$whip_hc_socket" ]; then
  if [ -n "${{HC_SOCKET:-}}" ]; then
    whip_hc_socket=$HC_SOCKET
  elif [ -r "$whip_hc_state/core.lock" ]; then
    whip_hc_socket=$(cat "$whip_hc_state/core.lock")
  elif [ -n "${{XDG_RUNTIME_DIR:-}}" ]; then
    whip_hc_socket="$XDG_RUNTIME_DIR/herdr-core/$whip_hc_session.sock"
  elif [ -d "/run/user/$(id -u)" ]; then
    whip_hc_socket="/run/user/$(id -u)/herdr-core/$whip_hc_session.sock"
  else
    whip_hc_socket="$whip_hc_state/$whip_hc_session.sock"
  fi
fi
whip_hc_installed=0
if command -v "$whip_hc_command" >/dev/null 2>&1 || [ -x "$whip_hc_command" ]; then whip_hc_installed=1; fi
printf '%s\000%s\000%s\000%s\000' "$whip_hc_session" "$whip_hc_socket" "$whip_hc_installed" "$whip_hc_command"
"#,
        command = quote(command)
    );
    Ok(posix_command(&script))
}

pub fn parse_discovery(bytes: &[u8]) -> Result<Option<UnixEndpoint>, Error> {
    if bytes.len() > MAX_PROBE_BYTES {
        return Err(Error::Limit("endpoint discovery output"));
    }
    let Some(start) = bytes.windows(MARKER.len()).position(|part| part == MARKER) else {
        return Ok(None);
    };
    let fields: Vec<_> = bytes[start + MARKER.len()..].split(|b| *b == 0).collect();
    if fields.len() != 5 || !fields[4].is_empty() {
        return Err(Error::InvalidMessage(
            "malformed endpoint discovery reply".into(),
        ));
    }
    let string = |bytes: &[u8]| {
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| Error::InvalidMessage("endpoint path is not UTF-8".into()))
    };
    let session = string(fields[0])?;
    let socket = string(fields[1])?;
    let command = string(fields[3])?;
    if command.is_empty() || command.chars().any(char::is_control) {
        return Err(Error::InvalidMessage(
            "invalid discovered core command".into(),
        ));
    }
    validate_session(&session)?;
    if socket.is_empty() || !socket.starts_with('/') || socket.chars().any(char::is_control) {
        return Err(Error::InvalidMessage(
            "invalid Unix core socket path".into(),
        ));
    }
    let installed = match fields[2] {
        b"0" => false,
        b"1" => true,
        _ => {
            return Err(Error::InvalidMessage(
                "invalid installation probe result".into(),
            ));
        }
    };
    Ok(Some(UnixEndpoint {
        command,
        session,
        socket,
        installed,
    }))
}

/// A short-lived start operation followed by rediscovery honors the core's TOML
/// socket override without embedding a second TOML/config implementation.
pub fn start_command(
    command: &str,
    session: &str,
    explicit_socket: Option<&str>,
) -> Result<String, Error> {
    validate_session(session)?;
    let socket =
        explicit_socket.map_or_else(String::new, |path| format!("HC_SOCKET={} ", quote(path)));
    Ok(posix_command(&format!(
        "HC_SESSION={} {socket}{} server start --json",
        quote(session),
        quote(command)
    )))
}

pub fn connect_command(command: &str, session: &str, posix: bool) -> Result<String, Error> {
    validate_session(session)?;
    if posix {
        return Ok(format!(
            "{} connect --session {}",
            quote(command),
            quote(session)
        ));
    }
    // A common command works in both cmd.exe and PowerShell. Complex paths need
    // a Unix socket or a POSIX SSH shell rather than ambiguous shell escaping.
    if !command
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/\\:._-".contains(&b))
        || !session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(Error::InvalidMessage(
            "non-POSIX SSH shells require a simple hc command and session name".into(),
        ));
    }
    Ok(format!("{command} connect --session {session}"))
}

pub fn version_command(command: &str, posix: bool) -> Result<String, Error> {
    if posix {
        return Ok(format!("{} --version", quote(command)));
    }
    connect_command(command, "default", false)?;
    Ok(format!("{command} --version"))
}

pub fn posix_command(script: &str) -> String {
    format!("/bin/sh -c {}", quote(script))
}

pub fn legacy_version_command() -> String {
    posix_command(
        r#"whip_legacy=herdr
if ! command -v "$whip_legacy" >/dev/null 2>&1 && [ -x "$HOME/.local/bin/$whip_legacy" ]; then whip_legacy="$HOME/.local/bin/$whip_legacy"; fi
exec "$whip_legacy" --version"#,
    )
}
