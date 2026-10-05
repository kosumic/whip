/* eslint-env node, es2022 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { encode, toSvg } from '@verevoir/qr';
import { JSDOM } from 'jsdom';
import sharp from 'sharp';

// The library's circuit renderer supplies the traces and circular endpoints.
// https://github.com/verevoir/qr/blob/main/src/svg/outline.ts
// Neon palette from https://github.com/desmond845/QRX.
const NEON = Object.freeze({
  background: '#0a0a0f',
  cyan: '#00f0ff',
  purple: '#b967ff',
  pink: '#ff4d9e',
});
const INSTALL_URL = process.argv[2] ?? 'https://kosumic.github.io/whip/';
const SIZE = 512;
const QUIET_MODULES = 5;
const OUTPUT_SCALE = 3;
const LOGO_RATIO = 0.2;
const LOGO_MARGIN = 0.5;
const LOGO_AREA = 0.06;
const RECTANGLES_PER_MARKER = 3;
const ALIGNMENT_CENTER_OFFSET = 2;
const GRADIENT_ID = 'circuit-neon';
const GRADIENT_FILL = `url(#${GRADIENT_ID})`;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const siteDirectory = new URL('../site/', import.meta.url);

if (new URL(INSTALL_URL).protocol !== 'https:') {
  throw new Error('The install URL must use HTTPS.');
}

const [qr] = encode(INSTALL_URL, { logoArea: LOGO_AREA });
// In 2.1.0, circuit paths expect alignment centers; encode returns origins.
const circuitQr = {
  ...qr,
  alignmentCoordinates: qr.alignmentCoordinates.map(([row, column]) => [
    row + ALIGNMENT_CENTER_OFFSET,
    column + ALIGNMENT_CENTER_OFFSET,
  ]),
};
const document = new JSDOM(
  toSvg(circuitQr, {
    style: 'circuit',
    cornerStyle: 'rounded',
    lineWidth: 'normal',
    color: { dark: GRADIENT_FILL, light: NEON.background },
  }),
  { contentType: 'image/svg+xml' },
).window.document;
const svg = document.documentElement;
const drawing = svg.querySelector('g');
// Keep the correctly placed alignment markers from the circuit renderer,
// removing the shifted duplicates emitted by the general corner renderer.
const finderRectCount = qr.finderCoordinates.length * RECTANGLES_PER_MARKER;
const alignmentRectCount = qr.alignmentCoordinates.length * RECTANGLES_PER_MARKER;
for (const marker of Array.from(drawing.children).slice(finderRectCount, finderRectCount + alignmentRectCount)) {
  marker.remove();
}
const viewSize = qr.size + QUIET_MODULES * 2;
svg.setAttribute('width', String(SIZE));
svg.setAttribute('height', String(SIZE));
svg.setAttribute('viewBox', `0 0 ${viewSize} ${viewSize}`);
svg.setAttribute('role', 'img');
svg.setAttribute('aria-label', 'Whip install QR with neon circuit traces');

function appendSvg(parent, name, attributes = {}) {
  const element = document.createElementNS(SVG_NAMESPACE, name);
  for (const [attribute, value] of Object.entries(attributes)) {
    element.setAttribute(attribute, String(value));
  }
  parent.appendChild(element);
  return element;
}

const defs = appendSvg(svg, 'defs');
const gradient = appendSvg(defs, 'linearGradient', {
  id: GRADIENT_ID,
  gradientUnits: 'userSpaceOnUse',
  x1: 1,
  y1: 1,
  x2: qr.size + 1,
  y2: qr.size + 1,
});
appendSvg(gradient, 'stop', { offset: 0, 'stop-color': NEON.cyan });
appendSvg(gradient, 'stop', { offset: 1, 'stop-color': NEON.purple });
const glow = appendSvg(defs, 'filter', { id: 'neon-glow' });
appendSvg(glow, 'feGaussianBlur', { stdDeviation: 0.12, result: 'glow' });
const merge = appendSvg(glow, 'feMerge');
for (const input of ['glow', 'SourceGraphic']) {
  appendSvg(merge, 'feMergeNode', { in: input });
}

const background = appendSvg(svg, 'rect', {
  width: viewSize,
  height: viewSize,
  rx: 3,
  fill: NEON.background,
});
svg.insertBefore(background, drawing);
drawing.setAttribute('transform', `translate(${QUIET_MODULES - 1} ${QUIET_MODULES - 1})`);
drawing.setAttribute('filter', 'url(#neon-glow)');

for (const rect of drawing.querySelectorAll('rect')) {
  const width = Number(rect.getAttribute('width'));
  if (!rect.hasAttribute('rx')) rect.setAttribute('rx', String(width / 3));
  if (rect.getAttribute('fill') !== GRADIENT_FILL) continue;
  if (width === 7) rect.setAttribute('fill', NEON.cyan);
  if (width === 3) rect.setAttribute('fill', NEON.pink);
}

const logo = await sharp(
  await readFile(new URL('../assets/whip-cyborg-hand-concept.svg', import.meta.url)),
).resize(160, 160).png().toBuffer();
const logoSize = qr.size * LOGO_RATIO;
const logoPosition = (viewSize - logoSize) / 2;
appendSvg(svg, 'rect', {
  x: logoPosition - LOGO_MARGIN,
  y: logoPosition - LOGO_MARGIN,
  width: logoSize + LOGO_MARGIN * 2,
  height: logoSize + LOGO_MARGIN * 2,
  rx: 1,
  fill: NEON.background,
});
appendSvg(svg, 'image', {
  x: logoPosition,
  y: logoPosition,
  width: logoSize,
  height: logoSize,
  href: `data:image/png;base64,${logo.toString('base64')}`,
});

const output = Buffer.from(svg.outerHTML + '\n');
await sharp(output)
  .resize(SIZE * OUTPUT_SCALE, SIZE * OUTPUT_SCALE)
  .png()
  .toFile(fileURLToPath(new URL('whip-install-qr.png', siteDirectory)));
await writeFile(new URL('whip-install-qr.svg', siteDirectory), output);
console.log(`Generated circuit-style Whip QR for ${INSTALL_URL}`);
