const { execFileSync } = require('node:child_process');
const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const modulePath = 'packages/react-native-whip-ssh';
const iosTarget = 'aarch64-apple-ios';

function run(command, args, { cwd, capture = false } = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}

// Hash contents rather than mtimes: syncing a worktree must not invalidate it.
// Stream archives in bounded chunks; the Rust static library can exceed 400 MB.
function fingerprint(root, files, context = []) {
  const hash = createHash('sha256').update(JSON.stringify([root, ...context]));
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  function visit(file) {
    const absolute = path.resolve(root, file);
    hash.update(JSON.stringify(file));
    if (!fs.existsSync(absolute)) {
      hash.update('missing');
    } else if (fs.statSync(absolute).isDirectory()) {
      hash.update('directory');
      for (const child of fs.readdirSync(absolute).sort()) visit(path.join(file, child));
    } else {
      hash.update(`file:${fs.statSync(absolute).size}:`);
      const descriptor = fs.openSync(absolute, 'r');
      try {
        let bytes;
        while ((bytes = fs.readSync(descriptor, buffer)) !== 0) hash.update(buffer.subarray(0, bytes));
      } finally {
        fs.closeSync(descriptor);
      }
    }
  }
  for (const file of [...files].sort()) visit(file);
  return hash.digest('hex');
}

function cachedStep({ root, name, stamp, inputs, outputs, context = [], action }) {
  const stampPath = path.join(root, stamp);
  const input = fingerprint(root, inputs, context);
  let previous;
  try {
    previous = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const outputsExist = () => outputs.every(file => fs.existsSync(path.join(root, file)));
  if (previous && previous.input === input && outputsExist() && previous.output === fingerprint(root, outputs)) {
    console.log(`${name} is up to date`);
    return;
  }

  // A failed install/generation must never leave an earlier success stamp valid.
  fs.rmSync(stampPath, { force: true });
  console.log(`Preparing ${name}`);
  action();
  if (!outputsExist()) throw new Error(`${name} did not produce its required outputs`);
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, JSON.stringify({ input, output: fingerprint(root, outputs) }));
}

function localPackages(root) {
  return ['packages', 'modules'].flatMap(directory =>
    fs.readdirSync(path.join(root, directory)).map(name => path.join(directory, name))
      .filter(directoryPath => fs.existsSync(path.join(root, directoryPath, 'package.json')))
  );
}

function nativeInputs(root, directories) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['build', 'target', 'node_modules', 'TerminalAssets', 'android'].includes(entry.name)) visit(file);
      } else if (/\.(podspec|swift|mm?|h|hpp|cpp|cc|cxx|c)$/.test(entry.name)
        || /^(Native.*\.tsx?|package\.json|react-native\.config\.js|expo-module\.config\.json)$/.test(entry.name)) {
        files.push(file);
      }
    }
  }
  for (const directory of directories) visit(directory);
  return files;
}

