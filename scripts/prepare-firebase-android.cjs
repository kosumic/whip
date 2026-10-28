/* eslint-env node, es2021 */
const fs = require('node:fs');
const path = require('node:path');

function prepareFirebaseAndroid(root, content) {
  if (!content) return false;
  let config;
  try {
    config = JSON.parse(content);
  } catch {
    throw new Error(
      'GOOGLE_SERVICES_JSON must contain Firebase Android client JSON',
    );
  }
  const packageName = JSON.parse(
    fs.readFileSync(path.join(root, 'app.json'), 'utf8'),
  ).expo.android.package;
  if (
    !config ||
    config.type === 'service_account' ||
    config.private_key ||
    typeof config.project_info?.project_id !== 'string' ||
    typeof config.project_info?.project_number !== 'string' ||
    !Array.isArray(config.client) ||
    !config.client.some(
      client =>
        client?.client_info?.android_client_info?.package_name === packageName,
    )
  ) {
    throw new Error(
      'GOOGLE_SERVICES_JSON must be client configuration for Whip’s Android package; never supply a service-account private key',
    );
  }
  const destination = path.join(root, 'android', 'app', 'google-services.json');
  fs.writeFileSync(destination, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.chmodSync(destination, 0o600);
  return true;
}

if (require.main === module) {
  try {
    const written = prepareFirebaseAndroid(
      path.resolve(__dirname, '..'),
      process.env.GOOGLE_SERVICES_JSON,
    );
    console.log(
      written
        ? 'Firebase Android client configured'
        : 'No Firebase client supplied; keeping local notification support',
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { prepareFirebaseAndroid };
