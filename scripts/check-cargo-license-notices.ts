import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { commandErrorDetails, type LicenseNotice } from './license-notice.ts';

interface CargoPackage {
  name: string;
  version: string;
  repository?: string | null;
  homepage?: string | null;
}

interface RustPackage {
  name: string;
  manifest: string;
}

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(root, 'licenses/cargo/about.toml');
const templatePath = resolve(root, 'licenses/cargo/about.hbs');
const textTemplatePath = resolve(root, 'licenses/cargo/about.txt.hbs');
const outputDirectory = resolve(root, 'build');
const noticesPath = resolve(outputDirectory, 'cargo-direct-license-notices.json');

const packages = [
  {
    name: 'whip-ssh',
    manifest: 'packages/react-native-whip-ssh/rust/Cargo.toml',
    output: 'cargo-whip-ssh-licenses.html',
    textOutput: 'cargo-whip-ssh-licenses.txt',
  },
];

await mkdir(outputDirectory, { recursive: true });
const directNotices = new Map<string, LicenseNotice>();

for (const rustPackage of packages) {
  const outputPath = resolve(outputDirectory, rustPackage.output);
  const textOutputPath = resolve(outputDirectory, rustPackage.textOutput);
  try {
    await execFileAsync(
      'cargo',
      [
        'about',
        'generate',
        '--locked',
        '--fail',
        '--config',
        configPath,
        '--manifest-path',
        resolve(root, rustPackage.manifest),
        '--output-file',
        outputPath,
        templatePath,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      },
    );
  } catch (error) {
    const details = commandErrorDetails(error);
    throw new Error(`cargo-about failed for ${rustPackage.name}: ${details}`);
  }

  const htmlNotice = await readFile(outputPath, 'utf8');
  if (!htmlNotice.includes('<!doctype html>') || !htmlNotice.includes('<section id=')) {
    throw new Error(`cargo-about produced an incomplete notice for ${rustPackage.name}`);
  }

  await generateNotice(rustPackage, textOutputPath, textTemplatePath);
  const generatedTextNotice = await readFile(textOutputPath, 'utf8');
  const textNotice = omitRootPackage(generatedTextNotice, rustPackage.name);
  await writeFile(textOutputPath, textNotice);
  if (!textNotice.includes('Whip Rust dependency licenses') || !textNotice.includes('Used by:')) {
    throw new Error(`cargo-about produced an incomplete text notice for ${rustPackage.name}`);
  }
  const metadata = await cargoMetadata(rustPackage);
  for (const notice of parseDirectNotices(textNotice, metadata, rustPackage.name)) {
    if (notice.name === 'two-face') {
      const { stdout } = await execFileAsync('cargo', [
        'run', '--locked', '--quiet', '--manifest-path', resolve(root, rustPackage.manifest),
        '--example', 'syntax-notices',
      ], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 600_000 });
      notice.licenseText += `\n\nBundled syntax definitions and themes\n\n${stdout}`;
    }
    if (notice.name === 'turso') {
      notice.licenseText += `\n\n${await tursoTransitiveNotices(rustPackage)}`;
    }
    const key = `${notice.name}@${notice.version}`;
    const existing = directNotices.get(key);
    if (existing) {
      existing.usedBy = [...new Set([...(existing.usedBy ?? []), ...(notice.usedBy ?? [])])].sort();
    } else {
      directNotices.set(key, notice);
    }
  }

  console.log(
    `Checked ${rustPackage.name}; wrote ${relativePath(outputPath)} and ` +
      `${relativePath(textOutputPath)}.`,
  );
}

await writeFile(
  noticesPath,
  `${JSON.stringify([...directNotices.values()].sort(compareNotices), null, 2)}\n`,
);
console.log(`Wrote ${relativePath(noticesPath)}.`);

function omitRootPackage(notice: string, rootPackageName: string) {
  const divider = '\n================================================================================\n';
  const [header, ...sections] = notice.split(divider);
  const directDependencySections = sections.flatMap(section => {
    const usedBy = section.match(/Used by:\n([\s\S]*?)\n\n-+/);
    if (!usedBy) throw new Error(`Could not parse cargo-about text section for ${rootPackageName}`);
    const directUsers = usedBy[1]
      .split('\n')
      .filter(line => !line.startsWith(`- ${rootPackageName} `));
    if (directUsers.length === 0) return [];
    return [section.replace(usedBy[1], directUsers.join('\n'))];
  });
  return [header, ...directDependencySections].join(divider);
}

