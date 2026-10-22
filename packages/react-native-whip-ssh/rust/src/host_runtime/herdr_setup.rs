//! Explicit, user-confirmed Herdr installation over the existing SSH transport.

use std::sync::Arc;
use std::time::Duration;

use super::connection::{
    current_generation, current_ssh, start_herdr_server_inner, validate_generation,
};
use super::{HostRuntime, HostRuntimeError, RuntimeInner};
use crate::remote_ops::shell_quote;
use crate::ssh::CommandOutput;

const DEFAULT_HERDR_COMMAND: &str = "herdr";
const MISSING_EXIT_STATUS: u32 = 3;
const CUSTOM_COMMAND_MISSING_EXIT_STATUS: u32 = 4;
const SETUP_TIMEOUT: Duration = Duration::from_secs(15);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_INSTALL_OUTPUT_BYTES: usize = 64 * 1024;
// This exact script is returned to the confirmation UI before it can be run.
const INSTALL_COMMAND: &str = r#"curl -fsSL https://herdr.dev/install.sh | sh"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrInstallationStatus {
    Installed,
    Missing,
    CustomCommandMissing,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HerdrSetup {
    pub status: HerdrInstallationStatus,
    pub install_command: String,
}

#[uniffi::export(with_foreign)]
pub trait HerdrInstallOutputSink: Send + Sync {
    /// A bounded snapshot of stdout and stderr, in arrival order.
    fn output(&self, text: String);
}

struct InstallOutput {
    bytes: parking_lot::Mutex<Vec<u8>>,
    sink: Arc<dyn HerdrInstallOutputSink>,
}

impl InstallOutput {
    fn append(&self, bytes: &[u8]) {
        let text = {
            let mut buffer = self.bytes.lock();
            buffer.extend_from_slice(bytes);
            if buffer.len() > MAX_INSTALL_OUTPUT_BYTES {
                let excess = buffer.len() - MAX_INSTALL_OUTPUT_BYTES;
                buffer.drain(..excess);
            }
            let text = plain_output(&buffer);
            drop(buffer);
            text
        };
        self.sink.output(text);
    }
}

fn plain_output(bytes: &[u8]) -> String {
    let mut plain = Vec::with_capacity(bytes.len());
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] == 0x1b && bytes.get(cursor + 1) == Some(&b'[') {
            cursor += 2;
            while cursor < bytes.len() {
                let byte = bytes[cursor];
                cursor += 1;
                if (0x40..=0x7e).contains(&byte) {
                    break;
                }
            }
        } else {
            plain.push(bytes[cursor]);
            cursor += 1;
        }
    }
    String::from_utf8_lossy(&plain)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

pub(super) fn resolve_executable_script(configured: &str) -> String {
    let configured = configured.trim();
    let command = if configured.is_empty() {
        DEFAULT_HERDR_COMMAND
    } else {
        configured
    };
    let fallback = if command == DEFAULT_HERDR_COMMAND {
        r#"
if ! command -v "$whip_herdr" >/dev/null 2>&1 && [ -x "$HOME/.local/bin/herdr" ]; then
    whip_herdr="$HOME/.local/bin/herdr"
fi"#
    } else {
        ""
    };
    format!("whip_herdr={}{}", shell_quote(command), fallback)
}

// Login-shell PATH discovery also works when the user's shell is fish: all
// actual setup scripts execute in an explicit POSIX shell.
pub(super) fn login_shell_command(script: &str) -> String {
    let command = format!("exec /bin/sh -c {}", shell_quote(script));
    let bootstrap = r#"exec "${SHELL:-/bin/sh}" -lc "$1""#;
    format!(
        "exec /bin/sh -c {} whip {}",
        shell_quote(bootstrap),
        shell_quote(&command)
    )
}

fn probe_script(configured: &str) -> String {
    let missing = if configured.trim().is_empty() || configured.trim() == DEFAULT_HERDR_COMMAND {
        MISSING_EXIT_STATUS
    } else {
        CUSTOM_COMMAND_MISSING_EXIT_STATUS
    };
    format!(
        "{}\nif command -v \"$whip_herdr\" >/dev/null 2>&1; then exit 0; else exit {missing}; fi",
        resolve_executable_script(configured)
    )
}

