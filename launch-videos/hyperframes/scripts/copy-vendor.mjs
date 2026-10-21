import {copyFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ['node_modules/gsap/dist/gsap.min.js', 'assets/vendor/gsap.min.js'],
  ['node_modules/gsap/dist/MotionPathPlugin.min.js', 'assets/vendor/MotionPathPlugin.min.js'],
  ['node_modules/three/build/three.module.js', 'assets/vendor/three/three.module.js'],
  ['node_modules/three/build/three.core.js', 'assets/vendor/three/three.core.js'],
  ['node_modules/three/examples/jsm/loaders/GLTFLoader.js', 'assets/vendor/three/addons/loaders/GLTFLoader.js'],
  ['node_modules/three/examples/jsm/utils/BufferGeometryUtils.js', 'assets/vendor/three/addons/utils/BufferGeometryUtils.js'],
];

for (const [source, destination] of files) {
  const output = resolve(root, destination);
  await mkdir(dirname(output), {recursive: true});
  await copyFile(resolve(root, source), output);
  console.log(`Prepared ${output}`);
}
