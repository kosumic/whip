import {
  BROWSER_ACTION_TIMEOUT_MS,
  type BrowserDriver,
} from '../src/browser/controller';
import { browserAddress } from '../src/browser/address';
import {
  BrowserRegistry,
  type BrowserSessionIdentity,
} from '../src/browser/registry';
import { offersReverseControl } from '../src/browser/launch';

const identity = (id: string): BrowserSessionIdentity => ({
  runtimeId: 'host',
  sessionId: id,
  paneId: 'pane-' + id,
  terminalId: 'terminal-' + id,
});
function fixture(registry = new BrowserRegistry(), id = 'a') {
  const transport = {
    startWebPreview: jest.fn(async () => ({
      id: 'preview-' + id,
      url: 'http://127.0.0.1:54321/',
    })),
    stopPreview: jest.fn(async () => undefined),
  };
  const entry = registry.ensure(identity(id), transport);
  const controller = entry.controller;
  const tab = controller.tab();
  let documentId = 0;
  const driver: BrowserDriver = {
    documentState: jest.fn(async () => ({
      id: String(documentId),
      url: tab.url,
      ready: true,
    })),
    evaluate: jest.fn(async () => ({
      ok: true,
      value: { url: 'https://example.test/', elements: [] },
    })),
    screenshot: jest.fn(async () => 'image'),
    navigate: jest.fn(url => {
      queueMicrotask(() => {
        documentId++;
        controller.navigation(tab.id, {
          url,
          title: 'Page',
          canGoBack: true,
          canGoForward: false,
        });
        controller.loadEnd(tab.id);
      });
    }),
    back: jest.fn(() => {
      documentId++;
      controller.loadEnd(tab.id);
    }),
    forward: jest.fn(() => {
      documentId++;
      controller.loadEnd(tab.id);
    }),
    reload: jest.fn(() => {
      documentId++;
      controller.loadEnd(tab.id);
    }),
    clearData: jest.fn(async () => undefined),
  };
  controller.attach(tab.id, driver);
  return { registry, controller, transport, driver, tab };
}

test('clearing data releases history and renderers while preserving URLs for an explicit reload', async () => {
  const { controller, driver, transport, tab } = fixture();
  await controller.action('navigate', { url: 'http://localhost:3000/page' });
  const viewGeneration = tab.viewGeneration;
  await controller.clearData();
  expect(driver.clearData).toHaveBeenCalledTimes(1);
  expect(tab).toMatchObject({
    url: 'http://localhost:3000/page',
    driver: null,
    lifecycle: 'cleared',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    viewGeneration: viewGeneration + 1,
  });
  expect(tab.previews.size).toBe(0);
  expect(transport.stopPreview).toHaveBeenCalledWith('preview-a');
  controller.attach(tab.id, driver, viewGeneration);
  expect(tab.driver).toBeNull();
});

test.each([
  ['google.com', 'https://google.com/'],
  [' reddit.com/r/android ', 'https://reddit.com/r/android'],
  ['https://example.test/path?q=test', 'https://example.test/path?q=test'],
  ['//example.test/path', 'https://example.test/path'],
  ['localhost:3000/path', 'http://localhost:3000/path'],
  ['127.0.0.1:8000', 'http://127.0.0.1:8000/'],
  ['[::1]:3000', 'http://[::1]:3000/'],
  ['192.168.1.2:8080', 'http://192.168.1.2:8080/'],
])('browser address %s opens %s', (input, expected) => {
  expect(browserAddress(input)).toBe(expected);
});

test.each([
  // Deliberately verify that script URLs cannot reach native navigation.
  // eslint-disable-next-line no-script-url
  'javascript:alert(1)',
  'file:///tmp/page',
  'data:text/html,test',
  'https://user:secret@example.test/',
  'not an address',
  'https://example.test\\@evil.test',
])('browser addresses reject unsupported or ambiguous input: %s', input => {
  expect(() => browserAddress(input)).toThrow();
});

test('initial blank-page actions need only a mounted driver, without any load-end event', async () => {
  const { controller, driver, tab } = fixture();
  expect(tab.loading).toBe(false);
  await expect(controller.action('resolve_tab')).resolves.toMatchObject({
    tab_id: tab.id,
  });
  await expect(
    controller.action('navigate', { url: 'google.com' }),
  ).resolves.toMatchObject({ url: 'https://google.com/' });
  expect(driver.navigate).toHaveBeenCalledWith('https://google.com/');
});

