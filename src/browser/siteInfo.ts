export type BrowserPermissionState = 'allowed' | 'ask' | 'blocked' | 'system';
export interface BrowserSiteInfo {
  url: string;
  secure: boolean;
  hasCookies: boolean;
  thirdPartyCookiesAllowed: boolean | null;
  canClearSiteData: boolean;
  permissions: {
    location: BrowserPermissionState;
    camera: BrowserPermissionState;
    microphone: BrowserPermissionState;
  };
  certificate?: {
    subject: string;
    issuer?: string;
    validFrom?: number;
    validTo?: number;
  } | null;
}

/** The address shown on a page remains separate from the full URL used to edit. */
export function browserDisplayAddress(url: string): string {
  const address = new URL(url);
  return (
    address.host +
    (address.pathname === '/' ? '' : address.pathname) +
    address.search +
    address.hash
  );
}
