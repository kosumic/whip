let
  lock = builtins.fromJSON (builtins.readFile ../../flake.lock);
  root = lock.nodes.${lock.root};
  nixpkgsLock = lock.nodes.${root.inputs.nixpkgs}.locked;
  nixpkgs = builtins.fetchTree { inherit (nixpkgsLock) type url narHash; };
  pkgs = import nixpkgs.outPath { system = builtins.currentSystem; };
in pkgs.mkShellNoCC {
  # CodeQL compiles JVM sources against the runner's Android SDK.
  packages = [pkgs.jdk17_headless pkgs.nodejs_24];
  JAVA_HOME = pkgs.jdk17_headless.home;
}