test('a page-loading flag does not block snapshots, typing, or a replacement navigation', async () => {
  const { controller, tab, driver } = fixture();
  controller.loadStart(tab.id);
  await expect(
    controller.action('evaluate', { js: 'test' }),
  ).resolves.toBeDefined();
  await expect(
    controller.action('evaluate', { js: 'test' }),
  ).resolves.toBeDefined();
  await expect(
    controller.action('navigate', { url: 'https://example.test/next' }),
  ).resolves.toBeDefined();
  expect(driver.navigate).toHaveBeenCalledTimes(1);
});

test('navigation waits for the new document, then succeeds before subresources finish loading', async () => {
  const { controller, driver, tab } = fixture();
  let committed = false;
  jest
    .mocked(driver.navigate)
    .mockImplementation(() => controller.loadStart(tab.id));
  jest.mocked(driver.documentState).mockImplementation(async () => ({
    id: committed ? 'new-document' : 'old-document',
    url: committed ? 'https://example.test/redirect' : 'about:blank',
    ready: true,
  }));
  const pending = controller.action('navigate', {
    url: 'https://example.test/next',
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(driver.navigate).toHaveBeenCalled();
  // A late completion from the initial blank page cannot finish navigation.
  controller.loadEnd(tab.id);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  controller.loadStart(tab.id);
  committed = true;
  await expect(pending).resolves.toMatchObject({
    url: 'https://example.test/redirect',
  });
  expect(tab.url).toBe('https://example.test/redirect');
  expect(tab.loading).toBe(true);
  await expect(
    controller.action('evaluate', { js: 'test' }),
  ).resolves.toBeDefined();
});

test('failed loads report a WebView error and a later navigation can recover', async () => {
  const { controller, driver, tab } = fixture();
  jest
    .mocked(driver.navigate)
    .mockImplementationOnce(() => controller.loadError(tab.id, -6));
  await expect(
    controller.action('navigate', { url: 'https://example.test/' }),
  ).rejects.toThrow('WebView error -6');
  await expect(
    controller.action('navigate', { url: 'google.com' }),
  ).resolves.toBeDefined();
});

test('back and forward can finish within the same SPA document', async () => {
  const { controller, driver, tab } = fixture();
  tab.url = 'https://example.test/#second';
  tab.canGoBack = true;
  tab.canGoForward = true;
  jest.mocked(driver.documentState).mockImplementation(async () => ({
    id: 'same-document',
    url: tab.url,
    ready: true,
  }));
  jest.mocked(driver.back).mockImplementation(() => {
    tab.url = 'https://example.test/#first';
  });
  jest.mocked(driver.forward).mockImplementation(() => {
    tab.url = 'https://example.test/#second';
  });
  await expect(controller.action('back')).resolves.toMatchObject({
    url: 'https://example.test/',
  });
  expect(tab.url).toBe('https://example.test/#first');
  await expect(controller.action('forward')).resolves.toBeDefined();
  expect(tab.url).toBe('https://example.test/#second');
});

test('closing a tab during its document probe rejects a late navigation result', async () => {
  const { controller, driver, tab } = fixture();
  let finish!: (state: { id: string; url: string; ready: boolean }) => void;
  let started!: () => void;
  const probing = new Promise<void>(resolve => {
    started = resolve;
  });
  jest
    .mocked(driver.documentState)
    .mockResolvedValueOnce({ id: 'old', url: 'about:blank', ready: true })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
          started();
        }),
    );
  const pending = controller.action('navigate', {
    url: 'https://example.test/',
  });
  await probing;
  await controller.closeTab(tab.id);
  finish({ id: 'new', url: 'https://example.test/', ready: true });
  await expect(pending).rejects.toThrow('closed');
});

