/* global window, BigInt */
// Runs inside the terminal WebView, with no React Native JS-thread callback.
function postNativeTerminalMessage(value) {
  if (window.WhipTerminalNative && typeof window.WhipTerminalNative.postMessage === 'function') {
    if (value.op === 'written' && !value.tracing && window.WhipTerminalNative.acknowledge) {
      window.WhipTerminalNative.acknowledge(value.generation, value.batchId);
      return true;
    }
    window.WhipTerminalNative.postMessage(JSON.stringify(value));
    return true;
  }
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.WhipTerminalNative;
  if (handler) { handler.postMessage(value); return true; }
  return false;
}

function createNativeTerminalDelivery({ terminals, call, post, report }) {
  const current = (entry, generation) => entry && entry.native && entry.native.generation === generation;
  return {
    armTrace(key) {
      const entry = terminals.get(key);
      if (entry) entry.nativeTracePending = Math.min(64, (entry.nativeTracePending || 0) + 1);
    },
    bind(key, identity, generation, reset) {
      const entry = terminals.get(key);
      if (!entry || entry.identity !== identity || !entry.ready) return;
      if (entry.generation !== null && BigInt(generation) < BigInt(entry.generation)) return;
      entry.generation = generation;
      entry.native = { generation, reset, baselinePending: true, fullPending: true };
      if (!post({ op: 'bind', key, identity, generation })) this.bound(generation, false);
    },
    bound(generation, success) {
      const entry = [...terminals.values()].find(value => current(value, generation));
      if (!entry || success) return;
      report({ type: 'terminal-native-unavailable', key: entry.key, identity: entry.identity,
        generation, reset: entry.native.reset });
      entry.native = null;
    },
    deliver(packet, tracing, startedAt) {
      const [key, identity, generation] = packet;
      const entry = terminals.get(key);
      if (!entry || entry.identity !== identity || !entry.ready || !current(entry, generation)) return;
      if (tracing && Number.isFinite(startedAt)) post({ op: 'received', generation, batchId: packet[3], receiveMs: Math.max(0, Date.now() - startedAt) });
      const reset = entry.native.reset;
      entry.native.reset = false;
      const traceUi = entry.nativeTracePending > 0;
      if (traceUi) {
        entry.nativeTracePending -= 1;
        report({ type: 'terminal-native-frame', key, identity, generation, batchId: packet[3] });
      }
      call(key, 'herdrDeliverBatch', [packet, reset, null, null, null, true, tracing, traceUi]);
    },
    receive(entry, value) {
      if (!current(entry, value.generation)) return;
      if (value.type === 'native-batch-written') {
        const state = entry.native;
        post(Object.assign({ op: 'written' }, value));
        if (state.baselinePending || (state.fullPending && value.fullFrame)) {
          state.baselinePending = false;
          if (value.fullFrame) state.fullPending = false;
          report({ type: 'terminal-native-baseline', key: entry.key, identity: entry.identity,
            generation: value.generation, fullFrame: value.fullFrame });
        }
      } else if (value.type === 'native-batch-visible') {
        if (value.tracing) post(Object.assign({ op: 'visible' }, value));
        if (value.traceUi) report(Object.assign({}, value, { type: 'terminal-native-visible', key: entry.key, identity: entry.identity }));
      }
    },
    gap(entry) { if (entry.native) entry.native.fullPending = true; },
    release(entry) {
      if (entry.native) post({ op: 'release', generation: entry.native.generation });
      entry.native = null;
    },
  };
}
module.exports = { postNativeTerminalMessage, createNativeTerminalDelivery };
