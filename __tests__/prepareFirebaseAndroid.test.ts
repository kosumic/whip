import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { prepareFirebaseAndroid } =
  require('../scripts/prepare-firebase-android.cjs') as {
    prepareFirebaseAndroid(root: string, content?: string): boolean;
  };
let root: string;
let destination: string;
const clientConfig = {
  project_info: { project_id: 'whip-test', project_number: '123456' },
  client: [
    { client_info: { android_client_info: { package_name: 'dev.whip.test' } } },
  ],
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'whip-firebase-'));
  destination = path.join(root, 'android/app/google-services.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'app.json'),
    JSON.stringify({ expo: { android: { package: 'dev.whip.test' } } }),
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('writes matching client config privately and preserves optional local-only builds', () => {
  expect(prepareFirebaseAndroid(root, JSON.stringify(clientConfig))).toBe(true);
  expect(JSON.parse(fs.readFileSync(destination, 'utf8'))).toEqual(
    clientConfig,
  );
  expect(fs.statSync(destination).mode.toString(8).slice(-3)).toBe('600');
  expect(prepareFirebaseAndroid(root)).toBe(false);
  expect(JSON.parse(fs.readFileSync(destination, 'utf8'))).toEqual(
    clientConfig,
  );
});

test('rejects provider private keys before they can enter an app bundle', () => {
  expect(() =>
    prepareFirebaseAndroid(
      root,
      JSON.stringify({
        ...clientConfig,
        type: 'service_account',
        private_key: 'secret',
      }),
    ),
  ).toThrow('never supply');
  expect(fs.existsSync(destination)).toBe(false);
});

test('rejects malformed client configuration and other Android packages', () => {
  expect(() => prepareFirebaseAndroid(root, '{')).toThrow('client JSON');
  expect(() =>
    prepareFirebaseAndroid(
      root,
      JSON.stringify({ ...clientConfig, client: [] }),
    ),
  ).toThrow('Android package');
  expect(fs.existsSync(destination)).toBe(false);
});
