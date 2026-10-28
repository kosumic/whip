/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { CODE_EDITOR_ACTIONS, type CodeEditorDocument } from '../src/lib/codeEditor';

const asset = (name: string) => readFileSync(resolve(__dirname, '../android/app/src/main/assets', name), 'utf8');
const mixedText = 'const 中文\u{e0100} = "日本語😀한국어";\n\n';
const source: CodeEditorDocument = {
  content: mixedText, filename: 'example.ts', requestId: 1, readOnly: false, dark: true, fontSize: 12,
  labels: Object.fromEntries([...CODE_EDITOR_ACTIONS, 'line', 'column', 'characters', 'selections', 'edit', 'language', 'autoLanguage', 'plainText', 'indentation', 'tabs', 'spaces'].map(key => [key, key])),
  phrases: { Find: '查找', Replace: '替换' },
  colors: { foreground: '#fff', canvas: '#000', surface: '#222', border: '#444', accent: '#08f' },
};
let dom: JSDOM;
let messages: Record<string, unknown>[];
const editor = () => EditorView.findFromDOM(dom.window.document.getElementById('editor')!)!;
const command = (name: string) => (dom.window.document.querySelector(`[data-command="${name}"]`) as HTMLButtonElement).click();
const settle = () => new Promise(done => setTimeout(done, 20));
async function load(content = mixedText, readOnly = false, filename = 'example.ts') {
  dom.window.whipSetCodeDocument({ ...source, content, readOnly, filename });
  await settle();
}
beforeEach(() => {
  messages = [];
  dom = new JSDOM(asset('code-editor.html'), { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.ReactNativeWebView = { postMessage: (data: string) => messages.push(JSON.parse(data)) };
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [] });
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  dom.window.HTMLElement.prototype.scrollTo = jest.fn();
  dom.window.eval(asset('code-editor.js'));
});
afterEach(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); });

test('loads exact Unicode and blank lines with syntax highlighting and the bundled CJK font', async () => {
  await load();
  expect(messages[0]).toMatchObject({ type: 'ready' });
  expect(editor().state.doc.toString()).toBe(mixedText);
  expect(editor().state.doc.lines).toBe(3);
  expect(dom.window.document.querySelector('.cm-line span')).not.toBeNull();
  expect(dom.window.getComputedStyle(editor().scrollDOM).fontFamily).toContain('WhipChatCJK');
});

test('mobile commands change real editor state and undo history survives theme changes', async () => {
  await load('const value = 1;\n');
  command('selectAll'); command('indent');
  expect(editor().state.doc.toString()).toBe('  const value = 1;\n');
  expect(messages.filter(message => message.type === 'change').at(-1)).toMatchObject({ value: '  const value = 1;\n', requestId: 1 });
  dom.window.whipConfigureCodeEditor({ ...source, dark: false, fontSize: 18 });
  command('undo');
  expect(editor().state.doc.toString()).toBe('const value = 1;\n');
  command('redo');
  expect(editor().state.doc.toString()).toBe('  const value = 1;\n');
  command('comment');
  expect(editor().state.doc.toString()).toContain('//');
});

test('search supports localized controls, regex, replace all, and read-only search', async () => {
  await load('item1 item2 other');
  command('find');
  const document = dom.window.document;
  const field = (name: string) => document.querySelector(`.cm-search input[name="${name}"]`) as HTMLInputElement;
  expect(field('search').getAttribute('aria-label')).toBe('查找');
  field('search').value = 'item\\d'; field('replace').value = 'done'; field('re').checked = true;
  field('search').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  (document.querySelector('.cm-search button[name="replaceAll"]') as HTMLButtonElement).click();
  expect(editor().state.doc.toString()).toBe('done done other');
  await load('read only', true);
  command('find');
  expect(field('search')).not.toBeNull();
  expect(field('replace')).toBeNull();
  command('deleteLine');
  expect(editor().state.doc.toString()).toBe('read only');
  expect(editor().contentDOM.getAttribute('contenteditable')).toBe('false');
  const saves = messages.filter(message => message.type === 'save').length;
  dom.window.whipSaveCodeEditor();
  expect(messages.filter(message => message.type === 'save')).toHaveLength(saves);
});

test('supports multiple selections, line folding, navigation, completion and save shortcuts', async () => {
  await load('function demo() {\n  const apple = 1;\n  return apple;\n}\n');
  editor().dispatch({ selection: { anchor: 26, head: 31 } });
  command('selectNext');
  expect(editor().state.selection.ranges).toHaveLength(2);
  command('singleSelection');
  expect(editor().state.selection.ranges).toHaveLength(1);
  command('selectAll'); command('splitSelection');
  expect(editor().state.selection.ranges).toHaveLength(4);
  command('singleSelection'); command('foldAll');
  expect(dom.window.document.querySelector('.cm-foldPlaceholder')).not.toBeNull();
  command('unfoldAll');
  expect(dom.window.document.querySelector('.cm-foldPlaceholder')).toBeNull();
  dom.window.whipRevealCodeLine(3);
  expect(editor().state.doc.lineAt(editor().state.selection.main.head).number).toBe(3);
  editor().dispatch({ selection: { anchor: 29, head: 29 } });
  command('complete'); await new Promise(done => setTimeout(done, 120));
  expect(dom.window.document.querySelector('.cm-tooltip-autocomplete')).not.toBeNull();
  editor().contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true }));
  expect(messages.some(message => message.type === 'save' && message.value === editor().state.doc.toString())).toBe(true);
  editor().dispatch({ changes: { from: 0, insert: '// latest\n' } });
  dom.window.whipSaveCodeEditor();
  expect(messages.at(-1)).toMatchObject({ type: 'save', value: editor().state.doc.toString() });
});

test('switching documents cancels a pending language load and resets history', async () => {
  dom.window.whipSetCodeDocument({ ...source, filename: 'first.rs', content: 'fn main() {}' });
  dom.window.whipSetCodeDocument({ ...source, filename: 'next.json', content: '{"name": 1}', requestId: 2 });
  await settle();
  expect(editor().state.doc.toString()).toBe('{"name": 1}');
  expect(dom.window.document.querySelector('#language')!.getAttribute('title')).toBe('JSON');
  expect((dom.window.document.querySelector('[data-command="undo"]') as HTMLButtonElement).disabled).toBe(true);
});
