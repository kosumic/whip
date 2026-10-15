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
