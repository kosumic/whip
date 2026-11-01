import {
  SshWorkflow,
  SshWorkflowPlatformError,
  type SshWorkflowPlatform,
  type SshWorkflowPermitLike,
  type WorkflowRequest,
} from 'react-native-whip-ssh/src/sshWorkflows';
import type { HostProfile } from '../types';
import { credentialTransactions, nativeHost } from './credentialTransactions';
import {
  knownHostRepository,
  type UnknownHostKeyChallenge,
} from './knownHosts';

export interface SshWorkflowRoute {
  hosts: HostProfile[];
  signal?: AbortSignal;
  onAuthenticatePrivateKey?: () => Promise<boolean>;
  onConfirmUnknownHost: (
    challenge: UnknownHostKeyChallenge,
  ) => Promise<boolean>;
  onTrustHost: (challenge: UnknownHostKeyChallenge) => Promise<void>;
}

/** Narrow prompt/projection effects. Ordering, credentials and trust live in Rust. */
export function workflowPlatform(route: SshWorkflowRoute): SshWorkflowPlatform {
  async function effect<T>(
    permit: SshWorkflowPermitLike,
    callback: () => Promise<T>,
  ): Promise<T> {
    try {
      permit.checkActive();
      const result = await callback();
      permit.checkActive();
      return result;
    } catch {
      // Never forward arbitrary platform exception text across the native boundary.
      try {
        permit.checkActive();
      } catch {
        throw new SshWorkflowPlatformError.Cancelled();
      }
      throw new SshWorkflowPlatformError.Unavailable();
    }
  }
  return {
    authenticatePrivateKey: permit =>
      effect(permit, async () => {
        if (!route.onAuthenticatePrivateKey)
          throw new SshWorkflowPlatformError.Unavailable();
        return route.onAuthenticatePrivateKey();
      }),
    confirmHostKey: (permit, challenge) =>
      effect(permit, () => route.onConfirmUnknownHost(challenge)),
    hostKeyTrusted: (permit, challenge) =>
      effect(permit, () => route.onTrustHost(challenge)),
  };
}
export async function runSshWorkflow(
  request: WorkflowRequest,
  route: SshWorkflowRoute,
) {
  const operation = new SshWorkflow(
    request,
    route.hosts.map(nativeHost),
    !!route.onAuthenticatePrivateKey,
    credentialTransactions.native,
    knownHostRepository,
    workflowPlatform(route),
  );
  const cancel = () => operation.cancel();
  route.signal?.addEventListener('abort', cancel, { once: true });
  if (route.signal?.aborted) cancel();
  try {
    return await operation.run();
  } finally {
    route.signal?.removeEventListener('abort', cancel);
  }
}
