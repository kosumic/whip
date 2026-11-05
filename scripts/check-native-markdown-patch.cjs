const {spawnSync} = require('node:child_process');
const {readdirSync} = require('node:fs');
const {join, resolve} = require('node:path');

const MARKDOWN_PACKAGE = 'react-native-enriched-markdown';

function verifyNativeMarkdownPatch(root) {
  const directory = join(root, 'patches');
  const patches = readdirSync(directory).filter(name => name.startsWith(`${MARKDOWN_PACKAGE}+`) && name.endsWith('.patch'));
  if (patches.length !== 1) throw new Error(`Expected one native Markdown patch, found ${patches.length}`);
  // A reverse dry run verifies the installed files, including an older patch
  // that was only partly updated. It never modifies the dependency.
  const result = spawnSync('git', ['apply', '--reverse', '--check', join(directory, patches[0])], {cwd: root, encoding: 'utf8'});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Native Markdown dependency is stale or incompletely patched (${patches[0]}). Run npm ci before building.\n${result.stderr.trim()}`);
  }
}

module.exports = {MARKDOWN_PACKAGE, verifyNativeMarkdownPatch};

if (require.main === module) {
  try {
    verifyNativeMarkdownPatch(resolve(process.argv[2] || join(__dirname, '..')));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
