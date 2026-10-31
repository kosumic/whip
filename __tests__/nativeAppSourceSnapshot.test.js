const {mkdtempSync, mkdirSync, writeFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, dirname} = require('node:path');
const {captureNativeAppSources} = require('../scripts/native-app-source-snapshot.cjs');

let root;
const write = (path, contents) => {
  const file = join(root, path);
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, contents);
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'whip-build-sources-')); });
afterEach(() => { rmSync(root, {recursive: true, force: true}); });

test('detects alert code or Rust API changes after a native build starts', () => {
  const alert = 'src/services/alerts.ts';
  const rust = 'packages/react-native-whip-ssh/rust/src/app_core/mod.rs';
  write(alert, 'old alert implementation');
  write(rust, 'old native API');
  const initial = captureNativeAppSources(root);
  expect(captureNativeAppSources(root)).toEqual(initial);

  write(alert, 'new alert implementation');
  expect(captureNativeAppSources(root)[alert]).not.toBe(initial[alert]);
  write(rust, 'new native API');
  expect(captureNativeAppSources(root)[rust]).not.toBe(initial[rust]);
});

test('detects newly introduced and removed source files', () => {
  const initial = captureNativeAppSources(root);
  const path = 'packages/react-native-whip-ssh/rust/src/app_core/local_alerts.rs';
  write(path, 'new native alerts');
  expect(captureNativeAppSources(root)).not.toEqual(initial);
  rmSync(join(root, path));
  expect(captureNativeAppSources(root)).toEqual(initial);
});

test('allows bindings, assets and compiler output to be regenerated', () => {
  write('src/services/alerts.ts', 'stable application source');
  const initial = captureNativeAppSources(root);
  for (const path of [
    'packages/react-native-whip-ssh/src/generated/whip_ssh.ts',
    'packages/react-native-whip-ssh/cpp/generated/whip_ssh.cpp',
    'packages/react-native-whip-ssh/rust/target/aarch64-linux-android/release/libwhip_ssh.a',
    'android/app/src/main/assets/terminal.html',
  ]) write(path, 'regenerated build output');
  expect(captureNativeAppSources(root)).toEqual(initial);
});
