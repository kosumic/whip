const projectBuildDirectories = require('./scripts/project-build-directories.cjs');

module.exports = {
  modulePathIgnorePatterns: [
    ...projectBuildDirectories.map(directory => `<rootDir>/${directory}/`),
    '<rootDir>/.codex-',
    '<rootDir>/.codex/',
    '<rootDir>/.worktrees/',
    '<rootDir>/artifacts/',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  preset: '@react-native/jest-preset',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // jsdom's encoding, HTML parser, and CSS dependencies now ship ES modules.
  transform: {
    '^.+\\.mjs$': 'babel-jest',
  },
  // Match the innermost node_modules to transform nested ES modules while
  // leaving jsdom's CommonJS internals untouched.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|react-native-keyboard-controller|@react-native(-community)?|@rn-primitives/portal|expo/virtual|@exodus/bytes|parse5|entities|@asamuzakjp|@csstools)/)(?!.*node_modules/)',
  ],
  testPathIgnorePatterns: [
    '<rootDir>/.codex-',
    '<rootDir>/__tests__/mockWhipSsh.js',
  ],
};
