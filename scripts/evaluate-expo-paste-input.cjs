/* eslint-env node, es2022 */
// Evaluation for #322. Native hosts are mocked; this does not test native IME/paste.
// Pass the extracted expo-paste-input@0.2.2 package directory as argv[2].
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const { act, create } = require('react-test-renderer');
const { transformSync } = require('esbuild');

global.IS_REACT_ACT_ENVIRONMENT = true;
const handle = { tag: 42, focus() {}, clear() {} };
const fontTags = [];
let pasteBindings = 0;
const mocks = {
  expo: { requireNativeView: () => 'PasteWrapper' },
  'react-native': { findNodeHandle: node => node.tag, View: 'View' },
  './ui/input': { Input: 'NativeInput' },
  '../services/composerFont': { watchComposerFont: tag => {
    fontTags.push(tag);
    return () => {};
  } },
  '../services/composerImagePaste': { watchComposerImagePaste: () => {
    pasteBindings++;
    return () => {};
  } },
};
function loadSource(filename) {
  const module = { exports: {} };
  const code = transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: 'tsx', format: 'cjs', jsx: 'automatic',
  }).code;
  const localRequire = id => {
    if (id === 'react' || id.startsWith('react/')) return require(id);
    return mocks[id] || {};
  };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(
    localRequire, module, module.exports,
  );
  return module.exports;
}
const packageDirectory = process.argv[2];
assert.ok(packageDirectory, 'Usage: node scripts/evaluate-expo-paste-input.cjs <extracted-package-directory>');
assert.equal(JSON.parse(fs.readFileSync(path.resolve(packageDirectory, 'package.json'), 'utf8')).version, '0.2.2');
const { ComposerInput } = loadSource(path.resolve(__dirname, '../src/components/MessageComposer.tsx'));
const { TextInputWrapperView } = loadSource(path.resolve(packageDirectory, 'build/TextInputWrapperView.js'));
const ref = React.createRef();
const delivered = [];
let changes = 0;
function Prototype({ target }) {
  const [text, setText] = React.useState('中文 draft');
  return React.createElement(TextInputWrapperView, {
    onPaste: payload => delivered.push({ target, payload }),
  }, React.createElement(ComposerInput, {
    ref, initialValue: text, pasteTargetKey: target,
    onChangeText: value => { changes++; setText(value); },
  }));
}
let inputMounts = 0;
let renderer;
act(() => {
  renderer = create(React.createElement(Prototype, { target: 'A' }), {
    createNodeMock: node => {
      if (node.type === 'NativeInput') { inputMounts++; return handle; }
      return {};
    },
  });
});
const input = renderer.root.findByType('NativeInput');
act(() => input.props.onLayout({ nativeEvent: {} }));
assert.equal(ref.current, handle);
assert.deepEqual(fontTags, [42]);
for (const text of ['中', '中文', '中文 text', '中文 text!']) {
  act(() => input.props.onChangeText(text));
  assert.equal(renderer.root.findByType('NativeInput'), input);
  assert.equal(input.props.defaultValue, '中文 draft');
  assert.equal(input.props.value, undefined);
  assert.equal(ref.current, handle);
}
assert.equal(inputMounts, 1);
assert.equal(changes, 4);
assert.equal(delivered.length, 0);
assert.equal(pasteBindings, 0);
// Model an iOS job started for A and completed after updating the same wrapper.
// This tests the JS API's ambiguity, not UIKit event dispatch or file creation.
const delayedPayload = { type: 'images', uris: ['file:///tmp/from-A.png'] };
act(() => renderer.update(React.createElement(Prototype, { target: 'B' })));
act(() => renderer.root.findByType('PasteWrapper').props.onPaste({ nativeEvent: delayedPayload }));
assert.deepEqual(delivered, [{ target: 'B', payload: delayedPayload }]);
assert.equal(inputMounts, 1);
assert.deepEqual(fontTags, [42, 42]);
act(() => renderer.unmount());
assert.equal(ref.current, null);
console.log(JSON.stringify({
  inputMounts, changes, fontTags, ordinaryTypingPasteEvents: 0,
  customPasteBindings: pasteBindings, delayedOrigin: 'A', deliveredTarget: delivered[0].target,
  scope: 'React renderer with mocked native hosts; no native compatibility or IME claim',
}, null, 2));