async fn execute_setup(
    inner: &RuntimeInner,
    generation: u64,
    script: &str,
    timeout: Duration,
) -> Result<CommandOutput, HostRuntimeError> {
    validate_generation(inner, generation)?;
    let command = login_shell_command(script);
    let output = tokio::time::timeout(timeout, current_ssh(inner)?.execute(&command))
        .await
        .map_err(|_| {
            HostRuntimeError::HerdrUnavailable(
                "Herdr setup command timed out. Open an SSH shell to check its progress."
                    .to_owned(),
            )
        })??;
    validate_generation(inner, generation)?;
    Ok(output)
}

fn command_failed(output: &CommandOutput) -> HostRuntimeError {
    let stdout = plain_output(&output.stdout);
    let stderr = plain_output(&output.stderr);
    let status = output
        .exit_status
        .map_or_else(|| "unknown".to_owned(), |status| status.to_string());
    HostRuntimeError::HerdrUnavailable(format!(
        "Herdr setup exited with status {status}.\n{}\n{}",
        stdout.trim(),
        stderr.trim()
    ))
}

async fn check_installation(
    inner: &RuntimeInner,
    generation: u64,
) -> Result<HerdrInstallationStatus, HostRuntimeError> {
    let output = execute_setup(
        inner,
        generation,
        &probe_script(&inner.config.herdr_command),
        SETUP_TIMEOUT,
    )
    .await?;
    match output.exit_status {
        Some(0) => Ok(HerdrInstallationStatus::Installed),
        Some(MISSING_EXIT_STATUS) => Ok(HerdrInstallationStatus::Missing),
        Some(CUSTOM_COMMAND_MISSING_EXIT_STATUS) => {
            Ok(HerdrInstallationStatus::CustomCommandMissing)
        }
        _ => Err(command_failed(&output)),
    }
}

async fn install(
    inner: Arc<RuntimeInner>,
    sink: Arc<dyn HerdrInstallOutputSink>,
) -> Result<(), HostRuntimeError> {
    let _installation = inner.herdr_installation.lock().await;
    let generation = current_generation(&inner)?;
    let output = InstallOutput {
        bytes: parking_lot::Mutex::new(Vec::new()),
        sink,
    };
    output.append(b"Checking Herdr installation...\n");
    match check_installation(&inner, generation).await? {
        HerdrInstallationStatus::CustomCommandMissing => {
            return Err(HostRuntimeError::InvalidConfiguration("The configured Herdr command is unavailable. Check its path in Edit host before installing.".to_owned()));
        }
        HerdrInstallationStatus::Installed => {}
        HerdrInstallationStatus::Missing => {
            let command = login_shell_command(INSTALL_COMMAND);
            let result = tokio::time::timeout(
                INSTALL_TIMEOUT,
                current_ssh(&inner)?.execute_with_output(&command, |bytes| {
                    if validate_generation(&inner, generation).is_ok() {
                        output.append(bytes);
                    }
                }),
            )
            .await
            .map_err(|_| {
                HostRuntimeError::HerdrUnavailable(
                    "Herdr installation timed out. Open an SSH shell to check its progress."
                        .to_owned(),
                )
            })??;
            validate_generation(&inner, generation)?;
            if result.exit_status != Some(0) {
                return Err(command_failed(&result));
            }
            if check_installation(&inner, generation).await? != HerdrInstallationStatus::Installed {
                return Err(HostRuntimeError::HerdrUnavailable("Herdr could not be found after the install command. Open an SSH shell to check the installation.".to_owned()));
            }
        }
    }
    // Reuse native startup/readiness and host-state publication. Never replay
    // installation automatically after an SSH failure or a reconnect.
    validate_generation(&inner, generation)?;
    output.append(b"\nStarting Herdr server...\n");
    start_herdr_server_inner(inner.clone()).await?;
    output.append(b"Herdr is ready.\n");
    Ok(())
}

