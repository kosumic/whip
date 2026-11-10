#![cfg(feature = "host")]
use serde_json::Value;
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

fn execute(root: &Path, action: &str) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_whip-notify"))
        .args([
            "core",
            "--socket",
            root.join("core.sock").to_str().unwrap(),
            action,
        ])
        .env("HOME", root)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("WHIP_TEST_SERVICE", root)
        .env(
            "PATH",
            std::env::join_paths(
                std::iter::once(root.join("bin"))
                    .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
            )
            .unwrap(),
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{action}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn lifecycle_is_endpoint_scoped_and_uninstall_stops_a_disabled_but_running_watcher() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("bin")).unwrap();
    let script = r#"#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$WHIP_TEST_SERVICE/commands"
if [ "$1" = --user ]; then shift; fi
case "$1" in
  daemon-reload) ;;
  is-enabled) test -f "$WHIP_TEST_SERVICE/enabled" ;;
  is-active|print) test -f "$WHIP_TEST_SERVICE/active" ;;
  enable) touch "$WHIP_TEST_SERVICE/enabled"; if [ "${2:-}" = --now ]; then touch "$WHIP_TEST_SERVICE/active"; fi ;;
  bootstrap) touch "$WHIP_TEST_SERVICE/active" ;;
  disable) rm -f "$WHIP_TEST_SERVICE/enabled"; if [ "${2:-}" = --now ]; then rm -f "$WHIP_TEST_SERVICE/active"; fi ;;
  stop|bootout) rm -f "$WHIP_TEST_SERVICE/active" ;;
  *) exit 2 ;;
esac
"#;
    for name in ["systemctl", "launchctl"] {
        let path = root.path().join("bin").join(name);
        fs::write(&path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    assert_eq!(execute(root.path(), "status")["installed"], false);
    let installed = execute(root.path(), "install");
    assert_eq!(installed["installed"], true);
    assert_eq!(installed["enabled"], true);
    assert_eq!(installed["version"], whip_notify::PACKAGE_VERSION);
    let paths = execute(root.path(), "paths");
    let config = std::path::PathBuf::from(paths["config"].as_str().unwrap());
    fs::create_dir_all(&config).unwrap();
    fs::write(config.join("identity.json"), b"preserve existing identity").unwrap();
    assert_eq!(execute(root.path(), "disable")["enabled"], false);
    assert_eq!(execute(root.path(), "enable")["enabled"], true);
    fs::remove_file(root.path().join("enabled")).unwrap();
    assert_eq!(execute(root.path(), "uninstall")["installed"], false);
    assert!(!root.path().join("active").exists());
    assert_eq!(
        fs::read(config.join("identity.json")).unwrap(),
        b"preserve existing identity"
    );
    assert_eq!(
        execute(root.path(), "uninstall")["installed"],
        false,
        "idempotent removal"
    );
    let commands = fs::read_to_string(root.path().join("commands")).unwrap();
    assert!(!commands.contains("server"));
    assert!(!commands.contains("herdr-core"));
}
