import type { BrowserBridgeEvent, BrowserRuntime } from '../browser/registry';
import type { HostProfile } from '../types';
import type { HostMetadataPatch } from './hostProfiles';

export interface HostControlContext {
  ready: boolean;
  locked: boolean;
  globalInstructions: string;
  getHosts: () => HostProfile[];
  connections: () => { host_id: string; status: string }[];
  save: (id: string, profile: HostMetadataPatch, source: string | undefined, assertActive: () => void) => Promise<{ host: HostProfile }>;
  delete: (hostId: string, assertActive: () => void) => Promise<void>;
  connect: (host: HostProfile, signal: AbortSignal, assertActive: () => void) => Promise<boolean>;
  disconnect: (hostId: string) => Promise<void>;
}

interface HostArguments {
  host_id?: string;
  profile?: HostMetadataPatch;
  credential_from_host_id?: string;
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Storage and connection adapter. Tool validation and Herdr dispatch live in Rust. */
export class ReverseControlHosts {
  private readonly calls = new Map<string, AbortController>();

  constructor(private readonly context: () => HostControlContext) {}

  dispose(): void {
    for (const call of this.calls.values()) call.abort();
    this.calls.clear();
  }

  async event(event: BrowserBridgeEvent, runtime: BrowserRuntime): Promise<void> {
    if (event.session.runtimeId !== runtime.runtimeId) return;
    const sessionId = event.session.sessionId;
    const prefix = `${sessionId}:`;
    if (event.kind === 'closed') {
      for (const [key, call] of this.calls) {
        if (key.startsWith(prefix)) call.abort();
      }
      return;
    }
    const key = prefix + event.requestId;
    if (event.kind === 'cancel') {
      this.calls.get(key)?.abort();
      return;
    }
    if (event.kind !== 'action' || !event.action.startsWith('hosts.')) return;
    const abort = new AbortController();
    this.calls.set(key, abort);
    const assertActive = () => {
      if (abort.signal.aborted) throw failure('cancelled', 'Host action cancelled');
      if (!runtime.reverseControlSessions().some(session =>
        session.sessionId === sessionId && session.paneId === event.session.paneId &&
        session.terminalId === event.session.terminalId && session.runtimeId === runtime.runtimeId,
      )) throw failure('unauthorized', 'Reverse Control session is no longer authorized');
      const context = this.context();
      if (!context.ready) throw failure('device_unavailable', 'Wait for Whip host profiles and preferences to load');
      if (context.locked) throw failure('permission_denied', 'Unlock Whip before managing hosts');
    };
    let response: unknown;
    try {
      assertActive();
      const args = JSON.parse(event.argumentsJson) as HostArguments;
      const value = await this.run(event.action, args, abort.signal, assertActive);
      assertActive();
      response = { ok: true, value };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error &&
        typeof error.code === 'string' &&
        ['cancelled', 'unauthorized', 'permission_denied', 'device_unavailable', 'not_found', 'invalid_argument'].includes(error.code)
        ? error.code : 'device_unavailable';
      // Storage/keychain errors can contain private payloads. Reflect only our
      // bounded domain failures; detailed storage diagnostics stay on the phone.
      const message = code !== 'device_unavailable' && error instanceof Error
        ? error.message : 'Host action failed; check the saved host and connection in Whip';
      response = { ok: false, error: { code, message } };
    } finally {
      this.calls.delete(key);
    }
    if (!abort.signal.aborted)
      runtime.reverseControlReply(sessionId, event.requestId, JSON.stringify(response));
  }

  private async run(
    action: string,
    args: HostArguments,
    signal: AbortSignal,
    assertActive: () => void,
  ): Promise<unknown> {
    const context = this.context();
    if (action === 'hosts.list')
      return { hosts: context.getHosts(), connections: context.connections() };
    const host = context.getHosts().find(item => item.id === args.host_id);
    if (action === 'hosts.save') {
      if (!args.host_id || !args.profile) throw failure('invalid_argument', 'Host save requires a profile');
      return context.save(args.host_id, args.profile, args.credential_from_host_id, assertActive);
    }
    if (!host) throw failure('not_found', 'Saved host does not exist');
    switch (action) {
      case 'hosts.instructions':
        return { host_id: host.id, global: context.globalInstructions, host: host.agentInstructions || '' };
      case 'hosts.connect': {
        if (!await context.connect(host, signal, assertActive))
          throw failure('device_unavailable', 'Host connection did not complete');
        assertActive();
        return context.connections().find(item => item.host_id === host.id) || { host_id: host.id, status: 'connected' };
      }
      case 'hosts.disconnect':
        await context.disconnect(host.id);
        return { host_id: host.id, completed: true };
      case 'hosts.delete':
        await context.delete(host.id, assertActive);
        return { host_id: host.id, completed: true };
      default:
        throw failure('invalid_argument', 'Unknown host operation');
    }
  }
}
