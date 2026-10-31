jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native-whip-ssh', () => ({ deleteAgentTranscriptsForHost: jest.fn() }));
jest.mock('../src/services/hostProfiles', () => ({
  saveHostMetadata: jest.fn(), loadConnectionProfile: jest.fn(), deleteHostProfile: jest.fn(),
}));
jest.mock('../src/services/herdrSnapshotCache', () => ({ herdrSnapshotCache: { delete: jest.fn() } }));
jest.mock('../src/services/reverseControlHosts', () => ({ ReverseControlHosts: jest.fn() }));

import React, { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ReverseControlHosts, type HostControlContext } from '../src/services/reverseControlHosts';
import { useReverseControlHosts } from '../src/hooks/useReverseControlHosts';
import type { ConnectionProfile } from '../src/types';

type Arguments = Parameters<typeof useReverseControlHosts>;
const connect = jest.fn(async () => true);
const authenticate = jest.fn(async () => true);
const context = {
  hosts: { profilesLoaded: true, getHosts: () => [] } as unknown as Arguments[0],
  sessions: { connect, closeHostById: jest.fn(), getState: () => ({ sessions: [] }) } as unknown as Arguments[1],
  preferences: { hydration: { status: 'loaded' }, value: { reverseControlInstructions: '# Rules' } } as unknown as Arguments[2],
  security: { locked: false, isKeyProtectionEnabled: () => true, verifyBiometric: authenticate } as unknown as Arguments[3],
};
let renderer: ReactTestRenderer | undefined;
let current!: HostControlContext;
let bridges: { updateContext: jest.Mock; dispose: jest.Mock }[];
function Harness({ locked = false }: { locked?: boolean }) {
  useReverseControlHosts(context.hosts, context.sessions, context.preferences, { ...context.security, locked });
  return null;
}

beforeEach(() => {
  jest.clearAllMocks();
  bridges = [];
  jest.mocked(ReverseControlHosts).mockImplementation(getContext => {
    const bridge = { updateContext: jest.fn(() => { current = getContext(); }), dispose: jest.fn() };
    bridges.push(bridge);
    return bridge as unknown as ReverseControlHosts;
  });
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); });
  renderer = undefined;
});

test('publishes committed lock changes through the existing native adapter', async () => {
  await act(async () => { renderer = create(<Harness />); });
  expect(current).toMatchObject({ ready: true, locked: false, biometricForKeys: true });
  await act(async () => { renderer!.update(<Harness locked />); });
  expect(current.locked).toBe(true);
  expect(bridges).toHaveLength(1);
  expect(bridges[0].updateContext).toHaveBeenCalledTimes(2);
});

test('connection effects use native biometric approval and preserve trust prompts without navigation', async () => {
  await act(async () => { renderer = create(<Harness />); });
  const profile = { id: 'mini', secret: 'private', passphrase: '' } as ConnectionProfile;
  const signal = new AbortController().signal;
  await current.connect(profile, signal);
  expect(connect).toHaveBeenCalledWith(profile, {
    persistProfile: false, navigate: false, activateSession: false,
    promptForUnknownHosts: true, biometricVerified: true, signal,
  });
  expect(authenticate).not.toHaveBeenCalled();
});

test('Strict Mode replaces the disposed adapter rather than reusing revoked native permits', async () => {
  await act(async () => { renderer = create(<StrictMode><Harness /></StrictMode>); });
  expect(bridges.length).toBeGreaterThanOrEqual(2);
  expect(bridges[0].dispose).toHaveBeenCalledTimes(1);
  expect(bridges.at(-1)!.dispose).not.toHaveBeenCalled();
  await act(async () => { renderer!.unmount(); });
  renderer = undefined;
  expect(bridges.every(bridge => bridge.dispose.mock.calls.length === 1)).toBe(true);
});
