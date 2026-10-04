/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const runtime = readFileSync(resolve(__dirname, '../scripts/markdown-preview-runtime.js'), 'utf8');
const marked = readFileSync(resolve(__dirname, '../node_modules/marked/lib/marked.umd.js'), 'utf8');
const purify = readFileSync(resolve(__dirname, '../node_modules/dompurify/dist/purify.min.js'), 'utf8');
const theme = { scheme: 'dark', colors: { canvas: '#1a1b26', foreground: '#c0caf5' } };
let dom: JSDOM;
let messages: Record<string, unknown>[];
const render = (content: string, id = 1) => dom.window.herdrRenderMarkdown(content, theme, id);

beforeEach(() => {
  messages = [];
  dom = new JSDOM('<main id="markdown"></main>', { runScripts: 'outside-only', url: 'file:///android_asset/markdown-preview.html' });
  dom.window.ReactNativeWebView = { postMessage: (message: string) => messages.push(JSON.parse(message) as Record<string, unknown>) };
  dom.window.scrollTo = jest.fn();
  dom.window.ResizeObserver = class { observe() {} };
  dom.window.eval(marked);
  dom.window.eval(purify);
  dom.window.eval(runtime);
});
afterEach(() => dom.window.close());

test('preserves README image dimensions, centered paragraphs, linked badges, and gallery table cells', () => {
  render(readFileSync(resolve(__dirname, '../README.md'), 'utf8'));
  const document = dom.window.document;
  const logo = document.querySelector('img[alt="Whip app icon"]')!;
  expect(logo.getAttribute('width')).toBe('128');
  expect(logo.parentElement!.getAttribute('align')).toBe('center');
  expect(document.querySelector('img[alt="CI status"]')!.parentElement!.tagName).toBe('A');
  expect(document.querySelector('img[alt="Download Whip Herd on the App Store"]')!.getAttribute('width')).toBe('190');
  expect(document.querySelectorAll('table img').length).toBeGreaterThan(2);
  expect(document.querySelector('table img')!.closest('td')).not.toBeNull();
  expect(messages.find(message => message.type === 'images')!.targets).toContain('assets/whip-cyborg-hand-concept.svg');
});

test('discovers real image nodes, decodes HTML entities, and ignores code samples and unsafe sources', () => {
  render('<img src="images/icon.svg" width="128"><img src="https://example.com/badge?x=1&amp;y=2">\n\n`<img src="fake.png">`\n\n![ref][icon]\n\n[icon]: images/ref.png\n\n<img src="file:///etc/passwd"><img src="data:text/html,bad"><script>alert(1)</script><iframe src="https://example.com"></iframe><p onclick="evil()" style="position:fixed">text</p>');
  const document = dom.window.document;
  expect(messages.find(message => message.type === 'images')!.targets).toEqual(['images/icon.svg', 'images/ref.png']);
  expect(document.querySelector('img[src]')!.getAttribute('src')).toBe('https://example.com/badge?x=1&y=2');
  expect(document.getElementById('markdown')!.querySelectorAll('script, iframe, [onclick], [style]')).toHaveLength(0);
  expect([...document.querySelectorAll('img[src]')].every(image => image.getAttribute('src')!.startsWith('https:'))).toBe(true);
});

test('updates cached images in place and rejects stale or arbitrary local URLs', () => {
  render('<a href="details.md"><img src="image.png" width="128"></a>');
  const image = dom.window.document.querySelector('img')!;
  dom.window.herdrSetMarkdownImage(0, 'image.png', 'data:image/png;base64,cG5n');
  dom.window.herdrSetMarkdownImage(1, 'image.png', 'file:///private/file.png');
  expect(image.hasAttribute('src')).toBe(false);
  dom.window.herdrSetMarkdownImage(1, 'image.png', 'data:image/png;base64,cG5n');
  expect(dom.window.document.querySelector('img')).toBe(image);
  expect(image.getAttribute('src')).toBe('data:image/png;base64,cG5n');
  expect(image.getAttribute('width')).toBe('128');
  image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(messages.at(-1)).toEqual({ type: 'link', target: 'details.md', requestId: 1 });
});

test('creates unique anchors and handles fragment links inside the document', () => {
  render('# Title\n\n# Title\n\n[Jump](#title-1)');
  const heading = dom.window.document.getElementById('title-1')!;
  heading.scrollIntoView = jest.fn();
  dom.window.document.querySelector('a')!.click();
  expect(heading.scrollIntoView).toHaveBeenCalled();
  expect(messages.some(message => message.type === 'link')).toBe(false);
});

test('waits for native images before reporting the height used to restore reading position', async () => {
  render('![Image](image.png)');
  expect(messages.some(message => message.type === 'size')).toBe(false);
  await dom.window.herdrFinishMarkdownImages(0);
  expect(messages.some(message => message.type === 'size')).toBe(false);
  await dom.window.herdrFinishMarkdownImages(1);
  expect(messages.at(-1)!.type).toBe('size');
});

test('retains SVG and Mermaid diagram previews with readable source on invalid diagrams', async () => {
  const fontFamily = 'WhipChatCJK, WhipInter, system-ui, sans-serif';
  dom.window.document.body.style.fontFamily = fontFamily;
  const load = jest.fn().mockResolvedValue([]);
  Object.defineProperty(dom.window.document, 'fonts', { value: { load } });
  dom.window.mermaid = { initialize: jest.fn(), render: jest.fn()
    .mockResolvedValueOnce({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>' })
    .mockRejectedValueOnce(new Error('Invalid diagram')) };
  render('```mermaid\nflowchart LR\nA --> B\n```\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>\n```\n\n```mermaid\ninvalid\n```');
  await dom.window.herdrFinishMarkdownImages(1);
  expect(load).toHaveBeenCalledWith(`16px ${fontFamily}`, 'flowchart LR\nA --> B\n');
  expect(dom.window.mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ fontFamily }));
  expect(dom.window.document.querySelectorAll('.diagram svg')).toHaveLength(2);
  expect(dom.window.document.querySelector('pre code')!.textContent).toContain('invalid');
});
