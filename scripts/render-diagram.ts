import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'pele';

export async function renderDiagramFile(sourcePath: string, outputPath: string) {
  const source = await readFile(sourcePath, 'utf8');
  const { svg } = render(source, {
    fontFamily: 'Arial, sans-serif',
    autoDirection: false,
    links: false,
    images: false,
  });
  await writeFile(outputPath, `${svg}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , sourcePath, outputPath] = process.argv;
  if (!sourcePath || !outputPath) throw new Error('Usage: node scripts/render-diagram.ts input.mmd output.svg');
  await renderDiagramFile(sourcePath, outputPath);
}
