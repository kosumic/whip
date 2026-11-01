import {
  PublicKeyInstallOutcome,
  SshWorkflowRequest_Tags,
  SshWorkflowResult,
} from 'react-native-whip-ssh/src/sshWorkflows';
import { SshWorkflow, workflowResult } from '../test-support/mockSshWorkflows';
import { installPublicKeyForHost } from '../src/services/publicKeyInstallation';
import type { HostProfile } from '../src/types';
jest.mock('react-native-whip-ssh', () =>
  require('./mockWhipSsh').createMockWhipSshModule(),
);
jest.mock('../src/services/appStorage', () => ({ appStorage: {} }));
const host = {
  id: 'target',
  host: 'target.test',
  port: '2222',
  username: 'user',
  authMode: 'key',
  tailcatEnabled: true,
  tailcatSshServer: true,
  jumpHostId: 'outer',
} as HostProfile;
const route = {
  hosts: [host],
  onAuthenticatePrivateKey: jest.fn(async () => true),
  onConfirmUnknownHost: jest.fn(async () => true),
  onTrustHost: jest.fn(async () => {}),
};
beforeEach(() => {
  jest.clearAllMocks();
  SshWorkflow.instances.length = 0;
});
test.each([
  [PublicKeyInstallOutcome.Added, 'added'],
  [PublicKeyInstallOutcome.AlreadyPresent, 'already-present'],
] as const)(
  'preserves native installation outcome %s',
  async (outcome, expected) => {
    workflowResult.mockResolvedValueOnce(
      new SshWorkflowResult.Installed({ outcome }),
    );
    await expect(
      installPublicKeyForHost(host, 'public-key', {
        ...route,
        connected: true,
      }),
    ).resolves.toBe(expected);
    const operation = SshWorkflow.instances[0];
    expect(operation.request).toMatchObject({
      tag: SshWorkflowRequest_Tags.Install,
      inner: {
        publicKey: 'public-key',
        connected: true,
        host: expect.objectContaining({
          id: 'target',
          port: '2222',
          tailcatEnabled: true,
          tailcatSshServer: true,
          jumpHostId: 'outer',
        }),
      },
    });
    expect(operation.biometric).toBe(true);
    expect(operation.run).toHaveBeenCalledTimes(1);
  },
);
test('eligibility failures are native outcomes and are never retried by the adapter', async () => {
  workflowResult.mockRejectedValueOnce(
    new Error('Connect to this host before installing a public key'),
  );
  await expect(installPublicKeyForHost(host, 'key', route)).rejects.toThrow(
    'Connect to this host',
  );
  expect(workflowResult).toHaveBeenCalledTimes(1);
});
test('native biometric/trust cancellation returns no installation result', async () => {
  workflowResult.mockResolvedValueOnce(new SshWorkflowResult.Cancelled());
  await expect(installPublicKeyForHost(host, 'key', route)).resolves.toBeNull();
});
