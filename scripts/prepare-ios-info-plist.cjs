const fs = require('node:fs');
const path = require('node:path');
const plist = require('@expo/plist').default;
const { version } = require('./app-version.cjs');

// Xcode consumes this build-local plist; the checked-in template has no version.
// Explicit input/output dependencies rerun this when package.json changes.
const [input, output] = process.argv.slice(2);
const info = plist.parse(fs.readFileSync(input, 'utf8'));
if ('CFBundleShortVersionString' in info) {
  throw new Error('Remove CFBundleShortVersionString from the iOS template; package.json owns the marketing version');
}
info.CFBundleShortVersionString = version;
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, plist.build(info));
console.log(`iOS CFBundleShortVersionString: ${version}`);
