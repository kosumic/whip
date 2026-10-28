import { basicSetup } from 'codemirror';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, panels, tooltips } from '@codemirror/view';
import { defaultHighlightStyle, foldAll, indentUnit, LanguageDescription, syntaxHighlighting, unfoldAll } from '@codemirror/language';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { languages } from '@codemirror/language-data';
import { completeAnyWord, startCompletion } from '@codemirror/autocomplete';
import { copyLineDown, deleteLine, indentLess, indentMore, indentWithTab, moveLineDown, moveLineUp, redo, redoDepth, selectAll, simplifySelection, toggleComment, undo, undoDepth } from '@codemirror/commands';
import { gotoLine, openSearchPanel, selectNextOccurrence } from '@codemirror/search';
import { jsonParseLinter } from '@codemirror/lang-json';
import { linter } from '@codemirror/lint';
import { CODE_EDITOR_ACTIONS, type CodeEditorAction, type CodeEditorDocument, type CodeEditorOptions } from '../src/lib/codeEditor.ts';
import { createCodeZoom } from './code-editor-zoom.ts';
import { createCodeGlass } from './code-editor-glass.ts';

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
const controls = document.getElementById('controls')!;
const footer = document.getElementById('footer')!;
const actionMenu = document.getElementById('action-menu')!;
const moreActions = document.getElementById('more-actions')!;
const status = document.getElementById('status')!;
const languageSelect = document.getElementById('language') as HTMLSelectElement;
const post = (message: object) => host.ReactNativeWebView?.postMessage(JSON.stringify({ ...message, requestId }));
const commandButtons = new Map<CodeEditorAction, HTMLButtonElement>();
const PRIMARY_ACTIONS = new Set<CodeEditorAction>(['undo', 'redo', 'find', 'wrap']);
// Lucide paths, matching the native app's icon set and bundled Lucide notice.
const iconPaths: Partial<Record<CodeEditorAction, string>> = {
  undo: '<path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  find: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  wrap: '<path d="M3 6h18M3 12h14a3 3 0 0 1 0 6h-4m0 0 3-3m-3 3 3 3M3 18h4"/>',
};
const svgIcon = (paths: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
moreActions.innerHTML = svgIcon('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>');
let chromeTop = 88;
let chromeBottom = 40;
let disposeZoom: (() => void) | undefined;
let disposeGlass: (() => void) | undefined;
const glass = createCodeGlass(() => editor);
const zoom = createCodeZoom(() => editor, () => {
  document.getElementById('zoom-reset')!.textContent = `${Math.round(zoom.scale * 100)}%`;
  reportSize();
});
function measureChrome() {
  chromeTop = controls.getBoundingClientRect().height;
  chromeBottom = footer.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--chrome-top', `${chromeTop}px`);
  document.documentElement.style.setProperty('--chrome-bottom', `${chromeBottom}px`);
  editor?.requestMeasure({ read: () => geometry(), write: () => reportSize() });
}

function geometry() {
  const scroller = editor?.scrollDOM;
  return scroller ? {
    x: scroller.scrollLeft, y: scroller.scrollTop, width: scroller.scrollWidth, height: scroller.scrollHeight,
    viewportWidth: scroller.clientWidth, viewportHeight: scroller.clientHeight,
  } : { x: 0, y: 0, width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 };
}
function reportSize() { glass.refresh(); post({ type: 'size', ...geometry() }); }
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
  return [syntaxHighlighting(options.dark ? oneDarkHighlightStyle : defaultHighlightStyle), EditorView.theme({
    '&': { color: c.foreground, backgroundColor: c.canvas, fontSize: `${options.fontSize}px` },
    '.cm-scroller': { fontFamily: 'WhipChatCJK, "JetBrains Mono", monospace', fontSize: 'var(--code-font-size)', lineHeight: '1.65', overflow: 'auto' },
    '.cm-content': { padding: 'calc(var(--chrome-top) + 16px) 0 calc(var(--chrome-bottom) + 16px)', caretColor: c.accent },
    '.cm-line': { padding: '0 16px' },
    '.cm-gutters': { backgroundColor: options.glass ? c.chrome : c.surface, color: c.muted, borderRight: '1px solid', borderRightColor: c.border },
    '.cm-gutterElement': { paddingLeft: '10px', paddingRight: '8px' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: c.highlight },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.accent },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: c.selection },
    '.cm-panels': { backgroundColor: 'transparent', color: c.foreground, border: 'none' },
    '.cm-tooltip': { backgroundColor: c.chrome, color: c.foreground, border: `1px solid ${c.border}`, borderRadius: '10px', overflow: 'hidden', boxShadow: '0 8px 28px #00000030' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: c.selection },
    '.cm-selectionMatch': { backgroundColor: c.match },
    '.cm-foldPlaceholder': { backgroundColor: c.field, color: c.accent, border: 'none', borderRadius: '4px', padding: '0 5px' },
    '.cm-foldGutter': { color: c.muted },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: c.accent, color: c.onAccent },
    '.cm-textfield, .cm-button': { backgroundColor: c.field, color: c.foreground, border: `1px solid ${c.border}`, borderRadius: '6px', backgroundImage: 'none' },
    '.cm-searchMatch': { backgroundColor: c.match, outline: `1px solid ${c.accent}` },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: c.selection, borderBottom: `1px solid ${c.accent}` },
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
function detectLanguage() {
  return LanguageDescription.matchFilename(languages, options.filename);
}
async function setLanguage(name: string) {
  const sequence = ++languageRequest;
  const description = name === 'auto' ? detectLanguage() : languages.find(item => item.name === name);
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
  if (iconPaths[name]) button.innerHTML = svgIcon(iconPaths[name]);
  if (name === 'find' || !PRIMARY_ACTIONS.has(name)) button.append(document.createElement('span'));
  if (!PRIMARY_ACTIONS.has(name)) button.setAttribute('role', 'menuitem');
  if (name === 'wrap') button.setAttribute('aria-pressed', String(wrap));
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.addEventListener('click', () => {
    if (!editor || (options.readOnly && command.edit)) return;
    closeMenu();
    if (name !== 'find' && name !== 'goToLine') editor.focus();
    command.run(); updateStatus(); reportSize();
  });
  commandButtons.set(name, button);
  if (PRIMARY_ACTIONS.has(name)) toolbar.insertBefore(button, moreActions);
  else actionMenu.append(button);
}
function closeMenu() {
  actionMenu.hidden = true;
  moreActions.setAttribute('aria-expanded', 'false');
}
moreActions.addEventListener('pointerdown', event => event.preventDefault());
moreActions.addEventListener('click', event => {
  actionMenu.hidden = !actionMenu.hidden;
  moreActions.setAttribute('aria-expanded', String(!actionMenu.hidden));
  if (!actionMenu.hidden && event.detail === 0) actionMenu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
});
document.addEventListener('pointerdown', event => {
  if (!actionMenu.contains(event.target as Node) && !moreActions.contains(event.target as Node)) closeMenu();
});
actionMenu.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeMenu(); moreActions.focus(); return; }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const buttons = Array.from(actionMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
});
for (const [id, action] of [
  ['zoom-in', () => zoom.step(1)], ['zoom-out', () => zoom.step(-1)], ['zoom-reset', () => zoom.setScale(1)],
] as const) {
  const button = document.getElementById(id)!;
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.addEventListener('click', action);
}
function configure(next: CodeEditorOptions) {
  options = next;
  document.documentElement.style.colorScheme = options.dark ? 'dark' : 'light';
  document.documentElement.dataset.glass = String(options.glass);
  document.documentElement.style.setProperty('--editor-ui-font-size', `${options.fontSize}px`);
  for (const [name, value] of Object.entries(options.colors)) document.documentElement.style.setProperty(`--${name}`, value);
  document.title = options.filename;
  zoom.configure(options.fontSize);
  glass.refresh();
  for (const [name, button] of commandButtons) {
    const label = options.labels[name];
    const text = button.querySelector('span');
    if (text) text.textContent = label;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = !!commands[name].edit && options.readOnly;
  }
  moreActions.setAttribute('aria-label', options.labels.moreActions);
  moreActions.title = options.labels.moreActions;
  for (const [id, label] of [['zoom-in', 'zoomIn'], ['zoom-out', 'zoomOut'], ['zoom-reset', 'resetZoom']]) {
    document.getElementById(id)!.setAttribute('aria-label', options.labels[label]);
    document.getElementById(id)!.title = options.labels[label];
  }
  languageSelect.setAttribute('aria-label', options.labels.language);
  languageSelect.options[0].textContent = `${options.labels.autoLanguage} · ${detectLanguage()?.name || options.labels.plainText}`;
  languageSelect.options[1].textContent = options.labels.plainText;
  const indentSelect = document.getElementById('indentation') as HTMLSelectElement;
  indentSelect.setAttribute('aria-label', options.labels.indentation);
  for (const option of indentSelect.options) option.textContent = option.value === 'tab' ? options.labels.tabs : `${options.labels.spaces}: ${option.value}`;
  editor?.dispatch({ effects: [appearance.reconfigure(theme()), permission.reconfigure(permissions()), phrases.reconfigure(EditorState.phrases.of(options.phrases))] });
  updateStatus();
  measureChrome();
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
  disposeZoom?.();
  disposeGlass?.();
  closeMenu();
  if (editor) { editor.destroy(); editor = null; }
  requestId = source.requestId;
  options = source;
  configure(source);
  languageSelect.value = 'auto';
  editor = new EditorView({ parent: root, state: EditorState.create({ doc: source.content, extensions: [
    basicSetup,
    panels({ topContainer: document.getElementById('top-panels')!, bottomContainer: document.getElementById('bottom-panels')! }),
    tooltips({ tooltipSpace: view => {
      const bounds = view.scrollDOM.getBoundingClientRect();
      return { top: bounds.top + chromeTop, bottom: bounds.bottom - chromeBottom, left: bounds.left, right: bounds.right };
    } }),
    EditorView.scrollMargins.of(() => ({ top: chromeTop, bottom: chromeBottom })),
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
  disposeZoom = zoom.attach(editor);
  disposeGlass = glass.attach(editor);
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
window.addEventListener('pagehide', () => { clearTimeout(scrollTimer); disposeZoom?.(); disposeGlass?.(); chromeObserver.disconnect(); editor?.destroy(); editor = null; });
new ResizeObserver(reportSize).observe(root);
const chromeObserver = new ResizeObserver(measureChrome);
chromeObserver.observe(controls);
chromeObserver.observe(footer);
post({ type: 'ready' });
