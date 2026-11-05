const {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {MARKDOWN_PACKAGE, verifyNativeMarkdownPatch} = require('../scripts/check-native-markdown-patch.cjs');

let root;
let dependency;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'whip-markdown-patch-'));
  const directory = join(root, 'node_modules', MARKDOWN_PACKAGE);
  mkdirSync(directory, {recursive: true});
  mkdirSync(join(root, 'patches'));
  dependency = join(directory, 'renderer.txt');
  const path = `node_modules/${MARKDOWN_PACKAGE}/renderer.txt`;
  writeFileSync(join(root, 'patches', `${MARKDOWN_PACKAGE}+1.0.0.patch`),
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n-old highlighter\n-old captions\n+rust highlighter\n+native captions\n`);
});

afterEach(() => { rmSync(root, {recursive: true, force: true}); });

test('accepts the fully patched dependency without changing it', () => {
  const contents = 'rust highlighter\nnative captions\n';
  writeFileSync(dependency, contents);
  expect(() => verifyNativeMarkdownPatch(root)).not.toThrow();
  expect(readFileSync(dependency, 'utf8')).toBe(contents);
});

test.each([
  'old highlighter\nold captions\n',
  'old highlighter\nnative captions\n',
])('blocks an unpatched or partially updated dependency', contents => {
  writeFileSync(dependency, contents);
  expect(() => verifyNativeMarkdownPatch(root)).toThrow('Run npm ci before building');
  expect(readFileSync(dependency, 'utf8')).toBe(contents);
});
