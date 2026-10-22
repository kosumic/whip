//! User-confirmed Herdr installation in an ordinary SSH terminal tab.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::watch;

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
static NEXT_INSTALLATION_ID: AtomicU64 = AtomicU64::new(1);
// This exact script is returned to the confirmation UI before it can be run.
const INSTALL_COMMAND: &str = "curl -fsSL https://herdr.dev/install.sh | sh";

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrInstallationStatus {
    Installed,
    Missing,
    CustomCommandMissing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrInstallOutcome {
    Succeeded,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HerdrSetup {
    pub status: HerdrInstallationStatus,
    pub install_command: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum InstallationCompletion {
    Running,
    Exited(u32),
    Interrupted(String),
}

pub(super) struct Installation {
    terminal_id: String,
    marker: String,
    pending: bool,
    tail: Vec<u8>,
    completion: watch::Sender<InstallationCompletion>,
}

impl Installation {
    fn new(terminal_id: String) -> Self {
        let id = NEXT_INSTALLATION_ID.fetch_add(1, Ordering::Relaxed);
        Self {
            terminal_id,
            marker: format!("\x1b]777;whip-herdr-{id};"),
            pending: true,
            tail: Vec::new(),
            completion: watch::channel(InstallationCompletion::Running).0,
        }
    }

    fn command(&self) -> String {
        // The PTY displays only the reviewed command and its actual output.
        // A private OSC reports completion without parsing installer text. The
        // interactive POSIX shell survives Ctrl+C, then becomes the login shell.
        let script = self.script();
        let interactive = format!("exec /bin/sh -ic {}", shell_quote(&script));
        in_login_shell(&interactive)
    }

    fn script(&self) -> String {
        format!(
            "printf '%s\\n' {}\nwhip_status=0\ntrap 'whip_status=130' INT\n{INSTALL_COMMAND}\nwhip_result=$?\nif [ \"$whip_status\" -eq 0 ]; then whip_status=$whip_result; fi\nprintf '{}%s\\007' \"$whip_status\"\nexec \"${{SHELL:-/bin/sh}}\" -l",
            shell_quote(&format!("$ {INSTALL_COMMAND}")),
            self.marker.replace('\x1b', "\\033"),
        )
    }

    fn observe(&mut self, bytes: &[u8]) {
        if *self.completion.borrow() != InstallationCompletion::Running {
            return;
        }
        // Only retain enough bytes for a split completion OSC, never a second
        // copy of the terminal transcript.
        for &byte in bytes {
            self.tail.push(byte);
            if byte == 7 {
                if let Some(start) = self
                    .tail
                    .windows(self.marker.len())
                    .position(|part| part == self.marker.as_bytes())
                {
                    let status = &self.tail[start + self.marker.len()..self.tail.len() - 1];
                    if let Some(status) = std::str::from_utf8(status)
                        .ok()
                        .and_then(|value| value.parse().ok())
                    {
                        self.completion
                            .send_replace(InstallationCompletion::Exited(status));
                    }
                }
                self.tail.clear();
            }
            if self.tail.len() > self.marker.len() + 16 {
                self.tail.remove(0);
            }
        }
    }
}

pub(super) fn take_terminal_command(inner: &RuntimeInner, terminal_id: &str) -> Option<String> {
    let mut guard = inner.herdr_installation.lock();
    let installation = guard
        .as_mut()
        .filter(|item| item.terminal_id == terminal_id && item.pending)?;
    installation.pending = false;
    let command = installation.command();
    drop(guard);
    Some(command)
}

pub(super) fn observe_terminal_output(inner: &RuntimeInner, terminal_id: &str, bytes: &[u8]) {
    if let Some(installation) = inner
        .herdr_installation
        .lock()
        .as_mut()
        .filter(|item| item.terminal_id == terminal_id)
    {
        installation.observe(bytes);
    }
}

pub(super) fn terminal_interrupted(inner: &RuntimeInner, terminal_id: &str, reason: &str) {
    if let Some(installation) = inner
        .herdr_installation
        .lock()
        .as_mut()
        .filter(|item| item.terminal_id == terminal_id)
    {
        let running = *installation.completion.borrow() == InstallationCompletion::Running;
        if running {
            installation.pending = false;
            installation
                .completion
                .send_replace(InstallationCompletion::Interrupted(reason.to_owned()));
        }
    }
}

struct InstallationGuard(Arc<RuntimeInner>, String);

impl Drop for InstallationGuard {
    fn drop(&mut self) {
        let mut installation = self.0.herdr_installation.lock();
        if installation
            .as_ref()
            .is_some_and(|item| item.terminal_id == self.1)
        {
            installation.take();
        }
    }
}

async fn finish_installation(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
) -> Result<HerdrInstallOutcome, HostRuntimeError> {
    let mut completion = inner
        .herdr_installation
        .lock()
        .as_ref()
        .filter(|item| item.terminal_id == terminal_id)
        .map(|item| item.completion.subscribe())
        .ok_or_else(|| {
            HostRuntimeError::InvalidConfiguration(
                "Herdr installation terminal is unavailable".to_owned(),
            )
        })?;
    let _guard = InstallationGuard(inner.clone(), terminal_id);
    let generation = current_generation(&inner)?;
    let mut cancellation = inner.cancellation.subscribe();
    let result = loop {
        let result = completion.borrow_and_update().clone();
        if result != InstallationCompletion::Running {
            break result;
        }
        tokio::select! {
            result = completion.changed() => {
                result.map_err(|_| HostRuntimeError::TerminalUnavailable("Installation terminal closed".to_owned()))?;
            }
            _ = cancellation.changed() => {
                return Err(HostRuntimeError::TerminalUnavailable("SSH disconnected during installation. Review the terminal before trying again.".to_owned()));
            }
        }
    };
    validate_generation(&inner, generation)?;
    match result {
        InstallationCompletion::Exited(130) => return Ok(HerdrInstallOutcome::Cancelled),
        InstallationCompletion::Exited(0) => {}
        InstallationCompletion::Exited(status) => {
            return Err(HostRuntimeError::HerdrUnavailable(format!(
                "Installer exited with status {status}. Review its output in the terminal."
            )));
        }
        InstallationCompletion::Interrupted(reason) => {
            return Err(HostRuntimeError::TerminalUnavailable(reason));
        }
        InstallationCompletion::Running => unreachable!(),
    }
    // A POSIX pipeline can return zero when curl fails. Verify the binary before
    // startup, and never retry the installer on transport or startup failure.
    if check_installation(&inner, generation).await? != HerdrInstallationStatus::Installed {
        return Err(HostRuntimeError::HerdrUnavailable(
            "Herdr was not found after installation. Review the terminal output.".to_owned(),
        ));
    }
    start_herdr_server_inner(inner).await?;
    Ok(HerdrInstallOutcome::Succeeded)
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
    in_login_shell(&command)
}

fn in_login_shell(command: &str) -> String {
    let bootstrap = r#"exec "${SHELL:-/bin/sh}" -lc "$1""#;
    format!(
        "exec /bin/sh -c {} whip {}",
        shell_quote(bootstrap),
        shell_quote(command)
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
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
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

#[uniffi::export]
impl HostRuntime {
    /// Queue the command before publishing its new terminal tab to React.
    pub fn prepare_herdr_installation(&self, terminal_id: String) -> Result<(), HostRuntimeError> {
        current_generation(&self.inner)?;
        let mut installation = self.inner.herdr_installation.lock();
        if installation.is_some() {
            return Err(HostRuntimeError::InvalidConfiguration(
                "Herdr installation is already in progress on this host".to_owned(),
            ));
        }
        *installation = Some(Installation::new(terminal_id));
        drop(installation);
        Ok(())
    }

    pub async fn install_herdr(
        &self,
        terminal_id: String,
    ) -> Result<HerdrInstallOutcome, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(finish_installation(inner, terminal_id))
            .await
            .map_err(|error| HostRuntimeError::SshTransportFailure(error.to_string()))?
    }

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
    fn terminal_command_is_scoped_to_its_host_and_consumed_once() {
        let inner = super::super::tests::connected_runtime_inner("install-terminal");
        let other = super::super::tests::connected_runtime_inner("other-terminal");
        let runtime = HostRuntime {
            inner: inner.clone(),
        };
        runtime
            .prepare_herdr_installation("install-tab".to_owned())
            .unwrap();
        assert!(
            runtime
                .prepare_herdr_installation("duplicate-tab".to_owned())
                .is_err()
        );
        assert!(take_terminal_command(&other, "install-tab").is_none());
        assert!(take_terminal_command(&inner, "unrelated-tab").is_none());
        assert!(take_terminal_command(&inner, "install-tab").is_some());
        // Renderer reattachment and transport recovery open a plain shell.
        assert!(take_terminal_command(&inner, "install-tab").is_none());
        terminal_interrupted(&inner, "unrelated-tab", "closed");
        assert_eq!(
            *inner
                .herdr_installation
                .lock()
                .as_ref()
                .unwrap()
                .completion
                .borrow(),
            InstallationCompletion::Running
        );
        terminal_interrupted(&inner, "install-tab", "SSH disconnected");
        assert_eq!(
            *inner
                .herdr_installation
                .lock()
                .as_ref()
                .unwrap()
                .completion
                .borrow(),
            InstallationCompletion::Interrupted("SSH disconnected".to_owned())
        );
    }

    #[test]
    fn completion_uses_a_split_safe_marker_instead_of_installer_output() {
        let mut installation = Installation::new("install-tab".to_owned());
        installation.observe(&vec![b'x'; 100_000]);
        installation.observe(b"Installed successfully\nHerdr is ready\n");
        assert_eq!(
            *installation.completion.borrow(),
            InstallationCompletion::Running
        );
        let marker = format!("{}130\x07", installation.marker);
        for byte in marker.bytes() {
            installation.observe(&[byte]);
        }
        assert_eq!(
            *installation.completion.borrow(),
            InstallationCompletion::Exited(130)
        );
        assert!(installation.tail.len() <= installation.marker.len() + 16);
    }

    #[test]
    fn cancelled_and_closed_terminals_settle_and_release_only_their_host_installation() {
        crate::runtime().unwrap().block_on(async {
            let inner = super::super::tests::connected_runtime_inner("finished-install");
            let other = super::super::tests::connected_runtime_inner("ongoing-install");
            let runtime = HostRuntime {
                inner: inner.clone(),
            };
            let other_runtime = HostRuntime {
                inner: other.clone(),
            };
            runtime
                .prepare_herdr_installation("cancel-tab".to_owned())
                .unwrap();
            other_runtime
                .prepare_herdr_installation("other-tab".to_owned())
                .unwrap();
            let marker = inner
                .herdr_installation
                .lock()
                .as_ref()
                .unwrap()
                .marker
                .clone();
            observe_terminal_output(&inner, "cancel-tab", format!("{marker}130\x07").as_bytes());
            assert_eq!(
                runtime
                    .install_herdr("cancel-tab".to_owned())
                    .await
                    .unwrap(),
                HerdrInstallOutcome::Cancelled
            );
            assert!(inner.herdr_installation.lock().is_none());
            assert!(other.herdr_installation.lock().is_some());
            runtime
                .prepare_herdr_installation("closed-tab".to_owned())
                .unwrap();
            runtime.close_ssh_shell("closed-tab".to_owned());
            assert!(
                runtime
                    .install_herdr("closed-tab".to_owned())
                    .await
                    .is_err()
            );
            assert!(inner.herdr_installation.lock().is_none());
        });
    }

    #[test]
    fn terminal_bootstrap_displays_reviewed_command_and_keeps_a_shell_after_completion() {
        let fixture = tempfile::tempdir().unwrap();
        executable(
            &fixture.path().join("curl"),
            "#!/bin/sh\nprintf 'printf \"installer output\\\\n\"\\n'\n",
        );
        let shell = fixture.path().join("login-shell");
        executable(&shell, "#!/bin/sh\nprintf 'login shell ready\\n'\n");
        let mut installation = Installation::new("install-tab".to_owned());
        let output = Command::new("/bin/sh")
            .args(["-ic", &installation.script()])
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    fixture.path().display(),
                    std::env::var("PATH").unwrap()
                ),
            )
            .env("SHELL", shell)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            format!(
                "$ {INSTALL_COMMAND}\ninstaller output\n{}0\x07login shell ready\n",
                installation.marker
            )
        );
        installation.observe(&output.stdout);
        assert_eq!(
            *installation.completion.borrow(),
            InstallationCompletion::Exited(0)
        );
    }

    #[test]
    fn interrupting_the_installer_reports_cancellation_and_returns_to_a_shell() {
        use std::io::{BufRead, BufReader, Read};
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;

        let fixture = tempfile::tempdir().unwrap();
        executable(
            &fixture.path().join("curl"),
            "#!/bin/sh\nprintf 'echo installer-started; sleep 2\\n'\n",
        );
        let shell = fixture.path().join("login-shell");
        executable(&shell, "#!/bin/sh\nprintf 'login shell ready\\n'\n");
        let mut installation = Installation::new("install-tab".to_owned());
        let mut child = Command::new("/bin/sh")
            .args(["-ic", &installation.script()])
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    fixture.path().display(),
                    std::env::var("PATH").unwrap()
                ),
            )
            .env("SHELL", shell)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut output = String::new();
        while !output.contains("installer-started\n") {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            output.push_str(&line);
        }
        assert!(
            Command::new("/bin/sh")
                .args([
                    "-c",
                    "kill -INT \"$1\"",
                    "whip-test",
                    &format!("-{}", child.id())
                ])
                .status()
                .unwrap()
                .success()
        );
        reader.read_to_string(&mut output).unwrap();
        assert!(child.wait().unwrap().success());
        assert!(output.ends_with("login shell ready\n"));
        installation.observe(output.as_bytes());
        assert_eq!(
            *installation.completion.borrow(),
            InstallationCompletion::Exited(130)
        );
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
}
