/* eslint-env jest */
jest.mock('react-native-keyboard-controller', () => {
  // Several component suites intentionally provide a minimal React Native mock.
  const native = require('react-native');
  native.Animated ??= { Value: jest.fn() };
  return require('react-native-keyboard-controller/jest');
});
