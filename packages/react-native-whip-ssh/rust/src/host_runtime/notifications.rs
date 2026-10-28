//! Optional host plugin operations use the existing authenticated transport.
use super::{HostConnectionState, HostRuntime, HostRuntimeError, current_ssh, event_sink};
use crate::{
    herdr_connection::HerdrRequestReplay, host_state::HostFreshness, remote_ops::shell_quote,
};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const PLUGIN: &str = "dev.whip.notify";
const PLUGIN_SOURCE: &str = "kosumic/whip/whip-notify";
const INSTALL_TIMEOUT: Duration = Duration::from_mins(3);
const RELEASE_PLATFORM_SCRIPT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../whip-notify/platform.sh"
));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum InstallationStage {
    CheckingHost,
    CheckingRelease,
    Downloading,
    Enabling,
    Verifying,
    Complete,
}

#[derive(Debug)]
pub(super) struct PluginInstallation {
    stage: InstallationStage,
    completed_stages: Vec<InstallationStage>,
    started: Instant,
    finished: Option<Duration>,
    error: Option<String>,
}

impl PluginInstallation {
    fn new() -> Self {
        Self {
            stage: InstallationStage::CheckingHost,
            completed_stages: Vec::new(),
            started: Instant::now(),
            finished: None,
            error: None,
        }
    }

    fn snapshot(&self) -> Value {
        json!({
            "stage": self.stage,
            "completed_stages": self.completed_stages,
            "elapsed_ms": self.finished.unwrap_or_else(|| self.started.elapsed()).as_millis(),
            "timeout_ms": INSTALL_TIMEOUT.as_millis(),
            "running": self.finished.is_none(),
            "error": self.error,
        })
    }

    fn advance(&mut self, stage: InstallationStage) {
        if self.stage != stage {
            self.completed_stages.push(self.stage);
            self.stage = stage;
        }
    }

    fn finish(&mut self, error: Option<String>) {
        self.finished = Some(self.started.elapsed());
        self.error = error;
        if self.error.is_none() {
            self.advance(InstallationStage::Complete);
        }
    }
}

fn plugin_status(listed: &Value) -> Result<Value, HostRuntimeError> {
    let plugins = listed["plugins"].as_array().ok_or_else(failure)?;
    let plugin = plugins.iter().find(|p| p["plugin_id"] == PLUGIN);
    let version = plugin.and_then(|p| p["version"].as_str());
    let available = Version::parse(whip_notify::PACKAGE_VERSION).map_err(|_| failure())?;
    let update_available = version
        .and_then(|installed| Version::parse(installed).ok())
        .is_some_and(|installed| available.cmp_precedence(&installed).is_gt());
    Ok(json!({
        "installed": plugin.is_some(),
        "enabled": plugin.is_some_and(|p| p["enabled"] == true),
        "version": version,
        "update_available": update_available,
    }))
}

fn installation_arguments(session: &str) -> String {
    let session = if session.trim().is_empty() {
        String::new()
    } else {
        format!(" --session {}", shell_quote(session.trim()))
    };
    format!(
        "{} plugin install --yes --ref {} {}",
        session,
        shell_quote(&format!(
            "whip-notify-install-v{}",
            whip_notify::PACKAGE_VERSION
        )),
        shell_quote(PLUGIN_SOURCE),
    )
}

fn installation_command(herdr_command: &str, session: &str) -> String {
    let herdr_command = herdr_command.trim();
    let executable = if herdr_command.is_empty() {
        super::herdr_setup::DEFAULT_HERDR_COMMAND
    } else {
        herdr_command
    };
    format!(
        "{}{}",
        shell_quote(executable),
        installation_arguments(session),
    )
}

fn installation_preflight_script() -> String {
    format!(
        r#"set -eu
{RELEASE_PLATFORM_SCRIPT}
notify_target=$(notify_release_target)
command -v git >/dev/null 2>&1 || {{ echo 'Install Git on this host first' >&2; exit 1; }}
command -v curl >/dev/null 2>&1 || {{ echo 'Install curl on this host first' >&2; exit 1; }}
notify_url="https://github.com/kosumic/whip/releases/download/whip-notify-v{version}/whip-notify-$notify_target.sha256"
if ! curl -q --fail --location --silent --show-error --head --proto '=https' --proto-redir '=https' --connect-timeout 5 --max-time 15 --output /dev/null "$notify_url"; then
  printf 'Whip notification plugin {version} for %s is unavailable. Check host network access and GitHub release availability.\n' "$notify_target" >&2
  exit 1
fi"#,
        version = whip_notify::PACKAGE_VERSION,
    )
}

