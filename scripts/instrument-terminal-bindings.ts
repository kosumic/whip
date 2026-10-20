// Part of both native binding builds. Keep callback diagnostics reproducible;
// never patch generated C++ by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../packages/react-native-whip-ssh/cpp/generated/whip_ssh.cpp', import.meta.url));
let source = readFileSync(path, 'utf8');
const include = '#include "../terminal_callback_trace.hpp"';
if (!source.includes(include)) source = `${include}\n${source}`;
const callbacks = [
  ['terminaldeliveryeventsinkmethod0', 'Whip terminal inbound native to JS'],
  ['herdrterminaleventsinkmethod0', 'Whip terminal inbound native to JS'],
  ['whipssheventsinkmethod1', 'Whip terminal inbound native to JS'],
  ['whipssheventsinkmethod2', 'Whip exec inbound native to JS'],
];
for (const [callback, label] of callbacks) {
  const marker = `// uniffi::whip_ssh::cb::callbackinterface${callback}::`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing terminal callback ${callback}`);
  const next = source.indexOf('// Callback function:', start);
  const end = next < 0 ? source.length : next;
  let body = source.slice(start, end);
  if (body.includes('WhipTerminalCallbackTrace')) continue;
  const blocking = 'callInvoker->invokeBlocking(rt, jsLambda);';
  if (!body.includes(blocking)) throw new Error(`Terminal callback no longer blocks: ${callback}`);
  body = body.replace(blocking, `WhipTerminalCallbackTrace nativeTrace("${label}");\n    ${blocking}`);
  const entry = '](jsi::Runtime &rt) mutable {';
  if (!body.includes(entry)) throw new Error(`Missing callback entry ${callback}`);
  body = body.replace(entry, `${entry}\n      WhipTerminalCallbackTrace jsTrace("${label.replace('native to JS', 'JS callback execution')}");`);
  source = source.slice(0, start) + body + source.slice(end);
}
writeFileSync(path, source);
