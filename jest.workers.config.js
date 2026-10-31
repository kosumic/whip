const app = require('./jest.config');
const workers = require('./scripts/worker-projects.cjs');

module.exports = {
  ...app,
  testEnvironment: 'node',
  setupFilesAfterEnv: [],
  testMatch: workers.testGlobs,
  testPathIgnorePatterns: app.testPathIgnorePatterns.filter(pattern => !workers.testIgnorePatterns.includes(pattern)),
};
