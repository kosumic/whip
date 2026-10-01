import { TextDecoder, TextEncoder } from 'node:util';
import { NativeModules, Platform } from 'react-native';
import {
  nativeBrowserDriver,
  browserSiteData,
  recordBrowserSite,
  clearBrowserDomainCookies,
  supportsBrowserControl,
} from '../src/browser/native';
import type { JSDOM as Dom } from 'jsdom';

Object.assign(global, { TextDecoder, TextEncoder });
const { JSDOM } = require('jsdom') as typeof import('jsdom');

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {
    WhipBrowser: {
      evaluate: jest.fn(),
      navigate: jest.fn(),
      recordSite: jest.fn(),
      siteData: jest.fn(),
      clearDomainCookies: jest.fn(),
      currentSiteInfo: jest.fn(),
      clearCurrentSiteData: jest.fn(),
      download: jest.fn(),
      cancelDownload: jest.fn(),
    },
  },
}));

const native = NativeModules.WhipBrowser as {
  evaluate: jest.Mock;
  navigate: jest.Mock;
  recordSite: jest.Mock;
  siteData: jest.Mock;
  clearDomainCookies: jest.Mock;
  currentSiteInfo: jest.Mock;
  clearCurrentSiteData: jest.Mock;
  download: jest.Mock;
  cancelDownload: jest.Mock;
};
let page: Dom;
const driver = nativeBrowserDriver(42, {
  goBack: jest.fn(),
  goForward: jest.fn(),
  reload: jest.fn(),
});

test('iOS browser support follows native adapter availability', () => {
  const module = NativeModules.WhipBrowser;
  const platform = Platform.OS;
  try {
    Platform.OS = 'ios';
    expect(supportsBrowserControl()).toBe(true);
    delete NativeModules.WhipBrowser;
    expect(supportsBrowserControl()).toBe(false);
  } finally {
    NativeModules.WhipBrowser = module;
    Platform.OS = platform;
  }
});

test('site management uses the native adapter and domain deletion never becomes a DOM command', async () => {
  const metadata = {
    hasCookies: true,
    domains: ['example.test'],
    canClearDomains: true,
  };
  native.siteData.mockResolvedValue(metadata);
  recordBrowserSite('https://example.test/page');
  expect(native.recordSite).toHaveBeenCalledWith(
    'https://example.test/page',
    '',
  );
  recordBrowserSite('https://localhost:3000/', 'host-runtime');
  expect(native.recordSite).toHaveBeenCalledWith(
    'https://localhost:3000/',
    'host-runtime',
  );
  expect(await browserSiteData()).toEqual(metadata);
  const before = native.evaluate.mock.calls.length;
  await clearBrowserDomainCookies('example.test');
  expect(native.clearDomainCookies).toHaveBeenCalledWith('example.test');
  expect(native.evaluate).toHaveBeenCalledTimes(before);
});

test('current site information and clearing target the mounted tab and expected URL', async () => {
  const url = 'https://example.test/path';
  native.currentSiteInfo.mockResolvedValue({ url, secure: true });
  expect(await driver.siteInfo!(url)).toEqual({ url, secure: true });
  expect(native.currentSiteInfo).toHaveBeenCalledWith(42, url);
  await driver.clearSiteData!(url);
  expect(native.clearCurrentSiteData).toHaveBeenCalledWith(42, url);
});

beforeEach(async () => {
  page = new JSDOM('<title>Page</title><button>Continue</button>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
  });
  native.evaluate.mockImplementation(async (_tag: number, script: string) =>
    JSON.stringify(page.window.eval(script)),
  );
  native.navigate.mockReset().mockResolvedValue(undefined);
  await new Promise<void>(resolve =>
    page.window.addEventListener('load', () => resolve()),
  );
});
afterEach(() => page.window.close());

