/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const runtime = readFileSync(resolve(__dirname, '../scripts/mermaid-preview-runtime.js'), 'utf8');
const fontFamily = 'WhipChatCJK, WhipInter, system-ui, sans-serif';
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<main id="diagram"></main>', { runScripts: 'outside-only' });
  dom.window.document.body.style.fontFamily = fontFamily;
  dom.window.ReactNativeWebView = { postMessage: jest.fn() };
  dom.window.eval(runtime);
});
afterEach(() => dom.window.close());

test('waits for the UKai font stack before Mermaid measures mixed-script labels', async () => {
  let finishLoading!: () => void;
  const loaded = new Promise<void>(done => { finishLoading = done; });
  const load = jest.fn(() => loaded);
  Object.defineProperty(dom.window.document, 'fonts', { value: { load } });
  dom.window.mermaid = {
    initialize: jest.fn(),
    render: jest.fn().mockResolvedValue({ svg: '<svg><text>中文日本語😀</text></svg>' }),
  };
  const source = 'flowchart LR\nA["中文"] --> B["日本語😀"]';
  const pending = dom.window.herdrRenderMermaid(source, 'dark', 1);
  expect(load).toHaveBeenCalledWith(`16px ${fontFamily}`, source);
  expect(dom.window.mermaid.render).not.toHaveBeenCalled();
  finishLoading();
  await pending;
  expect(dom.window.mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ fontFamily }));
  expect(dom.window.mermaid.render).toHaveBeenCalledWith('whip-mermaid-1', source);
  expect(dom.window.document.querySelector('svg text')!.textContent).toBe('中文日本語😀');
});
