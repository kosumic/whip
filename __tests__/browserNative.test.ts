import { TextDecoder, TextEncoder } from 'node:util';
import { NativeModules } from 'react-native';
import {
  nativeBrowserDriver,
  browserSiteData,
  recordBrowserSite,
  clearBrowserDomainCookies,
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
    },
  },
}));

const native = NativeModules.WhipBrowser as {
  evaluate: jest.Mock;
  navigate: jest.Mock;
  recordSite: jest.Mock;
  siteData: jest.Mock;
  clearDomainCookies: jest.Mock;
};
let page: Dom;
const driver = nativeBrowserDriver(42, {
  goBack: jest.fn(),
  goForward: jest.fn(),
  reload: jest.fn(),
});

test('site management uses the native adapter and domain deletion never becomes a DOM command', async () => {
  const metadata = {
    hasCookies: true,
    domains: ['example.test'],
    canClearDomains: true,
  };
  native.siteData.mockResolvedValue(metadata);
  recordBrowserSite('https://example.test/page');
  expect(native.recordSite).toHaveBeenCalledWith('https://example.test/page');
  expect(await browserSiteData()).toEqual(metadata);
  const before = native.evaluate.mock.calls.length;
  await clearBrowserDomainCookies('example.test');
  expect(native.clearDomainCookies).toHaveBeenCalledWith('example.test');
  expect(native.evaluate).toHaveBeenCalledTimes(before);
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
