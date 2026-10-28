#!/usr/bin/env bash
# Reuses the existing, isolated arm64 smoke app and mini worktree. Never uninstalls.
set -euo pipefail
cd /Users/kosumi/repos/whip-ios-device
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 WHIP_DISTRIBUTION_CHANNEL=github NODE_ENV=production
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fixture="$PWD/build/skia-perf-live"
device=35AF86B7-DC94-48B9-8215-82C9DE8E08F7
app_id=io.github.kaminarios.whip.skiasmoke
mkdir -p "$fixture/runtime" "$fixture/config" "$fixture/data"
chmod 700 "$fixture" "$fixture/runtime"
for port in 22391 22392 22393; do
  if /usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null; then
    echo "Fixture port $port is occupied; refusing to disturb its owner" >&2; exit 1
  fi
done
if [[ -f "$fixture/measurements.jsonl" ]]; then
  archive="$fixture/previous-$(date +%s)"
  mkdir -p "$archive"
  mv "$fixture/measurements.jsonl" "$archive/"
fi
rm -f "$fixture/error.json" "$fixture/complete.json" "$fixture"/run-complete-*.json
controller_pid=''; sshd_pid=''; herdr_pid=''
cleanup() {
  /usr/bin/xcrun simctl terminate "$device" "$app_id" 2>/dev/null || true
  for fixture_pid in "$controller_pid" "$sshd_pid" "$herdr_pid"; do
    if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; fi
  done
  rm -f "$fixture/client" "$fixture/client.pub" "$fixture/host" "$fixture/host.pub" .codex-skia-live-config.json
  /usr/bin/xcrun simctl launch "$device" io.github.kaminarios.whip >/dev/null 2>&1 || true
}
trap cleanup EXIT
ssh-keygen -q -t ed25519 -N '' -f "$fixture/client"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/host"
cat > "$fixture/sshd_config" <<CONFIG
Port 22391
ListenAddress 127.0.0.1
HostKey $fixture/host
PidFile $fixture/sshd.pid
AuthorizedKeysFile $fixture/client.pub
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
AllowUsers kosumi
AllowTcpForwarding yes
AllowStreamLocalForwarding yes
Subsystem sftp internal-sftp
LogLevel ERROR
CONFIG
nohup /usr/sbin/sshd -D -f "$fixture/sshd_config" > "$fixture/sshd.log" 2>&1 &
echo $! > "$fixture/sshd-process.pid"
sshd_pid=$!
printf 'onboarding = false\n' > "$fixture/herdr.toml"
HERDR_SOCKET_PATH="$fixture/herdr.sock" HERDR_CONFIG_PATH="$fixture/herdr.toml" XDG_CONFIG_HOME="$fixture/config" XDG_DATA_HOME="$fixture/data" XDG_RUNTIME_DIR="$fixture/runtime" SHELL=/bin/bash \
  nohup herdr server > "$fixture/herdr.log" 2>&1 &
echo $! > "$fixture/herdr-process.pid"
herdr_pid=$!
for i in {1..100}; do if test -S "$fixture/herdr.sock"; then break; fi; sleep 0.1; done
rm -f "$fixture/known_hosts"
/usr/bin/ssh -i "$fixture/client" -p 22391 -o IdentitiesOnly=yes -o UserKnownHostsFile="$fixture/known_hosts" -o StrictHostKeyChecking=accept-new kosumi@127.0.0.1 true
node - "$fixture" <<'NODE'
const fs=require('fs'),path=require('path');const root=process.argv[2];
fs.writeFileSync('.codex-skia-live-config.json',JSON.stringify({host:'127.0.0.1',username:'kosumi',key:fs.readFileSync(root+'/client','utf8'),knownHosts:fs.readFileSync(root+'/known_hosts','utf8').replaceAll('[127.0.0.1]:22391','[127.0.0.1]:22392'),socketPath:root+'/herdr.sock',herdrCommand:process.env.HOME+'/.nix-profile/bin/herdr',nodeBinary:process.execPath,workload:path.resolve('scripts/herdr-renderer-benchmark/workload.cjs'),sampleFile:root+'/vim-sample.txt',fixtureDirectory:root}),{mode:0o600});
fs.writeFileSync(root+'/vim-sample.txt',Array.from({length:200},(_,i)=>`${i}: terminal benchmark vim line`).join('\n'));
fs.writeFileSync(root+'/environment.json',JSON.stringify({node:process.version,arch:process.arch,os:require('os').release(),cpu:require('os').cpus()[0].model,createdAt:new Date().toISOString()}));
NODE
unset SDKROOT
/usr/bin/xcrun clang -arch arm64 -O2 scripts/herdr-renderer-benchmark/resource-sampler.c -o "$fixture/resource-sampler"
"$fixture/resource-sampler" self-test > "$fixture/counter-self-test.json"
nohup node scripts/herdr-renderer-benchmark/controller.cjs "$fixture" > "$fixture/controller.log" 2>&1 &
echo $! > "$fixture/controller.pid"
controller_pid=$!
node scripts/sync-terminal-assets.ts
app="$(/usr/bin/xcrun simctl get_app_container "$device" "$app_id" app)"
/usr/bin/xcrun simctl terminate "$device" "$app_id" 2>/dev/null || true
# Pause the normal app so its WebKit processes cannot be confused with the fixture.
/usr/bin/xcrun simctl terminate "$device" io.github.kaminarios.whip 2>/dev/null || true
cp -R modules/whip-terminal-assets/ios/TerminalAssets/. "$app/WhipTerminalAssets.bundle/"
node_modules/.bin/expo export:embed --platform ios --dev false --max-workers 1 \
  --entry-file scripts/herdr-renderer-benchmark/app.jsx --bundle-output "$fixture/main.jsbundle" --assets-dest "$app" > "$fixture/bundle.log" 2>&1
cp "$fixture/main.jsbundle" "$app/main.jsbundle"
for run in {0..5}; do
  /usr/bin/xcrun simctl terminate "$device" "$app_id" 2>/dev/null || true
  /usr/bin/xcrun simctl launch "$device" "$app_id"
  for i in {1..180}; do
    if [[ -f "$fixture/run-complete-$run.json" ]]; then break; fi
    if [[ -f "$fixture/error.json" ]]; then echo 'Benchmark failed; inspect error.json' >&2; exit 1; fi
    sleep 1
  done
  if [[ ! -f "$fixture/run-complete-$run.json" ]]; then echo "Run $run timed out" >&2; exit 1; fi
  echo "Run $run complete"
done
printf '{}\n' > "$fixture/complete.json"
echo 'Benchmark completed'
