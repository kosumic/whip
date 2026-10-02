const { execFileSync } = require('node:child_process');
const { version } = require('./scripts/app-version.cjs');

const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;
const DISTRIBUTION_CHANNELS = new Set(['app-store', 'google-play', 'github']);
const DEVELOPMENT_REVENUECAT_TEST_PUBLIC_SDK_KEY =
  'test_DlbxSQbXcMlbbZrHJdiUgunsAOx';

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function distributionChannel(value) {
  const candidate = optionalString(value);
  return candidate && DISTRIBUTION_CHANNELS.has(candidate) ? candidate : null;
}

function optionalHttpsUrl(value) {
  const candidate = optionalString(value);
  if (!candidate) return null;
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

function resolveGitCommit() {
  const environmentCommit = [
    process.env.WHIP_GIT_COMMIT,
    process.env.GITHUB_SHA,
    process.env.EAS_BUILD_GIT_COMMIT_HASH,
  ].find(value => value && COMMIT_PATTERN.test(value.trim()));

  if (environmentCommit) {
    return environmentCommit.trim();
  }

  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return COMMIT_PATTERN.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

module.exports = ({ config }) => {
  const gitCommit = resolveGitCommit();

  return {
    ...config,
    version,
    plugins: [
      ...(config.plugins || []),
      ...((config.plugins || []).includes('expo-sqlite')
        ? []
        : ['expo-sqlite']),
    ],
    extra: {
      ...config.extra,
      ...(gitCommit ? { gitCommit } : {}),
      feedbackApiUrl: process.env.WHIP_FEEDBACK_API_URL || null,
      revenueCatIosPublicSdkKey:
        optionalString(process.env.WHIP_REVENUECAT_IOS_PUBLIC_SDK_KEY),
      revenueCatAndroidPublicSdkKey:
        optionalString(process.env.WHIP_REVENUECAT_ANDROID_PUBLIC_SDK_KEY),
      revenueCatTestPublicSdkKey:
        optionalString(process.env.WHIP_REVENUECAT_TEST_PUBLIC_SDK_KEY) ||
        (process.env.NODE_ENV === 'production'
          ? null
          : DEVELOPMENT_REVENUECAT_TEST_PUBLIC_SDK_KEY),
      distributionChannel: distributionChannel(
        process.env.WHIP_DISTRIBUTION_CHANNEL,
      ),
      rancherWebPurchaseUrl: optionalHttpsUrl(
        process.env.WHIP_RANCHER_WEB_PURCHASE_URL,
      ),
    },
  };
};
