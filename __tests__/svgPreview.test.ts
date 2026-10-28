import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';

import { svgPreviewHtml } from '../src/lib/svgPreview';

jest.mock('react-native-svg/lib/commonjs/xmlTags', () => ({ tags: { svg: 'Svg' } }));
jest.mock('react-native-svg', () => ({
  parse: jest.requireActual('react-native-svg/lib/commonjs/xml').parse,
}));

function preview(content: string) {
  return new DOMParser().parseFromString(svgPreviewHtml(content), 'text/html');
}

function imageSource(document: ReturnType<typeof preview>): string {
  return decodeURIComponent(document.getElementsByTagName('img')[0].getAttribute('src')!.split(',').slice(1).join(','));
}

test.each(['react-native-frontend', 'whip-rust-core'])('preserves the %s architecture diagram as an SVG image, including labels and arrowheads', name => {
  const svg = readFileSync(resolve(__dirname, `../docs/${name}-architecture.svg`), 'utf8');
  const document = preview(svg);

  expect(imageSource(document)).toBe(svg);
  for (const tag of ['svg', 'script', 'foreignObject']) {
    expect(document.getElementsByTagName(tag)).toHaveLength(0);
  }
  const policy = Array.from(document.getElementsByTagName('meta')).find(meta => meta.getAttribute('http-equiv') === 'Content-Security-Policy');
  expect(policy!.getAttribute('content'))
    .toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
});

test('adds the SVG namespace to chat snippets', () => {
  const document = preview('<svg viewBox="0 0 100 50"><text>中文 😀</text></svg>');
  const svg = new DOMParser().parseFromString(imageSource(document), 'image/svg+xml');
  expect(svg.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
  expect(svg.getElementsByTagName('text')[0].textContent).toBe('中文 😀');
});

test('keeps executable markup and links inside the inert image document', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Label</div></foreignObject><script>alert(1)</script><image href="https://example.com/image.png"/><text>&lt;/body&gt;&lt;script&gt;alert(2)&lt;/script&gt;</text></svg>';
  const document = preview(svg);
  const body = document.getElementsByTagName('body')[0];
  expect(body.childNodes).toHaveLength(1);
  expect(body.firstChild!.nodeName).toBe('img');
  expect(imageSource(document)).toBe(svg);
});

test.each(['', '<svg><rect></svg>', '<html></html>'])('rejects invalid SVG input: %s', content => {
  expect(() => svgPreviewHtml(content)).toThrow();
});
