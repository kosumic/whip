#![cfg(unix)]

use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Output},
};

struct Installer {
    root: tempfile::TempDir,
    bytes: &'static [u8],
    target: &'static str,
}

fn executable(path: &Path, source: &str) {
    fs::write(path, source).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn tool(name: &str) -> PathBuf {
    let result = Command::new("sh")
        .args(["-c", "command -v \"$1\"", "sh", name])
        .output()
        .unwrap();
    assert!(result.status.success(), "missing test tool {name}");
    PathBuf::from(String::from_utf8(result.stdout).unwrap().trim())
}

impl Installer {
    fn new(platform: &str, arch: &str, hash: Option<&str>) -> Self {
        let root = tempfile::Builder::new()
            .prefix("whip notify installation ")
            .tempdir()
            .unwrap();
        let bin = root.path().join("bin");
        fs::create_dir(&bin).unwrap();
        // Only these real tools are available: the installer cannot use Cargo,
        // Node, Python or an unmocked downloader, even on a developer's machine.
        for name in [
            "sh", "dirname", "sed", "mktemp", "rm", "mv", "chmod", "cat", "mkdir", "install",
        ] {
            symlink(tool(name), bin.join(name)).unwrap();
        }
        if let Some(hash) = hash {
            symlink(tool(hash), bin.join(hash)).unwrap();
        }
        executable(
            &bin.join("uname"),
            &format!(
                "#!/bin/sh\ncase $1 in -s) printf '%s\\n' '{platform}';; -m) printf '%s\\n' '{arch}';; *) exit 1;; esac\n"
            ),
        );
        executable(
            &bin.join("curl"),
            r#"#!/bin/sh
set -eu
output=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    https://*) url=$1; shift ;;
    --proto|--proto-redir|--connect-timeout|--max-time|--retry|--max-filesize|--speed-limit|--speed-time) shift 2 ;;
    -q|--fail|--location|--silent|--show-error) shift ;;
    *) exit 2 ;;
  esac
done
printf '%s\n' "$url" >> "$WHIP_TEST_ROOT/requests"
if [ "${WHIP_TEST_FAIL:-}" = network ]; then
  printf 'partial download' > "$output"
  exit 22
fi
case "$url" in
  "$WHIP_TEST_URL.sha256") cat "$WHIP_TEST_ROOT/checksum" > "$output" ;;
  "$WHIP_TEST_URL") cat "$WHIP_TEST_ROOT/payload" > "$output" ;;
  *) echo 'Unexpected release URL' >&2; exit 2 ;;
esac
"#,
        );
        executable(
            &bin.join("herdr"),
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$WHIP_TEST_ROOT/herdr-args\"\n",
        );
        let source = Path::new(env!("CARGO_MANIFEST_DIR"));
        for name in ["build.sh", "install.sh", "herdr-plugin.toml", "platform.sh"] {
            fs::copy(source.join(name), root.path().join(name)).unwrap();
        }
        let bytes = b"binary fixture; downloaded executables must never run during installation\n";
        fs::write(root.path().join("payload"), bytes).unwrap();
        let target = match (platform, arch) {
            ("Darwin", _) => "aarch64-apple-darwin",
            ("Linux", "x86_64" | "amd64") => "x86_64-unknown-linux-musl",
            _ => "aarch64-unknown-linux-musl",
        };
        let installer = Self {
            root,
            bytes,
            target,
        };
        installer.checksum(&format!("{:x}", Sha256::digest(bytes)), &installer.asset());
        installer
    }

    fn asset(&self) -> String {
        format!("whip-notify-{}", self.target)
    }

    fn checksum(&self, digest: &str, asset: &str) {
        fs::write(
            self.root.path().join("checksum"),
            format!("{digest}  {asset}\n"),
        )
        .unwrap();
    }

    fn command(&self, script: &str) -> Command {
        let mut command = Command::new(tool("sh"));
        command
            .arg(self.root.path().join(script))
            .env_clear()
            .env("PATH", self.root.path().join("bin"))
            .env("HOME", self.root.path())
            .env("WHIP_TEST_ROOT", self.root.path())
            .env(
                "WHIP_NOTIFY_INSTALL_DIR",
                self.root.path().join("installed"),
            )
            .env(
                "WHIP_TEST_URL",
                format!(
                    "https://github.com/kosumic/whip/releases/download/whip-notify-v{}/{}",
                    env!("CARGO_PKG_VERSION"),
                    self.asset()
                ),
            )
            .current_dir(self.root.path());
        command
    }

    fn run(&self) -> Output {
        self.command("build.sh").output().unwrap()
    }

    fn assert_no_temporary_files(&self) {
        assert!(!fs::read_dir(self.root.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".whip-notify-download.")
        }));
    }
}

#[test]
fn downloads_matching_linux_and_macos_binaries_without_a_compiler() {
    for (platform, arch, hash) in [
        ("Linux", "aarch64", "sha256sum"),
        ("Linux", "x86_64", "sha256sum"),
        ("Darwin", "arm64", "shasum"),
    ] {
        let installer = Installer::new(platform, arch, Some(hash));
        let output = installer.run();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let binary = installer.root.path().join("whip-notify");
        assert_eq!(fs::read(&binary).unwrap(), installer.bytes);
        assert_eq!(
            fs::metadata(binary).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::read_to_string(installer.root.path().join("requests"))
                .unwrap()
                .lines()
                .count(),
            2
        );
        installer.assert_no_temporary_files();
    }
}

