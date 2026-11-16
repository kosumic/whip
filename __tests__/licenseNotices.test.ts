import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';

const root = join(__dirname, '..');

describe('bundled direct dependency license notices', () => {
  const generatedRegistry = read('src/licenses/generated.ts');
  // Execute the registry so quote style, indentation and object formatting are
  // irrelevant. Metro asset requires resolve to file contents in this harness.
  const registry = { exports: {} as { GENERATED_OPEN_SOURCE_LICENSES: Array<{
    category: string; projectName: string; licenseAsset: string;
  }> } };
  new Script(transpileModule(generatedRegistry, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText).runInNewContext({
    exports: registry.exports,
    require: (path: string) => readFileSync(join(root, 'src/licenses', path), 'utf8'),
  });
  const generatedEntries = registry.exports.GENERATED_OPEN_SOURCE_LICENSES;

  test('contains one row for every direct npm production dependency and nothing else', () => {
    const packageJson = JSON.parse(read('package.json'));
    const noticedPackages = generatedEntries
      .filter(entry => entry.category === 'npm')
      .map(entry => entry.projectName)
      .sort();

    expect(noticedPackages).toEqual(Object.keys(packageJson.dependencies).sort());
  });

  test('contains one row per resolved direct Rust crate and excludes workspace roots', () => {
    const expectedPackages = [
      ...directCargoDependencies('packages/react-native-whip-ssh/rust/Cargo.toml'),
    ];
    const noticedPackages = generatedEntries
      .filter(entry => entry.category === 'cargo')
      .map(entry => entry.projectName);

    expect([...new Set(noticedPackages)].sort()).toEqual([...new Set(expectedPackages)].sort());
    expect(noticedPackages).not.toContain('whip-ssh');
  });

  test('every row loads a non-empty license asset', () => {
    expect(generatedEntries.length).toBeGreaterThan(0);
    for (const entry of generatedEntries) expect(entry.licenseAsset.trim()).not.toBe('');
  });
});

function directCargoDependencies(manifestPath: string) {
  return [...read(manifestPath).matchAll(
    /\[(?:dependencies|target\..+\.dependencies)\]\n([\s\S]*?)(?=\n\[|$)/g,
  )].flatMap(section => (
    [...section[1].matchAll(/^([\w-]+)\s*=/gm)].map(match => match[1])
  ));
}

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}
