import type {
  TerminalSubmissionMessage,
  TerminalSubmissionPlatform,
  TerminalSubmissionTarget,
  TerminalSubmissionPermitLike,
} from 'react-native-whip-ssh/src/terminalSubmissions';
import {
  TerminalSubmissionStatus,
  TerminalSubmissionFailure,
  TerminalSubmissionPlatformError,
  TerminalSubmissionPermitError,
} from '../packages/react-native-whip-ssh/src/generated/whip_ssh';

export { TerminalSubmissionStatus, TerminalSubmissionFailure, TerminalSubmissionPlatformError, TerminalSubmissionPermitError };

// A platform-contract fixture. Retry, ambiguity and destination fencing are
// exercised against the real Rust coordinator, rather than reimplemented here.
let sequence = 0;
export class TerminalSubmissionQueue {
  static readonly instances: TerminalSubmissionQueue[] = [];
  readonly records = new Map<string, TerminalSubmissionMessage[]>();
  private readonly completed = new Map<string, TerminalSubmissionMessage[]>();
  private platform?: TerminalSubmissionPlatform;
  private targets: TerminalSubmissionTarget[] = [];
  private epoch = 0;
  private active = new Set<string>();

  constructor() { TerminalSubmissionQueue.instances.push(this); }
  enqueue(key: string, text: string, attachments: TerminalSubmissionMessage['attachments']): TerminalSubmissionMessage | undefined {
    const pasteEvents = [text.trimEnd(), ...attachments.map(value => value.remotePath)].filter(Boolean);
    if (!pasteEvents.length) return undefined;
    const message = { id: String(++sequence), text, attachments, pasteEvents, historyEntry: pasteEvents.join(' '), status: TerminalSubmissionStatus.Queued, attempts: 0, acceptedParts: 0, failure: undefined };
    this.records.set(key, [...this.view(key), message]);
    return message;
  }
  view(key: string) { return this.records.get(key) ?? []; }
  takeCompleted(key: string) { const values = this.completed.get(key) ?? []; this.completed.delete(key); return values; }
  attach(platform: TerminalSubmissionPlatform) { this.platform = platform; this.start(); }
  detach() {
    this.epoch++;
    this.platform = undefined;
    this.active.clear();
    for (const messages of this.records.values()) for (const message of messages) {
      if (message.status === TerminalSubmissionStatus.Preparing) message.status = TerminalSubmissionStatus.Queued;
    }
  }
  updateTargets(targets: TerminalSubmissionTarget[]) { this.targets = targets; this.start(); }
  unqueue(key: string, id: string) {
    const message = this.view(key).find(value => value.id === id);
    if (!message || message.status === TerminalSubmissionStatus.Preparing || message.status === TerminalSubmissionStatus.Writing) return undefined;
    this.records.set(key, this.view(key).filter(value => value.id !== id));
    return message;
  }
  remove(key: string) { this.records.delete(key); }
  /** Inject a native projection or completion in adapter tests. */
  project(key: string, id: string, update: Partial<TerminalSubmissionMessage> | 'accepted') {
    const message = this.view(key).find(value => value.id === id);
    if (!message) return;
    if (update === 'accepted') {
      this.records.set(key, this.view(key).filter(value => value.id !== id));
      this.completed.set(key, [...(this.completed.get(key) ?? []), message]);
    } else Object.assign(message, update);
    this.platform?.changed(key);
  }
  start() {
    for (const target of this.targets) {
      const key = target.key;
      const message = this.view(key)[0];
      const platform = this.platform;
      if (!target.online || !platform || !message || this.active.has(key) || message.status !== TerminalSubmissionStatus.Queued) continue;
      this.active.add(key);
      const epoch = this.epoch;
      const checkActive = () => { if (this.epoch !== epoch || !this.view(key).some(value => value.id === message.id)) throw new Error('Obsolete native permit'); };
      const permit = { checkActive, dispatch: () => { checkActive(); this.project(key, message.id, 'accepted'); return Promise.resolve(); } } as TerminalSubmissionPermitLike;
      message.status = TerminalSubmissionStatus.Preparing;
      void Promise.resolve().then(async () => {
        platform.changed(key);
        try { await platform.submit(permit, key, message.pasteEvents, true); } catch { /* Explicit projections drive failures in adapter tests. */ }
        if (this.epoch === epoch) { this.active.delete(key); this.start(); }
      });
    }
  }
}
