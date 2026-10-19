/* eslint-env node, es2022 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { whipQrImage, WHIP_QR_EXPORT_SIZE } from '../src/lib/whipQr.ts';

const INSTALL_URL = process.argv[2] ?? 'https://kosumic.github.io/whip/';
const OUTPUT_SCALE = 3;
const LOGO_RASTER_SIZE = 320;
const siteDirectory = new URL('../site/', import.meta.url);

if (new URL(INSTALL_URL).protocol !== 'https:') {
  throw new Error('The install URL must use HTTPS.');
}

const qr = whipQrImage(INSTALL_URL);
const logo = await sharp(
  await readFile(
    new URL('../assets/whip-cyborg-hand-concept.svg', import.meta.url),
  ),
)
  .trim()
  .resize(LOGO_RASTER_SIZE, LOGO_RASTER_SIZE, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();
const logoImage = `<image x="${qr.logo.x}" y="${qr.logo.y}" width="${qr.logo.size}" height="${qr.logo.size}" href="data:image/png;base64,${logo.toString('base64')}"/>`;
const output = Buffer.from(qr.svg.replace('</svg>', `${logoImage}</svg>\n`));
await sharp(output)
  .resize(
    WHIP_QR_EXPORT_SIZE * OUTPUT_SCALE,
    WHIP_QR_EXPORT_SIZE * OUTPUT_SCALE,
  )
  .png()
  .toFile(fileURLToPath(new URL('whip-install-qr.png', siteDirectory)));
await writeFile(new URL('whip-install-qr.svg', siteDirectory), output);
console.log(`Generated circuit-style Whip QR for ${INSTALL_URL}`);
