import {
  incrementTerminalControlUsage,
  type TerminalControlId,
  type TerminalControlUsage,
} from '../lib/terminalControls';
import type { DevicePreferences } from './devicePreferences';

export const DEVICE_PREFERENCES_FLUSH_INTERVAL_MS = 30_000;

/** Keeps usage off the React update path and serializes preference snapshots. */
export class DevicePreferencesPersistence {
  private preferences: DevicePreferences | undefined;
  private usage: TerminalControlUsage = {};
  private dirty = false;
  private pending: DevicePreferences | undefined;
  private writing: Promise<void> | undefined;

  constructor(
    private readonly save: (preferences: DevicePreferences) => Promise<void>,
  ) {}

  get terminalControlUsage(): TerminalControlUsage {
    return this.usage;
  }

  hydrate(preferences: DevicePreferences): void {
    this.preferences = preferences;
    this.usage = preferences.terminalControlUsage;
  }

  update(preferences: DevicePreferences): void {
    this.preferences = preferences;
    this.dirty = true;
  }

  recordTerminalControlUse(control: TerminalControlId): void {
    if (!this.preferences) return;
    this.usage = incrementTerminalControlUsage(this.usage, control);
    this.dirty = true;
  }

  flush(): Promise<void> {
    if (this.preferences && this.dirty) {
      this.pending = {
        ...this.preferences,
        terminalControlUsage: this.usage,
      };
      this.dirty = false;
    }
    if (this.writing) return this.writing;
    if (!this.pending) return Promise.resolve();

    // Defer the drain so writing is set before the first save starts.
    this.writing = Promise.resolve().then(() => this.drain());
    return this.writing;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        const snapshot = this.pending;
        this.pending = undefined;
        try {
          await this.save(snapshot);
        } catch (error) {
          // Retry on the next flush, preserving any newer snapshot queued meanwhile.
          this.pending ??= snapshot;
          throw error;
        }
      }
    } finally {
      // Clear synchronously with the drain ending so a flush cannot strand work
      // between the last save settling and the returned promise settling.
      this.writing = undefined;
    }
  }
}
