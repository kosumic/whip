/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const runtime = read('scripts/mermaid-preview-runtime.js');
const renderer = read('scripts/diagram-renderer.js');
const pele = read('node_modules/pele/dist/pele.global.js');
const fontFamily = 'WhipChatCJK, WhipInter, system-ui, sans-serif';
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<main id="diagram"></main>', { runScripts: 'outside-only' });
  dom.window.document.getElementById('diagram')!.style.fontFamily = fontFamily;
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { value: () => ({ measureText: (text: string) => ({ width: Array.from(text).length * 9 }) }) });
  dom.window.ReactNativeWebView = { postMessage: jest.fn() };
  dom.window.eval(`${pele}\nwindow.pele = { ...pele };`);
  dom.window.eval(renderer);
  dom.window.eval(runtime);
});
afterEach(() => dom.window.close());

test('waits for the bundled font stack before Pele measures mixed-script labels', async () => {
  let finishLoading!: () => void;
  const load = jest.fn(() => new Promise<void>(done => { finishLoading = done; }));
  Object.defineProperty(dom.window.document, 'fonts', { value: { load } });
  const render = jest.spyOn(dom.window.pele, 'render');
  const source = 'flowchart LR\nA["中文"] --> B["日本語😀"]';
  const pending = dom.window.herdrRenderMermaid(source, 'dark', 1);
  expect(load).toHaveBeenCalledWith(`16px ${fontFamily}`, source);
  expect(render).not.toHaveBeenCalled();
  finishLoading();
  await pending;
  expect(render).toHaveBeenCalledWith(source, expect.objectContaining({ fontFamily, links: false, images: false }));
  expect(dom.window.document.querySelector('svg')!.textContent).toContain('中文');
  expect(dom.window.document.querySelector('svg')!.textContent).toContain('日本語😀');
  expect(dom.window.ReactNativeWebView.postMessage).toHaveBeenLastCalledWith(JSON.stringify({ type: 'rendered', requestId: 1 }));
});

test('ignores superseded diagrams after font loading finishes', async () => {
  let finishLoading!: () => void;
  const load = jest.fn().mockReturnValueOnce(new Promise<void>(done => { finishLoading = done; })).mockResolvedValue([]);
  Object.defineProperty(dom.window.document, 'fonts', { value: { load } });
  const old = dom.window.herdrRenderMermaid('flowchart LR\nOld --> Document', 'dark', 1);
  await dom.window.herdrRenderMermaid('flowchart LR\nNew --> Document', 'light', 2);
  finishLoading();
  await old;
  expect(dom.window.document.querySelector('svg')!.textContent).toContain('New');
  expect(dom.window.document.querySelector('svg')!.textContent).not.toContain('Old');
  expect(dom.window.document.documentElement.dataset.appearance).toBe('light');
  expect(dom.window.ReactNativeWebView.postMessage).toHaveBeenLastCalledWith(JSON.stringify({ type: 'rendered', requestId: 2 }));
});

test.each(['react-native-frontend', 'whip-rust-core'])('renders the real %s architecture with Pele', async name => {
  await dom.window.herdrRenderMermaid(read(`docs/${name}-architecture.mmd`), 'light', 1);
  expect(dom.window.document.querySelector('svg')).not.toBeNull();
  expect(dom.window.document.querySelector('svg')!.textContent).toContain('Rust');
  expect(dom.window.document.querySelector('foreignObject, script, image, a')).toBeNull();
});

test('clears old diagrams and reports parse and source-limit errors', async () => {
  await dom.window.herdrRenderMermaid('flowchart LR\nA --> B', 'dark', 1);
  for (const source of ['invalid', 'x'.repeat(100_001)]) {
    await dom.window.herdrRenderMermaid(source, 'dark', 2);
    expect(dom.window.document.querySelector('svg')).toBeNull();
    expect(JSON.parse(dom.window.ReactNativeWebView.postMessage.mock.calls.at(-1)[0])).toMatchObject({ type: 'error', requestId: 2 });
  }
});

test('does not produce navigation or executable markup from diagram links and labels', async () => {
  await dom.window.herdrRenderMermaid('flowchart LR\nA["<script>alert(1)</script>"] --> B[Safe]\nclick B "javascript:alert(1)"', 'dark', 1);
  expect(dom.window.document.querySelector('a, script, foreignObject, [onclick], [onload]')).toBeNull();
});
