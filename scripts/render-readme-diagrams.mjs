#!/usr/bin/env node

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const diagrams = [
  ['docs/react-native-frontend-architecture.mmd', 'docs/react-native-frontend-architecture.svg'],
  ['docs/whip-rust-core-architecture.mmd', 'docs/whip-rust-core-architecture.svg'],
];
const localImages = new Map([
  [
    'https://raw.githubusercontent.com/kosumic/whip/main/assets/whip-cyborg-hand-concept.svg',
    'assets/whip-cyborg-hand-concept.svg',
  ],
]);

async function findBrowser() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'brave',
    'google-chrome',
    'chromium',
    'chromium-browser',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const paths = candidate.includes('/')
      ? [candidate]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .map(path => join(path, candidate));
    for (const path of paths) {
      try {
        await access(path, constants.X_OK);
        return path;
      } catch {
        // Try the next browser candidate.
      }
    }
  }

  throw new Error(
    'A Chromium-based browser is required to render Mermaid diagrams.',
  );
}

async function imageDataUrl(url) {
  const localPath = localImages.get(url);
  if (localPath) {
    const body = await readFile(resolve(root, localPath));
    return `data:image/svg+xml;base64,${body.toString('base64')}`;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }
  const contentType =
    response.headers.get('content-type')?.split(';')[0] || 'image/svg+xml';
  const body = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${body.toString('base64')}`;
}

async function inlineRemoteImages(source) {
  const urls = [
    ...source.matchAll(/<img\b[^>]*\bsrc=(['"])(https:\/\/[^'"]+)\1/g),
  ].map(match => match[2]);
  const replacements = new Map();

  await Promise.all(
    [...new Set(urls)].map(async url => {
      replacements.set(url, await imageDataUrl(url));
    }),
  );

  for (const [url, dataUrl] of replacements) {
    source = source.replaceAll(url, dataUrl);
  }
  return source;
}

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'whip-readme-diagrams-'),
);

try {
  const browser = await findBrowser();
  const puppeteerConfig = join(temporaryDirectory, 'puppeteer.json');
  const mermaidConfig = join(temporaryDirectory, 'mermaid.json');
  await writeFile(
    puppeteerConfig,
    `${JSON.stringify({ executablePath: browser, args: ['--no-sandbox'] })}\n`,
  );
  await writeFile(
    mermaidConfig,
    `${JSON.stringify({ maxTextSize: 5_000_000 })}\n`,
  );

  for (const [sourcePath, outputPath] of diagrams) {
    const source = await readFile(resolve(root, sourcePath), 'utf8');
    const inlinedSource = await inlineRemoteImages(source);
    const temporarySource = join(
      temporaryDirectory,
      sourcePath.split('/').at(-1),
    );
    await writeFile(temporarySource, inlinedSource);

    const result = spawnSync(
      'npx',
      [
        '--yes',
        '-p',
        '@mermaid-js/mermaid-cli@11.16.0',
        'mmdc',
        '-p',
        puppeteerConfig,
        '-c',
        mermaidConfig,
        '-i',
        temporarySource,
        '-o',
        resolve(root, outputPath),
        '-b',
        'white',
      ],
      { cwd: root, stdio: 'inherit' },
    );

    if (result.status !== 0) {
      throw new Error(`Mermaid CLI failed while rendering ${sourcePath}.`);
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