test('MCP watchdog expiry is reported as timeout rather than explicit cancellation', async () => {
  jest.useFakeTimers();
  try {
    const { registry, driver } = fixture();
    jest
      .mocked(driver.evaluate)
      .mockImplementationOnce(() => new Promise(() => undefined));
    const runtime = {
      runtimeId: 'host',
      startWebPreview: jest.fn(),
      stopPreview: jest.fn(),
      reverseControlSessions: () => [identity('a')],
      reverseControlReply: jest.fn(),
    };
    const pending = registry.event(
      {
        session: identity('a'),
        kind: 'action',
        requestId: 'timeout',
        action: 'evaluate',
        argumentsJson: '{"js":"test"}',
      },
      runtime,
    );
    await jest.advanceTimersByTimeAsync(BROWSER_ACTION_TIMEOUT_MS);
    await pending;
    expect(
      JSON.parse(runtime.reverseControlReply.mock.calls[0][2]),
    ).toMatchObject({
      ok: false,
      error: { code: 'timeout', message: 'Browser action timed out' },
    });
    await expect(
      registry.entries.get('a')!.controller.action('evaluate', { js: 'test' }),
    ).resolves.toBeDefined();
  } finally {
    jest.useRealTimers();
  }
});

test('launch offer is Codex-only and platform capability is checked', () => {
  expect(offersReverseControl('codex --model test', true)).toBe(true);
  for (const command of ['claude', 'opencode', 'echo codex', 'codex-helper'])
    expect(offersReverseControl(command, true)).toBe(false);
  expect(offersReverseControl('codex', false)).toBe(false);
});

test('UI hide and reopen keep the same tab, driver and browser state', async () => {
  const { registry, controller, driver, tab } = fixture();
  await controller.action('navigate', { url: 'https://example.test/next' });
  registry.open('a');
  registry.hide();
  registry.open('a');
  expect(controller.tab()).toBe(tab);
  expect(tab.driver).toBe(driver);
  expect(tab.url).toBe('https://example.test/next');
  expect(registry.forPane('host', 'pane-a')?.controller).toBe(controller);
  expect(registry.forPane('host', 'ordinary-pane')).toBeUndefined();
});

test('idle suspension skips visible and busy tabs and releases unused SSH previews', async () => {
  const { controller, driver, tab, transport } = fixture();
  await controller.action('navigate', { url: 'http://localhost:3000/' });
  tab.lastUsedAt = 0;
  await controller.suspendInactive(Date.now() + 1000, tab.id);
  expect(tab.lifecycle).toBe('active');
  let finish!: (value: unknown) => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => {
    started = resolve;
  });
  jest.mocked(driver.evaluate).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
        started();
      }),
  );
  const snapshot = controller.action('evaluate', { js: 'test' });
  await running;
  await controller.suspendInactive(Date.now() + 1000);
  expect(tab.lifecycle).toBe('active');
  finish({ ok: true, value: {} });
  await snapshot;
  await controller.suspendInactive(Date.now() + 1000);
  expect(tab.lifecycle).toBe('suspended');
  expect(tab.url).toBe('http://localhost:3000/');
  expect(tab.driver).toBeNull();
  expect(transport.stopPreview).toHaveBeenCalledWith('preview-a');
});

test('old renderer detach and crash callbacks cannot affect the restored renderer', async () => {
  const { controller, tab, driver } = fixture();
  const oldVersion = tab.viewGeneration;
  controller.rendererGone(tab.id, oldVersion);
  const restored = controller.action('reload');
  await Promise.resolve();
  await Promise.resolve();
  controller.attach(tab.id, driver, tab.viewGeneration);
  await restored;
  controller.attach(tab.id, null, oldVersion);
  controller.rendererGone(tab.id, oldVersion);
  expect(tab.lifecycle).toBe('active');
  expect(tab.driver).toBe(driver);
  await expect(
    controller.action('evaluate', { js: 'test' }),
  ).resolves.toBeDefined();
});

test('renderer failure during reload rejects without waiting for another attachment', async () => {
  const { controller, tab } = fixture();
  controller.rendererGone(tab.id, tab.viewGeneration);
  const restored = controller.action('reload').catch((error: unknown) => error);
  await Promise.resolve();
  await Promise.resolve();
  expect(tab.lifecycle).toBe('active');
  controller.rendererGone(tab.id, tab.viewGeneration);
  expect(await restored).toMatchObject({
    message: expect.stringContaining('Browser renderer stopped'),
  });
});

test('generic evaluation resumes a suspended page before capturing its generation', async () => {
  const { controller, tab, driver } = fixture();
  await controller.suspendInactive(Date.now() + 1000);
  const waiting = controller.action('evaluate', { js: 'test' });
  await Promise.resolve();
  await Promise.resolve();
  controller.attach(tab.id, driver, tab.viewGeneration);
  jest
    .mocked(driver.evaluate)
    .mockResolvedValueOnce({ ok: true, value: { ready: true } });
  await expect(waiting).resolves.toMatchObject({ value: { ready: true } });
  expect(tab.lifecycle).toBe('active');
});

