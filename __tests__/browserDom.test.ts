/** @jest-environment node */
import { TextDecoder, TextEncoder } from 'node:util';
import { readFileSync } from 'node:fs';
const runtime = readFileSync(
  require.resolve('../packages/react-native-whip-ssh/rust/src/reverse_control/browser/dom.js'),
  'utf8',
);
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
  try {
    const run = dom.window.eval(runtime + ';domRuntime') as (
      key: string,
      action: string,
      args: Record<string, unknown>,
      identity: string,
    ) => unknown;
    return JSON.parse(
      JSON.stringify({
        ok: true,
        value: run('test-runtime', action, args, identity),
      }),
    );
  } catch (error) {
    const failure = error as Error & { code?: string; details?: unknown };
    return JSON.parse(
      JSON.stringify({
        ok: false,
        error: failure.message,
        code: failure.code,
        details: failure.details,
      }),
    );
  }
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

test('wait requires a visible matching element and handles missing selectors', () => {
  expect(call('wait', { selector: '#search' }).value.ready).toBe(true);
  expect(call('wait', { selector: '#missing' }).value.ready).toBe(false);
});

test('a fresh blank tab can be observed before its first navigation', () => {
  dom.reconfigure({ url: 'about:blank' });
  expect(call('snapshot').value.url).toBe('about:blank');
});

function markup(html: string) {
  dom.window.document.body.innerHTML = html;
}

test('find uses semantic names, labels and test IDs, allocates reusable refs and prefers semantics to CSS fallback', () => {
  markup(
    '<label for="email">Email</label><input id="email" data-testid="email"><button aria-label="Save">icon</button><button>Other</button>',
  );
  const found = call('find', {
    role: 'button',
    name: 'Save',
    css: 'button',
  }).value;
  expect(found.matches).toBe(1);
  expect(
    call('get', { property: 'text', ref: found.elements[0].ref }).value.value,
  ).toBe('icon');
  expect(call('find', { label: 'Email' }).value.elements[0].role).toBe(
    'textbox',
  );
  expect(call('find', { test_id: 'email' }).value.matches).toBe(1);
  expect(call('find', { name: 'missing', css: '#email' }).value.matches).toBe(
    1,
  );
  expect(call('find', { name: 'sav', exact: false }).value.matches).toBe(1);
  // A second targeted lookup keeps refs for the same revision alive.
  expect(
    call('get', { property: 'attributes', ref: found.elements[0].ref }).ok,
  ).toBe(true);
});

test('semantic writes never choose among ambiguous targets and errors carry compact candidates', () => {
  markup('<button>Save</button><button>Save</button>');
  const click = jest.fn();
  dom.window.document.addEventListener('click', click);
  const result = call('click', { target: { role: 'button', name: 'Save' } });
  expect(result).toMatchObject({
    ok: false,
    code: 'ambiguous_target',
    details: { matches: 2 },
  });
  expect(result.details.candidates).toHaveLength(2);
  expect(click).not.toHaveBeenCalled();
  expect(call('click', { ref: result.details.candidates[1].ref }).ok).toBe(
    true,
  );
  expect(click).toHaveBeenCalledTimes(1);
  expect(
    call('get', { property: 'text', ref: result.details.candidates[0].ref })
      .code,
  ).toBe('stale_ref');
});

test('find text returns the smallest rendered match and ignores hidden ancestor text', () => {
  markup(
    '<main><section><span>Result</span></section><div style="display:none"><button>Secret</button></div><p>Public <span hidden>private-token</span></p></main>',
  );
  expect(call('find', { text: 'Result' }).value.elements).toEqual([
    expect.objectContaining({ tag: 'span' }),
  ]);
  expect(call('find', { name: 'Secret' }).value.matches).toBe(0);
  expect(
    call('get', { property: 'text', target: { css: 'main' } }).value.value,
  ).toBe('Result Public');
});

test('get bounds output and sanitizes HTML, attributes, values and page URLs', () => {
  markup(
    '<main><p>' +
      'a'.repeat(100) +
      '</p><input value="private-value"><input type="password" value="private-password"><a href="/api?token=secret" onclick="secret()" data-token="secret">API</a><div hidden>private-hidden</div><script>private-script</script></main>',
  );
  const text = call('get', {
    property: 'text',
    target: { css: 'p' },
    max_chars: 12,
  }).value;
  expect(text).toMatchObject({ value: 'a'.repeat(12), truncated: true });
  expect(
    call('get', { property: 'value', target: { css: 'input[type=password]' } })
      .code,
  ).toBe('sensitive_target');
  expect(
    call('get', { property: 'value', target: { css: 'input:not([type])' } })
      .value.value,
  ).toBe('private-value');
  const html = call('get', { property: 'html', target: { css: 'main' } }).value
    .value;
  for (const forbidden of ['private-', 'onclick', 'data-token', '?token'])
    expect(html).not.toContain(forbidden);
  expect(
    call('get', { property: 'attributes', target: { css: 'a' } }).value.value,
  ).toEqual({ href: 'https://example.test/api' });
  expect(call('get', { property: 'url' }).value.value).toBe(
    'https://example.test/page',
  );
  expect(call('get', { property: 'text', target: { css: '[' } }).code).toBe(
    'invalid_selector',
  );
});

