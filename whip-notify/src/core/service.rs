//! One opt-in user service per Core endpoint; registration keys survive removal.
use super::{Core, home, xdg};
use crate::{Result, host::atomic_write};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const MARKER: &str = "Whip Core notification watcher";
const VERSION_PREFIX: &str = "whip-notify-version=";
fn name(core: &Core) -> String {
    format!("dev.whip.core.{}", core.key)
}
fn path(core: &Core) -> Result<PathBuf> {
    if cfg!(target_os = "macos") {
        Ok(home()?
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", name(core))))
    } else {
        Ok(xdg("XDG_CONFIG_HOME", ".config")?
            .join("systemd/user")
            .join(format!("{}.service", name(core))))
    }
}
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn unit_arg(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}
pub fn unit(core: &Core, executable: &str, environment: &[(String, String)]) -> Result<String> {
    let args = [executable, "core", "--socket", &core.socket, "watch"];
    if args
        .iter()
        .copied()
        .chain(environment.iter().map(|(_, v)| v.as_str()))
        .any(|value| value.chars().any(char::is_control))
    {
        return Err("control character in service configuration".into());
    }
    let version = format!("{VERSION_PREFIX}{}", crate::PACKAGE_VERSION);
    if cfg!(target_os = "macos") {
        let args = args
            .iter()
            .map(|arg| format!("<string>{}</string>", xml(arg)))
            .collect::<String>();
        let env = environment
            .iter()
            .map(|(key, value)| format!("<key>{}</key><string>{}</string>", xml(key), xml(value)))
            .collect::<String>();
        Ok(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- {MARKER}\n{version}\n-->\n<plist version=\"1.0\"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array>{args}</array><key>EnvironmentVariables</key><dict>{env}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer></dict></plist>\n",
            name(core)
        ))
    } else {
        let env = environment
            .iter()
            .map(|(key, value)| format!("Environment={}\n", unit_arg(&format!("{key}={value}"))))
            .collect::<String>();
        Ok(format!(
            "# {MARKER}\n# {version}\n[Unit]\nDescription={MARKER}\nAfter=network-online.target\n[Service]\nType=simple\n{env}ExecStart={}\nRestart=always\nRestartSec=3\nTimeoutStopSec=5\nUMask=0077\n[Install]\nWantedBy=default.target\n",
            args.iter()
                .map(|arg| unit_arg(&arg.replace('$', "$$")))
                .collect::<Vec<_>>()
                .join(" ")
        ))
    }
}
fn managed(core: &Core) -> Result<Option<String>> {
    match std::fs::symlink_metadata(path(core)?) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > 65536 => {
            Err("unsafe watcher service file".into())
        }
        Ok(_) => {
            let source = std::fs::read_to_string(path(core)?)?;
            if !source.contains(MARKER) {
                return Err("watcher service path belongs to another configuration".into());
            }
            Ok(Some(source))
        }
    }
}
fn control(args: &[&str]) -> Result<bool> {
    let mut command = if cfg!(target_os = "macos") {
        Command::new("launchctl")
    } else {
        let mut command = Command::new("systemctl");
        command.arg("--user");
        if std::env::var_os("XDG_RUNTIME_DIR").is_none_or(|value| value.is_empty()) {
            // SAFETY: getuid has no preconditions.
            let runtime = format!("/run/user/{}", unsafe { libc::getuid() });
            command.env("XDG_RUNTIME_DIR", &runtime).env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={runtime}/bus"),
            );
        }
        command
    };
    let mut child = command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) if start.elapsed() < Duration::from_secs(5) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("notification user service command failed or timed out".into());
            }
        }
    }
}
fn require(args: &[&str]) -> Result<()> {
    if control(args)? {
        Ok(())
    } else {
        Err("Could not manage the Whip Core user service; check systemd --user or the logged-in launchd session".into())
    }
}
fn domain() -> String {
    // SAFETY: getuid has no preconditions.
    format!("gui/{}", unsafe { libc::getuid() })
}
pub fn status(core: &Core) -> Result<Value> {
    let source = managed(core)?;
    let installed = source.is_some();
    let version = source.as_deref().and_then(|source| {
        source.lines().find_map(|line| {
            line.trim_start_matches('#')
                .trim()
                .strip_prefix(VERSION_PREFIX)
        })
    });
    let enabled = installed
        && if cfg!(target_os = "macos") {
            control(&["print", &format!("{}/{}", domain(), name(core))])?
        } else {
            control(&["is-enabled", "--quiet", &format!("{}.service", name(core))])?
                && control(&["is-active", "--quiet", &format!("{}.service", name(core))])?
        };
    Ok(json!({"installed":installed,"enabled":enabled,"version":version}))
}
pub fn install(core: &Core) -> Result<()> {
    let existed = managed(core)?.is_some();
    // Capture only filesystem locations needed to find the same registration store.
    let environment = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok().map(|value| (key.to_owned(), value)))
        .collect::<Vec<_>>();
    let executable = std::env::current_exe()?;
    atomic_write(
        &path(core)?,
        unit(
            core,
            executable.to_str().ok_or("invalid executable")?,
            &environment,
        )?
        .as_bytes(),
    )?;
    if cfg!(target_os = "macos") {
        if existed {
            enable(core, false)?;
        }
    } else {
        require(&["daemon-reload"])?;
        if existed {
            require(&["stop", &format!("{}.service", name(core))])?;
        }
    }
    enable(core, true)
}
pub fn enable(core: &Core, enabled: bool) -> Result<()> {
    if managed(core)?.is_none() {
        return Err("Core notification service is not installed".into());
    }
    if cfg!(target_os = "macos") {
        let label = format!("{}/{}", domain(), name(core));
        if enabled {
            require(&["enable", &label])?;
            if !control(&["print", &label])? {
                require(&[
                    "bootstrap",
                    &domain(),
                    path(core)?.to_str().ok_or("invalid service path")?,
                ])?;
            }
        } else if control(&["print", &label])? {
            require(&["bootout", &label])?;
        }
        if !enabled {
            require(&["disable", &label])?;
        }
    } else {
        require(&[
            if enabled { "enable" } else { "disable" },
            "--now",
            &format!("{}.service", name(core)),
        ])?;
    }
    Ok(())
}
pub fn uninstall(core: &Core) -> Result<()> {
    if managed(core)?.is_some() {
        // Stop even a service which was manually disabled while still running.
        enable(core, false)?;
        std::fs::remove_file(path(core)?)?;
        if !cfg!(target_os = "macos") {
            require(&["daemon-reload"])?;
        }
    }
    Ok(())
}
