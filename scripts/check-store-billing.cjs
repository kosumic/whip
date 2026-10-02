const STORE_CONFIG = {
  ios: {
    channel: 'app-store',
    keyName: 'WHIP_REVENUECAT_IOS_PUBLIC_SDK_KEY',
    keyPattern: /^appl_[a-zA-Z0-9]+$/,
  },
  android: {
    channel: 'google-play',
    keyName: 'WHIP_REVENUECAT_ANDROID_PUBLIC_SDK_KEY',
    keyPattern: /^goog_[a-zA-Z0-9]+$/,
  },
};

const platform = process.argv[2];
const store = STORE_CONFIG[platform];
if (!store) {
  console.error('Usage: node scripts/check-store-billing.cjs <ios|android>');
  process.exit(1);
}
if (process.env.WHIP_DISTRIBUTION_CHANNEL !== store.channel) {
  console.error(`Store builds for ${platform} require WHIP_DISTRIBUTION_CHANNEL=${store.channel}.`);
  process.exit(1);
}
if (!store.keyPattern.test((process.env[store.keyName] || '').trim())) {
  console.error(`Set ${store.keyName} to the ${store.channel} public SDK key in the build environment.`);
  process.exit(1);
}
console.log(`Store billing configuration verified for ${store.channel}.`);