test('document readiness survives resource loading and identifies a replacement document at the same URL', async () => {
  Object.defineProperty(page.window.document, 'readyState', {
    configurable: true,
    value: 'interactive',
  });
  const first = await driver.documentState();
  expect(first).toMatchObject({ url: 'https://example.test/', ready: true });
  expect(await driver.documentState()).toEqual(first);
  page.window.close();
  page = new JSDOM('<title>Reloaded</title>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
  });
  Object.defineProperty(page.window.document, 'readyState', {
    value: 'interactive',
  });
  const next = await driver.documentState();
  expect(next?.id).not.toEqual(first?.id);
  expect(next?.ready).toBe(true);
});

test('navigation uses the native WebView command and propagates native failures', async () => {
  await driver.navigate('https://reddit.com/');
  expect(native.navigate).toHaveBeenCalledWith(42, 'https://reddit.com/');
  native.navigate.mockRejectedValueOnce(
    new Error('Browser tab is no longer mounted'),
  );
  await expect(driver.navigate('https://google.com/')).rejects.toThrow(
    'no longer mounted',
  );
});

test('a document still parsing reports not ready', async () => {
  Object.defineProperty(page.window.document, 'readyState', {
    value: 'loading',
  });
  expect(await driver.documentState()).toMatchObject({ ready: false });
});

test('native screenshot bridge forwards ref annotations without injecting page overlays', async () => {
  const annotations = {
    generation: 'page:1',
    viewport_width: 800,
    viewport_height: 600,
    elements: [{ ref: 'ref:1', x: 10, y: 20 }],
  };
  const screenshot = jest.fn(async () => 'jpeg');
  NativeModules.WhipBrowser.screenshot = screenshot;
  const before = native.evaluate.mock.calls.length;
  expect(await driver.screenshot(annotations)).toBe('jpeg');
  expect(screenshot).toHaveBeenCalledWith(42, annotations);
  expect(native.evaluate).toHaveBeenCalledTimes(before);
  await driver.screenshot();
  expect(screenshot).toHaveBeenLastCalledWith(42, null);
});

test('downloads use the native session and abort cancels the native request', async () => {
  const result = {
    local_path: '/cache/whip-browser-downloads/file',
    bytes: 4,
    mime_type: 'application/pdf',
  };
  const abort = new AbortController();
  let finish!: (value: typeof result) => void;
  native.download.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const before = native.evaluate.mock.calls.length;
  const pending = driver.download!(
    'https://example.test/report.pdf',
    1024,
    abort.signal,
  );
  const [tag, id, url, maxBytes] = native.download.mock.calls.at(-1)!;
  expect([tag, url, maxBytes]).toEqual([
    42,
    'https://example.test/report.pdf',
    1024,
  ]);
  abort.abort();
  expect(native.cancelDownload).toHaveBeenCalledWith(id);
  finish(result);
  await expect(pending).rejects.toThrow('cancelled');
  expect(native.evaluate).toHaveBeenCalledTimes(before);
});

test('a successful download returns only native file metadata and pre-aborted calls never start', async () => {
  const result = {
    local_path: '/cache/whip-browser-downloads/file',
    bytes: 4,
    mime_type: 'text/csv',
  };
  native.download.mockResolvedValueOnce(result);
  const abort = new AbortController();
  expect(
    await driver.download!(
      'https://example.test/report.csv',
      1024,
      abort.signal,
    ),
  ).toEqual(result);
  const before = native.download.mock.calls.length;
  abort.abort();
  await expect(
    driver.download!('https://example.test/report.csv', 1024, abort.signal),
  ).rejects.toThrow('cancelled');
  expect(native.download).toHaveBeenCalledTimes(before);
});

test('download errors never forward native request details', async () => {
  native.download.mockRejectedValueOnce(
    new Error('https://example.test/export?token=private Cookie: secret'),
  );
  await expect(
    driver.download!(
      'https://example.test/export',
      1024,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/^Browser download failed$/);
});
