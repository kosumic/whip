import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { LAUNCH_LOGO_SIZE } from '../src/lib/launchScreen.cjs';

const projectRoot = resolve(import.meta.dirname, '..');
const sourcePath = resolve(projectRoot, 'assets/whip-cyborg-hand-concept.svg');
const outputPath = resolve(
  projectRoot,
  'android/app/src/main/res/drawable/ic_launcher_whip_foreground.xml',
);

const source = readFileSync(sourcePath, 'utf8');
const pathTags = [...source.matchAll(/<path\b([^>]*)\/>/g)];

if (pathTags.length === 0) {
  throw new Error(`No SVG paths found in ${sourcePath}`);
}

const escapeXml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

const vectorPaths = pathTags.map(([, rawAttributes], index) => {
  const attributes = Object.fromEntries(
    [...rawAttributes.matchAll(/\s([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [
      name,
      value,
    ]),
  );

  if (!attributes.d) {
    throw new Error(`SVG path ${index + 1} has no path data`);
  }

  const vectorAttributes = [
    `android:pathData="${escapeXml(attributes.d)}"`,
    `android:fillColor="${
      attributes.fill === 'none'
        ? '@android:color/transparent'
        : escapeXml(attributes.fill ?? '#000000')
    }"`,
  ];

  if (attributes.stroke && attributes.stroke !== 'none') {
    vectorAttributes.push(`android:strokeColor="${escapeXml(attributes.stroke)}"`);
  }
  if (attributes['stroke-width']) {
    vectorAttributes.push(`android:strokeWidth="${escapeXml(attributes['stroke-width'])}"`);
  }
  if (attributes['stroke-linecap']) {
    vectorAttributes.push(
      `android:strokeLineCap="${escapeXml(attributes['stroke-linecap'])}"`,
    );
  }
  if (attributes['stroke-linejoin']) {
    vectorAttributes.push(
      `android:strokeLineJoin="${escapeXml(attributes['stroke-linejoin'])}"`,
    );
  }

  return `        <path\n            ${vectorAttributes.join('\n            ')} />`;
});

const output = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from assets/whip-cyborg-hand-concept.svg. Do not edit by hand. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="1414"
    android:viewportHeight="1414">
    <!--
      Adaptive icon masks occupy the centered 72/108 portion of each layer.
      Scaling the measured artwork to 70% fills 91% of that circle while
      preserving the complete whip silhouette inside the safe zone.
    -->
    <group
        android:pivotX="639"
        android:pivotY="632"
        android:scaleX="0.70"
        android:scaleY="0.70"
        android:translateX="68"
        android:translateY="75">
${vectorPaths.join('\n')}
    </group>
</vector>
`;

writeFileSync(outputPath, output);
console.log(`Generated ${pathTags.length} paths in ${outputPath}`);

// Match Expo's splash layout: a 200dp logo centered on a 288dp transparent
// canvas, which Android 12+ scales and masks as its system splash icon.
const splashCanvasSize = 288;
const drawableDensities = [
  ['mdpi', 1],
  ['hdpi', 1.5],
  ['xhdpi', 2],
  ['xxhdpi', 3],
  ['xxxhdpi', 4],
] as const;

for (const [density, scale] of drawableDensities) {
  const logoSize = LAUNCH_LOGO_SIZE * scale;
  const canvasSize = splashCanvasSize * scale;
  const inset = (canvasSize - logoSize) / 2;
  const logo = await sharp(Buffer.from(source))
    .resize(logoSize, logoSize, { fit: 'contain' })
    .png()
    .toBuffer();
  const directory = resolve(projectRoot, `android/app/src/main/res/drawable-${density}`);
  mkdirSync(directory, { recursive: true });
  await sharp({
    create: {
      width: canvasSize,
      height: canvasSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: logo, left: inset, top: inset }])
    .png()
    .toFile(resolve(directory, 'whip_launch_logo.png'));
  console.log(`Generated ${density} launch logo (${canvasSize}px canvas, ${logoSize}px logo)`);
}
