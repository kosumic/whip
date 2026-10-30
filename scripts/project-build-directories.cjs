// Keep native output, the separate NSH frontend and video projects out of RN tooling.
module.exports = [
  'android/app/.cxx',
  'android/app/build',
  'android/build',
  'build',
  'ios/Pods',
  'ios/build',
  'launch-videos',
  'packages/react-native-whip-ssh/rust/target',
  'packages/react-native-whip-ssh/android/nsh',
  'packages/react-native-whip-ssh/ios/nsh',
  'packages/whip-nsh',
  'whipair/target',
  'whip-notify/target',
];
