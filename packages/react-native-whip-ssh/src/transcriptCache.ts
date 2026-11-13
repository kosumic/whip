import { TranscriptCache } from './generated-entry';
import type { NativeAppCore } from './index';

export interface NativeTranscriptCacheBinding {
  hostSessionId: string;
  terminalId: string;
  bindingToken: string;
  runtimeIncarnation: number;
}

export interface NativeTranscriptCacheSnapshot {
  revision: bigint;
  bindings: NativeTranscriptCacheBinding[];
}

/** Typed bridge only. Admission, pins, retries and eviction live in Rust. */
export class NativeTranscriptCache {
  private readonly cache = new TranscriptCache();

  setListener(changed: () => void): void { this.cache.setListener({ changed }); }

  claimOwner() {
    const token = this.cache.claimOwner();
    return {
      token,
      isCurrent: () => this.cache.ownerIsCurrent(token),
      release: () => this.cache.release(token),
    };
  }

  retainForegroundTerminal(host: string, terminal: string): () => void {
    return this.release(this.cache.retainForegroundTerminal(host, terminal));
  }

  retainSubscription(bindingToken: string): () => void {
    return this.release(this.cache.retainSubscription(bindingToken));
  }

  reconcile(core: NativeAppCore, owner: bigint, capacity: number): NativeTranscriptCacheSnapshot | undefined {
    const snapshot = this.cache.reconcile(core.connectionCore, owner, capacity);
    return snapshot && { revision: snapshot.revision, bindings: snapshot.bindings.map(binding => ({
      ...binding, runtimeIncarnation: Number(binding.runtimeIncarnation),
    })) };
  }

  private release(token: bigint): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.cache.release(token);
    };
  }
}
