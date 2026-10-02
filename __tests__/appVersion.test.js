const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const plist = require('@expo/plist').default;

const root = path.resolve(__dirname, '..');
let fixture;

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'whip-version-'));
  fs.mkdirSync(path.join(fixture, 'scripts'));
  for (const script of ['app-version.cjs', 'prepare-ios-info-plist.cjs']) {
    fs.copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
  }
  fs.copyFileSync(path.join(root, 'app.config.js'), path.join(fixture, 'app.config.js'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
});

afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

function run(script, ...args) {
  return spawnSync(process.execPath, [path.join(fixture, 'scripts', script), ...args], {
    encoding: 'utf8',
  });
}

test.each(['1.6.3', '1.6.4'])('a package-only bump to %s reaches Expo, iOS, and the tag gate', version => {
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version }));
  for (const tag of [version, `v${version}`]) {
    expect(run('app-version.cjs', '--tag', tag).status).toBe(0);
  }
  const wrongVersion = version === '1.6.3' ? '1.6.4' : '1.6.3';
  const mismatch = run('app-version.cjs', '--tag', `v${wrongVersion}`);
  expect(mismatch.status).toBe(1);
  expect(mismatch.stderr).toContain(`expected ${version} (package.json), actual "${wrongVersion}"`);

  const expo = spawnSync(process.execPath, ['-e',
    'console.log(require(process.argv[1])({config: {}}).version)', path.join(fixture, 'app.config.js'),
  ], { encoding: 'utf8' });
  expect(expo.status).toBe(0);
  expect(expo.stdout.trim()).toBe(version);

  const output = path.join(fixture, 'DerivedSources', 'Info.plist');
  const prepared = run('prepare-ios-info-plist.cjs', path.join(root, 'ios/HerdR/Info.plist'), output);
  expect(prepared.stderr).toBe('');
  expect(prepared.status).toBe(0);
  const info = plist.parse(fs.readFileSync(output, 'utf8'));
  expect(info.CFBundleShortVersionString).toBe(version);
  expect(info.CFBundleVersion).toBe('$(CURRENT_PROJECT_VERSION)');

  // A stale marketing version in the template must fail instead of winning.
  expect(run('prepare-ios-info-plist.cjs', output, output).status).toBe(1);
  expect(run('app-version.cjs', '--actual', 'APK versionName', '9.9.9').status).toBe(1);
});

test.each(['01.6.3', '1.6', '1.6.3-beta.1'])('rejects unsupported store version %s', version => {
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version }));
  expect(run('app-version.cjs').status).toBe(1);
});