function prepareDependencies(root, execute = run) {
  const packages = localPackages(root);
  cachedStep({
    root,
    name: 'iOS JavaScript dependencies',
    stamp: 'node_modules/.whip-ios-dependencies.json',
    inputs: ['package.json', 'package-lock.json', '.npmrc', 'patches',
      ...packages.map(directory => `${directory}/package.json`)],
    outputs: ['node_modules/.package-lock.json', 'node_modules/.bin/expo', 'node_modules/.bin/ubrn'],
    context: [process.version, process.platform, process.arch],
    action: () => execute('npm', ['ci', '--include=dev', '--ignore-scripts=false'], { cwd: root }),
  });

  // These depend on application sources, not just package-lock.json. Run their
  // incremental checks even when npm ci was skipped (notably after Rust edits).
  execute(process.execPath, ['scripts/sync-terminal-assets.ts'], { cwd: root });
  execute('bash', ['scripts/build-ios-uniffi.sh'], { cwd: root });

  cachedStep({
    root,
    name: 'CocoaPods',
    stamp: 'ios/Pods/.whip-ios-dependencies.json',
    inputs: ['ios/Podfile', 'ios/Podfile.properties.json', 'Gemfile', 'Gemfile.lock',
      'package.json', 'package-lock.json', 'patches', 'app.json', 'app.config.js', 'react-native.config.js',
      'assets/terminal-fonts', 'scripts/sync-terminal-assets.ts',
      ...nativeInputs(root, packages)],
    outputs: ['ios/Podfile.lock', 'ios/Pods/Manifest.lock', 'ios/Pods/Pods.xcodeproj/project.pbxproj',
      'ios/Pods/Target Support Files/Pods-HerdR', 'ios/HerdR.xcodeproj/project.pbxproj',
      'ios/HerdR.xcworkspace/contents.xcworkspacedata'],
    context: [process.execPath, execute('pod', ['--version'], { cwd: root, capture: true }),
      execute('xcodebuild', ['-version'], { cwd: root, capture: true }),
      ...['USE_FRAMEWORKS', 'RCT_NEW_ARCH_ENABLED', 'RCT_USE_PREBUILT_RN', 'RCT_USE_RN_DEP',
        'EXPO_USE_COMMUNITY_AUTOLINKING', 'WHIP_DISTRIBUTION_CHANNEL', 'DEVELOPER_DIR', 'NODE_ENV']
        .map(name => [name, process.env[name]])],
    action: () => execute('pod', ['install'], { cwd: path.join(root, 'ios') }),
  });
}

function buildBridge(root, execute = run) {
  const directory = path.join(root, modulePath);
  const rustDirectory = path.join(directory, 'rust');
  const manifest = path.join(rustDirectory, 'Cargo.toml');
  // Cargo tracks Rust sources, include_str! assets, build scripts, compiler flags,
  // SDK/toolchain changes and dependency changes. Do not duplicate its rules.
  execute('cargo', ['build', '--locked', '--manifest-path', manifest, '--target', iosTarget, '--release'], { cwd: rustDirectory });
  const metadata = JSON.parse(execute('cargo', ['metadata', '--locked', '--no-deps',
    '--format-version', '1', '--manifest-path', manifest], { cwd: rustDirectory, capture: true }));
  const archive = path.join(metadata.target_directory, iosTarget, 'release/libwhip_ssh.a');
  cachedStep({
    root,
    name: 'iOS Rust framework and bindings',
    stamp: `${modulePath}/build/.whip-ios-bridge.json`,
    inputs: [archive, `${modulePath}/ubrn.config.yaml`, 'package-lock.json',
      'node_modules/uniffi-bindgen-react-native/package.json',
      'patches/uniffi-bindgen-react-native+0.31.0-3.patch',
      'scripts/build-ios-uniffi.sh', 'scripts/ios-build-cache.cjs', 'scripts/instrument-terminal-bindings.ts'],
    outputs: [`${modulePath}/build/WhipSsh.xcframework/Info.plist`,
      `${modulePath}/build/WhipSsh.xcframework/ios-arm64/libwhip_ssh.a`,
      `${modulePath}/cpp/generated`, `${modulePath}/src/generated`, `${modulePath}/src/NativeWhipSsh.ts`,
      `${modulePath}/src/generated-entry.tsx`],
    context: [process.env.DEVELOPER_DIR, process.env.IPHONEOS_DEPLOYMENT_TARGET,
      execute('xcodebuild', ['-version'], { cwd: root, capture: true })],
    action() {
      execute('ubrn', ['build', 'ios', '--config', 'ubrn.config.yaml', '--release',
        '--and-generate', '--no-sim', '--no-cargo', '--targets', iosTarget], { cwd: directory });
      execute(process.execPath, ['scripts/instrument-terminal-bindings.ts'], { cwd: root });
    },
  });
}

module.exports = { prepareDependencies, buildBridge };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const commands = { dependencies: prepareDependencies, bridge: buildBridge };
  const command = commands[process.argv[2]];
  if (!Object.hasOwn(commands, process.argv[2]) || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/ios-build-cache.cjs dependencies|bridge');
  }
  command(root);
}
