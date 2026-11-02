import {
  SshWorkflowRequest,
  SshWorkflowResult_Tags,
} from 'react-native-whip-ssh/src/sshWorkflows';
import type { PairHostResult } from '../lib/sshPairing';
import { runSshWorkflow, type SshWorkflowRoute } from './sshWorkflows';

interface PairingRoute extends SshWorkflowRoute {
  jumpHostId?: string;
}
export async function pairHostWithRoute(
  code: string,
  publicKey: string,
  deviceName: string,
  route: PairingRoute,
): Promise<PairHostResult | null> {
  const result = await runSshWorkflow(
    new SshWorkflowRequest.Pair({
      code,
      publicKey,
      deviceName,
      jumpHostId: route.jumpHostId,
    }),
    route,
  );
  if (result.tag === SshWorkflowResult_Tags.Cancelled) return null;
  if (result.tag !== SshWorkflowResult_Tags.Paired)
    throw new Error('Invalid native pairing result');
  return result.inner.result;
}
