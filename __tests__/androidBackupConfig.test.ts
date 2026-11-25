import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';

const projectFile = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

test('Android enables legacy and modern backup rules for the app', () => {
  const manifest = projectFile('android/app/src/main/AndroidManifest.xml');
  const packageJson = JSON.parse(projectFile('package.json')) as {
    dependencies?: Record<string, string>;
  };

  expect(packageJson.dependencies?.['@react-native-async-storage/async-storage'])
    .toBeDefined();
  expect(manifest).toContain('android:allowBackup="true"');
  expect(manifest).toContain('android:fullBackupContent="@xml/backup_rules"');
  expect(manifest).toContain(
    'android:dataExtractionRules="@xml/data_extraction_rules"',
  );
});

test.each([
  ['full-backup-content', 'backup_rules.xml'],
  ['cloud-backup', 'data_extraction_rules.xml'],
  ['device-transfer', 'data_extraction_rules.xml'],
])('%s includes the databases and both background image folders', (section, resource) => {
  const xml = projectFile(`android/app/src/main/res/xml/${resource}`);
  const policy = new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName(section)[0];
  const includes = Array.from(policy.getElementsByTagName('include'), entry => [
    entry.getAttribute('domain'), entry.getAttribute('path'),
  ]);
  expect(includes).toEqual(expect.arrayContaining([
    ['database', '.'],
    ['file', 'app-backgrounds/'],
    ['file', 'terminal-backgrounds/'],
  ]));
});
