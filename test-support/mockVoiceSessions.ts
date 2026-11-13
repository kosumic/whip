import type { VoiceSessionAuthority, SessionEffect } from '../packages/react-native-whip-ssh/src/voiceSession';

/** Native transport fake for presenter tests. Arbitration regressions live in Rust. */
type MockRequest = { scope: { kind: string; hostId?: string }; mode: string; resumeCallId?: string; available: boolean };
export class MockVoiceSessions implements VoiceSessionAuthority {
  private current?: string;
  private locked = false;
  private sequence = 0;
  private calls = new Map<string, { request: MockRequest; phase: string; preparing?: boolean; closing?: boolean; error?: string }>();
  private effects: SessionEffect[] = [];
  private observer?: { changed(): void };
  setObserver(observer: { changed(): void }) { this.observer = observer; }
  private changed() { this.observer?.changed(); }
  request(value: string) {
    const request = JSON.parse(value) as MockRequest;
    const previous = this.current && this.calls.get(this.current);
    if (previous && JSON.stringify(previous.request.scope) === JSON.stringify(request.scope) && (!request.resumeCallId || previous.request.resumeCallId === request.resumeCallId)) return JSON.stringify({ id: this.current, attached: true });
    const id = `test-call:${++this.sequence}`;
    const error = this.locked ? 'Unlock Whip to start a call.' : !request.available || (request.scope.kind === 'Terminal' && request.mode !== 'Realtime') ? 'This conversation mode is not available yet.' : undefined;
    if (error) return JSON.stringify({ id, error });
    for (const [pendingId, call] of this.calls) if (call.phase === 'closing' && !call.preparing && !call.closing) this.close(pendingId);
    if (this.current) this.end(this.current);
    this.calls.set(id, { request, phase: 'queued' }); this.current = id; this.changed();
    return JSON.stringify({ id });
  }
  activeId() { return this.current; }
  isCurrent(id: string) { return id === this.current; }
  phase(id: string) { return this.calls.get(id)?.phase ?? 'ended'; }
  setLocked(locked: boolean) { this.locked = locked; }
  retainHosts(hosts: string[]) { const call = this.current && this.calls.get(this.current); if (call && call.request.scope.kind !== 'Global' && !hosts.includes(call.request.scope.hostId!)) this.end(this.current!); }
  sameTarget(left: string, right: string) { return left === right; }
  submitContext = jest.fn();
  end(id: string, error?: string) {
    if (this.current === id) this.current = undefined;
    const call = this.calls.get(id); if (!call) return;
    call.error ??= error;
    if (call.phase === 'queued') this.finish(id);
    else { call.phase = 'closing'; this.close(id); }
    this.changed();
  }
  private close(id: string) { const call = this.calls.get(id)!; if (!call.preparing && !call.closing) { call.closing = true; this.effects.push({ id, action: 'close', error: call.error }); } }
  private finish(id: string) { const call = this.calls.get(id)!; this.calls.delete(id); this.effects.push({ id, action: 'end', error: call.error }); }
  acknowledge(id: string, event: string) {
    const call = this.calls.get(id); if (!call) return;
    if (call.preparing && (event === 'prepared' || event === 'prepareFailed')) {
      call.preparing = false;
      if (event === 'prepareFailed') { if (this.current === id) { this.current = undefined; call.error = 'The voice call could not be prepared.'; } this.finish(id); }
      else if (call.phase === 'closing') this.close(id);
      else { call.phase = 'starting'; this.effects.push({ id, action: 'start' }); }
    } else if (event === 'started' && call.phase === 'starting') call.phase = 'active';
    else if (event === 'startFailed' && call.phase === 'starting') this.end(id, 'The voice call could not start.');
    else if (event === 'closed' && call.phase === 'closing') this.finish(id);
    else if (event === 'closeFailed') { call.closing = false; call.error = 'The voice call could not be closed. Retry Hang Up.'; this.effects.push({ id, action: 'error', error: call.error }); if (this.current && this.current !== id) this.end(this.current, call.error); }
    this.changed();
  }
  takeEffects() {
    if (this.current && this.calls.size === 1 && this.phase(this.current) === 'queued') {
      const call = this.calls.get(this.current)!; call.phase = 'preparing'; call.preparing = true;
      this.effects.push({ id: this.current, action: 'prepare' });
    }
    const effects = this.effects; this.effects = []; return JSON.stringify({ version: 1, effects });
  }
}
export function nativeVoiceSessions() { return new MockVoiceSessions(); }
export function voiceSourceIdentity(source: { runtimeId: string; incarnation: bigint; terminalId: string; paneId: string; agent: string; targetKey: string }) {
  return { ...source, incarnation: source.incarnation.toString(), queue: undefined };
}
