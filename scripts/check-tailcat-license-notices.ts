import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const go = process.env.GO || 'go';
const moduleName = 'github.com/tailscale/tailcat';
const moduleInfo = JSON.parse(execFileSync(go, ['mod', 'download', '-json', moduleName], {
  cwd: join(root, 'packages/react-native-whip-ssh/rust/tailcat'), encoding: 'utf8',
})) as { Dir: string; Version: string };
const tags = readFileSync(join(moduleInfo.Dir, 'build-tags.txt'), 'utf8').trim();
const modules = new Map<string, { version: string; directory: string }>();
for (const platform of ['android', 'ios']) {
  const listing = execFileSync(go, ['list', '-mod=readonly', '-buildvcs=false', '-deps', '-tags', tags,
    '-f', '{{if .Module}}{{.Module.Path}}\t{{.Module.Version}}\t{{.Module.Dir}}{{end}}', './cmd/libtailcat'], {
    cwd: moduleInfo.Dir, encoding: 'utf8',
    env: { ...process.env, GOOS: platform, GOARCH: 'arm64', CGO_ENABLED: '1' },
  });
  for (const line of listing.trim().split('\n').filter(Boolean)) {
    const [name, version, directory] = line.split('\t');
    modules.set(name, { version: version || moduleInfo.Version, directory });
  }
}
// Nix omits LICENSE from the installed GOROOT. Keep the Go source license in
// the repository so attribution does not depend on the toolchain's packaging.
let notice = 'Tailcat transport and native dependency licenses\n\nGo runtime\n\n'
  + readFileSync(join(root, 'assets/licenses/go-BSD-3-Clause.txt'), 'utf8').trim() + '\n\n';
for (const [name, module] of [...modules].sort(([a], [b]) => a.localeCompare(b))) {
  const licenses = readdirSync(module.directory).filter(file => !file.endsWith('.go')
    && /^(LICENSE|LICENCE|COPYING|NOTICE|PATENTS|COPYRIGHT)([._-].*)?$/i.test(file)).sort();
  if (!licenses.length) throw new Error(`Missing license for ${name}`);
  notice += `${'='.repeat(80)}\n${name} ${module.version}\n\n`;
  for (const license of licenses) {
    notice += `${license}\n\n${readFileSync(join(module.directory, license), 'utf8').trim()}\n\n`;
  }
}
notice = `${notice.trimEnd()}\n`;
const destination = join(root, 'assets/licenses/tailcat-dependencies.txt');
if (process.argv.includes('--write')) writeFileSync(destination, notice);
else if (readFileSync(destination, 'utf8') !== notice) {
  throw new Error('Tailcat notices are stale; run node scripts/check-tailcat-license-notices.ts --write');
}
console.log(`Verified Tailcat notices for ${modules.size} native dependencies.`);