fn installation_script(herdr_command: &str, session: &str) -> String {
    format!(
        "{}\nexec \"$whip_herdr\"{}",
        super::herdr_setup::resolve_executable_script(herdr_command),
        installation_arguments(session),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mock_download_tools(
        root: &std::path::Path,
    ) -> Result<std::ffi::OsString, Box<dyn std::error::Error>> {
        let bin = root.join("bin");
        std::fs::create_dir(&bin)?;
        for (name, script) in [
            (
                "uname",
                "#!/bin/sh\ncase $1 in -s) echo Linux;; -m) echo \"${WHIP_TEST_ARCH:-aarch64}\";; esac\n",
            ),
            (
                "curl",
                "#!/bin/sh\nexit \"${WHIP_TEST_DOWNLOAD_EXIT:-0}\"\n",
            ),
        ] {
            let path = bin.join(name);
            std::fs::write(&path, script)?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        }
        let original_path = std::env::var_os("PATH").ok_or("Missing test PATH")?;
        Ok(std::env::join_paths(
            std::iter::once(bin).chain(std::env::split_paths(&original_path)),
        )?)
    }

    #[test]
    fn installation_targets_only_the_selected_host_session_and_quotes_arguments() {
        let root = tempfile::tempdir().unwrap();
        let path = mock_download_tools(root.path()).unwrap();
        let executable = root.path().join("herdr ' custom");
        let output = root.path().join("args");
        std::fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$WHIP_TEST_ARGS\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let release = format!("whip-notify-install-v{}", whip_notify::PACKAGE_VERSION);
        for session in ["agents'$(touch unexpected)", ""] {
            let mut expected = Vec::new();
            if !session.is_empty() {
                expected.extend(["--session", session]);
            }
            expected.extend([
                "plugin",
                "install",
                "--yes",
                "--ref",
                &release,
                PLUGIN_SOURCE,
            ]);
            for command in [
                installation_script(executable.to_str().unwrap(), session),
                installation_command(executable.to_str().unwrap(), session),
            ] {
                let result = std::process::Command::new("/bin/sh")
                    .arg("-c")
                    .arg(command)
                    .env("PATH", &path)
                    .env("WHIP_TEST_ARGS", &output)
                    .current_dir(root.path())
                    .status()
                    .unwrap();
                assert!(result.success());
                assert_eq!(
                    std::fs::read_to_string(&output)
                        .unwrap()
                        .lines()
                        .collect::<Vec<_>>(),
                    expected
                );
                assert!(!root.path().join("unexpected").exists());
            }
        }
    }

    #[test]
    fn unsupported_hosts_and_missing_releases_fail_before_starting_herdr() {
        for (arch, download_exit, message) in [
            (
                "i686",
                "0",
                "No prebuilt Whip notification plugin for Linux/i686",
            ),
            (
                "x86_64",
                "22",
                "for x86_64-unknown-linux-musl is unavailable",
            ),
        ] {
            let root = tempfile::tempdir().unwrap();
            let path = mock_download_tools(root.path()).unwrap();
            let executable = root.path().join("herdr");
            let called = root.path().join("called");
            std::fs::write(&executable, "#!/bin/sh\ntouch \"$WHIP_TEST_CALLED\"\n").unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            let output = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(format!(
                    "{}\n{}",
                    installation_preflight_script(),
                    installation_script(executable.to_str().unwrap(), "default")
                ))
                .env("PATH", &path)
                .env("WHIP_TEST_ARCH", arch)
                .env("WHIP_TEST_DOWNLOAD_EXIT", download_exit)
                .env("WHIP_TEST_CALLED", &called)
                .output()
                .unwrap();
            assert!(!output.status.success());
            assert!(String::from_utf8_lossy(&output.stderr).contains(message));
            assert!(!called.exists());
        }
    }

    #[test]
    fn installation_status_rejects_unsupported_api_and_distinguishes_disabled_plugins() {
        assert!(plugin_status(&json!({})).is_err());
        assert_eq!(
            plugin_status(&json!({"plugins":[]})).unwrap()["installed"],
            false
        );
        let status = plugin_status(&json!({"plugins":[
            {"plugin_id":"another.plugin","enabled":true},
            {"plugin_id":PLUGIN,"enabled":false,"version":"0.1.0"}
        ]}))
        .unwrap();
        assert_eq!(
            status,
            json!({"installed":true,"enabled":false,"version":"0.1.0","update_available":true})
        );
    }

    #[test]
    fn progress_records_real_steps_and_freezes_on_failure() {
        let mut progress = PluginInstallation::new();
        progress.advance(InstallationStage::CheckingRelease);
        progress.advance(InstallationStage::Downloading);
        progress.finish(Some("Download failed".into()));
        let snapshot = progress.snapshot();
        assert_eq!(snapshot["stage"], "downloading");
        assert_eq!(
            snapshot["completed_stages"],
            json!(["checking-host", "checking-release"])
        );
        assert_eq!(snapshot["running"], false);
        assert_eq!(snapshot["error"], "Download failed");
        assert_eq!(snapshot["timeout_ms"], json!(INSTALL_TIMEOUT.as_millis()));
        assert_eq!(snapshot["elapsed_ms"], progress.snapshot()["elapsed_ms"]);
    }

    #[test]
    fn enabling_an_existing_plugin_does_not_report_a_download() {
        let mut progress = PluginInstallation::new();
        progress.advance(InstallationStage::Enabling);
        progress.advance(InstallationStage::Verifying);
        progress.finish(None);
        assert_eq!(progress.snapshot()["stage"], "complete");
        assert_eq!(
            progress.snapshot()["completed_stages"],
            json!(["checking-host", "enabling", "verifying"])
        );
    }

    #[tokio::test]
    async fn a_failed_install_finishes_progress_without_affecting_another_host() {
        let runtime = HostRuntime {
            inner: super::super::tests::connected_runtime_inner("notify-progress-failed"),
        };
        let other = super::super::tests::connected_runtime_inner("notify-progress-other");
        assert!(runtime.notify_install().await.is_err());
        let snapshot = runtime
            .inner
            .state
            .lock()
            .notification_install
            .as_ref()
            .unwrap()
            .snapshot();
        assert_eq!(snapshot["stage"], "checking-host");
        assert_eq!(snapshot["running"], false);
        assert!(snapshot["error"].is_string());
        assert!(other.state.lock().notification_install.is_none());
    }

    #[test]
    fn upgrades_only_older_versions_and_ignores_build_metadata() {
        let current = whip_notify::PACKAGE_VERSION;
        for (version, expected) in [
            (Some("0.0.0".to_string()), true),
            (Some(current.to_string()), false),
            (Some(format!("{current}+host-build")), false),
            (Some(format!("{current}-rc.1")), true),
            (Some("99.0.0".to_string()), false),
            (Some("unknown".to_string()), false),
            (None, false),
        ] {
            let listed = json!({"plugins":[{"plugin_id":PLUGIN,"enabled":true,"version":version}]});
            assert_eq!(
                plugin_status(&listed).unwrap()["update_available"],
                expected,
                "installed version {version:?}"
            );
        }
        assert_eq!(
            plugin_status(&json!({"plugins":[]})).unwrap()["update_available"],
            false
        );
    }
}
#[derive(Deserialize)]
struct Paths {
    config: String,
    state: String,
    binary: String,
}
fn failure() -> HostRuntimeError {
    HostRuntimeError::InvalidConfiguration("Whip notification plugin unavailable; install and enable whip-notify for this Herdr session (Herdr >= 0.9.5)".into())
}

fn check_installation_output(output: &crate::ssh::CommandOutput) -> Result<(), HostRuntimeError> {
    if output.exit_status == Some(0) {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    Err(HostRuntimeError::InvalidConfiguration(format!(
        "Plugin installation failed: {}",
        detail
            .chars()
            .rev()
            .take(4096)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    )))
}

impl HostRuntime {
    async fn notify_plugin_status(&self) -> Result<Value, HostRuntimeError> {
        let mut status = plugin_status(
            &self
                .notify_rpc("plugin.list", json!({"plugin_id":PLUGIN}))
                .await?,
        )?;
        status["install_command"] = json!(installation_command(
            &self.inner.config.herdr_command,
            &self.inner.config.session_name,
        ));
        Ok(status)
    }

    async fn notify_install(&self) -> Result<String, HostRuntimeError> {
        {
            let mut state = self.inner.state.lock();
            if state
                .notification_install
                .as_ref()
                .is_some_and(|progress| progress.finished.is_none())
            {
                return Err(HostRuntimeError::InvalidConfiguration(
                    "A notification plugin installation is already running on this host".into(),
                ));
            }
            state.notification_install = Some(PluginInstallation::new());
        }
        let result = tokio::time::timeout(INSTALL_TIMEOUT, self.notify_install_inner())
            .await
            .unwrap_or_else(|_| Err(HostRuntimeError::InvalidConfiguration(format!(
                "Plugin installation timed out after {} minutes. Check this host's network access and installation status before retrying.",
                INSTALL_TIMEOUT.as_secs() / 60,
            ))));
        if let Some(progress) = self.inner.state.lock().notification_install.as_mut() {
            progress.finish(result.as_ref().err().map(ToString::to_string));
        }
        result
    }

    fn notify_install_stage(&self, stage: InstallationStage) {
        if let Some(progress) = self.inner.state.lock().notification_install.as_mut() {
            progress.advance(stage);
        }
    }

    async fn notify_install_inner(&self) -> Result<String, HostRuntimeError> {
        let status = self.notify_plugin_status().await?;
        if status["installed"] != true || status["update_available"] == true {
            let ssh = current_ssh(&self.inner)?;
            self.notify_install_stage(InstallationStage::CheckingRelease);
            let preflight =
                super::herdr_setup::login_shell_command(&installation_preflight_script());
            let output = ssh.execute(&preflight).await.map_err(|_| failure())?;
            check_installation_output(&output)?;
            self.notify_install_stage(InstallationStage::Downloading);
            let command = super::herdr_setup::login_shell_command(&installation_script(
                &self.inner.config.herdr_command,
                &self.inner.config.session_name,
            ));
            // Installation downloads a pinned release; hook execution stays
            // bounded to four seconds. Never retry a mutating install automatically.
            let output = ssh.execute(&command).await.map_err(|_| failure())?;
            check_installation_output(&output)?;
        }
        self.notify_install_stage(InstallationStage::Enabling);
        self.notify_rpc("plugin.enable", json!({"plugin_id":PLUGIN}))
            .await?;
        self.notify_install_stage(InstallationStage::Verifying);
        let status = self.notify_plugin_status().await?;
        if status["installed"] != true || status["enabled"] != true {
            return Err(failure());
        }
        Ok(status.to_string())
    }

    async fn notify_rpc(&self, method: &str, params: Value) -> Result<Value, HostRuntimeError> {
        let mut bytes =
            serde_json::to_vec(&json!({"id":"whip-notify", "method":method, "params":params}))
                .map_err(|_| failure())?;
        bytes.push(b'\n');
        let response = self
            .inner
            .herdr
            .request(&bytes, b'\n', 2000, 65536, HerdrRequestReplay::Never)
            .await
            .map_err(|_| failure())?;
        let response: Value = serde_json::from_slice(&response).map_err(|_| failure())?;
        response.get("result").cloned().ok_or_else(failure)
    }
    async fn notify_exec(
        &self,
        paths: &Paths,
        args: &[String],
        input: Option<&[u8]>,
    ) -> Result<String, HostRuntimeError> {
        if [&paths.binary, &paths.config, &paths.state]
            .iter()
            .any(|p| !p.starts_with('/') || p.len() > 4096 || p.contains('\0'))
        {
            return Err(failure());
        }
        let command = [&paths.binary, "--dirs", &paths.config, &paths.state]
            .into_iter()
            .map(shell_quote)
            .chain(args.iter().map(String::as_str).map(shell_quote))
            .collect::<Vec<_>>()
            .join(" ");
        let ssh = current_ssh(&self.inner)?;
        let output = tokio::time::timeout(Duration::from_secs(3), async {
            match input {
                Some(bytes) => ssh.execute_with_input(&command, bytes).await,
                None => ssh.execute(&command).await,
            }
        })
        .await
        .map_err(|_| failure())?
        .map_err(|_| failure())?;
        if output.exit_status != Some(0) || output.stdout_truncated {
            return Err(failure());
        }
        String::from_utf8(output.stdout).map_err(|_| failure())
    }
}

impl HostRuntime {
    async fn notification_command_inner(
        &self,
        operation: String,
        payload: String,
    ) -> Result<String, HostRuntimeError> {
        if payload.len() > 16384 {
            return Err(failure());
        }
        match operation.as_str() {
            "plugin-install-progress" => {
                return Ok(self
                    .inner
                    .state
                    .lock()
                    .notification_install
                    .as_ref()
                    .map_or(Value::Null, PluginInstallation::snapshot)
                    .to_string());
            }
            "plugin-status" => return Ok(self.notify_plugin_status().await?.to_string()),
            "plugin-install" => return self.notify_install().await,
            "plugin-uninstall" => {
                // Herdr unregisters globally for this SSH user. Its managed
                // checkout cleanup protects in-flight hooks; config is retained.
                self.notify_rpc("plugin.unlink", json!({"plugin_id":PLUGIN}))
                    .await?;
                let status = self.notify_plugin_status().await?;
                if status["installed"] == true {
                    return Err(failure());
                }
                return Ok(status.to_string());
            }
            _ => {}
        }
        if operation == "discover" {
            let listed = self
                .notify_rpc("plugin.list", json!({"plugin_id":PLUGIN}))
                .await?;
            if !listed
                .get("plugins")
                .and_then(Value::as_array)
                .is_some_and(|list| {
                    list.iter()
                        .any(|p| p["plugin_id"] == PLUGIN && p["enabled"] == true)
                })
            {
                return Err(failure());
            }
            let invoked = self
                .notify_rpc(
                    "plugin.action.invoke",
                    json!({"plugin_id":PLUGIN,"action_id":"paths"}),
                )
                .await?;
            let id = invoked["log"]["log_id"]
                .as_str()
                .ok_or_else(failure)?
                .to_owned();
            for _ in 0..20 {
                let result = self
                    .notify_rpc("plugin.log.list", json!({"plugin_id":PLUGIN,"limit":20}))
                    .await?;
                if let Some(log) = result["logs"].as_array().and_then(|logs| {
                    logs.iter()
                        .find(|log| log["log_id"] == id && log["exit_code"] == 0)
                }) {
                    let paths_value: Value =
                        serde_json::from_str(log["stdout"].as_str().ok_or_else(failure)?)
                            .map_err(|_| failure())?;
                    if paths_value["protocol"] != 1 {
                        return Err(failure());
                    }
                    let paths: Paths =
                        serde_json::from_value(paths_value.clone()).map_err(|_| failure())?;
                    let identity: Value = serde_json::from_str(
                        &self.notify_exec(&paths, &["identity".into()], None).await?,
                    )
                    .map_err(|_| failure())?;
                    return Ok(json!({"paths":paths_value,"identity":identity,"session":self.inner.herdr.resolved_socket_path()}).to_string());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            return Err(failure());
        }
        let input: Value = serde_json::from_str(&payload).map_err(|_| failure())?;
        let paths: Paths = serde_json::from_value(input["paths"].clone()).map_err(|_| failure())?;
        let args = match operation.as_str() {
            "register" => vec!["register".into()],
            "unregister" => vec![
                "unregister".into(),
                input["device_id"].as_str().ok_or_else(failure)?.to_owned(),
            ],
            "renew" => {
                // A JS pulse proves the callback can run now. Android service health
                // alone cannot reach this method; iOS callers pulse only in foreground.
                let active = self.inner.monitoring.lock().health_enabled();
                let healthy = {
                    let state = self.inner.state.lock();
                    active
                        && state.connection == HostConnectionState::Connected
                        && !state.explicit_disconnect
                        && state.event.as_ref().is_some_and(|e| !e.retry_running)
                        && state.host_state.projection().freshness == HostFreshness::Fresh
                };
                if !healthy || event_sink().read().is_none() {
                    return Err(failure());
                }
                let id = input["device_id"].as_str().ok_or_else(failure)?;
                if !whip_notify::valid_id(id) {
                    return Err(failure());
                }
                vec!["lease".into(), "renew".into(), id.into()]
            }
            _ => return Err(failure()),
        };
        let registration = if operation == "register" {
            Some(serde_json::to_vec(&input["registration"]).map_err(|_| failure())?)
        } else {
            None
        };
        self.notify_exec(&paths, &args, registration.as_deref())
            .await
    }
}

#[uniffi::export]
impl HostRuntime {
    pub async fn notification_command(
        &self,
        operation: String,
        payload: String,
    ) -> Result<String, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                HostRuntime { inner }
                    .notification_command_inner(operation, payload)
                    .await
            })
            .await
            .map_err(|_| failure())?
    }
}
