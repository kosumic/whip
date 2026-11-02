// App tooling excludes these independently installed and checked packages.
const directories = ['feedback-worker', 'notify-relay'];

module.exports = {
  paths: directories.map(directory => directory + '/**'),
  testIgnorePatterns: directories.map(directory => '<rootDir>/' + directory + '/'),
};
