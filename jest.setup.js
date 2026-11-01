/* eslint-env jest */
const { notifyManager } = require('@tanstack/react-query');
const { appQueryClient } = require('./src/services/appQueryClient');

appQueryClient.setDefaultOptions({
  queries: { ...appQueryClient.getDefaultOptions().queries, gcTime: Infinity },
});
// Let React act flush query notifications, including suites using fake timers.
notifyManager.setScheduler(callback => Promise.resolve().then(callback));
afterEach(() => { appQueryClient.clear(); });

jest.mock('react-native-whip-ssh/src/terminalSubmissions', () => require('./test-support/mockTerminalSubmissions'));
jest.mock('react-native-whip-ssh/src/browserOperations', () => require('./test-support/mockBrowserOperations'));
jest.mock('react-native-whip-ssh/src/credentialTransactions', () => require('./test-support/mockCredentialTransactions'));
jest.mock('react-native-whip-ssh/src/sshWorkflows', () => require('./test-support/mockSshWorkflows'));
jest.mock('react-native-whip-ssh/src/sessionConnections', () => require('./packages/react-native-whip-ssh/src/generated/whip_ssh'));

jest.mock('react-native-keyboard-controller', () => {
  // Several component suites intentionally provide a minimal React Native mock.
  const native = require('react-native');
  native.Animated ??= { Value: jest.fn() };
  return require('react-native-keyboard-controller/jest');
});
