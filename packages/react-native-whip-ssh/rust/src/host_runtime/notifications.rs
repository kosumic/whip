//! Optional host plugin operations use the existing authenticated transport.
use super::{HostConnectionState, HostRuntime, HostRuntimeError, current_ssh, event_sink};
use crate::{
    herdr_connection::HerdrRequestReplay, host_state::HostFreshness, remote_ops::shell_quote,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

const PLUGIN: &str = "dev.whip.notify";
const PLUGIN_SOURCE: &str = "kosumic/whip/whip-notify";
const INSTALL_TIMEOUT: Duration = Duration::from_mins(5);

fn plugin_status(listed: &Value) -> Result<Value, HostRuntimeError> {
    let plugins = listed["plugins"].as_array().ok_or_else(failure)?;
    let plugin = plugins.iter().find(|p| p["plugin_id"] == PLUGIN);
    Ok(json!({
        "installed": plugin.is_some(),
        "enabled": plugin.is_some_and(|p| p["enabled"] == true),
        "version": plugin.and_then(|p| p["version"].as_str()),
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
        shell_quote(&format!("whip-notify-v{}", whip_notify::PACKAGE_VERSION)),
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

fn installation_script(herdr_command: &str, session: &str) -> String {
    format!(
        "{}\ncommand -v git >/dev/null 2>&1 || {{ echo 'Install Git on this host first' >&2; exit 1; }}\ncommand -v curl >/dev/null 2>&1 || {{ echo 'Install curl on this host first' >&2; exit 1; }}\nexec \"$whip_herdr\"{}",
        super::herdr_setup::resolve_executable_script(herdr_command),
        installation_arguments(session),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn installation_targets_only_the_selected_host_session_and_quotes_arguments() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("herdr ' custom");
        let output = root.path().join("args");
        std::fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$WHIP_TEST_ARGS\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let release = format!("whip-notify-v{}", whip_notify::PACKAGE_VERSION);
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
            json!({"installed":true,"enabled":false,"version":"0.1.0"})
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
        status["update_available"] = json!(
            status["installed"] == true
                && status["version"].as_str() != Some(whip_notify::PACKAGE_VERSION)
        );
        Ok(status)
    }

    async fn notify_install(&self) -> Result<String, HostRuntimeError> {
        let status = self.notify_plugin_status().await?;
        if status["installed"] != true || status["update_available"] == true {
            let ssh = current_ssh(&self.inner)?;
            let command = super::herdr_setup::login_shell_command(&installation_script(
                &self.inner.config.herdr_command,
                &self.inner.config.session_name,
            ));
            // Installation downloads a pinned release; hook execution stays
            // bounded to four seconds. Never retry a mutating install automatically.
            let output = tokio::time::timeout(INSTALL_TIMEOUT, ssh.execute(&command))
                .await
                .map_err(|_| {
                    HostRuntimeError::InvalidConfiguration(
                        "Plugin installation timed out; inspect this host before retrying".into(),
                    )
                })?
                .map_err(|_| failure())?;
            if output.exit_status != Some(0) {
                let detail = String::from_utf8_lossy(&output.stderr);
                return Err(HostRuntimeError::InvalidConfiguration(format!(
                    "Plugin installation failed: {}",
                    detail
                        .chars()
                        .rev()
                        .take(4096)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                )));
            }
        }
        self.notify_rpc("plugin.enable", json!({"plugin_id":PLUGIN}))
            .await?;
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
