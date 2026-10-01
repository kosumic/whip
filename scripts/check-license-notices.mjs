import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(root, 'build/npm-direct-licenses.json');
const noticesPath = resolve(root, 'build/npm-direct-license-notices.json');
const unknownLicenseValues = new Set(['', 'n/a', 'none', 'unknown', 'unlicensed']);

const noticeSources = [
  {
    id: 'shizuku-api',
    asset: 'assets/licenses/shizuku-MIT.txt',
    sha256: '64870037f294b6f2b75c8ebe77cc0702acb3b64f86b4b0e58bf8558525303686',
  },
  {
    id: 'whip',
    asset: 'assets/licenses/whip-AGPL-3.0.txt',
    source: 'LICENSE',
  },
  {
    id: 'opencode-web',
    asset: 'assets/licenses/opencode-MIT.txt',
    sha256: '625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b',
  },
  {
    id: 'inter',
    asset: 'assets/licenses/inter-OFL-1.1.txt',
    source: 'assets/gui-fonts/OFL.txt',
  },
  {
    id: 'jetbrains-mono',
    asset: 'assets/licenses/jetbrains-mono-OFL-1.1.txt',
    source: 'assets/terminal-fonts/OFL.txt',
  },
  {
    id: 'ar-pl-ukai-hk',
    asset: 'assets/licenses/arphic-public-license.txt',
    source: 'assets/terminal-fonts/ARPHICPL.txt',
  },
  {
    id: 'symbols-nerd-font-mono',
    asset: 'assets/licenses/nerd-fonts-MIT.txt',
    source: 'assets/terminal-fonts/NerdFonts-LICENSE.txt',
  },
  {
    id: 'mermaid',
    asset: 'assets/licenses/mermaid-MIT.txt',
    source: 'node_modules/mermaid/LICENSE',
    dependency: 'mermaid',
  },
  {
    id: 'xterm-js',
    asset: 'assets/licenses/xterm-MIT.txt',
    source: 'node_modules/@xterm/xterm/LICENSE',
    dependency: '@xterm/xterm',
  },
  {
    id: 'lucide',
    asset: 'assets/licenses/lucide-ISC-and-Feather-MIT.txt',
    source: 'node_modules/lucide-react-native/LICENSE',
    dependency: 'lucide-react-native',
  },
];

const npmLicenseSourceOverrides = new Map([
  ['@react-native-community/slider', 'licenses/npm/react-native-slider-MIT.txt'],
  ['@ubjs/core', 'node_modules/uniffi-bindgen-react-native/LICENSE'],
  ['@xterm/addon-serialize', 'node_modules/@xterm/xterm/LICENSE'],
  ['react-native-whip-ssh', 'LICENSE'],
]);

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const report = await generateLicenseReport();
await validateReport(report, packageJson.dependencies ?? {});
await writeDirectDependencyNotices(await createDirectDependencyNotices(report));
await validateNoticeRegistry();
await validateNoticeSources(report);

console.log(
  `Checked ${report.length} direct production dependencies and ${noticeSources.length} bundled license notices.`,
);
console.log(`Wrote ${relativePath(reportPath)}.`);
console.log(`Wrote ${relativePath(noticesPath)}.`);

