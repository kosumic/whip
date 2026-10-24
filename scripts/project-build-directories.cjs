// Keep native compiler output and the separate video projects out of JS tooling.
module.exports = [
  'android/app/.cxx',
  'android/app/build',
  'android/build',
  'build',
  'ios/Pods',
  'ios/build',
  'launch-videos',
  'packages/react-native-whip-ssh/rust/target',
  'whipair/target',
];
