const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildBridge, prepareDependencies } = require('../scripts/ios-build-cache.cjs');

const modulePath = 'packages/react-native-whip-ssh';
const archivePath = 'build/cargo/aarch64-apple-ios/release/libwhip_ssh.a';
const frameworkPath = `${modulePath}/build/WhipSsh.xcframework`;
let root;
let calls;
let failGeneration;
let xcodeVersion;

function write(file, contents = file) {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function count(command, firstArgument) {
  return calls.filter(call => call.command === command && call.args[0] === firstArgument).length;
}

// Exercise real cache files and generated artifacts, substituting only external
// build tools so invalidation and failure recovery also run on Linux.
function execute(command, args, { cwd }) {
  calls.push({ command, args, cwd });
  if (command === 'cargo' && args[0] === 'metadata') {
    return JSON.stringify({ target_directory: path.join(root, 'build/cargo') });
  }
  if (command === 'xcodebuild') return xcodeVersion;
  if (command === 'pod' && args[0] === '--version') return '1.16.2';
  if (command === 'npm') {
    write('node_modules/.package-lock.json', fs.readFileSync(path.join(root, 'package-lock.json')));
    write('node_modules/.bin/expo');
    write('node_modules/.bin/ubrn');
  } else if (command === 'bash') {
    buildBridge(root, execute);
  } else if (command === 'ubrn') {
    if (failGeneration) throw new Error('generator failed');
    write(`${frameworkPath}/Info.plist`);
    write(`${frameworkPath}/ios-arm64/libwhip_ssh.a`, fs.readFileSync(path.join(root, archivePath)));
    write(`${modulePath}/cpp/generated/whip_ssh.cpp`);
    write(`${modulePath}/cpp/generated/whip_ssh.hpp`);
    write(`${modulePath}/src/generated/whip_ssh.ts`);
    write(`${modulePath}/src/generated/whip_ssh-ffi.ts`);
    write(`${modulePath}/src/NativeWhipSsh.ts`);
    write(`${modulePath}/src/generated-entry.tsx`);
  } else if (command === 'pod') {
    write('ios/Podfile.lock');
    write('ios/Pods/Manifest.lock');
    write('ios/Pods/Pods.xcodeproj/project.pbxproj');
    write('ios/Pods/Target Support Files/Pods-HerdR/Pods-HerdR.release.xcconfig');
    write('ios/HerdR.xcodeproj/project.pbxproj');
    write('ios/HerdR.xcworkspace/contents.xcworkspacedata');
  }
  return '';
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'whip-ios-build-'));
  calls = [];
  failGeneration = false;
  xcodeVersion = 'Xcode 26.0';
  for (const file of ['package.json', 'package-lock.json', `${modulePath}/package.json`,
    'modules/whip-native-spinner/package.json', 'modules/whip-native-spinner/ios/Spinner.swift',
    `${modulePath}/ubrn.config.yaml`, `${modulePath}/rust/Cargo.toml`, 'ios/Podfile',
    'scripts/instrument-terminal-bindings.ts', 'patches/uniffi-bindgen-react-native+0.31.0-3.patch',
    archivePath]) write(file);
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

test('TS-only installs preserve dependencies, the framework and native binding timestamps', () => {
  prepareDependencies(root, execute);
  const outputs = [`${frameworkPath}/ios-arm64/libwhip_ssh.a`, `${modulePath}/cpp/generated/whip_ssh.cpp`];
  const timestamp = new Date('2020-01-01T00:00:00Z');
  for (const file of outputs) fs.utimesSync(path.join(root, file), timestamp, timestamp);

  write('src/App.tsx', 'export default () => "updated UI";');
  prepareDependencies(root, execute);

  expect(count('npm', 'ci')).toBe(1);
  expect(count('pod', 'install')).toBe(1);
  expect(count('ubrn', 'build')).toBe(1);
  expect(count('cargo', 'build')).toBe(2);
  // rustup discovers rust-toolchain.toml from the working directory.
  for (const call of calls.filter(entry => entry.command === 'cargo')) {
    expect(call.cwd).toBe(path.join(root, modulePath, 'rust'));
  }
  for (const file of outputs) expect(fs.statSync(path.join(root, file)).mtimeMs).toBe(timestamp.getTime());
});