/** Include the mobile production Turso/FTS graph, using the app's exact lockfile. */
async function tursoTransitiveNotices(rustPackage: RustPackage): Promise<string> {
  const manifest = resolve(root, rustPackage.manifest);
  const reportPath = resolve(outputDirectory, 'cargo-turso-transitive-licenses.json');
  await execFileAsync('cargo', [
    'about', 'generate', '--locked', '--fail', '--manifest-path', manifest,
    '--config', resolve(root, 'licenses/cargo/turso-about.toml'),
    '--target', 'aarch64-linux-android', '--target', 'aarch64-apple-ios',
    '--format', 'json', '--output-file', reportPath,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120_000 });
  const { stdout } = await execFileAsync('cargo', [
    'metadata', '--locked', '--format-version', '1', '--manifest-path', manifest,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120_000 });
  const metadata = JSON.parse(stdout) as {
    packages: (CargoPackage & { id: string })[];
    resolve: { nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] };
  };
  const graph = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const ids = new Set<string>();
  const visit = (id: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const dependency of graph.get(id)?.deps ?? []) {
      if (dependency.dep_kinds.some(kind => kind.kind === null)) visit(dependency.pkg);
    }
  };
  const turso = metadata.packages.find(pkg => pkg.name === 'turso');
  if (!turso) throw new Error('Turso is missing from the resolved Rust graph');
  visit(turso.id);
  ids.delete(turso.id);
  const dependencies = new Set(metadata.packages.filter(pkg => ids.has(pkg.id)).map(pkg => `${pkg.name}@${pkg.version}`));
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
    licenses: { name: string; id: string; text: string; used_by: { crate: CargoPackage }[] }[];
  };
  const sections = report.licenses.flatMap(license => {
    const users = license.used_by.map(user => user.crate)
      .filter(pkg => dependencies.has(`${pkg.name}@${pkg.version}`))
      .map(pkg => `- ${pkg.name} ${pkg.version}`).sort();
    if (users.length === 0) return [];
    return [`${license.name} (${license.id})\n\nUsed by:\n${users.join('\n')}\n\n${license.text}`];
  }).sort();
  if (sections.length === 0) throw new Error('Turso transitive license report is empty');
  return `Turso and FTS production transitive dependency notices (Android/iOS)\n\n${sections.join('\n\n================================================================================\n')}`;
}

async function generateNotice(rustPackage: RustPackage, outputPath: string, template: string) {
  try {
    await execFileAsync(
      'cargo',
      [
        'about',
        'generate',
        '--locked',
        '--fail',
        '--config',
        configPath,
        '--manifest-path',
        resolve(root, rustPackage.manifest),
        '--output-file',
        outputPath,
        template,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      },
    );
  } catch (error) {
    const details = commandErrorDetails(error);
    throw new Error(`cargo-about failed for ${rustPackage.name}: ${details}`);
  }
}

async function cargoMetadata(rustPackage: RustPackage) {
  const { stdout } = await execFileAsync(
    'cargo',
    [
      'metadata',
      '--format-version',
      '1',
      '--locked',
      '--manifest-path',
      resolve(root, rustPackage.manifest),
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
  );
  const metadata = JSON.parse(stdout) as { packages: CargoPackage[] };
  return new Map(metadata.packages.map(pkg => [`${pkg.name}@${pkg.version}`, pkg]));
}

function parseDirectNotices(notice: string, metadata: Map<string, CargoPackage>, usedBy: string): LicenseNotice[] {
  const divider = '\n================================================================================\n';
  const [, ...sections] = notice.split(divider);
  const crates = new Map<string, {
    category: 'cargo';
    licenseNames: string[];
    licenseTexts: string[];
    name: string;
    version: string;
  }>();
  for (const section of sections) {
    const heading = section.match(/^(.+) \(([^)]+)\)\n/);
    const body = section.match(/Used by:\n([\s\S]*?)\n\n-+\n([\s\S]*)/);
    if (!heading || !body) throw new Error(`Could not parse cargo-about section for ${usedBy}`);
    for (const line of body[1].split('\n')) {
      const crate = line.match(/^- ([\w-]+) (\S+)$/);
      if (!crate) continue;
      const key = `${crate[1]}@${crate[2]}`;
      const current = crates.get(key) ?? {
        category: 'cargo',
        licenseNames: [],
        licenseTexts: [],
        name: crate[1],
        version: crate[2],
      };
      current.licenseNames.push(heading[2]);
      current.licenseTexts.push(`${heading[1]} (${heading[2]})\n\n${body[2].trim()}\n`);
      crates.set(key, current);
    }
  }

  return [...crates.entries()].map(([key, crate]) => {
    const pkg = metadata.get(key);
    return {
      category: crate.category,
      licenseName: crate.licenseNames.join(' AND '),
      licenseText: crate.licenseTexts.join('\n'),
      name: crate.name,
      sourceUrl: pkg?.repository || pkg?.homepage || '',
      usedBy: [usedBy],
      version: crate.version,
    };
  });
}

function compareNotices(left: LicenseNotice, right: LicenseNotice) {
  return left.name.localeCompare(right.name) || left.version.localeCompare(right.version);
}

function relativePath(path: string) {
  return path.slice(root.length + 1);
}
