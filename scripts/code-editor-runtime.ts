import { basicSetup } from 'codemirror';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultHighlightStyle, foldAll, HighlightStyle, indentUnit, LanguageDescription, syntaxHighlighting, unfoldAll } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { languages } from '@codemirror/language-data';
import { completeAnyWord, startCompletion } from '@codemirror/autocomplete';
import { copyLineDown, deleteLine, indentLess, indentMore, indentWithTab, moveLineDown, moveLineUp, redo, redoDepth, selectAll, simplifySelection, toggleComment, undo, undoDepth } from '@codemirror/commands';
import { gotoLine, openSearchPanel, selectNextOccurrence } from '@codemirror/search';
import { jsonParseLinter } from '@codemirror/lang-json';
import { linter } from '@codemirror/lint';
import { CODE_EDITOR_ACTIONS, type CodeEditorAction, type CodeEditorDocument, type CodeEditorOptions } from '../src/lib/codeEditor.ts';

interface EditorWindow extends Window {
  ReactNativeWebView?: { postMessage: (data: string) => void };
  whipSetCodeDocument?: (document: CodeEditorDocument) => void;
  whipConfigureCodeEditor?: (options: CodeEditorOptions) => void;
  whipScrollCodeEditor?: (x: number, y: number) => void;
  whipRevealCodeLine?: (line: number) => void;
  whipSaveCodeEditor?: () => void;
}
const host = window as EditorWindow;
const language = new Compartment();
const appearance = new Compartment();
const permission = new Compartment();
const wrapping = new Compartment();
const indentation = new Compartment();
const phrases = new Compartment();
let editor: EditorView | null = null;
let options: CodeEditorOptions;
let requestId = 0;
let languageRequest = 0;
let wrap = false;
let tabSize = 2;
let scrollTimer: ReturnType<typeof setTimeout>;
const root = document.getElementById('editor')!;
const toolbar = document.getElementById('toolbar')!;
const status = document.getElementById('status')!;
const languageSelect = document.getElementById('language') as HTMLSelectElement;
const post = (message: object) => host.ReactNativeWebView?.postMessage(JSON.stringify({ ...message, requestId }));
const commandButtons = new Map<CodeEditorAction, HTMLButtonElement>();
const darkHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#bb9af7' },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName], color: '#c0caf5' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#7aa2f7' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#ff9e64' },
  { tag: [tags.definition(tags.name), tags.separator], color: '#89ddff' },
  { tag: [tags.typeName, tags.className, tags.number, tags.bool, tags.null], color: '#e0af68' },
  { tag: [tags.operator, tags.punctuation], color: '#89ddff' },
  { tag: [tags.string, tags.regexp, tags.inserted], color: '#9ece6a' },
  { tag: [tags.meta, tags.comment], color: '#a9b1d6', fontStyle: 'italic' },
  { tag: tags.heading, fontWeight: 'bold', color: '#7aa2f7' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#7dcfff', textDecoration: 'underline' },
  { tag: tags.invalid, color: '#f7768e' },
]);

