// Keep native compiler output and the separate video projects out of JS tooling.
module.exports = [
  'android/app/.cxx',
  'android/app/build',
  'android/build',
  'build',
  'crates/agent-browser-control/target',
  'crates/agent-transcript-core/target',
  'crates/tailcat-client/target',
  'crates/whipair-protocol/target',
  'ios/Pods',
  'ios/build',
  'launch-videos',
  'packages/react-native-whip-ssh/rust/target',
  'whipair/target',
  'whip-notify/target',
];
