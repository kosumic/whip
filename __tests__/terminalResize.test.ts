import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import { terminalViewportLayout } from '../src/lib/floatingChrome';

function eventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatch: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
}

type ElementStub = ReturnType<typeof eventTarget> & {
  style: { display: string; setProperty: ReturnType<typeof jest.fn> };
  classList: { contains: (name: string) => boolean; remove: (name: string) => boolean };
  closest: () => ElementStub;
  querySelector: (selector: string) => ElementStub;
  getBoundingClientRect: () => { width: number; height: number; top: number; bottom: number };
};

// Execute the shipped runtime with real FitAddon measurements. Only the DOM
// layout and xterm rendering are stubbed; event wiring and bridge calls are real.
async function runtime(asset: string, userAgent: string) {
  const geometry = { width: 400, height: 800 };
  const padding: Record<string, string> = {};
  const classNames = new Set(['presented']);
  const nodes = new Map<string, ElementStub>();
  function element(): ElementStub {
    return {
      ...eventTarget(),
      style: { display: '', setProperty: jest.fn() },
      classList: {
        contains: (name: string) => classNames.has(name),
        remove: (name: string) => classNames.delete(name),
      },
      closest: () => root,
      querySelector: (selector: string): ElementStub => {
        if (!nodes.has(selector)) nodes.set(selector, element());
        return nodes.get(selector)!;
      },
      getBoundingClientRect: () => ({ ...geometry, top: 0, bottom: geometry.height }),
    };
  }
  const root = element();
  const parent = element();
  const window = {
    ...eventTarget(),
    visualViewport: eventTarget(),
    devicePixelRatio: 2,
    innerHeight: geometry.height,
    getComputedStyle: (node: unknown) => ({
      getPropertyValue: (property: string) => node === parent
        ? `${geometry[property as keyof typeof geometry]}px`
        : padding[property] || '0px',
    }),
    ReactNativeWebView: { postMessage: jest.fn() },
  };
  Object.assign(parent, { ownerDocument: { defaultView: window } });
  let resizeListener = (_size: { cols: number; rows: number }) => {};
  const terminal = {
    options: { fontSize: 8, scrollbar: { showScrollbar: false } },
    dimensions: { css: { cell: { width: 8, height: 16 } } },
    element: { ...element(), parentElement: parent, ownerDocument: { defaultView: window } },
    cols: 0,
    rows: 0,
    buffer: { active: { baseY: 0, viewportY: 0 }, onBufferChange: jest.fn() },
    parser: { registerOscHandler: jest.fn() },
    loadAddon: (addon: { activate?: (term: Terminal) => void }) => addon.activate?.(terminal as unknown as Terminal),
    open: jest.fn(),
    blur: jest.fn(),
    attachCustomKeyEventHandler: jest.fn(),
    onData: jest.fn(),
    onResize: (listener: typeof resizeListener) => { resizeListener = listener; },
    onScroll: jest.fn(),
    resize: jest.fn((cols: number, rows: number) => {
      const changed = terminal.cols !== cols || terminal.rows !== rows;
      terminal.cols = cols;
      terminal.rows = rows;
      if (changed) resizeListener({ cols, rows });
    }),
  };
  const fit = new FitAddon();
  const fitSpy = jest.spyOn(fit, 'fit');
  const report = jest.fn();
  const html = readFileSync(resolve(__dirname, '..', asset), 'utf8');
  const script = html.split('<script>')[1].split('</script>')[0];
  const api = new Script(`${script}\ncreateTerminalSession(root, report);`).runInNewContext({
    root, report, window,
    document: {},
    navigator: { userAgent },
    performance: { now: () => 0 },
    setTimeout, clearTimeout,
    Terminal: jest.fn(() => terminal),
    FitAddon: { FitAddon: jest.fn(() => fit) },
    ImageAddon: { ImageAddon: jest.fn(() => ({})) },
    SerializeAddon: { SerializeAddon: jest.fn(() => ({})) },
  }) as Record<string, (...args: unknown[]) => void>;
  // Initialization waits for the font-ready promise, then the race continuation.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const resizeReports = () => report.mock.calls.filter(([value]) => value.type === 'resize');
  return { api, window, terminal, geometry, padding, classNames, fitSpy, resizeReports, report };
}