function geometry() {
  const scroller = editor?.scrollDOM;
  return scroller ? {
    x: scroller.scrollLeft, y: scroller.scrollTop, width: scroller.scrollWidth, height: scroller.scrollHeight,
    viewportWidth: scroller.clientWidth, viewportHeight: scroller.clientHeight,
  } : { x: 0, y: 0, width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 };
}
function reportSize() { post({ type: 'size', ...geometry() }); }
function updateStatus() {
  if (!editor) return;
  const state = editor.state;
  const selection = state.selection.main;
  const line = state.doc.lineAt(selection.head);
  status.textContent = `${options.labels.line} ${line.number}, ${options.labels.column} ${selection.head - line.from + 1} · ${state.doc.length.toLocaleString()} ${options.labels.characters}${state.selection.ranges.length > 1 ? ` · ${state.selection.ranges.length} ${options.labels.selections}` : ''}`;
  commandButtons.get('undo')!.disabled = options.readOnly || undoDepth(state) === 0;
  commandButtons.get('redo')!.disabled = options.readOnly || redoDepth(state) === 0;
}
function theme() {
  const c = options.colors;
  return [syntaxHighlighting(options.dark ? darkHighlightStyle : defaultHighlightStyle), EditorView.theme({
    '&': { color: c.foreground, backgroundColor: c.canvas, fontSize: `${options.fontSize}px`, height: '100%' },
    '.cm-scroller': { fontFamily: 'WhipChatCJK, "JetBrains Mono", monospace', lineHeight: '1.6', overflow: 'auto' },
    '.cm-content': { padding: '12px 0', caretColor: c.accent },
    '.cm-line': { padding: '0 12px' },
    '.cm-gutters': { backgroundColor: c.surface, color: c.muted, borderRightColor: c.border },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: c.highlight },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.accent },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: c.selection },
    '.cm-panels, .cm-tooltip': { backgroundColor: c.surface, color: c.foreground, borderColor: c.border },
    '.cm-searchMatch': { backgroundColor: c.match },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: c.selection },
    '.cm-selectionMatch': { backgroundColor: c.match },
    '.cm-foldPlaceholder': { backgroundColor: c.surface, color: c.muted, borderColor: c.border },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: c.accent, color: c.onAccent },
    '.cm-textfield, .cm-button': { backgroundColor: c.canvas, color: c.foreground, borderColor: c.border, backgroundImage: 'none' },
  }, { dark: options.dark })];
}
function splitSelection() {
  if (!editor) return;
  const { state } = editor;
  const ranges = state.selection.ranges.flatMap(range => {
    if (range.empty) return [range];
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    const split = [];
    for (let number = first; number <= last; number++) {
      const line = state.doc.line(number);
      if (number > first && line.from === range.to) break;
      const from = Math.max(range.from, line.from);
      const to = Math.min(range.to, line.to);
      split.push(range.anchor <= range.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from));
    }
    return split;
  });
  editor.dispatch({ selection: EditorSelection.create(ranges), userEvent: 'select' });
}
function permissions() {
  return [EditorState.readOnly.of(options.readOnly), EditorView.editable.of(!options.readOnly), EditorView.contentAttributes.of({ 'aria-label': `${options.labels.edit} ${options.filename}`, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' })];
}
async function setLanguage(name: string) {
  const sequence = ++languageRequest;
  const description = name === 'auto' ? LanguageDescription.matchFilename(languages, options.filename) : languages.find(item => item.name === name);
  try {
    const support = await description?.load();
    if (!editor || sequence !== languageRequest) return;
    editor.dispatch({ effects: language.reconfigure(support ? [support, ...(description?.name === 'JSON' ? [linter(jsonParseLinter())] : [])] : []) });
    languageSelect.title = description?.name || options.labels.plainText;
    reportSize();
  } catch (error) {
    if (sequence === languageRequest) post({ type: 'error', message: String(error) });
  }
}
const commands: Record<CodeEditorAction, { run: () => void; edit?: boolean }> = {
  undo: { run: () => { if (editor) undo(editor); }, edit: true },
  redo: { run: () => { if (editor) redo(editor); }, edit: true },
  find: { run: () => { if (editor) openSearchPanel(editor); } },
  goToLine: { run: () => { if (editor) gotoLine(editor); } },
  complete: { run: () => { if (editor) startCompletion(editor); }, edit: true },
  indent: { run: () => { if (editor) indentMore(editor); }, edit: true },
  outdent: { run: () => { if (editor) indentLess(editor); }, edit: true },
  comment: { run: () => { if (editor) toggleComment(editor); }, edit: true },
  wrap: { run: () => { wrap = !wrap; editor?.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) }); commandButtons.get('wrap')!.setAttribute('aria-pressed', String(wrap)); } },
  foldAll: { run: () => { if (editor) foldAll(editor); } },
  unfoldAll: { run: () => { if (editor) unfoldAll(editor); } },
  selectAll: { run: () => { if (editor) selectAll(editor); } },
  selectNext: { run: () => { if (editor) selectNextOccurrence(editor); } },
  splitSelection: { run: splitSelection },
  singleSelection: { run: () => { if (editor) simplifySelection(editor); } },
  moveUp: { run: () => { if (editor) moveLineUp(editor); }, edit: true },
  moveDown: { run: () => { if (editor) moveLineDown(editor); }, edit: true },
  duplicateLine: { run: () => { if (editor) copyLineDown(editor); }, edit: true },
  deleteLine: { run: () => { if (editor) deleteLine(editor); }, edit: true },
};
for (const name of CODE_EDITOR_ACTIONS) {
  const command = commands[name];
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.command = name;
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.addEventListener('click', () => {
    if (!editor || (options.readOnly && command.edit)) return;
    if (name !== 'find' && name !== 'goToLine') editor.focus();
    command.run(); updateStatus(); reportSize();
  });
  commandButtons.set(name, button); toolbar.append(button);
}
function configure(next: CodeEditorOptions) {
  options = next;
  document.documentElement.style.colorScheme = options.dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--editor-ui-font-size', `${options.fontSize}px`);
  for (const [name, value] of Object.entries(options.colors)) document.documentElement.style.setProperty(`--${name}`, value);
  document.title = options.filename;
  for (const [name, button] of commandButtons) {
    button.textContent = options.labels[name]; button.title = options.labels[name];
    button.disabled = !!commands[name].edit && options.readOnly;
  }
  languageSelect.setAttribute('aria-label', options.labels.language);
  languageSelect.options[0].textContent = options.labels.autoLanguage;
  languageSelect.options[1].textContent = options.labels.plainText;
  const indentSelect = document.getElementById('indentation') as HTMLSelectElement;
  indentSelect.setAttribute('aria-label', options.labels.indentation);
  for (const option of indentSelect.options) option.textContent = option.value === 'tab' ? options.labels.tabs : `${options.labels.spaces}: ${option.value}`;
  editor?.dispatch({ effects: [appearance.reconfigure(theme()), permission.reconfigure(permissions()), phrases.reconfigure(EditorState.phrases.of(options.phrases))] });
  updateStatus();
}
for (const [value, name] of [['auto', 'Auto'], ['plain', 'Plain text'], ...languages.map(item => [item.name, item.name])]) {
  const option = document.createElement('option'); option.value = value; option.textContent = name; languageSelect.append(option);
}
languageSelect.addEventListener('change', () => { void setLanguage(languageSelect.value); });
document.getElementById('indentation')!.addEventListener('change', event => {
  const value = (event.target as HTMLSelectElement).value;
  tabSize = value === 'tab' ? 4 : Number(value);
  editor?.dispatch({ effects: indentation.reconfigure([EditorState.tabSize.of(tabSize), indentUnit.of(value === 'tab' ? '\t' : ' '.repeat(tabSize))]) });
});

