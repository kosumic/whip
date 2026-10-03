import { NativeModules, Platform } from 'react-native';
import type { BrowserDocumentState, BrowserDriver } from './controller';
import type { BrowserSiteInfo } from './siteInfo';
export interface BrowserAnnotations {
  elements: { ref: string; x: number; y: number }[];
  viewport_width: number;
  viewport_height: number;
  generation: string;
}
export interface BrowserSiteData {
  hasCookies: boolean;
  domains: string[];
  canClearDomains: boolean;
}

interface NativeBrowser {
  saveState(tag: number): Promise<string | null>;
  restoreState(tag: number, token: string): Promise<boolean>;
  discardState(token: string): void;
  download(
    tag: number,
    id: string,
    url: string,
    maxBytes: number,
  ): Promise<BrowserDownload>;
  cancelDownload(id: string): void;
  prepare(
    tag: number,
    runtimeId?: string,
    tunnelHostId?: string | null,
  ): Promise<void>;
  supportsProxy?: boolean;
  configureProxy(runtimeId: string, port: number): Promise<void>;
  favicon(runtimeId: string, url: string): Promise<string>;
  currentSiteInfo(tag: number, url: string): Promise<BrowserSiteInfo>;
  clearCurrentSiteData(tag: number, url: string): Promise<void>;
  defaultUserAgent(): Promise<string>;
  evaluate(tag: number, script: string): Promise<string>;
  navigate(tag: number, url: string): Promise<void>;
  screenshot(
    tag: number,
    annotations: BrowserAnnotations | null,
  ): Promise<string>;
  clearSiteData(): Promise<void>;
  clearTabData(tag: number): Promise<void>;
  recordSite(url: string, runtimeId?: string): void;
  siteData(): Promise<BrowserSiteData>;
  clearDomainCookies(domain: string): Promise<void>;
}
export interface BrowserDownload {
  local_path: string;
  bytes: number;
  mime_type: string;
}
let nextDownload = 0;
/** UI enablement follows adapter availability, so iOS can use the same layers. */
export function supportsBrowserControl(): boolean {
  return (
    (Platform?.OS === 'android' || Platform?.OS === 'ios') &&
    !!NativeModules?.WhipBrowser
  );
}
function nativeBrowser(): NativeBrowser {
  const module = NativeModules.WhipBrowser as NativeBrowser | undefined;
  if (!module)
    throw new Error('Browser control requires the native Whip browser adapter');
  return module;
}
export function nativeBrowserDriver(
  tag: number,
  handle: {
    goBack(): void;
    goForward(): void;
    reload(): void;
  },
): BrowserDriver {
  const evaluate = async (script: string): Promise<unknown> => {
    const encoded = await nativeBrowser().evaluate(tag, script);
    const value: unknown = JSON.parse(encoded);
    return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  };
  return {
    saveState: async () => {
      const module = nativeBrowser();
      const token = await module.saveState(tag);
      return token
        ? {
            restore: driver =>
              driver.restoreState?.(token) || Promise.resolve(false),
            dispose: () => module.discardState(token),
          }
        : null;
    },
    restoreState: token => nativeBrowser().restoreState(tag, token),
    download: async (url, maxBytes, signal) => {
      const id = `${tag}-${++nextDownload}`;
      const module = nativeBrowser();
      const cancel = () => module.cancelDownload(id);
      if (signal.aborted) throw new Error('Browser action cancelled');
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await module.download(tag, id, url, maxBytes);
        if (signal.aborted) {
          cancel();
          throw new Error('Browser action cancelled');
        }
        return result;
      } catch {
        throw new Error(
          signal.aborted
            ? 'Browser action cancelled'
            : 'Browser download failed',
        );
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
    siteInfo: url => nativeBrowser().currentSiteInfo(tag, url),
    clearSiteData: url => nativeBrowser().clearCurrentSiteData(tag, url),
    evaluate,
    documentState: async () =>
      (await evaluate(`(function () {
        if (!document.__whipDocumentId)
          document.__whipDocumentId = Date.now().toString(36) + Math.random().toString(36);
        return JSON.stringify({id: document.__whipDocumentId, url: location.href,
          ready: document.readyState !== 'loading'});
      })();`)) as BrowserDocumentState | null,
    screenshot: annotations =>
      nativeBrowser().screenshot(tag, annotations || null),
    navigate: url => nativeBrowser().navigate(tag, url),
    back: () => handle.goBack(),
    forward: () => handle.goForward(),
    reload: () => handle.reload(),
    clearData: () => nativeBrowser().clearTabData(tag),
  };
}
export const clearBrowserSiteData = () => nativeBrowser().clearSiteData();
export const prepareBrowserView = (
  tag: number,
  runtimeId?: string,
  tunnelHostId?: string | null,
) =>
  Platform.OS === 'android'
    ? nativeBrowser().prepare(tag, runtimeId, tunnelHostId || null)
    : nativeBrowser().prepare(tag);
export const supportsBrowserProxy = () =>
  Platform?.OS === 'android' &&
  !!(NativeModules?.WhipBrowser as NativeBrowser | undefined)?.supportsProxy;
export const configureBrowserProxy = (runtimeId: string, port: number) =>
  nativeBrowser().configureProxy(runtimeId, port);
export const browserFavicon = (runtimeId: string, url: string) =>
  Platform.OS === 'android'
    ? nativeBrowser().favicon(runtimeId, url)
    : Promise.resolve(url);
export const defaultBrowserUserAgent = () => nativeBrowser().defaultUserAgent();
export const recordBrowserSite = (url: string, runtimeId?: string) =>
  Platform.OS === 'android'
    ? nativeBrowser().recordSite(url, runtimeId || '')
    : nativeBrowser().recordSite(url);
export const browserSiteData = () => nativeBrowser().siteData();
export const clearBrowserDomainCookies = (domain: string) =>
  nativeBrowser().clearDomainCookies(domain);