test('agents on the same host have separate browsers and cannot address sibling tabs', async () => {
  const registry = new BrowserRegistry();
  const a = fixture(registry, 'a');
  const b = fixture(registry, 'b');
  await a.controller.action('navigate', { url: 'https://example.test/a' });
  expect(b.tab.url).toBe('about:blank');
  await expect(
    a.controller.action('evaluate', { js: 'test', tab_id: b.tab.id }),
  ).rejects.toThrow('unknown');
  await registry.close('a');
  expect(b.controller.disposed).toBe(false);
});

test('tabs enforce quota and closing the selected tab chooses a live sibling', async () => {
  const { controller, tab } = fixture();
  const second = (await controller.action('new_tab')) as { tab_id: string };
  await controller.action('new_tab');
  await expect(controller.action('new_tab')).rejects.toThrow('limit');
  await controller.action('close_tab');
  expect(controller.selectedTabId).toBe(tab.id);
  expect(
    ((await controller.action('list_tabs')) as { tabs: unknown[] }).tabs,
  ).toHaveLength(2);
  await expect(
    controller.action('evaluate', { js: 'test', tab_id: 'not-mine' }),
  ).rejects.toThrow('unknown');
  expect(controller.tabs.some(item => item.id === second.tab_id)).toBe(true);
});

test('queued actions keep their arrival tab despite user tab selection', async () => {
  const { controller, driver, tab } = fixture();
  let finish!: (value: unknown) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  jest.mocked(driver.evaluate).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
        markStarted();
      }),
  );
  const first = controller.action('evaluate', { js: 'test' });
  await started;
  const queued = controller.action('evaluate', { js: 'test' });
  controller.newTab();
  finish({ ok: true, value: { elements: [] } });
  await first;
  expect(await queued).toMatchObject({ value: { elements: [] } });
  expect(driver.evaluate).toHaveBeenCalledTimes(2);
  expect(controller.tab(tab.id).driver).toBe(driver);
});

test('page changes during evaluation reject the response and release the queue', async () => {
  const { controller, driver, tab } = fixture();
  jest.mocked(driver.evaluate).mockImplementationOnce(async () => {
    controller.loadStart(tab.id);
    controller.loadEnd(tab.id);
    return { ok: true, value: {} };
  });
  await expect(controller.action('evaluate', { js: 'test' })).rejects.toThrow(
    'Page changed',
  );
  await expect(
    controller.action('evaluate', { js: 'test' }),
  ).resolves.toMatchObject({
    value: { elements: [] },
  });
});

test('cancelled renderer calls release the action queue without applying to another tab', async () => {
  const { controller, driver } = fixture();
  jest
    .mocked(driver.evaluate)
    .mockImplementationOnce(() => new Promise(() => undefined));
  const abort = new AbortController();
  const pending = controller.action('evaluate', { js: 'test' }, abort.signal);
  await Promise.resolve();
  await Promise.resolve();
  abort.abort();
  await expect(pending).rejects.toThrow('cancelled');
  await expect(
    controller.action('evaluate', { js: 'test' }),
  ).resolves.toBeDefined();
});

test('remote localhost forwards survive UI close and are released on tab/session cleanup', async () => {
  const { controller, transport, registry, tab } = fixture();
  await controller.action('navigate', { url: 'http://localhost:3000/' });
  expect(transport.startWebPreview).toHaveBeenCalledWith(
    'http://localhost:3000/',
  );
  registry.open('a');
  registry.hide();
  expect(transport.stopPreview).not.toHaveBeenCalled();
  await controller.action('navigate', { url: 'http://localhost:3000/other' });
  expect(transport.startWebPreview).toHaveBeenCalledTimes(1);
  await controller.closeTab(tab.id);
  expect(transport.stopPreview).toHaveBeenCalledWith('preview-a');
  await registry.closeHost('host');
  expect(controller.disposed).toBe(true);
});

