#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(packageRoot, "package.json"));
const cargoToml = fs.readFileSync(path.join(packageRoot, "..", "Cargo.toml"), "utf8");
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

if (!cargoVersion) {
  throw new Error("Unable to read the whipair version from Cargo.toml");
}
if (packageJson.version !== cargoVersion) {
  throw new Error(
    `npm version ${packageJson.version} does not match Cargo version ${cargoVersion}`,
  );
}
if (packageJson.license !== "MIT" || !packageJson.files.includes("LICENSE")) {
  throw new Error("The published npm package must declare and include the MIT license");
}
const license = fs.readFileSync(path.join(packageRoot, "LICENSE"), "utf8");
if (license !== fs.readFileSync(path.join(packageRoot, "..", "LICENSE"), "utf8")) {
  throw new Error("The npm and Rust packages must ship the same MIT license");
}

for (const target of [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
]) {
  const binary = path.join(packageRoot, "vendor", target, "whipair");
  const stat = fs.statSync(binary, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw new Error(`Missing native binary: vendor/${target}/whipair`);
  }
}

console.log(`Verified whipair npm package ${packageJson.version}`);
