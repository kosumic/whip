const projects = [
  { directory: 'feedback-worker', testPrefix: 'feedbackWorker', tsconfig: 'tsconfig.json' },
  { directory: 'notify-relay', testPrefix: 'notifyRelay', tsconfig: 'tsconfig.test.json' },
];

module.exports = {
  projects,
  paths: projects.flatMap(({ directory, testPrefix }) => [
    `${directory}/**`, `__tests__/${testPrefix}*.test.ts`,
  ]),
  testGlobs: projects.map(({ testPrefix }) => `<rootDir>/__tests__/${testPrefix}*.test.ts`),
  testIgnorePatterns: projects.map(({ testPrefix }) => `<rootDir>/__tests__/${testPrefix}.*\\.test\\.ts$`),
};