test('late preview completion after session cleanup is immediately stopped', async () => {
  const { controller, transport } = fixture();
  let finish!: (value: { id: string; url: string }) => void;
  transport.startWebPreview.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const pending = controller.action('navigate', {
    url: 'http://localhost:3000/',
  });
  await Promise.resolve();
  await controller.dispose();
  finish({ id: 'late', url: 'http://127.0.0.1:5000/' });
  await expect(pending).rejects.toThrow('cancelled');
  expect(transport.stopPreview).toHaveBeenCalledWith('late');
});

test('unauthorized MCP events never invoke a browser and session cleanup cancels calls', async () => {
  const { registry, controller, driver } = fixture();
  const runtime = {
    runtimeId: 'host',
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
    reverseControlSessions: () => [],
    reverseControlReply: jest.fn(),
  };
  await registry.event(
    {
      session: identity('a'),
      kind: 'action',
      requestId: 'request',
      action: 'snapshot',
      argumentsJson: '{}',
    },
    runtime,
  );
  expect(driver.evaluate).not.toHaveBeenCalled();
  expect(!JSON.parse(runtime.reverseControlReply.mock.calls[0][2]).ok).toBe(
    true,
  );
  await registry.event(
    {
      session: identity('a'),
      kind: 'closed',
      requestId: '',
      action: '',
      argumentsJson: '{}',
    },
    runtime,
  );
  expect(controller.disposed).toBe(true);
});

test('manual preview browsers do not offer reverse-control agent UI', () => {
  const registry = new BrowserRegistry();
  registry.ensure(
    identity('manual'),
    { startWebPreview: jest.fn(), stopPreview: jest.fn() },
    false,
  );
  expect(registry.forPane('host', 'pane-manual')).toBeUndefined();
});

test('a delayed opened event cannot recreate a revoked browser session', async () => {
  const registry = new BrowserRegistry();
  const runtime = {
    runtimeId: 'host',
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
    reverseControlSessions: () => [],
    reverseControlReply: jest.fn(),
  };
  await registry.event(
    {
      session: identity('revoked'),
      kind: 'opened',
      requestId: '',
      action: '',
      argumentsJson: '{}',
    },
    runtime,
  );
  expect(registry.entries.size).toBe(0);
  expect(registry.forPane('host', 'pane-revoked')).toBeUndefined();
});

test('the process cap denies new views without evicting another session or hiding its controls', async () => {
  const registry = new BrowserRegistry();
  const transport = { startWebPreview: jest.fn(), stopPreview: jest.fn() };
  for (let index = 0; index < 9; index++)
    registry.ensure(identity(`session-${index}`), transport);
  const full = registry.ensure(identity('session-9'), transport);
  expect(registry.totalTabs()).toBe(9);
  expect(full.controller.tabs).toHaveLength(0);
  expect(registry.forPane('host', 'pane-session-9')).toBe(full);
  await expect(full.controller.action('new_tab')).rejects.toThrow('limit');
  await registry.close('session-0');
  await expect(full.controller.action('new_tab')).resolves.toHaveProperty(
    'tab_id',
  );
  await registry.closeHost('host');
});

test('Rust operation leases prevent idle suspension between native calls', async () => {
  const { controller, tab } = fixture();
  await controller.action('resolve_tab', { lease_id: 'operation' });
  tab.lastUsedAt = 0;
  await controller.suspendInactive(Date.now());
  expect(tab.lifecycle).toBe('active');
  controller.releaseLease('operation');
  await controller.suspendInactive(Date.now());
  expect(tab.lifecycle).toBe('suspended');
});

test('generic bridge evaluation rejects a replaced page before executing JavaScript', async () => {
  const { controller, driver, tab } = fixture();
  const before = (await controller.action('document_state')) as {
    identity: string;
  };
  controller.loadStart(tab.id);
  await expect(
    controller.action('evaluate', {
      identity: before.identity,
      js: 'window.test = 1',
    }),
  ).rejects.toMatchObject({ code: 'stale_page' });
  expect(driver.evaluate).not.toHaveBeenCalled();
});

test('bridge navigation starts the native request while Rust observes its completion', async () => {
  const { controller, driver, tab } = fixture();
  expect(
    await controller.action('navigate', {
      primitive: true,
      url: 'https://example.test/next',
    }),
  ).toEqual({ target: 'https://example.test/next', navigated: true });
  expect(driver.navigate).toHaveBeenCalledWith('https://example.test/next');
  expect(await controller.action('document_state')).toMatchObject({
    public_url: 'https://example.test/next',
  });
  expect(controller.tab(tab.id)).toBe(tab);
});
