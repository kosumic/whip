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

test('ignores superseded diagrams after font loading or rendering finishes', async () => {
  let finishLoading!: () => void;
  let finishRendering!: (result: { svg: string }) => void;
  let startRendering!: () => void;
  const renderingStarted = new Promise<void>(done => { startRendering = done; });
  const load = jest.fn().mockReturnValueOnce(new Promise<void>(done => { finishLoading = done; }))
    .mockResolvedValue([]);
  Object.defineProperty(dom.window.document, 'fonts', { value: { load } });
  dom.window.mermaid = {
    initialize: jest.fn(),
    render: jest.fn().mockImplementation(() => {
      startRendering();
      return new Promise<{ svg: string }>(done => { finishRendering = done; });
    }),
  };
  const oldFonts = dom.window.herdrRenderMermaid('Old fonts', 'dark', 1);
  const oldDiagram = dom.window.herdrRenderMermaid('Old diagram', 'dark', 2);
  await renderingStarted;
  expect(dom.window.mermaid.render).toHaveBeenCalledTimes(1);
  dom.window.mermaid.render.mockResolvedValueOnce({ svg: '<svg><text>New</text></svg>' });
  await dom.window.herdrRenderMermaid('New', 'light', 3);
  finishLoading();
  finishRendering({ svg: '<svg><text>Old</text></svg>' });
  await Promise.all([oldFonts, oldDiagram]);
  expect(dom.window.mermaid.render).toHaveBeenCalledTimes(2);
  expect(dom.window.document.querySelector('text')!.textContent).toBe('New');
  expect(dom.window.document.documentElement.dataset.appearance).toBe('light');
  expect(dom.window.ReactNativeWebView.postMessage).toHaveBeenLastCalledWith(JSON.stringify({ type: 'rendered', requestId: 3 }));
});
