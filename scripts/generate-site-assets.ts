/* eslint-env node, es2022 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const outputDirectory = new URL(
  '../legal-site/public/assets/',
  import.meta.url,
);
const screenshots = ['herd', 'chat-view', 'git-diff'];
const socialSize = { width: 1200, height: 630 };
await mkdir(outputDirectory, { recursive: true });
await copyFile(
  new URL('../assets/brand/github.svg', import.meta.url),
  new URL('github.svg', outputDirectory),
);
for (const name of [
  'app-store.svg',
  'google-play.png',
  'whip-install-qr.svg',
]) {
  await copyFile(
    new URL(`../site/${name}`, import.meta.url),
    new URL(name, outputDirectory),
  );
}
for (const name of screenshots) {
  await copyFile(
    new URL(`../assets/screenshots/ios/${name}.webp`, import.meta.url),
    new URL(`${name}.webp`, outputDirectory),
  );
}
const icon = await readFile(
  new URL('../assets/whip-cyborg-hand-concept.svg', import.meta.url),
);
await copyFile(
  new URL('../assets/whip-cyborg-hand-concept.svg', import.meta.url),
  new URL('icon.svg', outputDirectory),
);
const iconPng = await sharp(icon)
  .resize(350, 450, { fit: 'inside' })
  .png()
  .toBuffer();
const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="${socialSize.width}" height="${socialSize.height}" viewBox="0 0 ${socialSize.width} ${socialSize.height}">
  <rect width="1200" height="630" fill="#eee9e0"/>
  <rect width="1200" height="8" fill="#b82f18"/>
  <g font-family="DejaVu Sans, sans-serif" fill="#201b18">
    <text x="64" y="208" font-size="148" font-weight="700" letter-spacing="-10">Whip</text>
    <text x="70" y="306" font-size="44" font-weight="600" letter-spacing="-1">Your coding agents,</text>
    <text x="70" y="366" font-size="44" font-weight="600" letter-spacing="-1">in your pocket.</text>
    <text x="72" y="457" font-size="23" fill="#675e56">Mobile SSH · Android, iPhone &amp; iPad</text>
    <text x="72" y="548" font-size="24" fill="#b82f18">whip.kosumi.dev</text>
  </g>
</svg>`;
await sharp(Buffer.from(preview))
  .composite([{ input: iconPng, left: 790, top: 90 }])
  .png()
  .toFile(fileURLToPath(new URL('social.png', outputDirectory)));
console.log('Generated Whip homepage screenshots, icon, and social preview.');