test('extract chooses main, omits chrome and hidden content, paginates and rejects changed generations', () => {
  markup(
    '<nav>Navigation</nav><main><h1>Report</h1><p>' +
      'Readable content. '.repeat(15) +
      '<span hidden>private-hidden</span></p><ul><li>Item</li></ul><input type="password" value="secret"></main><footer>Footer</footer>',
  );
  const first = call('extract', { chunk_size: 41 }).value;
  expect(first.content).toContain('# Report');
  expect(first.content).toHaveLength(41);
  let content = String(first.content),
    cursor = first.next_start;
  while (cursor !== null) {
    const next = call('extract', {
      chunk_size: 41,
      start: cursor,
      generation: first.generation,
    }).value;
    content += String(next.content);
    cursor = next.next_start;
  }
  expect(content).toContain('- Item');
  for (const forbidden of ['Navigation', 'Footer', 'private-hidden', 'secret'])
    expect(content).not.toContain(forbidden);
  expect(content).toHaveLength(first.total_chars);
  dom.window.document.querySelector('p')!.append('changed');
  expect(
    call('extract', { start: first.next_start, generation: first.generation })
      .code,
  ).toBe('stale_content');
});

test('extraction has a collection ceiling and bounded chunks even for very large pages', () => {
  markup('<article><p>' + 'x'.repeat(300000) + '</p></article>');
  const result = call('extract', { chunk_size: 12000 }).value;
  expect(result.content).toHaveLength(12000);
  expect(result.total_chars).toBeLessThanOrEqual(262144);
  expect(result.truncated).toBe(true);
  expect(call('extract', { chunk_size: 12001 }).code).toBe('invalid_argument');
});

test('history pushState and non-structural changes invalidate refs safely', () => {
  const ref = call('find', { role: 'link' }).value.elements[0].ref;
  dom.window.history.pushState({}, '', '/another?secret=token');
  expect(call('click', { ref }).code).toBe('stale_ref');
  const fresh = call('find', { role: 'link' }).value.elements[0].ref;
  dom.window.document.querySelector('a')!.setAttribute('aria-disabled', 'true');
  expect(call('click', { ref: fresh }).code).toBe('stale_ref');
});

test('wait handles rendered text, URL match/change and DOM stability', () => {
  expect(call('wait', { condition: 'text', text: 'Issues' }).value.ready).toBe(
    true,
  );
  expect(
    call('wait', { condition: 'text', text: 'private-password' }).value.ready,
  ).toBe(false);
  expect(call('wait', { condition: 'url', url: '/page' }).value.ready).toBe(
    true,
  );
  expect(
    call('wait', {
      condition: 'url_change',
      previous_url: 'https://example.test/page?token=private-token',
    }).value.ready,
  ).toBe(false);
  dom.window.history.pushState({}, '', '/next');
  expect(
    call('wait', {
      condition: 'url_change',
      previous_url: 'https://example.test/page?token=private-token',
    }).value.ready,
  ).toBe(true);
  expect(call('wait', { condition: 'stable' }).value.ready).toBe(false);
});