async function generateLicenseReport() {
  const executable = resolve(root, 'node_modules/license-report/index.js');
  let stdout;

  try {
    ({ stdout } = await execFileAsync(process.execPath, [executable], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    }));
  } catch (error) {
    const details = error.stderr?.trim() || error.message;
    throw new Error(`license-report failed: ${details}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`license-report returned invalid JSON: ${error.message}`);
  }

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

async function validateReport(report, dependencies) {
  if (!Array.isArray(report)) throw new Error('license-report output must be an array');

  const expectedNames = Object.keys(dependencies).sort();
  const reportedNames = report.map(entry => entry.name).sort();
  if (JSON.stringify(reportedNames) !== JSON.stringify(expectedNames)) {
    const missing = expectedNames.filter(name => !reportedNames.includes(name));
    const unexpected = reportedNames.filter(name => !expectedNames.includes(name));
    throw new Error(
      `license-report dependency mismatch; missing: ${missing.join(', ') || 'none'}; ` +
        `unexpected: ${unexpected.join(', ') || 'none'}`,
    );
  }

  for (const entry of report) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('license-report returned a non-object entry');
    }
    if (
      typeof entry.licenseType !== 'string' ||
      unknownLicenseValues.has(entry.licenseType.trim().toLowerCase())
    ) {
      throw new Error(`Missing license metadata for ${entry.name}`);
    }
    if (
      typeof entry.installedVersion !== 'string' ||
      entry.installedVersion.trim() === '' ||
      entry.installedVersion === 'n/a'
    ) {
      throw new Error(`Missing installed version for ${entry.name}`);
    }
  }
}

async function createDirectDependencyNotices(report) {
  const notices = [];
  for (const entry of report) {
    const packageDirectory = resolve(root, 'node_modules', entry.name);
    const dependencyPackage = JSON.parse(
      await readFile(resolve(packageDirectory, 'package.json'), 'utf8'),
    );
    const sourceUrl = normalizeRepositoryUrl(
      dependencyPackage.repository?.url || dependencyPackage.repository || dependencyPackage.homepage,
    );
    const licenseSource = await resolveLicenseSource(entry.name, packageDirectory);
    const licenseText = await readFile(licenseSource, 'utf8');
    notices.push({
      category: 'npm',
      licenseName: entry.licenseType,
      licenseText: `${licenseText.trim()}\n`,
      name: entry.name,
      sourceUrl,
      version: entry.installedVersion,
    });
  }
  return notices;
}

async function resolveLicenseSource(packageName, packageDirectory) {
  const override = npmLicenseSourceOverrides.get(packageName);
  if (override) return resolve(root, override);

  const candidates = (await readdir(packageDirectory))
    .filter(name => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(name))
    .sort();
  if (candidates.length === 0) {
    throw new Error(`No bundled license file found for direct dependency ${packageName}`);
  }
  return resolve(packageDirectory, candidates[0]);
}

async function writeDirectDependencyNotices(notices) {
  await writeFile(noticesPath, `${JSON.stringify(notices, null, 2)}\n`);
}

function normalizeRepositoryUrl(repository) {
  if (typeof repository !== 'string') return '';
  return repository
    .replace(/^git\+/, '')
    .replace(/^git:\/\/github\.com\//, 'https://github.com/')
    .replace(/\.git$/, '');
}

async function validateNoticeRegistry() {
  const registryPath = resolve(root, 'src/licenses/index.ts');
  const registry = await readFile(registryPath, 'utf8');
  const registeredIds = [...registry.matchAll(/\bid:\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
  const registeredAssets = [
    ...registry.matchAll(
      /licenseAsset:\s*bundledAsset\(\s*require\(['"]\.\.\/\.\.\/(assets\/licenses\/[^'"]+)['"]\)\s*\)/g,
    ),
  ].map(match => match[1]);
  const expectedIds = noticeSources.map(notice => notice.id);
  const expectedAssets = noticeSources.map(notice => notice.asset);

  assertSameMembers('license notice IDs', registeredIds, expectedIds);
  assertSameMembers('license notice assets', registeredAssets, expectedAssets);
}

async function validateNoticeSources(report) {
  const reportedDependencies = new Set(report.map(entry => entry.name));

  for (const notice of noticeSources) {
    const asset = await readFile(resolve(root, notice.asset));
    if (asset.length === 0) throw new Error(`${notice.asset} is empty`);

    if (notice.source) {
      const source = await readFile(resolve(root, notice.source));
      if (!asset.equals(source)) {
        throw new Error(`${notice.asset} differs from ${notice.source}`);
      }
    }

    if (notice.sha256) {
      const actualHash = createHash('sha256').update(asset).digest('hex');
      if (actualHash !== notice.sha256) {
        throw new Error(
          `${notice.asset} has SHA-256 ${actualHash}; expected upstream text ${notice.sha256}`,
        );
      }
    }

    if (notice.dependency && !reportedDependencies.has(notice.dependency)) {
      throw new Error(`${notice.id} notice refers to missing dependency ${notice.dependency}`);
    }
  }
}

function assertSameMembers(label, actual, expected) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(
      `${label} do not match verifier coverage; found: ${actualSorted.join(', ')}; ` +
        `expected: ${expectedSorted.join(', ')}`,
    );
  }
}

function relativePath(path) {
  return path.slice(root.length + 1);
}
