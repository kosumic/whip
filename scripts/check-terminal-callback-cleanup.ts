// Compile and execute the actual generated native callback entry points. This
// exercises ownership when JS is alive and after its callback has been cleared.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync('packages/react-native-whip-ssh/cpp/generated/whip_ssh.cpp', 'utf8');
const bufferHeader = readFileSync('node_modules/uniffi-bindgen-react-native/cpp/includes/RustBuffer.h', 'utf8');
const bufferStart = bufferHeader.indexOf('struct RustBuffer {');
if (bufferStart < 0) throw new Error('Missing generated RustBuffer ABI');
const buffer = bufferHeader.slice(bufferStart, bufferHeader.indexOf('};', bufferStart) + 2);
const callbacks = ['terminaldeliveryeventsinkmethod0', 'herdrterminaleventsinkmethod0', 'whipssheventsinkmethod1', 'whipssheventsinkmethod2'];
const tests: string[] = [];
const bodies = callbacks.map((name, index) => {
  const namespace = source.indexOf(`callbackinterface${name}::`);
  if (namespace < 0) throw new Error(`Missing callback ${name}`);
  const start = source.indexOf('static void callback(', namespace);
  const open = source.indexOf('{', start);
  if (start < 0 || open < 0) throw new Error(`Missing native callback entry ${name}`);
  let depth = 1;
  let end = open + 1;
  for (; end < source.length && depth; end += 1) {
    if (source[end] === '{') depth += 1;
    else if (source[end] === '}') depth -= 1;
  }
  if (depth) throw new Error(`Unclosed callback ${name}`);
  const parameters = source.slice(start + 'static void callback('.length, open).trim().replace(/\)$/, '');
  const declarations = parameters.split(',').map(value => value.trim());
  const inputs = declarations.map(declaration => {
    const variable = /([a-zA-Z_]\w*)$/.exec(declaration)?.[1];
    if (!variable) throw new Error(`Unknown parameter ${declaration}`);
    return { variable, owned: declaration.startsWith('RustBuffer '), pointer: declaration.includes('*') };
  });
  const arguments_ = inputs.map(input => input.owned ? 'own()' : input.pointer ? 'nullptr' : '1').join(', ');
  const checks = inputs.map(input => input.owned
    ? `Bridging<RustBuffer>::rustbuffer_free(${input.variable});`
    : `assert(${input.variable} == ${input.pointer ? 'nullptr' : '1'});`).join('\n');
  tests.push(`test${index}::run();`);
  return `namespace test${index} {
static std::function<void(${parameters})> rsLambda = nullptr;
${source.slice(start, end)}
void run() {
  for (int i = 0; i < 1000; ++i) { callback(${arguments_}); assert(allocations.empty()); }
  int calls = 0;
  rsLambda = [&calls](${parameters}) { ++calls; ${checks} };
  callback(${arguments_});
  assert(calls == 1 && allocations.empty());
  rsLambda = nullptr;
  callback(${arguments_});
  assert(allocations.empty());
}
}`;
});
const cpp = `#include <cassert>
#include <cstdint>
#include <functional>
#include <unordered_set>
${buffer}
struct RustCallStatus;
static std::unordered_set<uint8_t *> allocations;
static RustBuffer own() { auto data = new uint8_t[64]; allocations.insert(data); return {64,64,data}; }
template<typename T> struct Bridging;
template<> struct Bridging<RustBuffer> {
  static void rustbuffer_free(RustBuffer value) { assert(allocations.erase(value.data) == 1); delete[] value.data; }
};
${bodies.join('\n')}
int main() { ${tests.join('\n')} return allocations.empty() ? 0 : 1; }
`;
const directory = mkdtempSync(join(tmpdir(), 'whip-native-callbacks-'));
try {
  const file = join(directory, 'callbacks.cpp');
  const binary = join(directory, 'callbacks');
  writeFileSync(file, cpp);
  execFileSync(process.argv[2] || process.env.CXX || 'c++', ['-std=c++20', '-O2', '-Wall', '-Wextra', '-Werror', file, '-o', binary], { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
  console.log('Native callback ownership: four generated entry points, live and after teardown; zero outstanding buffers.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
