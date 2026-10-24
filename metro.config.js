const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('node:path');
const projectBuildDirectories = require('./scripts/project-build-directories.cjs');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('txt');
const existingBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existingBlockList) ? existingBlockList : existingBlockList ? [existingBlockList] : []),
  ...projectBuildDirectories.map(directory => {
    const absolutePath = path.resolve(__dirname, directory);
    const escapedPath = absolutePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escapedPath}[/\\\\]`);
  }),
];

module.exports = withNativeWind(config, { input: './global.css', inlineRem: 16 });
