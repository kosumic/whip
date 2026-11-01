import {
  SshWorkflowResult,
  type SshWorkflowRequest,
  type HostProfileRecord,
  type SshWorkflowPlatform,
} from '../packages/react-native-whip-ssh/src/generated/whip_ssh';
export * from '../packages/react-native-whip-ssh/src/generated/whip_ssh';
/** Bridge fixture only. Rust tests own all workflow behavior and policy. */
export const workflowResult = jest.fn(
  (_operation: SshWorkflow): Promise<SshWorkflowResult> =>
    Promise.resolve(new SshWorkflowResult.Cancelled()),
);
export const setSshWorkflowLocked = jest.fn();
export class SshWorkflow {
  static readonly instances: SshWorkflow[] = [];
  constructor(
    readonly request: SshWorkflowRequest,
    readonly hosts: HostProfileRecord[],
    readonly biometric: boolean,
    readonly credentials: unknown,
    readonly knownHosts: unknown,
    readonly platform: SshWorkflowPlatform,
  ) {
    SshWorkflow.instances.push(this);
  }
  cancel = jest.fn();
  run = jest.fn(() => workflowResult(this));
}
