//! Public-key sharing and enrollment through an existing SSH profile.

use std::{sync::Arc, time::Duration};

use russh::keys::ssh_key::{HashAlg, PublicKey};

use crate::{
    HostRuntimeError, HostSshConfig,
    host_runtime::{disconnect_sessions, ssh_config},
    remote_ops::shell_quote,
    ssh::SshSession,
};

const QR_PREFIX: &str = "whip:ssh-public-key:v1:";
const MAX_PUBLIC_KEY_BYTES: usize = 4096;
const OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct PublicKeyShare {
    pub public_key: String,
    pub fingerprint: String,
    pub key_type: String,
    pub qr_payload: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum PublicKeyInstallOutcome {
    Added,
    AlreadyPresent,
}

fn invalid_key(message: impl Into<String>) -> HostRuntimeError {
    HostRuntimeError::InvalidConfiguration(message.into())
}

fn parse_public_key(value: &str) -> Result<PublicKey, HostRuntimeError> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_PUBLIC_KEY_BYTES || value.chars().any(char::is_control)
    {
        return Err(invalid_key("Expected one OpenSSH public key"));
    }
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    PublicKey::from_openssh(&normalized)
        .map_err(|_| invalid_key("Expected an OpenSSH public key without authorized_keys options"))
}

/// Derive the same six-digit fingerprint code displayed by whipair.
#[uniffi::export]
pub fn public_key_verification_code(public_key: String) -> Result<String, HostRuntimeError> {
    let key = parse_public_key(&public_key)?;
    let digest = key
        .fingerprint(HashAlg::Sha256)
        .sha256()
        .ok_or_else(|| invalid_key("SSH public key is malformed"))?;
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    let digits = format!("{value:06}");
    Ok(format!("{}-{}", &digits[..3], &digits[3..]))
}

/// Accept bare OpenSSH keys from the clipboard, or a versioned Whip sharing QR.
#[uniffi::export]
pub fn inspect_public_key(
    value: String,
    require_qr: bool,
) -> Result<PublicKeyShare, HostRuntimeError> {
    let value = value.trim();
    let public_key = match value.strip_prefix(QR_PREFIX) {
        Some(key) => key,
        None if !require_qr => value,
        None => return Err(invalid_key("Scan a Whip public-key QR code")),
    };
    let mut key = parse_public_key(public_key)?;
    key.set_comment("");
    let public_key = key
        .to_openssh()
        .map_err(|error| invalid_key(error.to_string()))?;
    Ok(PublicKeyShare {
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        key_type: key.algorithm().as_str().to_owned(),
        qr_payload: format!("{QR_PREFIX}{public_key}"),
        public_key,
    })
}