#[uniffi::export]
impl HostRuntime {
    pub async fn herdr_setup(&self) -> Result<HerdrSetup, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                Ok(HerdrSetup {
                    status: check_installation(&inner, generation).await?,
                    install_command: INSTALL_COMMAND.to_owned(),
                })
            })
            .await
            .map_err(|error| HostRuntimeError::SshTransportFailure(error.to_string()))?
    }

    pub async fn install_herdr(
        &self,
        sink: Arc<dyn HerdrInstallOutputSink>,
    ) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(install(inner, sink))
            .await
            .map_err(|error| HostRuntimeError::SshTransportFailure(error.to_string()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::process::{Command, Output};

    fn executable(path: &Path, script: &str) {
        fs::write(path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn probe(home: &Path, command: &str) -> Output {
        Command::new("/bin/sh")
            .args(["-c", &probe_script(command)])
            .env("HOME", home)
            .env("PATH", home.join("empty-path"))
            .output()
            .unwrap()
    }

    #[test]
    fn probe_finds_local_installation_without_path_and_preserves_custom_paths() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(probe(home.path(), "herdr").status.code(), Some(3));
        fs::create_dir_all(home.path().join(".local/bin")).unwrap();
        executable(&home.path().join(".local/bin/herdr"), "#!/bin/sh\nexit 0\n");
        assert!(probe(home.path(), "herdr").status.success());
        assert!(probe(home.path(), " ").status.success());
        assert_eq!(
            probe(home.path(), "/missing/custom-herdr").status.code(),
            Some(4)
        );
        let custom = home.path().join("custom herdr's binary");
        executable(&custom, "#!/bin/sh\nexit 0\n");
        assert!(
            probe(home.path(), custom.to_str().unwrap())
                .status
                .success()
        );
        let malicious = format!("missing; touch {}", home.path().join("injected").display());
        assert_eq!(probe(home.path(), &malicious).status.code(), Some(4));
        assert!(!home.path().join("injected").exists());
    }

    #[test]
    fn confirmed_command_reports_download_failure_and_leaves_host_uninstalled() {
        let fixture = tempfile::tempdir().unwrap();
        executable(
            &fixture.path().join("curl"),
            "#!/bin/sh\nprintf 'download failed\\n' >&2\nexit 22\n",
        );
        let path = format!(
            "{}:{}",
            fixture.path().display(),
            std::env::var("PATH").unwrap()
        );
        let output = Command::new("/bin/sh")
            .args(["-c", INSTALL_COMMAND])
            .env("PATH", path)
            .env("HOME", fixture.path())
            .env("TMPDIR", fixture.path())
            .output()
            .unwrap();
        // POSIX pipelines report the last command's status. The native install
        // flow therefore verifies executable discovery before starting Herdr.
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stderr), "download failed\n");
        assert!(!fixture.path().join(".local").exists());
        assert_eq!(probe(fixture.path(), "herdr").status.code(), Some(3));
        assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 1);
    }

    #[test]
    fn confirmed_command_runs_the_installer_with_its_default_directory() {
        let fixture = tempfile::tempdir().unwrap();
        executable(
            &fixture.path().join("curl"),
            r#"#!/bin/sh
cat <<'INSTALLER'
set -eu
INSTALL_DIR="${HERDR_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR"
printf '#!/bin/sh\nexit 0\n' > "$INSTALL_DIR/herdr"
chmod +x "$INSTALL_DIR/herdr"
printf 'Installed Herdr\n'
INSTALLER
"#,
        );
        let path = format!(
            "{}:{}",
            fixture.path().display(),
            std::env::var("PATH").unwrap()
        );
        let output = Command::new("/bin/sh")
            .args(["-c", INSTALL_COMMAND])
            .env("PATH", path)
            .env("HOME", fixture.path())
            .env("TMPDIR", fixture.path())
            .env_remove("HERDR_INSTALL_DIR")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout), "Installed Herdr\n");
        assert!(probe(fixture.path(), "herdr").status.success());
        assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 2);
    }

    #[test]
    fn output_snapshots_remove_ansi_and_keep_split_utf8_and_a_bounded_tail() {
        #[derive(Default)]
        struct Sink(parking_lot::Mutex<String>);
        impl HerdrInstallOutputSink for Sink {
            fn output(&self, text: String) {
                *self.0.lock() = text;
            }
        }
        let sink = Arc::new(Sink::default());
        let output = InstallOutput {
            bytes: parking_lot::Mutex::new(Vec::new()),
            sink: sink.clone(),
        };
        output.append(b"\x1b[32mready\x1b[0m\r\n\xe2\x9c");
        output.append(b"\x93\n");
        assert_eq!(*sink.0.lock(), "ready\n✓\n");
        output.append(&vec![b'x'; MAX_INSTALL_OUTPUT_BYTES * 2]);
        assert_eq!(sink.0.lock().len(), MAX_INSTALL_OUTPUT_BYTES);
    }
}
