const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { build } = require('../eas.json');

const root = path.resolve(__dirname, '..');
const stores = [
  ['ios', 'app-store', 'WHIP_REVENUECAT_IOS_PUBLIC_SDK_KEY', 'appl_fixture'],
  ['android', 'google-play', 'WHIP_REVENUECAT_ANDROID_PUBLIC_SDK_KEY', 'goog_fixture'],
];

describe.each(stores)('%s store build validation', (platform, channel, keyName, key) => {
  function validate(overrides = {}) {
    return spawnSync(process.execPath, ['scripts/check-store-billing.cjs', platform], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        WHIP_DISTRIBUTION_CHANNEL: channel,
        [keyName]: key,
        ...overrides,
      },
    });
  }

  test('accepts the matching store configuration', () => {
    expect(validate().status).toBe(0);
  });

  test.each(['', 'test_fixture', 'sk_secret_fixture'])(
    'rejects missing or inappropriate SDK key %s', invalidKey => {
      const result = validate({ [keyName]: invalidKey });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(keyName);
      if (invalidKey) expect(result.stderr).not.toContain(invalidKey);
    },
  );

  test('rejects another store key and a non-store distribution', () => {
    const otherKey = stores.find(store => store[0] !== platform)[3];
    expect(validate({ [keyName]: otherKey }).status).toBe(1);
    expect(validate({ WHIP_DISTRIBUTION_CHANNEL: 'github' }).status).toBe(1);
  });
});

test('EAS production iOS resolves native billing without a Test Store fallback', () => {
  const result = spawnSync(process.execPath, ['-e',
    'console.log(JSON.stringify(require("./app.config.js")({config: {}}).extra))',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...build.production.ios.env,
      NODE_ENV: 'production',
      WHIP_REVENUECAT_IOS_PUBLIC_SDK_KEY: 'appl_fixture',
      WHIP_REVENUECAT_TEST_PUBLIC_SDK_KEY: '',
    },
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    distributionChannel: 'app-store',
    revenueCatIosPublicSdkKey: 'appl_fixture',
    revenueCatTestPublicSdkKey: null,
  });
});
