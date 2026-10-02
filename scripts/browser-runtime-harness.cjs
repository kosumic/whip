/* eslint-env node, es2022 */
// Behavioral test harness for Rust-generated page programs, not a browser stack.
const { JSDOM } = require('jsdom');
const { createInterface } = require('node:readline');
const { TextDecoder, TextEncoder } = require('node:util');
const page = new JSDOM(
  '<title>Test</title><main><h1>Report</h1><p>Readable content.</p><button>Save</button><label for="q">Query</label><input id="q"><input type="password" value="private-password"></main>',
  {
    url: 'https://example.test/page?token=private-token',
    runScripts: 'outside-only',
  },
);
Object.assign(page.window, {
  TextDecoder,
  TextEncoder,
  PointerEvent: page.window.MouseEvent,
});
page.window.document.__whipDocumentId = 'doc-1';
Object.defineProperty(page.window.Element.prototype, 'getBoundingClientRect', {
  value() {
    return { width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 };
  },
});
page.window.fetch = async (url, options) => ({
  json: async () => ({
    url,
    authenticated: true,
    method: options?.method || 'GET',
  }),
});
const lines = createInterface({ input: process.stdin });
lines.on('line', source => {
  try {
    const request = JSON.parse(source);
    let result = page.window.eval(request.js);
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result);
      } catch {}
    }
    process.stdout.write(
      JSON.stringify({ value: result === undefined ? null : result }) + '\n',
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ error: String(error.message) }) + '\n',
    );
  }
});
lines.on('close', () => {
  page.window.close();
});
