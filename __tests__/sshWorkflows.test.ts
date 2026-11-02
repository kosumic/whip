import {
  SshWorkflowRequest,
  SshWorkflowPlatformError,
  SshWorkflowResult,
  type SshWorkflowPermitLike,
} from 'react-native-whip-ssh/src/sshWorkflows';
import { SshWorkflow, workflowResult } from '../test-support/mockSshWorkflows';
import { runSshWorkflow, workflowPlatform } from '../src/services/sshWorkflows';
jest.mock('react-native-whip-ssh', () =>
  require('./mockWhipSsh').createMockWhipSshModule(),
);
jest.mock('../src/services/appStorage', () => ({ appStorage: {} }));
const challenge = {
  host: 'target.test',
  port: 2222,
  keyType: 'ssh-ed25519',
  publicKey: 'server-key',
  fingerprint: 'SHA256:server',
};
function route() {
  return {
    hosts: [],
    onAuthenticatePrivateKey: jest.fn(async () => true),
    onConfirmUnknownHost: jest.fn(async () => true),
    onTrustHost: jest.fn(async () => {}),
  };
}
function permit(checkActive = jest.fn()) {
  return { checkActive } as unknown as SshWorkflowPermitLike;
}
beforeEach(() => {
  jest.clearAllMocks();
  SshWorkflow.instances.length = 0;
});
test.each([true, false])(
  'forwards explicit trust approval %s for the exact native challenge',
  async approved => {
    const ui = route();
    ui.onConfirmUnknownHost.mockResolvedValue(approved);
    await expect(
      workflowPlatform(ui).confirmHostKey(permit(), challenge),
    ).resolves.toBe(approved);
    expect(ui.onConfirmUnknownHost).toHaveBeenCalledWith(challenge);
    expect(ui.onTrustHost).not.toHaveBeenCalled();
  },
);
test('refreshes trust UI only when native requests the post-commit effect', async () => {
  const ui = route();
  await workflowPlatform(ui).hostKeyTrusted(permit(), challenge);
  expect(ui.onTrustHost).toHaveBeenCalledWith(challenge);
});
test('biometric cancellation remains a denial', async () => {
  const ui = route();
  ui.onAuthenticatePrivateKey.mockResolvedValue(false);
  await expect(
    workflowPlatform(ui).authenticatePrivateKey(permit()),
  ).resolves.toBe(false);
});
test('a revoked permit prevents invoking any platform action', async () => {
  const ui = route();
  const revoked = permit(
    jest.fn(() => {
      throw new Error('revoked');
    }),
  );
  await expect(
    workflowPlatform(ui).confirmHostKey(revoked, challenge),
  ).rejects.toBeInstanceOf(SshWorkflowPlatformError.Cancelled);
  await expect(
    workflowPlatform(ui).hostKeyTrusted(revoked, challenge),
  ).rejects.toBeInstanceOf(SshWorkflowPlatformError.Cancelled);
  expect(ui.onConfirmUnknownHost).not.toHaveBeenCalled();
  expect(ui.onTrustHost).not.toHaveBeenCalled();
});
test('a delayed biometric response cannot resume after native revocation', async () => {
  let active = true;
  let resolve!: (value: boolean) => void;
  const ui = route();
  ui.onAuthenticatePrivateKey.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const request = workflowPlatform(ui).authenticatePrivateKey(
    permit(
      jest.fn(() => {
        if (!active) throw new Error('stale');
      }),
    ),
  );
  active = false;
  resolve(true);
  await expect(request).rejects.toBeInstanceOf(
    SshWorkflowPlatformError.Cancelled,
  );
});
test('foreign prompt exceptions are mapped to a bounded typed error', async () => {
  const ui = route();
  ui.onConfirmUnknownHost.mockRejectedValue(
    new Error('secret platform details'),
  );
  await expect(
    workflowPlatform(ui).confirmHostKey(permit(), challenge),
  ).rejects.toBeInstanceOf(SshWorkflowPlatformError.Unavailable);
});
test.each([false, true])(
  'AbortSignal cancels the native operation, including pre-aborted signals (%s)',
  async preAborted => {
    const abort = new AbortController();
    if (preAborted) abort.abort();
    let resolve!: (value: SshWorkflowResult) => void;
    workflowResult.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const request = runSshWorkflow(
      new SshWorkflowRequest.Pair({
        code: 'code',
        publicKey: 'key',
        deviceName: 'phone',
      }),
      { ...route(), signal: abort.signal },
    );
    const operation = SshWorkflow.instances[0];
    if (!preAborted) abort.abort();
    expect(operation.cancel).toHaveBeenCalledTimes(1);
    resolve(new SshWorkflowResult.Cancelled());
    await request;
    abort.signal.dispatchEvent(new Event('abort'));
    expect(operation.cancel).toHaveBeenCalledTimes(1);
  },
);
