#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDiagramFile } from './render-diagram.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const diagrams = [
  'react-native-frontend-architecture',
  'whip-rust-core-architecture',
];

for (const name of diagrams) {
  await renderDiagramFile(resolve(root, `docs/${name}.mmd`), resolve(root, `docs/${name}.svg`));
}