test('native select, checkbox/radio and keys use unique targets and bubbling events', () => {
  markup(
    '<select aria-label="Sort"><option value="new">Newest</option><option value="old">Oldest</option></select><label><input type="checkbox">Alerts</label><input type="radio" aria-label="Mode"><input aria-label="Query" value="abc"><button>Go</button>',
  );
  const change = jest.fn();
  dom.window.document.addEventListener('change', change);
  expect(
    call('select', { target: { name: 'Sort' }, option: 'Oldest' }).ok,
  ).toBe(true);
  expect(
    call('get', { property: 'value', target: { name: 'Sort' } }).value.value,
  ).toBe('old');
  expect(
    call('check', { target: { role: 'checkbox', label: 'Alerts' } }).ok,
  ).toBe(true);
  expect(call('check', { target: { role: 'checkbox' } }).ok).toBe(true);
  expect(
    (dom.window.document.querySelector('[type=checkbox]') as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(change).toHaveBeenCalledTimes(2);
  expect(call('uncheck', { target: { role: 'checkbox' } }).ok).toBe(true);
  expect(call('uncheck', { target: { role: 'radio' } }).code).toBe(
    'not_checkable',
  );
  const keydown = jest.fn();
  dom.window.document.addEventListener('keydown', keydown);
  expect(call('keys', { target: { name: 'Query' }, key: 'Control+a' }).ok).toBe(
    true,
  );
  const query = dom.window.document.querySelector(
    '[aria-label=Query]',
  ) as HTMLInputElement;
  expect([query.selectionStart, query.selectionEnd]).toEqual([0, 3]);
  expect(keydown).toHaveBeenCalledTimes(1);
  const click = jest.fn();
  dom.window.document.querySelector('button')!.addEventListener('click', click);
  expect(call('keys', { target: { name: 'Go' }, key: 'Enter' }).ok).toBe(true);
  expect(click).toHaveBeenCalledTimes(1);
});

test('annotated screenshots reuse find refs without mutating the document and reject DOM drift', () => {
  const ref = call('find', { role: 'link' }).value.elements[0].ref;
  const before = dom.window.document.documentElement.outerHTML;
  const annotations = call('annotations').value;
  expect(annotations.elements).toContainEqual(
    expect.objectContaining({ ref, x: 0, y: 0 }),
  );
  expect(dom.window.document.documentElement.outerHTML).toBe(before);
  expect(
    call('annotation_check', { generation: annotations.generation }).ok,
  ).toBe(true);
  dom.window.document.querySelector('a')!.textContent = 'Changed';
  expect(
    call('annotation_check', { generation: annotations.generation }).code,
  ).toBe('stale_ref');
});

test('extract cursors preserve Unicode characters across small chunks', () => {
  markup('<main><p>🙂界🙂</p></main>');
  const first = call('extract', { chunk_size: 1 }).value;
  expect(first.content).toBe('🙂');
  const next = call('extract', {
    chunk_size: 1,
    start: first.next_start,
    generation: first.generation,
  }).value;
  expect(next.content).toBe('界');
  expect(
    call('extract', {
      chunk_size: 1,
      start: next.next_start,
      generation: first.generation,
    }).value.content,
  ).toBe('🙂');
});

test('keys emulate deletion using native setters and bubbling input events', () => {
  markup('<input aria-label="Query" value="abc">');
  const input = dom.window.document.querySelector('input')!;
  const changed = jest.fn();
  input.addEventListener('input', changed);
  input.setSelectionRange(3, 3);
  expect(call('keys', { target: { name: 'Query' }, key: 'Backspace' }).ok).toBe(
    true,
  );
  expect(input.value).toBe('ab');
  expect(changed).toHaveBeenCalledTimes(1);
});

test('ref capacity fails before eviction so observation results never contain already stale refs', () => {
  markup(
    '<main>' +
      Array.from(
        { length: 501 },
        (_, index) => `<button data-testid="b${index}">B${index}</button>`,
      ).join('') +
      '</main>',
  );
  for (let start = 0; start < 500; start += 50) {
    const batch = call('find', {
      css: `button:nth-child(n+${start + 1}):nth-child(-n+${start + 50})`,
      limit: 50,
    });
    expect(batch.ok).toBe(true);
    expect(batch.value.elements).toHaveLength(50);
  }
  expect(call('find', { test_id: 'b500' }).code).toBe('result_too_large');
  expect(call('snapshot').ok).toBe(true);
  expect(call('find', { test_id: 'b500' }).ok).toBe(true);
});

test('keys move caret and delete whole Unicode characters, and move native select options', () => {
  markup(
    '<input aria-label="Query" value="a🙂b"><select aria-label="Choice"><option value="a">A</option><option disabled>Skipped</option><option value="b">B</option></select>',
  );
  const input = dom.window.document.querySelector('input')!;
  input.setSelectionRange(3, 3);
  expect(call('keys', { target: { name: 'Query' }, key: 'ArrowLeft' }).ok).toBe(
    true,
  );
  expect(input.selectionStart).toBe(1);
  expect(
    call('keys', { target: { name: 'Query' }, key: 'Shift+ArrowRight' }).ok,
  ).toBe(true);
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
  expect(call('keys', { target: { name: 'Query' }, key: 'Delete' }).ok).toBe(
    true,
  );
  expect(input.value).toBe('ab');
  input.value = 'a🙂';
  input.setSelectionRange(3, 3);
  expect(call('keys', { target: { name: 'Query' }, key: 'Backspace' }).ok).toBe(
    true,
  );
  expect(input.value).toBe('a');
  const select = dom.window.document.querySelector('select')!;
  const changed = jest.fn();
  select.addEventListener('change', changed);
  expect(
    call('keys', { target: { name: 'Choice' }, key: 'ArrowDown' }).ok,
  ).toBe(true);
  expect(select.value).toBe('b');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(call('keys', { target: { name: 'Choice' }, key: 'Tab' }).ok).toBe(
    true,
  );
  expect(dom.window.document.activeElement).toBe(input);
});
