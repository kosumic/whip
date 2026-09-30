import { TextDecoder, TextEncoder } from 'node:util';
import { browserDomScript } from '../src/browser/dom';
import type { JSDOM as Dom } from 'jsdom';
Object.assign(global, { TextDecoder, TextEncoder });
const { JSDOM } = require('jsdom') as typeof import('jsdom');

let dom: Dom;
beforeEach(() => {
  dom = new JSDOM(
    '<title>Test page</title><a href="/issues">Issues</a><label for="search">Search</label><input id="search"><input type="password" aria-label="Password" value="private-password"><button hidden>Hidden</button>',
    {
      url: 'https://example.test/page?token=private-token',
      runScripts: 'outside-only',
    },
  );
  Object.defineProperty(dom.window.Element.prototype, 'getBoundingClientRect', {
    value() {
      return {
        width: 100,
        height: 30,
        top: 0,
        left: 0,
        right: 100,
        bottom: 30,
      };
    },
  });
  dom.window.PointerEvent = dom.window
    .MouseEvent as typeof dom.window.PointerEvent;
});
afterEach(() => dom.window.close());
function call(
  action: string,
  args: Record<string, unknown> = {},
  identity = 'page-1',
) {
  return JSON.parse(
    dom.window.eval(
      browserDomScript('test-runtime', action, args, identity),
    ) as string,
  );
}

test('snapshot returns semantic refs, labels and no password values or URL tokens', () => {
  const snapshot = call('snapshot');
  expect(snapshot.ok).toBe(true);
  expect(snapshot.value.url).toBe('https://example.test/page');
  expect(snapshot.value.elements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'link', name: 'Issues' }),
      expect.objectContaining({ role: 'textbox', name: 'Search' }),
      expect.objectContaining({
        role: 'textbox',
        name: 'Password',
        sensitive: true,
      }),
    ]),
  );
  expect(
    snapshot.value.elements.some(
      (element: { name: string }) => element.name === 'Hidden',
    ),
  ).toBe(false);
  expect(JSON.stringify(snapshot)).not.toContain('private-password');
  expect(JSON.stringify(snapshot)).not.toContain('private-token');
});

test('click acts on the observed DOM node and refs are invalidated afterwards', () => {
  const click = jest.fn();
  dom.window.document.querySelector('a')!.addEventListener('click', event => {
    event.preventDefault();
    click();
  });
  const snapshot = call('snapshot').value;
  const ref = snapshot.elements.find(
    (element: { name: string }) => element.name === 'Issues',
  ).ref;
  expect(call('click', { ref }).ok).toBe(true);
  expect(click).toHaveBeenCalledTimes(1);
  expect(call('click', { ref }).error).toContain('Stale ref');
});

test('typing uses native setters and bubbling events for controlled inputs', () => {
  const input = dom.window.document.querySelector(
    '#search',
  ) as HTMLInputElement;
  const values: string[] = [];
  dom.window.document.addEventListener('input', event =>
    values.push((event.target as HTMLInputElement).value),
  );
  const change = jest.fn();
  input.addEventListener('change', change);
  // React-like value tracking overrides the instance setter.
  const setter = jest.fn();
  Object.defineProperty(input, 'value', {
    set: setter,
    get: () =>
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value',
      )!.get!.call(input),
  });
  const ref = call('snapshot').value.elements.find(
    (element: { name: string }) => element.name === 'Search',
  ).ref;
  expect(call('type', { ref, text: 'reverse control' }).ok).toBe(true);
  expect(input.value).toBe('reverse control');
  expect(setter).not.toHaveBeenCalled();
  expect(values).toEqual(['reverse control']);
  expect(change).toHaveBeenCalledTimes(1);
});

test('DOM replacement and manual input invalidate refs before any action applies', () => {
  const ref = call('snapshot').value.elements[0].ref;
  dom.window.document
    .querySelector('a')!
    .replaceWith(dom.window.document.createElement('a'));
  expect(call('click', { ref }).error).toContain('Stale ref');
  const input = dom.window.document.querySelector(
    '#search',
  ) as HTMLInputElement;
  const inputRef = call('snapshot').value.elements.find(
    (element: { name: string }) => element.name === 'Search',
  ).ref;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(call('type', { ref: inputRef, text: 'agent' }).error).toContain(
    'Stale ref',
  );
});

test('page generation and later snapshots never reuse old refs', () => {
  const first = call('snapshot').value.elements[0].ref;
  const second = call('snapshot').value.elements[0].ref;
  expect(first).not.toBe(second);
  expect(call('click', { ref: first }).error).toContain('Stale ref');
  expect(call('click', { ref: second }, 'page-2').error).toContain('Stale ref');
});

test('wait_for_dom requires a visible matching element and handles missing selectors', () => {
  expect(call('wait_for_dom', { selector: '#search' }).value.ready).toBe(true);
  expect(call('wait_for_dom', { selector: '#missing' }).value.ready).toBe(
    false,
  );
});

test('a fresh blank tab can be observed before its first navigation', () => {
  dom.reconfigure({ url: 'about:blank' });
  expect(call('snapshot').value.url).toBe('about:blank');
});
