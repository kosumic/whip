module.exports = {
  modulePathIgnorePatterns: [
    '<rootDir>/.codex-',
    '<rootDir>/.codex/',
    '<rootDir>/.worktrees/',
    '<rootDir>/artifacts/',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^expo-crypto$': '<rootDir>/__mocks__/expo-crypto.js',
  },
  preset: '@react-native/jest-preset',
  // jsdom's encoding, HTML parser, and CSS dependencies now ship ES modules.
  transform: {
    '^.+\\.mjs$': 'babel-jest',
  },
  // Match the innermost node_modules to transform nested ES modules while
  // leaving jsdom's CommonJS internals untouched.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@exodus/bytes|parse5|entities|@asamuzakjp|@csstools)/)(?!.*node_modules/)',
  ],
  testPathIgnorePatterns: [
    '<rootDir>/.codex-',
    '<rootDir>/__tests__/mockWhipSsh.js',
  ],
};
