/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const runtime = readFileSync(resolve(__dirname, '../scripts/mermaid-preview-runtime.js'), 'utf8');
const purify = readFileSync(resolve(__dirname, '../node_modules/dompurify/dist/purify.min.js'), 'utf8');
const fontFamily = 'WhipChatCJK, WhipInter, system-ui, sans-serif';
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<main id="diagram"></main>', { runScripts: 'outside-only' });
  dom.window.document.body.style.fontFamily = fontFamily;
  dom.window.ReactNativeWebView = { postMessage: jest.fn() };
  dom.window.eval(purify);
  dom.window.eval(runtime);
});
afterEach(() => dom.window.close());

test('displays native SVG after fonts load, preserving labels and removing active content', async () => {
  let finishLoading!: () => void;
  const loaded = new Promise<void>(done => { finishLoading = done; });
  const load = jest.fn(() => loaded);
  Object.defineProperty(dom.window.document, 'fonts', { value: { load } });
  const source = '<svg height="100"><style>text{fill:red}</style><text onclick="evil()">中文日本語😀</text><script>evil()</script><foreignObject>unsafe</foreignObject><image href="https://example.com/image"/></svg>';
  const pending = dom.window.herdrShowMermaid(source, 'dark', 1);
  expect(load).toHaveBeenCalledWith(`16px ${fontFamily}`, source);
  expect(dom.window.document.querySelector('svg')).toBeNull();
  finishLoading();
  await pending;
  expect(dom.window.document.querySelector('svg text')!.textContent).toBe('中文日本語😀');
  expect(dom.window.document.querySelector('svg')!.hasAttribute('height')).toBe(false);
  expect(dom.window.document.querySelector('svg style')).not.toBeNull();
  expect(dom.window.document.querySelector('script, foreignObject, image, [onclick]')).toBeNull();
  expect(dom.window.ReactNativeWebView.postMessage).toHaveBeenLastCalledWith(JSON.stringify({ type: 'rendered', requestId: 1 }));
});

test('ignores an older display request while its fonts are loading', async () => {
  let finish!: () => void;
  const load = jest.fn().mockReturnValueOnce(new Promise<void>(done => { finish = done; }))
    .mockResolvedValueOnce([]);
  Object.defineProperty(dom.window.document, 'fonts', { value: { load } });
  const pending = dom.window.herdrShowMermaid('<svg><text>Old</text></svg>', 'dark', 1);
  await dom.window.herdrShowMermaid('<svg><text>New</text></svg>', 'light', 2);
  finish();
  await pending;
  expect(dom.window.document.querySelector('text')!.textContent).toBe('New');
  expect(dom.window.document.documentElement.dataset.appearance).toBe('light');
});
