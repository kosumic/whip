import {
  BrowserPlatformAction,
  BrowserPlatformError,
  BrowserPlatformResult_Tags,
  BrowserTabChange,
  type BrowserEffectPermitLike,
} from 'react-native-whip-ssh/src/browserOperations';
import { BrowserRegistry } from '../src/browser/registry';
import { browserOperationPlatform } from '../src/browser/operations';
import type { BrowserDriver } from '../src/browser/controller';

function permit(id = 'native-effect') {
  let active = true;
  const value: BrowserEffectPermitLike = {
    effectId: () => id,
    checkActive: jest.fn(() => { if (!active) throw new Error('Native operation revoked'); }),
  };
  return { value, revoke: () => { active = false; } };
}

function fixture() {
  const registry = new BrowserRegistry();
  const transport = { startWebPreview: jest.fn(async () => ({ id: 'preview', url: 'http://127.0.0.1:5000/' })), stopPreview: jest.fn(async () => {}) };
  const owner = { runtimeId: 'host', sessionId: 'session', paneId: 'pane', terminalId: 'terminal' };
  const { controller } = registry.ensure(owner, transport);
  const tab = controller.tab();
  const driver: BrowserDriver = {
    documentState: jest.fn(async () => ({ id: 'document', url: tab.url, ready: true })),
    evaluate: jest.fn(async () => ({ result: 'page data' })),
    screenshot: jest.fn(async () => 'image'),
    navigate: jest.fn(), back: jest.fn(), forward: jest.fn(), reload: jest.fn(), clearData: jest.fn(async () => {}),
  };
  controller.attach(tab.id, driver);
  const adapter = browserOperationPlatform(registry);
  return { registry, controller, tab, transport, driver, adapter, owner };
}

test('typed native effects address their original tab after a user selects another tab', async () => {
  const { controller, tab, driver, adapter } = fixture();
  const other = controller.newTab();
  const otherDriver = { ...driver, evaluate: jest.fn() };
  controller.attach(other.id, otherDriver);
  const result = await adapter.platform.perform(permit().value, 'session', new BrowserPlatformAction.Evaluate({ tabId: tab.id, script: 'page script' }));
  expect(result).toMatchObject({ tag: BrowserPlatformResult_Tags.Json, inner: { valueJson: '{"result":"page data"}' } });
  expect(driver.evaluate).toHaveBeenCalledWith('page script');
  expect(otherDriver.evaluate).not.toHaveBeenCalled();
  adapter.dispose();
});

test('native permit revocation rejects late evaluations and bounds platform error text', async () => {
  const { tab, driver, adapter } = fixture();
  let finish!: (value: unknown) => void;
  jest.mocked(driver.evaluate).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const current = permit();
  const pending = adapter.platform.perform(current.value, 'session', new BrowserPlatformAction.Evaluate({ tabId: tab.id, script: 'page script' }));
  current.revoke();
  finish({ result: 'late page data' });
  await expect(pending).rejects.toBeInstanceOf(BrowserPlatformError.EvalFailed);
  jest.mocked(driver.evaluate).mockRejectedValueOnce(new Error('private-cookie=secret'));
  await expect(adapter.platform.perform(permit('next').value, 'session', new BrowserPlatformAction.Evaluate({ tabId: tab.id, script: 'page script' })))
    .rejects.toMatchObject({ message: expect.not.stringContaining('secret') });
  adapter.dispose();
});

test('cancelled native view preparation releases late SSH previews without mounting them', async () => {
  const { controller, tab, transport, adapter } = fixture();
  controller.navigation(tab.id, { url: 'http://localhost:3000/page', title: 'Remote', canGoBack: false, canGoForward: false });
  await controller.suspendTab(tab);
  controller.operations.change(tab.id, BrowserTabChange.Resume);
  let finish!: (value: { id: string; url: string }) => void;
  transport.startWebPreview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const current = permit();
  const pending = adapter.platform.prepareTab(current.value, 'session', tab.id, true, false);
  await Promise.resolve();
  current.revoke();
  adapter.platform.cancel(current.value.effectId());
  finish({ id: 'late-preview', url: 'http://127.0.0.1:6000/' });
  await expect(pending).rejects.toBeInstanceOf(BrowserPlatformError.Unavailable);
  expect(transport.stopPreview).toHaveBeenCalledWith('late-preview');
  expect(tab.driver).toBeNull();
  expect(tab.lifecycle).toBe('suspended');
  adapter.dispose();
});

test('opaque native effect IDs cancel only the corresponding OS download', async () => {
  const { tab, driver, adapter } = fixture();
  const signals: AbortSignal[] = [];
  const finish: ((value: { local_path: string; bytes: number; mime_type: string }) => void)[] = [];
  let bothStarted!: () => void;
  const started = new Promise<void>(resolve => { bothStarted = resolve; });
  driver.download = jest.fn((_url, _max, signal) => new Promise((resolve, reject) => {
    signals.push(signal); finish.push(resolve);
    signal.addEventListener('abort', () => reject(new Error('download cancelled')), { once: true });
    if (signals.length === 2) bothStarted();
  }));
  const first = permit('first');
  const second = permit('second');
  const action = new BrowserPlatformAction.Download({ tabId: tab.id, url: 'https://example.test/file', maxBytes: 1024 });
  const a = adapter.platform.perform(first.value, 'session', action).catch((error: unknown) => error);
  const b = adapter.platform.perform(second.value, 'session', action);
  await started;
  first.revoke();
  adapter.platform.cancel('first');
  expect(signals.map(signal => signal.aborted)).toEqual([true, false]);
  finish[1]({ local_path: '/cache/whip-browser-downloads/file', bytes: 4, mime_type: 'text/plain' });
  expect(await a).toBeInstanceOf(BrowserPlatformError.DownloadFailed);
  expect(await b).toMatchObject({ tag: BrowserPlatformResult_Tags.Download, inner: { bytes: 4n, mimeType: 'text/plain' } });
  adapter.dispose();
});

test('late archive hydration cannot create browser handles after native cancellation', async () => {
  const registry = new BrowserRegistry();
  let finish!: () => void;
  jest.spyOn(registry, 'loadArchive').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const ensure = jest.spyOn(registry, 'ensure');
  const adapter = browserOperationPlatform(registry);
  const current = permit();
  const pending = adapter.platform.ensureSession(current.value, { runtimeId: 'host', sessionId: 'session', paneId: 'pane', terminalId: 'terminal' }, true);
  current.revoke();
  finish();
  await expect(pending).rejects.toBeInstanceOf(BrowserPlatformError.Unavailable);
  expect(ensure).not.toHaveBeenCalled();
  adapter.dispose();
});
