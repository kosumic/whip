import type { PaneScrollInfo } from '../types';

export interface OfflineTerminalSnapshot {
  transcript: string;
  scroll: PaneScrollInfo;
}

export interface OfflineTerminalMutation {
  snapshot: OfflineTerminalSnapshot;
  changed: boolean;
}

const emptyScroll = (): PaneScrollInfo => ({
  offset_from_bottom: 0,
  max_offset_from_bottom: 0,
  viewport_rows: 0,
});

const emptySnapshot = (): OfflineTerminalSnapshot => ({
  transcript: '',
  scroll: emptyScroll(),
});

const EMPTY_SNAPSHOT = emptySnapshot();

function normalizeScroll(scroll: PaneScrollInfo): PaneScrollInfo {
  const maxOffset = Number.isFinite(scroll.max_offset_from_bottom)
    ? Math.max(0, Math.round(scroll.max_offset_from_bottom))
    : 0;
  const offset = Number.isFinite(scroll.offset_from_bottom)
    ? Math.max(0, Math.min(maxOffset, Math.round(scroll.offset_from_bottom)))
    : 0;
  const viewportRows = Number.isFinite(scroll.viewport_rows)
    ? Math.max(0, Math.round(scroll.viewport_rows))
    : 0;
  return {
    offset_from_bottom: offset,
    max_offset_from_bottom: maxOffset,
    viewport_rows: viewportRows,
  };
}

function sameScroll(left: PaneScrollInfo, right: PaneScrollInfo): boolean {
  return left.offset_from_bottom === right.offset_from_bottom
    && left.max_offset_from_bottom === right.max_offset_from_bottom
    && left.viewport_rows === right.viewport_rows;
}

export class OfflineTerminalBackend {
  private readonly snapshots = new Map<string, OfflineTerminalSnapshot>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  snapshot(targetKey: string): OfflineTerminalSnapshot {
    return this.snapshots.get(targetKey) ?? EMPTY_SNAPSHOT;
  }

  updateTranscript(targetKey: string, transcript: string): OfflineTerminalMutation {
    const current = this.snapshots.get(targetKey) || emptySnapshot();
    if (current.transcript === transcript) {
      return { snapshot: current, changed: false };
    }
    const next = {
      transcript,
      // A new remote capture is a new virtual pane snapshot. Its geometry is
      // renderer-dependent, so start at the bottom until xterm reports it.
      scroll: emptyScroll(),
    };
    this.snapshots.set(targetKey, next);
    this.emit();
    return { snapshot: next, changed: true };
  }

  updateScroll(targetKey: string, scroll: PaneScrollInfo): OfflineTerminalMutation {
    const current = this.snapshots.get(targetKey) || emptySnapshot();
    const normalized = normalizeScroll(scroll);
    if (sameScroll(current.scroll, normalized)) {
      return { snapshot: current, changed: false };
    }
    const next = { ...current, scroll: normalized };
    this.snapshots.set(targetKey, next);
    this.emit();
    return { snapshot: next, changed: true };
  }

  retain(targetKeys: ReadonlySet<string>): void {
    let changed = false;
    for (const key of this.snapshots.keys()) {
      if (!targetKeys.has(key)) {
        this.snapshots.delete(key);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
