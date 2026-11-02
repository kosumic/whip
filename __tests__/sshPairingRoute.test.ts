import {
  SshWorkflowRequest_Tags,
  SshWorkflowResult,
} from 'react-native-whip-ssh/src/sshWorkflows';
import { SshWorkflow, workflowResult } from '../test-support/mockSshWorkflows';
import { pairHostWithRoute } from '../src/services/sshPairing';
import type { HostProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () =>
  require('./mockWhipSsh').createMockWhipSshModule(),
);
jest.mock('../src/services/appStorage', () => ({ appStorage: {} }));
const result = { sshHost: 'target.test', alreadyPresent: false };
const host = {
  id: 'outer',
  host: 'outer.test',
  port: '22',
  username: 'user',
  authMode: 'password',
  tailcatEnabled: true,
} as HostProfile;
const route = {
  hosts: [host],
  onConfirmUnknownHost: jest.fn(async () => true),
  onTrustHost: jest.fn(async () => {}),
};
beforeEach(() => {
  jest.clearAllMocks();
  SshWorkflow.instances.length = 0;
});
test.each([undefined, 'outer'])(
  'submits the pinned pairing request and selected direct/ProxyJump route (%s)',
  async jumpHostId => {
    workflowResult.mockResolvedValueOnce(
      new SshWorkflowResult.Paired({ result: result as never }),
    );
    await expect(
      pairHostWithRoute('WP4:code', 'public-key', 'phone', {
        ...route,
        jumpHostId,
      }),
    ).resolves.toBe(result);
    const operation = SshWorkflow.instances[0];
    expect(operation.request).toMatchObject({
      tag: SshWorkflowRequest_Tags.Pair,
      inner: {
        code: 'WP4:code',
        publicKey: 'public-key',
        deviceName: 'phone',
        jumpHostId,
      },
    });
    expect(operation.hosts).toEqual([
      expect.objectContaining({ id: 'outer', tailcatEnabled: true }),
    ]);
    expect(operation.run).toHaveBeenCalledTimes(1);
    expect(route.onConfirmUnknownHost).not.toHaveBeenCalled();
  },
);
test('native cancellation maps to no pairing result', async () => {
  workflowResult.mockResolvedValueOnce(new SshWorkflowResult.Cancelled());
  await expect(
    pairHostWithRoute('code', 'key', 'phone', route),
  ).resolves.toBeNull();
});
test('native transport errors are propagated without replay', async () => {
  const error = new Error('remote outcome unknown');
  workflowResult.mockRejectedValueOnce(error);
  await expect(pairHostWithRoute('code', 'key', 'phone', route)).rejects.toBe(
    error,
  );
  expect(workflowResult).toHaveBeenCalledTimes(1);
});
