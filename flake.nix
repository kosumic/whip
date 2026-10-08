{
  description = "Whip Expo Android development environment";

  # Match the host flake so the Android shell reuses its cached JDK/SDK closure.
  inputs = {
    nixpkgs.url = "tarball+https://releases.nixos.org/nixos/unstable/nixos-26.11pre1034379.18b9261cb329/nixexprs.tar.xz";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {nixpkgs, rust-overlay, ...}: let
    androidSystem = "x86_64-linux";
    darwinSystem = "aarch64-darwin";
    rustVersion = "1.99.0";
    androidPkgs = import nixpkgs {
      system = androidSystem;
      overlays = [ (import rust-overlay) ];
      config.allowUnfree = true;
      config.android_sdk.accept_license = true;
    };
    darwinPkgs = import nixpkgs {
      system = darwinSystem;
      overlays = [ (import rust-overlay) ];
      config.allowUnfree = true;
    };

    androidComposition = androidPkgs.androidenv.composeAndroidPackages {
      platformVersions = ["36"];
      buildToolsVersions = ["35.0.0" "36.0.0"];
      cmakeVersions = ["3.22.1"];
      includeNDK = true;
      ndkVersions = ["27.1.12297006"];
    };
    androidSdk = androidComposition.androidsdk;
    androidNdkTools = "${androidSdk}/libexec/android-sdk/ndk-bundle/toolchains/llvm/prebuilt/linux-x86_64/bin";
    androidRustToolchain = androidPkgs.rust-bin.stable.${rustVersion}.default.override {
      targets = ["aarch64-linux-android"];
    };
    darwinRustToolchain = darwinPkgs.rust-bin.stable.${rustVersion}.default.override {
      targets = ["aarch64-apple-ios"];
    };
    mkCargoAbout = pkgs: target: hash:
      pkgs.stdenvNoCC.mkDerivation {
        pname = "cargo-about";
        version = "0.9.1";
        src = pkgs.fetchurl {
          url = "https://github.com/EmbarkStudios/cargo-about/releases/download/0.9.1/cargo-about-0.9.1-${target}.tar.gz";
          inherit hash;
        };
        sourceRoot = ".";
        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"
          install -m 755 "cargo-about-0.9.1-${target}/cargo-about" "$out/bin/cargo-about"
          runHook postInstall
        '';
      };
    linuxCargoAbout = mkCargoAbout
      androidPkgs
      "x86_64-unknown-linux-musl"
      "sha256-wOfcb110sL7sXABT05qyRRTHF9GazZGIaQeiJFfqnpg=";
    darwinCargoAbout = mkCargoAbout
      darwinPkgs
      "aarch64-apple-darwin"
      "sha256-ajj+Fm0XpnQmnUNzJWwLa9k6zCVT4S3gUXy57Mc8nAI=";
    mkWhipair = pkgs:
      pkgs.rustPlatform.buildRustPackage {
        pname = "whipair";
        version = "0.1.3";
        src = pkgs.lib.cleanSourceWith {
          src = ./whipair;
          filter = path: type:
            type != "directory" || builtins.baseNameOf path != "target";
        };
        cargoLock.lockFile = ./whipair/Cargo.lock;
        nativeBuildInputs = [pkgs.makeWrapper];

        postInstall = ''
          wrapProgram $out/bin/whipair \
            --prefix PATH : ${pkgs.lib.makeBinPath [pkgs.curl pkgs.openssh]}
        '';

        meta = {
          description = "Direct, QR-based SSH public-key enrollment prototype for Whip";
          license = pkgs.lib.licenses.agpl3Plus;
          mainProgram = "whipair";
          platforms = pkgs.lib.platforms.unix;
        };
      };
    linuxWhipair = mkWhipair androidPkgs;
    darwinWhipair = mkWhipair darwinPkgs;
  in {
    packages.${androidSystem} = {
      whipair = linuxWhipair;
      cargo-about = linuxCargoAbout;
    };
    packages.${darwinSystem} = {
      whipair = darwinWhipair;
      cargo-about = darwinCargoAbout;
    };

    apps.${androidSystem}.whipair = {
      type = "app";
      program = "${linuxWhipair}/bin/whipair";
      meta.description = "Run the Whip SSH pairing prototype";
    };
    apps.${darwinSystem}.whipair = {
      type = "app";
      program = "${darwinWhipair}/bin/whipair";
      meta.description = "Run the Whip SSH pairing prototype";
    };

    devShells.${androidSystem}.default = androidPkgs.mkShell {
      packages = [
        androidSdk
        linuxCargoAbout
        androidPkgs.jdk17_headless
        androidPkgs.libwebp
        androidPkgs.nodejs_22
        androidRustToolchain
      ];

      ANDROID_HOME = "${androidSdk}/libexec/android-sdk";
      ANDROID_SDK_ROOT = "${androidSdk}/libexec/android-sdk";
      ANDROID_NDK_ROOT = "${androidSdk}/libexec/android-sdk/ndk-bundle";
      JAVA_HOME = androidPkgs.jdk17_headless.home;
      GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidSdk}/libexec/android-sdk/build-tools/36.0.0/aapt2";
      CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = "${androidNdkTools}/aarch64-linux-android24-clang";
      CC_aarch64_linux_android = "${androidNdkTools}/aarch64-linux-android24-clang";
      AR_aarch64_linux_android = "${androidNdkTools}/llvm-ar";
      CFLAGS_aarch64_linux_android = "--target=aarch64-none-linux-android24";
    };

    devShells.${darwinSystem}.default = darwinPkgs.mkShell {
      packages = with darwinPkgs; [
        darwinCargoAbout
        nodejs_22
        watchman
        (ruby_3_4.withPackages (gems: [ gems.xcodeproj ]))
        bundler
        cocoapods
        fastlane
        libwebp
        darwinRustToolchain
      ];

      DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
    };
  };
}
