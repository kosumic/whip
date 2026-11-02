import {
  PublicKeyInstallOutcome,
  SshWorkflowRequest,
  SshWorkflowResult_Tags,
} from 'react-native-whip-ssh/src/sshWorkflows';
import type { HostProfile } from '../types';
import { nativeHost } from './credentialTransactions';
import { runSshWorkflow, type SshWorkflowRoute } from './sshWorkflows';

export interface PublicKeyInstallationRoute extends SshWorkflowRoute {
  connected?: boolean;
}
export async function installPublicKeyForHost(
  host: HostProfile,
  publicKey: string,
  route: PublicKeyInstallationRoute,
): Promise<'added' | 'already-present' | null> {
  const result = await runSshWorkflow(
    new SshWorkflowRequest.Install({
      host: nativeHost(host),
      publicKey,
      connected: !!route.connected,
    }),
    route,
  );
  if (result.tag === SshWorkflowResult_Tags.Cancelled) return null;
  if (result.tag !== SshWorkflowResult_Tags.Installed)
    throw new Error('Invalid native installation result');
  return result.inner.outcome === PublicKeyInstallOutcome.Added
    ? 'added'
    : 'already-present';
}
