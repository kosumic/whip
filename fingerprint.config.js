const projectBuildDirectories = require('./scripts/project-build-directories.cjs');

module.exports = {
  ignorePaths: projectBuildDirectories.map(directory => `${directory}/**`),
};
