/* global Uint8Array, atob */

// Stringified into both native WebView assets. Keep these functions standalone.
function decodeTerminalBase64(data) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function createTerminalBatchWriter({ sequence, decode, write, reset, requestFull }) {
  let disposed = false;
  return {
    dispose() { disposed = true; },
    reset() { sequence.reset(); },
    write(outputs, shouldReset, complete) {
      if (disposed) return;
      let fullFrame = false;
      if (shouldReset) sequence.reset();
      // Coalesce contiguous text/graphics into one xterm write. A reset splits
      // the batch and waits for the preceding write before resetting xterm.
      const segments = [];
      let current = { reset: shouldReset, parts: [], bytes: 0 };
      for (const output of outputs) {
        if (output.kind === 'ansi') {
          const result = sequence.observe({ seq: output.seq, full: output.full, final: output.final });
          if (result.requestFull) { fullFrame = false; requestFull(); }
          if (!result.render) continue;
          if (output.full && output.final !== false) fullFrame = true;
          if (result.reset) {
            if (current.parts.length) segments.push(current);
            current = { reset: true, parts: [], bytes: 0 };
          }
        }
        const bytes = decode(output.data);
        current.parts.push(bytes);
        current.bytes += bytes.byteLength;
      }
      if (current.parts.length || current.reset) segments.push(current);
      let index = 0;
      const next = () => {
        if (disposed) return;
        const segment = segments[index++];
        if (!segment) { complete(fullFrame); return; }
        if (segment.reset) {
          segment.reset = false;
          index -= 1;
          reset(next);
          return;
        }
        if (!segment.parts.length) { next(); return; }
        let bytes = segment.parts[0];
        if (segment.parts.length > 1) {
          bytes = new Uint8Array(segment.bytes);
          let offset = 0;
          for (const part of segment.parts) { bytes.set(part, offset); offset += part.byteLength; }
        }
        // Drop intermediate buffers before xterm retains the merged write.
        segment.parts = [];
        write(bytes, next);
      };
      next();
    },
  };
}

module.exports = { decodeTerminalBase64, createTerminalBatchWriter };
