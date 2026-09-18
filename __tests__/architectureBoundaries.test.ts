import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(__dirname, '..');
const FILE_READING_TESTS = new Set([
  '__tests__/androidBackupConfig.test.ts',
  '__tests__/architectureBoundaries.test.ts',
  '__tests__/licenseNotices.test.ts',
  '__tests__/terminalAssetGeneration.test.ts',
  '__tests__/terminalAssets.test.ts',
  '__tests__/terminalResize.test.ts',
]);

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(
    (entry: Dirent) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    },
  );
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function imports(path: string): ts.ImportDeclaration[] {
  return parse(path).statements.filter(ts.isImportDeclaration);
}

function moduleName(declaration: ts.ImportDeclaration): string {
  return ts.isStringLiteral(declaration.moduleSpecifier)
    ? declaration.moduleSpecifier.text
    : '';
}

describe('module boundaries', () => {
  test('HerdrClient stays a lifecycle facade instead of duplicating native APIs', () => {
    const source = parse(join(ROOT, 'src/services/HerdrClient.ts'));
    const declaration = source.statements.find(
      statement => ts.isClassDeclaration(statement)
        && statement.name?.text === 'HerdrClient',
    );
    if (!declaration || !ts.isClassDeclaration(declaration)) {
      throw new Error('HerdrClient class was not found');
    }
    const methods = declaration.members
      .filter(ts.isMethodDeclaration)
      .map(method => method.name)
      .filter(ts.isIdentifier)
      .map(name => name.text)
      .sort();

    expect(methods).toEqual([
      'connect',
      'detach',
      'disconnect',
      'initialSnapshot',
      'measureLatency',
      'reconnectControl',
      'refreshHostState',
      'requireProfile',
      'setMonitoringState',
      'setRuntimeEventHandler',
      'snapshot',
      'snapshotFromHostState',
    ]);
  });

  test('React has no generated Herdr wire-schema subtree', () => {
    expect(existsSync(join(ROOT, 'src/generated/herdrApi.ts'))).toBe(false);
  });

  test('the composition root cannot depend on native transport or Herdr wire APIs', () => {
    const forbidden = imports(join(ROOT, 'App.tsx'))
      .map(moduleName)
      .filter(
        name =>
          name === 'react-native-whip-ssh' ||
          name.includes('/generated/') ||
          name.includes('herdrApiBridge') ||
          name.includes('services/HerdrClient'),
      );

    expect(forbidden).toEqual([]);
  });

  test('presentation modules cannot import generated Herdr wire contracts', () => {
    const violations = filesBelow(join(ROOT, 'src/components'))
      .filter(path => path.endsWith('.ts') || path.endsWith('.tsx'))
      .flatMap(path =>
        imports(path)
          .map(moduleName)
          .filter(
            name =>
              name.includes('/generated/') || name.includes('herdrApiBridge'),
          )
          .map(name => `${relative(ROOT, path)} -> ${name}`),
      );

    expect(violations).toEqual([]);
  });

  test.each(['PaneDetail.tsx', 'HerdScreen.tsx', 'SessionScreen.tsx'])(
    '%s cannot bypass app-styled errors with the native Alert API',
    name => {
      const alertImports = imports(join(ROOT, 'src/components', name))
        .filter(declaration => moduleName(declaration) === 'react-native')
        .flatMap(declaration => {
          const bindings = declaration.importClause?.namedBindings;
          return bindings && ts.isNamedImports(bindings)
            ? bindings.elements.map(
                element => (element.propertyName ?? element.name).text,
              )
            : [];
        })
        .filter(imported => imported === 'Alert');

      expect(alertImports).toEqual([]);
    },
  );
});

test('tests only read files from explicit artifact or architecture suites', () => {
  const fileReaders = filesBelow(join(ROOT, '__tests__'))
    .filter(path => /\.test\.[jt]sx?$/.test(path))
    .filter(path =>
      imports(path).some(declaration =>
        ['node:fs', 'fs'].includes(moduleName(declaration)),
      ),
    )
    .map(path => relative(ROOT, path));

  fileReaders.sort();
  const expectedFileReaders = [...FILE_READING_TESTS];
  expectedFileReaders.sort();
  expect(fileReaders).toEqual(expectedFileReaders);
});
