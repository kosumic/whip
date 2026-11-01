const {createHash} = require('node:crypto');
const {existsSync, readFileSync, readdirSync} = require('node:fs');
const {extname, join, relative, resolve, sep} = require('node:path');

// Generated bindings and assets are expected to change during compilation.
// Their source inputs must stay fixed until the APK has been packaged.
const SOURCE_ROOTS = ['src', 'packages', 'modules', 'crates/tailcat-client', 'whip-notify/src', 'scripts', 'patches', 'android/app/src/main'];
const OUTPUT_DIRECTORIES = new Set(['node_modules', 'build', 'target', '.git', '.cxx', 'generated', 'Pods', 'TerminalAssets', 'assets', 'jniLibs']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.rs', '.toml', '.lock', '.go', '.mod', '.sum', '.cpp', '.c', '.h', '.hpp', '.m', '.mm', '.swift', '.kt', '.java', '.gradle', '.properties', '.cmake', '.txt', '.json', '.xml', '.yaml', '.yml', '.sh', '.html', '.css', '.sql', '.patch']);
const ROOT_FILES = ['index.js', 'package.json', 'package-lock.json', 'app.json', 'app.config.js', 'babel.config.js', 'metro.config.js', 'tailwind.config.js', 'global.css', 'flake.nix', 'flake.lock', 'android/build.gradle', 'android/settings.gradle', 'android/gradle.properties', 'android/app/build.gradle', 'whip-notify/Cargo.toml', 'whip-notify/Cargo.lock', 'whip-notify/platform.sh'];

function captureNativeAppSources(root) {
  const files = new Map();
  const capture = file => {
    const path = relative(root, file).split(sep).join('/');
    files.set(path, createHash('sha256').update(readFileSync(file)).digest('hex'));
  };
  const walk = directory => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !OUTPUT_DIRECTORIES.has(entry.name)) walk(path);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) capture(path);
    }
  };
  for (const directory of SOURCE_ROOTS) walk(join(root, directory));
  for (const path of ROOT_FILES) {
    const file = join(root, path);
    if (existsSync(file)) capture(file);
  }
  return Object.fromEntries([...files].sort(([left], [right]) => left.localeCompare(right)));
}

module.exports = {captureNativeAppSources};

if (require.main === module) {
  process.stdout.write(JSON.stringify(captureNativeAppSources(resolve(process.argv[2] || join(__dirname, '..')))));
}
