/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import { JSDOM } from 'jsdom';

import { TERMINAL_ASSET_KEY, terminalAssetRuntime } from '../test-support/terminalAssetRuntime';

const ANDROID_ASSET = 'android/app/src/main/assets/herdr-terminal.html';
const IOS_ASSET = 'modules/whip-terminal-assets/ios/TerminalAssets/index.html';
const GENERATOR = 'scripts/sync-terminal-assets.ts';

function artifact(path: string): string {
  return readFileSync(resolve(__dirname, '..', path), 'utf8');
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(
    match => match[1],
  );
}

function platformNeutralAsset(html: string): string {
  return html
    .replace(/^\s*<base href="file:\/\/\/android_asset\/">\n/m, '')
    .replace(
      /^\s*const terminalFontFamily = .*;$/m,
      "    const terminalFontFamily = '<platform monospace>';",
    );
}

describe('generated terminal artifacts', () => {
  const android = artifact(ANDROID_ASSET);
  const ios = artifact(IOS_ASSET);

  test('platform assets are up to date with the source generator', () => {
    expect(() => execFileSync(process.execPath, [GENERATOR, '--check'], {
      cwd: resolve(__dirname, '..'),
      stdio: 'pipe',
    })).not.toThrow();
  });

  test('Android and iOS ship the same generated terminal runtime', () => {
    expect(platformNeutralAsset(android)).toBe(platformNeutralAsset(ios));
  });

  test.each([['Android', android], ['iOS', ios]])('%s packages the terminal mount and serializer script', (_platform, html) => {
    const dom = new JSDOM(html);
    try {
      expect(dom.window.document.getElementById('terminals')).not.toBeNull();
      expect(dom.window.document.querySelector('script[src="addon-serialize.js"]')).not.toBeNull();
    } finally {
      dom.window.close();
    }
  });

  test.each([
    ['Android', android],
    ['iOS', ios],
  ])('%s inline JavaScript compiles', (_platform, html) => {
    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(() => new Script(script)).not.toThrow();
    }
  });
});

// Execute the generated assets, entering through their public RN/WebView API.
// xterm rendering and DOM layout are fixtures; the generated event handlers,
// inset model, input batching, and message routing execute unchanged.
describe.each([
  ['Android', ANDROID_ASSET],
  ['iOS', IOS_ASSET],
])('%s generated bridge contract', (platform, asset) => {
  const key = TERMINAL_ASSET_KEY;
  const setup = () => terminalAssetRuntime(asset, platform === 'iOS' ? 'iPhone' : 'Android', true);
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('announces a keyed terminal and controls its keyboard without focusing the native textarea', async () => {
    const { bridge, window, terminal } = await setup();
    const messages = () => window.ReactNativeWebView.postMessage.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(messages()).toContainEqual({ type: 'terminal-ready', key, identity: 'identity' });
    bridge.herdrSetKeyboardEnabled(key, true);
    expect(terminal.textarea.readOnly).toBe(true);
    expect(terminal.textarea.inputMode).toBe('none');
    expect(terminal.element.classList.contains('native-input-focus')).toBe(true);
    bridge.herdrSetKeyboardEnabled(key, false);
    expect(terminal.element.classList.contains('native-input-focus')).toBe(false);
    expect(terminal.focus).not.toHaveBeenCalled();
  });

  test('closed-keyboard taps send SGR mouse bytes through the input bridge only when captured', async () => {
    const { bridge, window, terminal, touch } = await setup();
    terminal.cols = 80;
    terminal.rows = 24;
    Object.assign(terminal.element.querySelector('.xterm-screen'), {
      getBoundingClientRect: () => ({ left: 20, top: 80, width: 800, height: 480 }),
    });
    window.ReactNativeWebView.postMessage.mockClear();
    const tap = () => { touch('touchstart', 200); touch('touchend', 200); };
    tap();
    jest.advanceTimersByTime(4);
    expect(window.ReactNativeWebView.postMessage).not.toHaveBeenCalled();
    bridge.herdrSetApplicationMouseCapture(key, true);
    tap();
    jest.advanceTimersByTime(4);
    expect(window.ReactNativeWebView.postMessage.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      { type: 'input', key, data: '\u001b[<0;3;7M\u001b[<0;3;7m' },
    ]);
    expect(terminal.focus).not.toHaveBeenCalled();
  });

  test('swipes report scroll coordinates and visual-bottom transitions with inset geometry', async () => {
    const { bridge, report, root, touch } = await setup();
    bridge.herdrSetVisualInsets(key, {
      top: 0, bottom: 140, geometryBottomInset: 40,
      scrollOffsetFromBottom: 5, maxScrollOffsetFromBottom: 10,
    });
    expect(root.querySelector('#terminal-geometry').style.setProperty)
      .toHaveBeenCalledWith('--terminal-geometry-bottom', '40px');
    expect(report).toHaveBeenCalledWith({ type: 'visual-scroll-state', atVisualBottom: false });
    report.mockClear();
    touch('touchstart', 200);
    touch('touchmove', 216);
    touch('touchend', 216);
    expect(report).toHaveBeenCalledWith({ type: 'scroll', direction: 'up', lines: 1, column: 5, row: 13 });
    bridge.herdrScrollToVisualBottom(key);
    expect(root.querySelector('#terminal-geometry').style.setProperty)
      .toHaveBeenLastCalledWith('--terminal-visual-offset', '-100px');
    expect(report).toHaveBeenCalledWith({ type: 'visual-scroll-state', atVisualBottom: true });
  });

  test('captured swipes generate wheel input instead of scrollback messages', async () => {
    const { bridge, report, touch } = await setup();
    bridge.herdrSetApplicationMouseCapture(key, true);
    report.mockClear();
    touch('touchstart', 200);
    touch('touchmove', 216);
    touch('touchend', 216);
    jest.advanceTimersByTime(4);
    expect(report).toHaveBeenCalledWith({ type: 'input', data: '\u001b[<64;6;14M' });
    expect(report.mock.calls.filter(([message]) => message.type === 'scroll')).toEqual([]);
  });

  test('snapshots serialize written output and removal stops further calls', async () => {
    const { bridge, window, serialize, terminal } = await setup();
    bridge.herdrConfigure(key, { offlineCache: true, scrollback: 2000 });
    bridge.herdrWrite(key, 'output');
    expect(terminal.write).toHaveBeenCalledWith('output', expect.any(Function));
    bridge.herdrSnapshot(key, 'background');
    expect(serialize).toHaveBeenCalledWith({ scrollback: 2000 });
    expect(window.ReactNativeWebView.postMessage.mock.calls.map(([raw]) => JSON.parse(raw)))
      .toContainEqual(expect.objectContaining({ type: 'cache-snapshot', key, reason: 'background', transcript: 'serialized terminal' }));
    bridge.herdrRemove(key);
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    terminal.write.mockClear();
    bridge.herdrWrite(key, 'late output');
    expect(terminal.write).not.toHaveBeenCalled();
  });
});
