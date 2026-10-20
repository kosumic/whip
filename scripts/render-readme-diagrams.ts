#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

async function imageDataUrl(url: string) {
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

async function inlineRemoteImages(source: string) {
  const urls = [
    ...source.matchAll(/<img\b[^>]*\bsrc=(['"])(https:\/\/[^'"]+)\1/g),
  ].map(match => match[2]);
  const replacements = new Map<string, string>();

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
  for (const [sourcePath, outputPath] of diagrams) {
    const source = await readFile(resolve(root, sourcePath), 'utf8');
    const inlinedSource = await inlineRemoteImages(source);
    const temporarySource = join(
      temporaryDirectory,
      sourcePath.split('/').at(-1)!,
    );
    await writeFile(temporarySource, inlinedSource);

    const result = spawnSync(
      'merman-cli',
      [
        'render',
        temporarySource,
        '--output',
        resolve(root, outputPath),
        '--background',
        'white',
      ],
      { cwd: root, stdio: 'inherit' },
    );

    if (result.status !== 0) {
      if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
        throw new Error('Install Merman with: cargo install --locked --version 0.9.1 merman-cli');
      }
      throw new Error(result.error?.message || `Merman CLI failed while rendering ${sourcePath}.`);
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
