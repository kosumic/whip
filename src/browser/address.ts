import { isSshTunnelHost, terminalWebLinkTarget } from '../lib/terminalLinks';
import { browserSearchUrl, type BrowserSearchEngine } from './search';

/** Address-bar input and agent navigation share the same HTTP-only policy. */
export function browserAddress(value: string): string {
  let address = value.trim();
  if (!address || /[\s\\]/.test(address))
    throw new Error('Enter a valid web address');
  if (!/^https?:\/\//i.test(address)) {
    // A numeric port belongs to a hostname, not a custom URL scheme.
    if (
      /^[a-z][a-z\d+.-]*:/i.test(address) &&
      !/^[^/:]+:\d+(?:[/?#]|$)/.test(address)
    )
      throw new Error('Only HTTP and HTTPS links can be opened');
    address = address.startsWith('//')
      ? `https:${address}`
      : `https://${address}`;
    const parsed = new URL(address);
    if (isSshTunnelHost(parsed.hostname)) parsed.protocol = 'http:';
    address = parsed.toString();
  }
  const target = terminalWebLinkTarget(address);
  const parsed = new URL(target.url);
  if (parsed.username || parsed.password)
    throw new Error('Browser URLs cannot contain credentials');
  return target.url;
}

/** Search is an address-bar affordance; agent navigate remains URL-only. */
export function browserOmniboxAddress(
  value: string,
  engine: BrowserSearchEngine,
): string {
  const input = value.trim();
  if (!input) throw new Error('Enter a web address or search');
  // URL-like input must pass the existing scheme/credential policy. Never send
  // rejected URL credentials or executable schemes to a search provider.
  if (
    input.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:\/\//i.test(input) ||
    /^(?:https?|javascript|data|file|ftp|mailto|tel|intent|about):/i.test(
      input,
    ) ||
    /^[^\s/:]+:[^\s/]+@/.test(input)
  )
    return browserAddress(input);
  // A colon in a search operator (site:, filetype:, etc.) is not a URL scheme.
  const operator =
    /^[a-z][a-z\d+.-]*:/i.test(input) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(input);
  const host = input.split(/[/?#]/, 1)[0];
  if (
    !operator &&
    !/\s/.test(input) &&
    (host.toLowerCase() === 'localhost' ||
      host.includes('.') ||
      /^\[[\da-f:]+\](?::\d+)?$/i.test(host) ||
      /^[^:@]+:\d+$/.test(host))
  )
    return browserAddress(input);
  return browserSearchUrl(input, engine);
}