#[test]
fn failed_download_preserves_previous_executable_and_cleans_up() {
    let installer = Installer::new("Linux", "aarch64", Some("sha256sum"));
    let binary = installer.root.path().join("whip-notify");
    fs::write(&binary, "previous version").unwrap();
    let output = installer
        .command("build.sh")
        .env("WHIP_TEST_FAIL", "network")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(fs::read_to_string(binary).unwrap(), "previous version");
    installer.assert_no_temporary_files();
}

#[test]
fn corrupt_or_substituted_checksums_never_replace_an_executable() {
    for (digest, filename) in [
        ("0".repeat(64), "whip-notify-aarch64-unknown-linux-musl"),
        (
            "not-a-checksum".into(),
            "whip-notify-aarch64-unknown-linux-musl",
        ),
        (
            format!("{:x}", Sha256::digest(b"other binary")),
            "../other-file",
        ),
    ] {
        let installer = Installer::new("Linux", "arm64", Some("sha256sum"));
        let binary = installer.root.path().join("whip-notify");
        fs::write(&binary, "previous version").unwrap();
        installer.checksum(&digest, filename);
        assert!(!installer.run().status.success());
        assert_eq!(fs::read_to_string(binary).unwrap(), "previous version");
        installer.assert_no_temporary_files();
    }
}

#[test]
fn unsupported_hosts_or_missing_hash_tools_fail_before_downloading() {
    for (platform, arch, hash) in [
        ("Linux", "i686", Some("sha256sum")),
        ("Windows", "arm64", Some("sha256sum")),
        ("Linux", "aarch64", None),
    ] {
        let installer = Installer::new(platform, arch, hash);
        assert!(!installer.run().status.success());
        assert!(!installer.root.path().join("whip-notify").exists());
        assert!(!installer.root.path().join("requests").exists());
    }
}

#[test]
fn simultaneous_installations_use_independent_staging_directories() {
    let installer = Installer::new("Linux", "aarch64", Some("sha256sum"));
    let mut first = installer.command("build.sh").spawn().unwrap();
    let mut second = installer.command("build.sh").spawn().unwrap();
    assert!(first.wait().unwrap().success());
    assert!(second.wait().unwrap().success());
    assert_eq!(
        fs::read(installer.root.path().join("whip-notify")).unwrap(),
        installer.bytes
    );
    installer.assert_no_temporary_files();
}

#[test]
fn downloaded_plugin_can_be_privately_linked_with_herdr() {
    let installer = Installer::new("Linux", "aarch64", Some("sha256sum"));
    assert!(installer.run().status.success());
    let output = installer.command("install.sh").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let destination = installer.root.path().join("installed");
    for (filename, mode) in [("whip-notify", 0o700), ("herdr-plugin.toml", 0o600)] {
        assert_eq!(
            fs::metadata(destination.join(filename))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            mode
        );
    }
    assert_eq!(
        fs::read(destination.join("whip-notify")).unwrap(),
        installer.bytes
    );
    assert_eq!(
        fs::read_to_string(installer.root.path().join("herdr-args")).unwrap(),
        format!("plugin\nlink\n{}\n", destination.display())
    );
}

#[test]
fn installer_tag_excludes_the_app_and_is_immutable() {
    let root = tempfile::tempdir().unwrap();
    let source = Path::new(env!("CARGO_MANIFEST_DIR"));
    let plugin = root.path().join("whip-notify");
    fs::create_dir(&plugin).unwrap();
    for name in ["build.sh", "platform.sh", "herdr-plugin.toml"] {
        fs::copy(source.join(name), plugin.join(name)).unwrap();
    }
    fs::write(root.path().join("unrelated-app-asset"), [0; 16_384]).unwrap();
    let git = |args: &[&str]| {
        let output = Command::new(tool("git"))
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
            ])
            .args(args)
            .current_dir(root.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    git(&["init", "--quiet"]);
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "Source release"]);
    let prepare = || {
        Command::new(tool("sh"))
            .arg(source.join("../scripts/prepare-notify-install-tag.sh"))
            .current_dir(root.path())
            .output()
            .unwrap()
    };
    let prepared = prepare();
    assert!(
        prepared.status.success(),
        "{}",
        String::from_utf8_lossy(&prepared.stderr)
    );
    let tag = format!("whip-notify-install-v{}", env!("CARGO_PKG_VERSION"));
    assert_eq!(String::from_utf8(prepared.stdout).unwrap().trim(), tag);
    assert_eq!(git(&["rev-list", "--count", &tag]), "1");
    assert_eq!(
        git(&["ls-tree", "-r", "--name-only", &tag]),
        "whip-notify/build.sh\nwhip-notify/herdr-plugin.toml\nwhip-notify/platform.sh"
    );
    assert!(prepare().status.success());
    fs::write(plugin.join("build.sh"), "changed installer").unwrap();
    git(&["add", "."]);
    git(&[
        "commit",
        "--quiet",
        "-m",
        "Changed source without a version bump",
    ]);
    let replaced = prepare();
    assert!(!replaced.status.success());
    assert!(String::from_utf8_lossy(&replaced.stderr).contains("increment the plugin version"));
}