fn installation_script(key: &PublicKeyShare) -> String {
    // Run in the remote home. The lock serializes Whip installs without replacing
    // the file; append mode preserves other entries and missing final newlines.
    format!(
        r#"set -eu
umask 077
[ ! -L .ssh ] || {{ echo 'The .ssh directory is a symlink' >&2; exit 1; }}
mkdir -p .ssh
chmod 700 .ssh
mkdir .ssh/.whip-authorized-keys.lock || {{ echo 'Another public-key install is in progress' >&2; exit 1; }}
trap 'rmdir .ssh/.whip-authorized-keys.lock' 0
trap 'exit 1' 1 2 15
file=.ssh/authorized_keys
[ ! -L "$file" ] || {{ echo 'authorized_keys is a symlink' >&2; exit 1; }}
if [ -e "$file" ] && [ ! -f "$file" ]; then
  echo 'authorized_keys is not a regular file' >&2; exit 1
fi
: >> "$file"
chmod 600 "$file"
if awk -v key_type={key_type} -v key_blob={key_blob} '
function token(    i, c, quoted, escaped, result) {{
  sub(/^[ \t]+/, "", rest)
  for (i = 1; i <= length(rest); i++) {{
    c = substr(rest, i, 1)
    if (escaped) escaped = 0
    else if (c == "\\" && quoted) escaped = 1
    else if (c == "\"") quoted = !quoted
    else if (c ~ /[ \t]/ && !quoted) break
    result = result c
  }}
  rest = substr(rest, i)
  return result
}}
/^[ \t]*($|#)/ {{ next }}
{{
  rest = $0
  kind = token()
  if (kind != key_type) kind = token()
  if (kind == key_type && token() == key_blob) found = 1
}}
END {{ exit found ? 0 : 1 }}' "$file"; then
  printf 'already-present\n'
else
  status=$?
  [ "$status" = 1 ] || exit "$status"
  if [ -s "$file" ] && [ -n "$(tail -c 1 "$file")" ]; then printf '\n' >> "$file"; fi
  printf '%s\n' {public_key} >> "$file"
  printf 'added\n'
fi"#,
        key_type = shell_quote(&key.key_type),
        key_blob = shell_quote(key.public_key.split_whitespace().nth(1).unwrap_or_default()),
        public_key = shell_quote(&key.public_key),
    )
}

async fn install_on_route(
    target: HostSshConfig,
    jump_hosts: Vec<HostSshConfig>,
    key: PublicKeyShare,
) -> Result<PublicKeyInstallOutcome, HostRuntimeError> {
    let mut sessions: Vec<Arc<SshSession>> = Vec::new();
    let result = async {
        for config in jump_hosts.iter().chain(std::iter::once(&target)) {
            if config.host.trim().is_empty()
                || config.username.trim().is_empty()
                || config.port == 0
            {
                return Err(invalid_key("SSH host, username, and port are required"));
            }
            let mut connection = ssh_config(config);
            connection.forward_agent = false;
            let session = tokio::time::timeout(
                OPERATION_TIMEOUT,
                SshSession::connect(&connection, sessions.last().map(Arc::as_ref)),
            )
            .await
            .map_err(|_| {
                HostRuntimeError::SshTransportFailure("SSH connection timed out".to_owned())
            })??;
            sessions.push(session);
        }
        let session = sessions
            .last()
            .ok_or_else(|| invalid_key("Missing SSH target"))?;
        let command = format!(
            "cd \"$HOME\" && sh -c {}",
            shell_quote(&installation_script(&key))
        );
        let output = tokio::time::timeout(OPERATION_TIMEOUT, session.execute(&command))
            .await
            .map_err(|_| {
                HostRuntimeError::SshTransportFailure(
                    "Public-key installation timed out".to_owned(),
                )
            })??;
        if output.exit_status != Some(0) {
            return Err(HostRuntimeError::RemoteFileFailure(format!(
                "Could not install public key: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        match String::from_utf8_lossy(&output.stdout).trim() {
            "added" => Ok(PublicKeyInstallOutcome::Added),
            "already-present" => Ok(PublicKeyInstallOutcome::AlreadyPresent),
            _ => Err(HostRuntimeError::RemoteFileFailure(
                "Unexpected public-key installation response".to_owned(),
            )),
        }
    }
    .await;
    disconnect_sessions(sessions).await;
    result
}

/// Uses a separate SSH transport so installing a key never replaces a live host runtime.
#[uniffi::export]
pub async fn install_host_public_key(
    target: HostSshConfig,
    jump_hosts: Vec<HostSshConfig>,
    public_key: String,
) -> Result<PublicKeyInstallOutcome, HostRuntimeError> {
    let key = inspect_public_key(public_key, false)?;
    crate::runtime()
        .map_err(HostRuntimeError::SshTransportFailure)?
        .spawn(install_on_route(target, jump_hosts, key))
        .await
        .map_err(|error| HostRuntimeError::SshTransportFailure(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
        process::{Command, Output},
    };
    use tempfile::TempDir;

    const KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti";

    #[test]
    fn verification_code_matches_whipair_and_ignores_comments() {
        for key in [
            KEY.to_owned(),
            format!("  {}   phone  ", KEY.replace(' ', "   ")),
        ] {
            assert_eq!(public_key_verification_code(key).unwrap(), "610-862");
        }
    }

    #[test]
    fn verification_code_preserves_leading_zeroes() {
        let key =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
        assert_eq!(
            public_key_verification_code(key.to_owned()).unwrap(),
            "079-539"
        );
    }

    #[test]
    fn verification_code_rejects_malformed_keys() {
        for key in [
            String::new(),
            "-----BEGIN OPENSSH PRIVATE KEY-----".to_owned(),
            "ssh-ed25519 AAAA".to_owned(),
            "ssh-ed25519 !!!!".to_owned(),
            format!("restrict {KEY}"),
            format!("{KEY}\n{KEY}"),
            KEY.replace("ssh-ed25519", "ssh-rsa"),
            format!("{KEY} {}", "x".repeat(MAX_PUBLIC_KEY_BYTES)),
        ] {
            assert!(matches!(
                public_key_verification_code(key),
                Err(HostRuntimeError::InvalidConfiguration(_))
            ));
        }
    }

    fn install(directory: &TempDir) -> Output {
        Command::new("sh")
            .arg("-c")
            .arg(installation_script(
                &inspect_public_key(KEY.to_owned(), false).unwrap(),
            ))
            .current_dir(directory.path())
            .output()
            .unwrap()
    }

    #[test]
    fn sharing_round_trip_excludes_comments_and_private_material() {
        let share = inspect_public_key(format!("{KEY} phone"), false).unwrap();
        assert_eq!(share.public_key, KEY);
        assert!(share.fingerprint.starts_with("SHA256:"));
        assert_eq!(
            inspect_public_key(share.qr_payload.clone(), true).unwrap(),
            share
        );
        for invalid in [
            KEY,
            "WP4:pairing-secret",
            "whip:ssh-public-key:v2:unknown",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
        ] {
            assert!(inspect_public_key(invalid.to_owned(), true).is_err());
        }
        for invalid in [
            format!("restrict {KEY}"),
            format!("{KEY}\n{KEY}"),
            "ssh-ed25519 AAAA".to_owned(),
        ] {
            assert!(inspect_public_key(invalid, false).is_err());
        }
    }

    #[test]
    fn installs_once_with_private_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let result = install(&directory);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(result.stdout, b"added\n");
        assert_eq!(install(&directory).stdout, b"already-present\n");
        let path = directory.path().join(".ssh/authorized_keys");
        assert_eq!(fs::read_to_string(&path).unwrap(), format!("{KEY}\n"));
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(directory.path().join(".ssh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    #[test]
    fn preserves_entries_and_recognizes_restricted_keys() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join(".ssh")).unwrap();
        let path = directory.path().join(".ssh/authorized_keys");
        let existing =
            format!("# keep\ncommand=\"echo \\\"hello world\\\"\",restrict {KEY} other comment");
        fs::write(&path, &existing).unwrap();
        assert_eq!(install(&directory).stdout, b"already-present\n");
        assert_eq!(fs::read_to_string(&path).unwrap(), existing);
        let comment = format!("# {KEY}");
        fs::write(&path, &comment).unwrap();
        assert_eq!(install(&directory).stdout, b"added\n");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!("{comment}\n{KEY}\n")
        );
    }

    #[test]
    fn refuses_symlinks_and_concurrent_installs() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join(".ssh")).unwrap();
        let victim = directory.path().join("victim");
        fs::write(&victim, "keep").unwrap();
        symlink(&victim, directory.path().join(".ssh/authorized_keys")).unwrap();
        assert!(!install(&directory).status.success());
        assert_eq!(fs::read_to_string(victim).unwrap(), "keep");
        assert!(
            !directory
                .path()
                .join(".ssh/.whip-authorized-keys.lock")
                .exists()
        );
        fs::create_dir(directory.path().join(".ssh/.whip-authorized-keys.lock")).unwrap();
        assert!(!install(&directory).status.success());
    }
}