describe.each([
  ['Android', 'android/app/src/main/assets/herdr-terminal.html'],
  ['iOS', 'modules/whip-terminal-assets/ios/TerminalAssets/index.html'],
])('%s terminal fitting', (platform, asset) => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const setup = () => runtime(asset, platform);

  test('mount fits once; unchanged window and visual viewport events do not fit or trace', async () => {
    const state = await setup();
    for (let i = 0; i < 3; i++) {
      state.window.dispatch('resize');
      state.window.visualViewport.dispatch('resize');
      state.window.visualViewport.dispatch('scroll');
    }
    expect(state.fitSpy).toHaveBeenCalledTimes(1);
    expect(state.resizeReports()).toHaveLength(1);
    expect(state.terminal.resize).toHaveBeenCalledTimes(1);
  });

  test('actual container size and orientation changes fit again', async () => {
    const state = await setup();
    for (const geometry of [
      { width: 401, height: 800 }, // Even a change smaller than one cell matters.
      { width: 401, height: 799 },
      { width: 800, height: 401 },
      { width: 800, height: 201 },
      { width: 800, height: 401 },
    ]) {
      Object.assign(state.geometry, geometry);
      state.window.dispatch('resize');
      state.window.dispatch('resize');
    }
    expect(state.fitSpy).toHaveBeenCalledTimes(6);
    expect(state.resizeReports()).toHaveLength(6);
    expect(state.terminal.rows).toBe(25);
  });

  test.each([false, true])('keyboard toggles leave PTY geometry alone with composer=%s', async composerVisible => {
    const state = await setup();
    for (const keyboardVisible of [true, false, true, false]) {
      const layout = terminalViewportLayout({
        composerVisible, composerExpanded: false, composerHeight: 112,
        controlBarHeight: 84, keyboardInset: keyboardVisible ? 301 : 0, topInset: 0,
      });
      state.api.herdrSetVisualInsets(layout.overlayInsets);
      state.window.innerHeight = keyboardVisible ? 499 : 800;
      state.window.dispatch('resize');
    }
    expect(state.fitSpy).toHaveBeenCalledTimes(1);
    expect(state.resizeReports()).toHaveLength(1);
    expect(state.terminal.resize).toHaveBeenCalledTimes(1);
  });

  test('subpixel CSS jitter is ignored; padding, cell metrics and DPR changes are fitted', async () => {
    const state = await setup();
    state.geometry.width += 0.9;
    state.geometry.height += 0.9;
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(1);
    state.padding['padding-left'] = '8px';
    state.window.dispatch('resize');
    state.padding['padding-left'] = '4px';
    state.padding['padding-right'] = '4px';
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(2);
    state.terminal.dimensions.css.cell.width = 9;
    state.window.dispatch('resize');
    state.window.devicePixelRatio = 3;
    state.window.dispatch('resize');
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(4);
  });

  test('unchanged explicit fits and configuration acknowledge completion without resizing', async () => {
    const state = await setup();
    state.report.mockClear();
    state.api.herdrFit();
    state.api.herdrFit();
    state.api.herdrConfigure({ fontSize: 8 });
    jest.runOnlyPendingTimers();
    expect(state.fitSpy).toHaveBeenCalledTimes(1);
    expect(state.terminal.resize).toHaveBeenCalledTimes(1);
    expect(state.resizeReports()).toHaveLength(0);
    expect(state.report.mock.calls.filter(([value]) => value.type === 'fit-complete')).toHaveLength(3);
  });

  test('font-size changes refit unchanged containers', async () => {
    const state = await setup();
    state.api.herdrFit();
    state.api.herdrChangeFontSize(2);
    state.api.herdrConfigure({ fontSize: 12 });
    jest.runOnlyPendingTimers();
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(3);
    expect(state.terminal.options.fontSize).toBe(12);
    expect(state.resizeReports()).toHaveLength(3);
  });

  test('hidden and unmeasurable sessions do not consume geometry changes', async () => {
    const state = await setup();
    state.classNames.delete('presented');
    state.geometry.width = 500;
    state.window.dispatch('resize');
    state.classNames.add('presented');
    state.terminal.dimensions.css.cell.width = 0;
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(1);
    state.terminal.dimensions.css.cell.width = 8;
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(2);
  });

  test('failed and no-op fits are retried without caching unapplied dimensions', async () => {
    const state = await setup();
    state.geometry.width = 500;
    state.fitSpy.mockImplementationOnce(() => { throw new Error('fit failed'); });
    expect(() => state.window.dispatch('resize')).toThrow('fit failed');
    expect(state.resizeReports()).toHaveLength(1);
    state.fitSpy.mockImplementationOnce(() => {});
    state.window.dispatch('resize');
    state.window.dispatch('resize');
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(4);
    expect(state.terminal.cols).toBe(62);
  });

  test('a failed explicit refit invalidates the previous successful geometry', async () => {
    const state = await setup();
    state.geometry.width = 500;
    state.fitSpy.mockImplementationOnce(() => { throw new Error('fit failed'); });
    expect(() => state.api.herdrFit()).toThrow('fit failed');
    state.window.dispatch('resize');
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(3);
    expect(state.resizeReports()).toHaveLength(2);
  });
});
