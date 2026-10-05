/* eslint-env node, es2022 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import QRCodeStyling from 'qr-code-styling';
import sharp from 'sharp';

// QRX's palette and extra-rounded preset, rendered by qr-code-styling.
// https://github.com/desmond845/QRX/blob/ba6f8b671770a77bd3b97aa1a3ab2a98d2cdeaac/script.js#L276
const NEON = Object.freeze({
  background: '#0a0a0f',
  cyan: '#00f0ff',
  purple: '#b967ff',
  pink: '#ff4d9e',
});
const INSTALL_URL = process.argv[2] ?? 'https://kosumic.github.io/whip/';
const SIZE = 512;
const MARGIN = 56;
const OUTPUT_SCALE = 3;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const siteDirectory = new URL('../site/', import.meta.url);

if (new URL(INSTALL_URL).protocol !== 'https:') {
  throw new Error('The install URL must use HTTPS.');
}

const logo = await sharp(
  await readFile(
    new URL('../assets/whip-cyborg-hand-concept.svg', import.meta.url),
  ),
)
  .resize(160, 160)
  .png()
  .toBuffer();

const qr = new QRCodeStyling({
  jsdom: JSDOM,
  // SVG export needs image dimensions; sharp handles that without a canvas.
  nodeCanvas: {
    async loadImage(uri) {
      const { width, height } = await sharp(
        Buffer.from(uri.split(',')[1], 'base64'),
      ).metadata();
      return { width, height };
    },
  },
  type: 'svg',
  width: SIZE,
  height: SIZE,
  margin: MARGIN,
  data: INSTALL_URL,
  image: `data:image/png;base64,${logo.toString('base64')}`,
  imageOptions: {
    imageSize: 0.2,
    margin: 8,
    hideBackgroundDots: true,
    saveAsBlob: false,
  },
  qrOptions: { errorCorrectionLevel: 'H' },
  dotsOptions: {
    type: 'extra-rounded',
    gradient: {
      type: 'linear',
      rotation: Math.PI / 4,
      colorStops: [
        { offset: 0, color: NEON.cyan },
        { offset: 1, color: NEON.purple },
      ],
    },
  },
  cornersSquareOptions: { type: 'extra-rounded', color: NEON.cyan },
  cornersDotOptions: { type: 'dot', color: NEON.pink },
  backgroundOptions: { color: NEON.background, round: 0.14 },
});

qr.applyExtension(svg => {
  const document = svg.ownerDocument;
  const filter = document.createElementNS(SVG_NAMESPACE, 'filter');
  filter.setAttribute('id', 'neon-glow');
  const blur = document.createElementNS(SVG_NAMESPACE, 'feGaussianBlur');
  blur.setAttribute('stdDeviation', '1.4');
  blur.setAttribute('result', 'glow');
  filter.appendChild(blur);
  const merge = document.createElementNS(SVG_NAMESPACE, 'feMerge');
  for (const input of ['glow', 'SourceGraphic']) {
    const node = document.createElementNS(SVG_NAMESPACE, 'feMergeNode');
    node.setAttribute('in', input);
    merge.appendChild(node);
  }
  filter.appendChild(merge);
  svg.querySelector('defs').appendChild(filter);

  for (const element of Array.from(svg.children)) {
    const clip = element.getAttribute('clip-path');
    if (element.tagName === 'rect' && clip && !clip.includes('background')) {
      const group = document.createElementNS(SVG_NAMESPACE, 'g');
      group.setAttribute('filter', 'url(#neon-glow)');
      svg.insertBefore(group, element);
      group.appendChild(element);
    }
  }
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    'Scan to get Whip on Google Play or the App Store',
  );
});

const svg = Buffer.from(
  (await qr.getRawData('svg')).toString('utf8').replace(/\r\n/g, '\n'),
);
await sharp(svg)
  .resize(SIZE * OUTPUT_SCALE, SIZE * OUTPUT_SCALE)
  .png()
  .toFile(fileURLToPath(new URL('whip-install-qr.png', siteDirectory)));
await writeFile(new URL('whip-install-qr.svg', siteDirectory), svg);
console.log(`Generated QRX-style neon Whip QR for ${INSTALL_URL}`);
