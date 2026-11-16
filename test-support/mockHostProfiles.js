/* eslint-env jest */

// Script native projections/errors in each adapter test. Never normalize,
// migrate, sort, or traverse host graphs here: Rust owns those decisions.
const hostProfileCalls = Object.fromEntries([
  'normalizeProfile', 'hydrate', 'view', 'upsert', 'markDisconnected',
  'remove', 'resolveJumpChain', 'jumpCandidates', 'migrateLegacy',
].map(method => [method, jest.fn(() => {
  throw new Error(`Unscripted NativeHostProfileStore.${method}`);
})]));

class NativeHostProfileStore {
  constructor() { Object.assign(this, hostProfileCalls); }
}

module.exports = { NativeHostProfileStore, hostProfileCalls };
