// App tooling excludes these independently installed and checked packages.
const directories = ['feedback-worker', 'notify-relay'];

module.exports = {
  testIgnorePatterns: directories.map(directory => '<rootDir>/' + directory + '/'),
};
