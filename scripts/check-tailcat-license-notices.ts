import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crate = join(root, 'crates/tailcat-client');
const notice = 'Whip Tailcat client transport\n\n'
  + readFileSync(join(crate, 'LICENSE'), 'utf8').trim()
  + '\n\n' + readFileSync(join(crate, 'THIRD_PARTY_NOTICES.md'), 'utf8').trim() + '\n';
const destination = join(root, 'assets/licenses/tailcat-dependencies.txt');
if (process.argv.includes('--write')) writeFileSync(destination, notice);
else if (readFileSync(destination, 'utf8') !== notice) {
  throw new Error('Tailcat notices are stale; run node scripts/check-tailcat-license-notices.ts --write');
}
console.log('Verified Tailcat client attribution; Rust dependencies are included in the Cargo notices.');
