const { version } = require('../package.json');

// Store marketing versions use the common iOS/Android subset of SemVer.
if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error(`package.json version must be MAJOR.MINOR.PATCH; actual ${JSON.stringify(version)}`);
}

function assertVersion(actual, label) {
  if (actual !== version) {
    throw new Error(`${label}: expected ${version} (package.json), actual ${JSON.stringify(actual)}`);
  }
  return version;
}

function validateTag(tag) {
  return assertVersion(tag.replace(/^v/, ''), `Release tag ${JSON.stringify(tag)}`);
}

module.exports = { version, assertVersion, validateTag };

if (require.main === module) {
  try {
    const [option, value, actual] = process.argv.slice(2);
    if (option === '--tag' && value !== undefined && actual === undefined) {
      validateTag(value);
    } else if (option === '--actual' && value && actual !== undefined) {
      assertVersion(actual, value);
    } else if (option !== undefined) {
      throw new Error('Usage: node scripts/app-version.cjs [--tag TAG | --actual LABEL VERSION]');
    }
    console.log(version);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