test.each([archivePath, `${modulePath}/ubrn.config.yaml`, 'package-lock.json',
  'patches/uniffi-bindgen-react-native+0.31.0-3.patch', 'scripts/instrument-terminal-bindings.ts'])(
  'refreshes the bridge when %s changes', file => {
    buildBridge(root, execute);
    write(file, 'changed build input');
    buildBridge(root, execute);
    expect(count('ubrn', 'build')).toBe(2);
    expect(calls.find(call => call.command === 'ubrn').args).toEqual(expect.arrayContaining([
      '--no-cargo', '--no-sim', '--targets', 'aarch64-apple-ios',
    ]));
  },
);

test.each([`${modulePath}/src/generated/whip_ssh-ffi.ts`, `${frameworkPath}/ios-arm64/libwhip_ssh.a`])(
  'regenerates a missing output even if its parent directory still exists: %s', file => {
    buildBridge(root, execute);
    fs.rmSync(path.join(root, file));
    buildBridge(root, execute);
    expect(count('ubrn', 'build')).toBe(2);
    expect(fs.existsSync(path.join(root, file))).toBe(true);
  },
);

test('repairs bindings overwritten by a build for another platform', () => {
  buildBridge(root, execute);
  write(`${modulePath}/cpp/generated/whip_ssh.cpp`, 'Android-generated binding');
  buildBridge(root, execute);
  expect(count('ubrn', 'build')).toBe(2);
});

test('failed generation invalidates the old success stamp even after reverting inputs', () => {
  buildBridge(root, execute);
  const original = fs.readFileSync(path.join(root, archivePath));
  write(archivePath, 'new Rust library');
  failGeneration = true;
  expect(() => buildBridge(root, execute)).toThrow('generator failed');

  write(archivePath, original);
  failGeneration = false;
  buildBridge(root, execute);
  expect(count('ubrn', 'build')).toBe(3);
});

test.each(['NewView.swift', 'NewBridge.h'])(
  'dependency updates reinstall npm and CocoaPods while adding %s only refreshes CocoaPods', nativeFile => {
    prepareDependencies(root, execute);
    write('package-lock.json', 'updated dependencies');
    prepareDependencies(root, execute);
    expect(count('npm', 'ci')).toBe(2);
    expect(count('pod', 'install')).toBe(2);

    write(`modules/whip-native-spinner/ios/${nativeFile}`, 'new native source');
    prepareDependencies(root, execute);
    expect(count('npm', 'ci')).toBe(2);
    expect(count('pod', 'install')).toBe(3);
    expect(count('ubrn', 'build')).toBe(2);
  },
);

test('repairs removed dependencies and CocoaPods support files', () => {
  prepareDependencies(root, execute);
  fs.rmSync(path.join(root, 'node_modules/.bin/ubrn'));
  fs.rmSync(path.join(root, 'ios/Pods/Target Support Files/Pods-HerdR'), { recursive: true });
  prepareDependencies(root, execute);
  expect(count('npm', 'ci')).toBe(2);
  expect(count('pod', 'install')).toBe(2);
});

test('a changed Podfile lock is reconciled without reinstalling JavaScript dependencies', () => {
  prepareDependencies(root, execute);
  write('ios/Podfile.lock', 'changed pod resolution');
  prepareDependencies(root, execute);
  expect(count('npm', 'ci')).toBe(1);
  expect(count('pod', 'install')).toBe(2);
});

test('a native dependency patch refreshes npm and CocoaPods without regenerating unchanged Rust bindings', () => {
  prepareDependencies(root, execute);
  write('patches/expo-blur.patch', 'updated native podspec');
  prepareDependencies(root, execute);
  expect(count('npm', 'ci')).toBe(2);
  expect(count('pod', 'install')).toBe(2);
  expect(count('ubrn', 'build')).toBe(1);
});

test('an Xcode upgrade refreshes the framework and CocoaPods without reinstalling npm', () => {
  prepareDependencies(root, execute);
  xcodeVersion = 'Xcode 26.1';
  prepareDependencies(root, execute);
  expect(count('npm', 'ci')).toBe(1);
  expect(count('pod', 'install')).toBe(2);
  expect(count('ubrn', 'build')).toBe(2);
});
