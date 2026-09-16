module.exports = {
  modulePathIgnorePatterns: ['<rootDir>/.codex-'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^expo-crypto$': '<rootDir>/__mocks__/expo-crypto.js',
  },
  preset: '@react-native/jest-preset',
  testPathIgnorePatterns: ['<rootDir>/.codex-', '<rootDir>/__tests__/mockWhipSsh.js'],
};
