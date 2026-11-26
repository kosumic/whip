import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { Terminal } from '@xterm/xterm';

export const TERMINAL_ASSET_KEY = 'test-terminal';
function eventTarget() {
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  return {
    addEventListener: (type: string, listener: (event?: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event?: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatch: (type: string, event?: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

type ElementStub = ReturnType<typeof eventTarget> & {
  textContent: string;
  style: { display: string; setProperty: jest.Mock<void, [string, string]> };
  classList: { contains: (name: string) => boolean; remove: (name: string) => boolean; toggle: (name: string, enabled: boolean) => void };
  closest: () => ElementStub;
  querySelector: (selector: string) => ElementStub;
  querySelectorAll: (selector: string) => ElementStub[];
  getBoundingClientRect: () => { width: number; height: number; top: number; bottom: number };
};

// Execute the shipped runtime with real FitAddon measurements. Only the DOM
// layout and xterm rendering are stubbed; event wiring and bridge calls are real.
export async function terminalAssetRuntime(asset: string, userAgent: string, multiplexed = false) {
  const geometry = { width: 400, height: 800 };
  const padding: Record<string, string> = {};
  const classNames = new Set(['presented']);
  const nodes = new Map<string, ElementStub>();
  function element(): ElementStub {
    return {
      ...eventTarget(),
      textContent: '',
      style: { display: '', setProperty: jest.fn<undefined, [string, string]>() },
      classList: {
        contains: (name: string) => classNames.has(name),
        remove: (name: string) => classNames.delete(name),
        toggle: (name: string, enabled: boolean) => { if (enabled) classNames.add(name); else classNames.delete(name); },
      },
      closest: () => root,
      querySelector: (selector: string): ElementStub => {
        if (!nodes.has(selector)) nodes.set(selector, element());
        return nodes.get(selector)!;
      },
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ ...geometry, left: 0, top: 0, bottom: geometry.height }),
    };
  }
  const root = element();
  Object.assign(root, { remove: jest.fn() });
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
    ReactNativeWebView: { postMessage: jest.fn<undefined, [string]>() },
  };
  Object.assign(parent, { ownerDocument: { defaultView: window } });
  let resizeListener = (_size: { cols: number; rows: number }) => {};
  const terminal = {
    options: { fontSize: 8, scrollbar: { showScrollbar: false } },
    unicode: { register: jest.fn(), activeVersion: '6' },
    dimensions: { css: { cell: { width: 8, height: 16 } } },
    element: { ...element(), parentElement: parent, ownerDocument: { defaultView: window } },
    cols: 0,
    rows: 0,
    buffer: { active: { type: 'normal', baseY: 0, viewportY: 0 }, onBufferChange: jest.fn() },
    modes: { mouseTrackingMode: 'none', applicationCursorKeysMode: false },
    parser: { registerOscHandler: jest.fn() },
    loadAddon: (addon: { activate?: (term: Terminal) => void }) => addon.activate?.(terminal as unknown as Terminal),
    open: jest.fn(),
    blur: jest.fn(),
    focus: jest.fn(),
    clearSelection: jest.fn(),
    getSelection: jest.fn(() => ''),
    getSelectionPosition: jest.fn<ReturnType<Terminal['getSelectionPosition']>, []>(() => undefined),
    select: jest.fn(),
    selectAll: jest.fn(),
    hasSelection: () => false,
    scrollLines: jest.fn((lines: number) => {
      const buffer = terminal.buffer.active;
      buffer.viewportY = Math.max(0, Math.min(buffer.baseY, buffer.viewportY + lines));
    }),
    scrollToBottom: jest.fn(),
    textarea: { ...element(), readOnly: false, inputMode: '', setAttribute: jest.fn() },
    write: jest.fn((_data: unknown, done?: () => void) => done?.()),
    dispose: jest.fn(),
    attachCustomKeyEventHandler: jest.fn(),
    onData: jest.fn(),
    onWriteParsed: jest.fn(),
    onCursorMove: jest.fn(),
    onRender: jest.fn(),
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
  const report = jest.fn<undefined, [Record<string, unknown> & { type: string }]>();
  const serialize = jest.fn(() => 'serialized terminal');
  const html = readFileSync(resolve(__dirname, '..', asset), 'utf8');
  const script = html.split('<script>')[1].split('</script>')[0];
  // eslint-disable-next-line sonarjs/code-eval -- Execute the checked-in generated test artifact.
  const api = new Script(multiplexed ? script : `${script}\ncreateTerminalSession(root, report);`).runInNewContext({
    root, report, window,
    document: {
      createElement: () => root,
      getElementById: () => ({ appendChild: jest.fn() }),
    },
    navigator: { userAgent },
    performance: { now: () => 0 },
    setTimeout, clearTimeout,
    requestAnimationFrame: jest.fn(() => 1),
    cancelAnimationFrame: jest.fn(),
    Terminal: jest.fn(() => terminal),
    FitAddon: { FitAddon: jest.fn(() => fit) },
    ImageAddon: { ImageAddon: jest.fn(() => ({})) },
    SerializeAddon: { SerializeAddon: jest.fn(() => ({ serialize })) },
    Unicode11Addon: { Unicode11Addon },
    atob,
    MouseEvent: class {
      constructor(readonly type: string, options: Record<string, unknown>) {
        Object.assign(this, options);
      }
    },
    WheelEvent: class {
      static readonly DOM_DELTA_LINE = 1;
      constructor(readonly type: string, options: Record<string, unknown>) {
        Object.assign(this, options);
      }
    },
  }) as Record<string, (...args: unknown[]) => void>;
  // The artifact contract tests enter via the same public bridge as RN. The
  // resize suite also needs the unbatched per-session reports for measurements.
  const bridge = window as typeof window & Record<string, (...args: unknown[]) => void>;
  if (multiplexed) {
    window.ReactNativeWebView.postMessage.mockImplementation((raw: string) => {
      const message = JSON.parse(raw) as Record<string, unknown> & { type: string };
      delete message.key;
      report(message);
    });
    bridge.herdrCreate(TERMINAL_ASSET_KEY, 'identity');
  }
  // Initialization waits for the font-ready promise, then the race continuation.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const resizeReports = () => report.mock.calls.filter(([value]) => value.type === 'resize');
  const wheelEvents: Array<{ deltaY: number; clientX: number; clientY: number }> = [];
  const dispatchEvent = jest.fn((event: typeof wheelEvents[number]) => { wheelEvents.push(event); return true; });
  Object.assign(terminal.element, { dispatchEvent });
  const touch = (type: string, y: number) => root.querySelector('#terminal').dispatch(type, {
    target: { closest: () => null },
    touches: type === 'touchend' ? [] : [{ clientX: 44, clientY: y }],
    changedTouches: [{ clientX: 44, clientY: y }],
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  });
  return { api, bridge, window, terminal, geometry, padding, classNames, fitSpy, resizeReports, report, root, touch, wheelEvents, serialize };
}

