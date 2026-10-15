/* global globalThis */
/* eslint-disable no-bitwise -- XOR keeps the benchmark checksum inexpensive. */
import { performance } from 'node:perf_hooks';

const TARGET_BYTES = 256 * 1024 * 1024;

// Models the JavaScript portion of terminal delivery. The old path copied or
// sliced bytes after decoding a Herdr frame in JS; the Rust bridge now delivers
// the already-decoded payload ArrayBuffer directly. SSH decryption, Rust codec
// work, UniFFI ownership transfer, and WebView IO are intentionally excluded.

function terminalPayload(payloadBytes: number) {
  const payload = new Uint8Array(payloadBytes);
  for (let index = 0; index < payload.byteLength; index += 1) {
    payload[index] = index % 251;
  }
  return payload;
}

function measure(name: string, payloadBytes: number, iterations: number, operation: () => Uint8Array) {
  let checksum = 0;
  for (let index = 0; index < Math.min(iterations, 2000); index += 1) {
    const value = operation();
    checksum ^= value[0] || 0;
    checksum ^= value[value.byteLength - 1] || 0;
  }
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const value = operation();
    checksum ^= value[index % value.byteLength] || 0;
  }
  const elapsedMs = performance.now() - started;
  const mibPerSecond = (payloadBytes * iterations) / (1024 * 1024) / (elapsedMs / 1000);
  return { name, elapsedMs, mibPerSecond, checksum };
}

console.log('Terminal bridge JS-boundary benchmark');
console.log('Node', process.version);
console.log('size\tJS payload copy\tRust-decoded direct binary\tspeedup');

for (const payloadBytes of [4 * 1024, 64 * 1024, 1024 * 1024]) {
  const payload = terminalPayload(payloadBytes);
  const iterations = Math.max(256, Math.floor(TARGET_BYTES / payloadBytes));
  const previous = measure('previous', payloadBytes, iterations, () => payload.slice());
  const optimized = measure('optimized', payloadBytes, iterations, () => payload);
  if (previous.checksum !== optimized.checksum) {
    throw new Error(`benchmark paths disagreed for ${payloadBytes} bytes`);
  }
  const speedup = previous.elapsedMs / optimized.elapsedMs;
  console.log(
    `${payloadBytes}\t${previous.mibPerSecond.toFixed(1)} MiB/s\t\t`
      + `${optimized.mibPerSecond.toFixed(1)} MiB/s\t\t${speedup.toFixed(2)}x`
  );
}
