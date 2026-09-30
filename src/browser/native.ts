import { NativeModules, Platform } from 'react-native';
import type { BrowserDocumentState, BrowserDriver } from './controller';
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
  prepare(tag: number): Promise<void>;
  defaultUserAgent(): Promise<string>;
  evaluate(tag: number, script: string): Promise<string>;
  navigate(tag: number, url: string): Promise<void>;
  screenshot(
    tag: number,
    annotations: BrowserAnnotations | null,
  ): Promise<string>;
  clearSiteData(): Promise<void>;
  clearTabData(tag: number): Promise<void>;
  recordSite(url: string): void;
  siteData(): Promise<BrowserSiteData>;
  clearDomainCookies(domain: string): Promise<void>;
}
/** UI enablement follows adapter availability, so iOS can use the same layers. */
export function supportsBrowserControl(): boolean {
  return (
    (Platform.OS === 'android' || Platform.OS === 'ios') &&
    !!NativeModules.WhipBrowser
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
export const prepareBrowserView = (tag: number) => nativeBrowser().prepare(tag);
export const defaultBrowserUserAgent = () => nativeBrowser().defaultUserAgent();
export const recordBrowserSite = (url: string) =>
  nativeBrowser().recordSite(url);
export const browserSiteData = () => nativeBrowser().siteData();
export const clearBrowserDomainCookies = (domain: string) =>
  nativeBrowser().clearDomainCookies(domain);
