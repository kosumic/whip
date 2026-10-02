import { browserOmniboxAddress } from '../src/browser/address';
import { BROWSER_SEARCH_ENGINES } from '../src/browser/search';

test.each([
  ['google.com', 'https://google.com/'],
  [' https://github.com/kosumic/whip ', 'https://github.com/kosumic/whip'],
  ['//example.test/path?q=a', 'https://example.test/path?q=a'],
  ['localhost', 'http://localhost/'],
  ['localhost:3000/path', 'http://localhost:3000/path'],
  ['127.0.0.1:8000', 'http://127.0.0.1:8000/'],
  ['[::1]:3000', 'http://[::1]:3000/'],
  ['192.168.1.2:8080', 'http://192.168.1.2:8080/'],
])('address bar navigates directly for %s', (input, expected) => {
  expect(browserOmniboxAddress(input, 'duckduckgo')).toBe(expected);
});

test.each([
  'whip',
  ' reverse control browser ',
  'site:github.com whip',
  'filetype:pdf',
  'C++ & café 日本語 #1',
])('address bar searches and safely encodes %s', input => {
  for (const engine of BROWSER_SEARCH_ENGINES) {
    const url = new URL(browserOmniboxAddress(input, engine.id));
    expect(url.origin).toBe(new URL(engine.queryUrl).origin);
    expect(url.searchParams.get('q')).toBe(input.trim());
    expect([...url.searchParams.keys()]).toEqual(['q']);
    expect(url.hash).toBe('');
  }
});

test.each([
  '',
  '   ',
  // eslint-disable-next-line no-script-url
  'javascript:alert(1)',
  'data:text/html,private',
  'file:///private/file',
  'ftp://example.test/',
  'https://user:secret@example.test/',
  'user:secret@example.test',
  'https://example.test\\@evil.test',
])(
  'invalid or unsafe URL input is rejected rather than sent to search: %s',
  input => {
    expect(() => browserOmniboxAddress(input, 'google')).toThrow();
  },
);
