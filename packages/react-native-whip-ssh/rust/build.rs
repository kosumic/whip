use std::{env, error::Error, fs, io, path::PathBuf, process::Command};

const MODULE: &str = "github.com/tailscale/tailcat";
type BuildResult<T> = Result<T, Box<dyn Error>>;

fn output(command: &mut Command) -> BuildResult<String> {
    let result = command.output().map_err(|error| {
        io::Error::other(format!(
            "Tailcat requires Go and a C compiler; run nix develop: {error}"
        ))
    })?;
    if !result.status.success() {
        return Err(io::Error::other(format!(
            "Tailcat build failed: {}",
            String::from_utf8_lossy(&result.stderr)
        ))
        .into());
    }
    Ok(String::from_utf8(result.stdout)?)
}

fn main() -> BuildResult<()> {
    println!("cargo:rerun-if-changed=tailcat/go.mod");
    println!("cargo:rerun-if-changed=tailcat/go.sum");
    for name in [
        "GO",
        "CC_aarch64_linux_android",
        "DEVELOPER_DIR",
        "IPHONEOS_DEPLOYMENT_TARGET",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let go = env::var("GO").unwrap_or_else(|_| "go".into());
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let metadata = output(
        Command::new(&go)
            .current_dir(manifest.join("tailcat"))
            .args(["mod", "download", "-json", MODULE]),
    )?;
    let metadata: serde_json::Value = serde_json::from_str(&metadata)?;
    let source = PathBuf::from(
        metadata["Dir"]
            .as_str()
            .ok_or_else(|| io::Error::other("Go module source directory is missing"))?,
    );
    let destination = PathBuf::from(env::var("OUT_DIR")?);
    let target = env::var("TARGET")?;
    let mut build = Command::new(&go);
    build.current_dir(&source).env("CGO_ENABLED", "1");
    let android = target == "aarch64-linux-android";
    match target.as_str() {
        "aarch64-linux-android" => {
            build.env("GOOS", "android").env("GOARCH", "arm64");
            build.env("CC", env::var("CC_aarch64_linux_android")?);
            build.env(
                "CGO_LDFLAGS",
                "-Wl,-z,max-page-size=16384 -Wl,-soname,libtailcat.so",
            );
        }
        "aarch64-apple-ios" | "aarch64-apple-ios-sim" => {
            let simulator = target.ends_with("-sim");
            let sdk = if simulator {
                "iphonesimulator"
            } else {
                "iphoneos"
            };
            let sdk_path = output(Command::new("xcrun").args(["--sdk", sdk, "--show-sdk-path"]))?;
            let compiler = output(Command::new("xcrun").args(["--sdk", sdk, "--find", "clang"]))?;
            let minimum = env::var("IPHONEOS_DEPLOYMENT_TARGET").unwrap_or_else(|_| "16.4".into());
            let platform = if simulator { "-simulator" } else { "" };
            let flags = format!(
                "-isysroot {} -target arm64-apple-ios{minimum}{platform}",
                sdk_path.trim()
            );
            build
                .env("GOOS", "ios")
                .env("GOARCH", "arm64")
                .env("CC", compiler.trim())
                .env("CGO_CFLAGS", &flags)
                .env("CGO_LDFLAGS", &flags);
        }
        _ if target == env::var("HOST")? => {}
        _ => {
            return Err(
                io::Error::other(format!("unsupported Tailcat build target: {target}")).into(),
            );
        }
    }
    if target.contains("-apple-") {
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=resolv");
    }
    // Android supports Go c-shared, while iOS embeds a static c-archive.
    let mode = if android { "c-shared" } else { "c-archive" };
    let library = if android {
        "libtailcat.so"
    } else {
        "libtailcat.a"
    };
    let tags = fs::read_to_string(source.join("build-tags.txt"))?;
    output(
        build
            .args([
                "build",
                "-buildvcs=false",
                "-mod=readonly",
                "-trimpath",
                &format!("-buildmode={mode}"),
                "-tags",
                tags.trim(),
                "-o",
            ])
            .arg(destination.join(library))
            .arg("./cmd/libtailcat"),
    )?;
    println!("cargo:rustc-link-search=native={}", destination.display());
    println!(
        "cargo:rustc-link-lib={}=tailcat",
        if android { "dylib" } else { "static" }
    );
    Ok(())
}
