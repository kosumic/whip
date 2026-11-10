//! Core push lifecycle over authenticated SSH, independent of legacy plugin RPCs.
use super::{
    HostRuntime, HostRuntimeError, InstallationStage, Paths, check_installation_output,
    current_ssh, failure, installation_preflight_script,
};
use crate::remote_ops::shell_quote;
use semver::Version;
use serde_json::{Value, json};
use std::time::Duration;

const INSTALL_SCRIPT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../whip-notify/install-core.sh"
));
const ROOT_SCRIPT: &str = r#"set -eu
case "${XDG_DATA_HOME:-}" in /*) notify_data=$XDG_DATA_HOME ;; *) notify_data="$HOME/.local/share" ;; esac
notify_root="$notify_data/whip-notify/core"
notify_binary="$notify_root/whip-notify"
"#;

fn invocation(socket: &str, action: &str) -> String {
    format!(
        "\"$notify_binary\" core --socket {} {}",
        shell_quote(socket),
        shell_quote(action)
    )
}
fn command_script(socket: &str, action: &str) -> String {
    let absent = if matches!(action, "status" | "uninstall") {
        "printf '%s\\n' '{\"installed\":false,\"enabled\":false,\"version\":null}'; exit 0"
    } else {
        "echo 'Install Core push notifications on this host first' >&2; exit 1"
    };
    format!(
        "{ROOT_SCRIPT}\nif [ ! -x \"$notify_binary\" ]; then {absent}; fi\nexec {}",
        invocation(socket, action)
    )
}
fn download_script(socket: &str) -> String {
    format!(
        "WHIP_NOTIFY_CORE_SOCKET={} sh -c {}",
        shell_quote(socket),
        shell_quote(INSTALL_SCRIPT)
    )
}

impl HostRuntime {
    pub(super) async fn notify_uses_core(&self) -> Result<bool, HostRuntimeError> {
        self.inner
            .herdr
            .backend()
            .await
            .map(|backend| backend == crate::HostHerdrBackend::Core)
            .map_err(|error| HostRuntimeError::InvalidConfiguration(error.to_string()))
    }
    fn notify_core_socket(&self) -> Result<String, HostRuntimeError> {
        self.inner
            .herdr
            .resolved_socket_path()
            .filter(|socket| socket.starts_with('/') && !socket.chars().any(char::is_control))
            .ok_or_else(|| {
                HostRuntimeError::InvalidConfiguration(
                    "Reconnect to this Core host to discover its notification endpoint".into(),
                )
            })
    }
    pub(super) async fn notify_core_run(&self, action: &str) -> Result<Value, HostRuntimeError> {
        self.notify_core_script(
            &command_script(&self.notify_core_socket()?, action),
            Duration::from_secs(25),
        )
        .await
    }
    async fn notify_core_script(
        &self,
        script: &str,
        timeout: Duration,
    ) -> Result<Value, HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        let command = super::super::herdr_setup::login_shell_command(script);
        let output = tokio::time::timeout(timeout, ssh.execute(&command))
            .await
            .map_err(|_| {
                HostRuntimeError::InvalidConfiguration("Core push operation timed out".into())
            })?
            .map_err(|error| HostRuntimeError::SshTransportFailure(error.to_string()))?;
        check_installation_output(&output)?;
        if output.stdout_truncated {
            return Err(failure());
        }
        serde_json::from_slice(&output.stdout).map_err(|_| failure())
    }
    pub(super) async fn notify_core_status(&self) -> Result<Value, HostRuntimeError> {
        let mut status = self.notify_core_run("status").await?;
        if !status.is_object()
            || status["installed"].as_bool().is_none()
            || status["enabled"].as_bool().is_none()
        {
            return Err(failure());
        }
        let available = Version::parse(whip_notify::PACKAGE_VERSION).map_err(|_| failure())?;
        status["update_available"] = json!(
            status["version"]
                .as_str()
                .and_then(|v| Version::parse(v).ok())
                .is_some_and(|installed| available.cmp_precedence(&installed).is_gt())
        );
        status["install_command"] = json!(format!(
            "curl -qfsSL --proto '=https' --proto-redir '=https' https://raw.githubusercontent.com/kosumic/whip/whip-notify-install-v{}/whip-notify/install-core.sh | sh -s -- --socket {}",
            whip_notify::PACKAGE_VERSION,
            shell_quote(&self.notify_core_socket()?)
        ));
        Ok(status)
    }
    pub(super) async fn notify_core_install(&self) -> Result<String, HostRuntimeError> {
        let status = self.notify_core_status().await?;
        if status["installed"] != true || status["update_available"] == true {
            self.notify_install_stage(InstallationStage::CheckingRelease);
            let ssh = current_ssh(&self.inner)?;
            let output = ssh
                .execute(&super::super::herdr_setup::login_shell_command(
                    &installation_preflight_script(false),
                ))
                .await
                .map_err(|_| failure())?;
            check_installation_output(&output)?;
            self.notify_install_stage(InstallationStage::Downloading);
            self.notify_core_script(
                &download_script(&self.notify_core_socket()?),
                Duration::from_secs(150),
            )
            .await?;
        }
        self.notify_install_stage(InstallationStage::Enabling);
        self.notify_core_run("enable").await?;
        self.notify_install_stage(InstallationStage::Verifying);
        let status = self.notify_core_status().await?;
        if status["installed"] != true || status["enabled"] != true {
            return Err(failure());
        }
        Ok(status.to_string())
    }
    pub(super) async fn notify_core_set_enabled(
        &self,
        enabled: bool,
    ) -> Result<String, HostRuntimeError> {
        self.notify_core_run(if enabled { "enable" } else { "disable" })
            .await?;
        let status = self.notify_core_status().await?;
        if status["installed"] != true || status["enabled"].as_bool() != Some(enabled) {
            return Err(failure());
        }
        Ok(status.to_string())
    }
    pub(super) async fn notify_core_discover(&self) -> Result<String, HostRuntimeError> {
        if self.notify_core_status().await?["enabled"] != true {
            return Err(failure());
        }
        let paths_value = self.notify_core_run("paths").await?;
        if paths_value["protocol"] != 1 {
            return Err(failure());
        }
        let paths: Paths = serde_json::from_value(paths_value.clone()).map_err(|_| failure())?;
        let identity: Value =
            serde_json::from_str(&self.notify_exec(&paths, &["identity".into()], None).await?)
                .map_err(|_| failure())?;
        Ok(
            json!({"paths":paths_value,"identity":identity,"session":self.notify_core_socket()?})
                .to_string(),
        )
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, process::Command};

    #[test]
    fn core_operations_use_the_selected_endpoint_without_legacy_plugin_commands() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data ' custom");
        let socket = "/tmp/core ' $(touch unexpected).sock";
        let run = |action| {
            Command::new("/bin/sh")
                .args(["-c", &command_script(socket, action)])
                .env("HOME", root.path())
                .env("XDG_DATA_HOME", &data)
                .env("WHIP_TEST_ARGS", root.path().join("args"))
                .current_dir(root.path())
                .output()
                .unwrap()
        };
        let missing = run("status");
        assert!(missing.status.success());
        assert_eq!(
            serde_json::from_slice::<Value>(&missing.stdout).unwrap()["installed"],
            false
        );
        let directory = data.join("whip-notify/core");
        std::fs::create_dir_all(&directory).unwrap();
        let binary = directory.join("whip-notify");
        std::fs::write(&binary,"#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$WHIP_TEST_ARGS\"\nprintf '%s\\n' '{\"installed\":true,\"enabled\":true}'\n").unwrap();
        std::fs::set_permissions(binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        for action in ["status", "enable", "disable", "paths", "uninstall"] {
            assert!(run(action).status.success());
            assert_eq!(
                std::fs::read_to_string(root.path().join("args")).unwrap(),
                format!("core\n--socket\n{socket}\n{action}\n")
            );
        }
        assert!(!root.path().join("unexpected").exists());
    }
}
