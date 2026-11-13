/** Scripted native outcomes. Cache policy is exercised by Rust integration tests. */
export class NativeTranscriptCache {
  static readonly instances: NativeTranscriptCache[] = [];
  private changed = () => {};
  private nextToken = 0n;
  private owners: bigint[] = [];

  constructor() { NativeTranscriptCache.instances.push(this); }
  setListener(changed: () => void) { this.changed = changed; }
  notify() { this.changed(); }
  reconcile = jest.fn();
  retainForegroundTerminal = jest.fn((_host: string, _terminal: string) => this.lease());
  retainSubscription = jest.fn((_binding: string) => this.lease());
  claimOwner() {
    const token = ++this.nextToken;
    this.owners.push(token);
    return {
      token,
      isCurrent: () => this.owners.at(-1) === token,
      release: () => { this.owners = this.owners.filter(owner => owner !== token); this.notify(); },
    };
  }
  private lease() {
    this.notify();
    const release = jest.fn(() => this.notify());
    let released = false;
    return () => { if (!released) { released = true; release(); } };
  }
}
