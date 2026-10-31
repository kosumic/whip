import {
  CredentialCommand_Tags,
  CredentialRecoveryState,
  CredentialResult,
  HostAuthMode,
  type CredentialCommand,
  type CredentialPlatform,
  type CredentialProfileView,
  type HostActionPermitLike,
} from '../packages/react-native-whip-ssh/src/generated/whip_ssh';

export * from '../packages/react-native-whip-ssh/src/generated/whip_ssh';

/** Adapter fixture only. Native fault/race tests own transaction semantics. */
export const credentialRequest = jest.fn((command: CredentialCommand, _guard: HostActionPermitLike | undefined, coordinator: CredentialCoordinator): Promise<CredentialResult> => {
  if (command.tag === CredentialCommand_Tags.LoadHosts) {
      const hosts = command.inner.hosts ? (JSON.parse(command.inner.hosts) as CredentialProfileView['hosts']).map(host => ({
        ...host,
        authMode: (host.authMode as unknown) === 'key' ? HostAuthMode.Key : (host.authMode as unknown) === 'password' ? HostAuthMode.Password : host.authMode,
      })) : [];
      coordinator.project({ loaded: true, revision: 1n, hosts, repairHostIds: [] });
      return Promise.resolve(new CredentialResult.Hosts({ hosts }));
  }
  if (command.tag === CredentialCommand_Tags.LoadGlobalKeys) return Promise.resolve(new CredentialResult.GlobalKeys({ keys: [] }));
  if (command.tag === CredentialCommand_Tags.RecoveryStatus) return Promise.resolve(new CredentialResult.RecoveryStatus({ state: CredentialRecoveryState.None, count: 0 }));
  if (command.tag === CredentialCommand_Tags.MigrateBackups) return Promise.resolve(new CredentialResult.Done());
  return Promise.reject(new Error('Configure a native transaction result for this adapter test'));
});

export class CredentialCoordinator {
  static readonly instances: CredentialCoordinator[] = [];
  private value: CredentialProfileView = { loaded: false, revision: 0n, hosts: [], repairHostIds: [] };
  constructor(readonly platform: CredentialPlatform) { CredentialCoordinator.instances.push(this); }
  view() { return this.value; }
  project(value: CredentialProfileView) {
    if (value.revision >= this.value.revision) this.value = value;
    this.platform.profilesChanged(value);
  }
  begin = jest.fn((command: CredentialCommand, guard?: HostActionPermitLike) => ({
    result: () => credentialRequest(command, guard, this),
    cancel: jest.fn(),
  }));
  close = jest.fn();
}