host.whipSetCodeDocument = (source: CodeEditorDocument) => {
  languageRequest += 1;
  if (editor) { editor.destroy(); editor = null; }
  requestId = source.requestId;
  options = source;
  configure(source);
  languageSelect.value = 'auto';
  editor = new EditorView({ parent: root, state: EditorState.create({ doc: source.content, extensions: [
    basicSetup,
    EditorState.allowMultipleSelections.of(true),
    EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
    language.of([]), appearance.of(theme()), permission.of(permissions()), wrapping.of(wrap ? EditorView.lineWrapping : []),
    indentation.of([EditorState.tabSize.of(tabSize), indentUnit.of((document.getElementById('indentation') as HTMLSelectElement).value === 'tab' ? '\t' : ' '.repeat(tabSize))]), phrases.of(EditorState.phrases.of(options.phrases)),
    keymap.of([indentWithTab, { key: 'Mod-s', run: view => {
      if (!options.readOnly) post({ type: 'save', value: view.state.doc.toString() });
      return true;
    } }]),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(Transaction.remote))) {
        post({ type: 'change', value: update.state.doc.toString() });
      }
      if (update.docChanged || update.selectionSet) updateStatus();
      if (update.docChanged || update.geometryChanged) reportSize();
    }),
    EditorView.domEventHandlers({ scroll: () => {
      clearTimeout(scrollTimer); scrollTimer = setTimeout(() => post({ type: 'position', ...geometry() }), 150);
    } }),
  ] }) });
  void setLanguage('auto'); updateStatus();
  editor.requestMeasure({ read: () => geometry(), write: () => reportSize() });
};
host.whipConfigureCodeEditor = configure;
host.whipSaveCodeEditor = () => {
  if (editor && !options.readOnly) post({ type: 'save', value: editor.state.doc.toString() });
};
host.whipScrollCodeEditor = (x, y) => editor?.scrollDOM.scrollTo({ left: x, top: y });
host.whipRevealCodeLine = number => {
  if (!editor) return;
  const line = editor.state.doc.line(Math.max(1, Math.min(editor.state.doc.lines, Math.floor(number))));
  editor.dispatch({ selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
};
window.addEventListener('resize', reportSize);
window.addEventListener('pagehide', () => { clearTimeout(scrollTimer); editor?.destroy(); editor = null; });
new ResizeObserver(reportSize).observe(root);
post({ type: 'ready' });
