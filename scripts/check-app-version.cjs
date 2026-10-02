const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getConfig } = require('expo/config');
const { IOSConfig } = require('expo/config-plugins');
const plist = require('@expo/plist').default;
const { version, assertVersion } = require('./app-version.cjs');

const root = path.resolve(__dirname, '..');
const { exp } = getConfig(root);
const staticConfig = require('../app.json').expo;
for (const config of [staticConfig, staticConfig.ios, staticConfig.android]) {
  assert(!Object.hasOwn(config || {}, 'version'), 'Keep marketing versions in package.json, not app.json');
}
assertVersion(exp.version, 'Expo version');
assertVersion((exp.ios && exp.ios.version) || exp.version, 'Expo iOS version');
assertVersion((exp.android && exp.android.version) || exp.version, 'Expo Android version');
assert(!(exp.ios && exp.ios.infoPlist && exp.ios.infoPlist.CFBundleShortVersionString), 'Remove the Expo Info.plist marketing version override');

const template = plist.parse(fs.readFileSync(path.join(root, 'ios/HerdR/Info.plist'), 'utf8'));
assert(!Object.hasOwn(template, 'CFBundleShortVersionString'), 'The iOS template must not hard-code a marketing version');
const project = IOSConfig.XcodeUtils.getPbxproj(root);
const configs = Object.values(project.pbxXCBuildConfigurationSection()).filter(value => value.buildSettings);
for (const { name, buildSettings } of configs) {
  assert(!Object.hasOwn(buildSettings, 'MARKETING_VERSION'), `${name}: remove MARKETING_VERSION; package.json owns it`);
  assert(!Object.hasOwn(buildSettings, 'INFOPLIST_KEY_CFBundleShortVersionString'), `${name}: remove the marketing version override`);
  if (buildSettings.INFOPLIST_FILE) {
    assert.equal(IOSConfig.XcodeUtils.unquote(buildSettings.INFOPLIST_FILE), '$(DERIVED_FILE_DIR)/Whip-Info.plist');
  }
}
console.log(`App version configuration: ${version} (Expo and iOS); run :app:checkAppVersion to evaluate Android`);
