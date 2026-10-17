import { browserLibrary } from './library';
import { browserDownloadUpdates, removeSavedBrowserDownload } from './native';

export const BROWSER_DOWNLOAD_POLL_MS = 500;
export const BROWSER_DOWNLOAD_LINK = 'whip://browser-downloads';
export const BROWSER_DOWNLOAD_NOTIFICATION_KEY = 'browserDownloadId';
export const BROWSER_DOWNLOAD_STATE = {
  active: 'downloading',
  complete: 'complete',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
} as const;

/** Native owns I/O; Rust owns the validated, persistent download index. */
export class BrowserDownloadMonitor {
  private seen = new Map<string, string>();
  private removed = new Set<string>();
  private polling: Promise<void> | null = null;
  constructor(
    private library = browserLibrary,
    private updates = browserDownloadUpdates,
    private removeNative = removeSavedBrowserDownload,
  ) {}
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.read().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }
  private async read() {
    await this.library.load();
    const updates: unknown = JSON.parse(await this.updates());
    if (!Array.isArray(updates)) throw new Error('Invalid download status');
    for (const entry of updates as unknown[]) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('id' in entry) ||
        typeof entry.id !== 'string' ||
        this.removed.has(entry.id)
      )
        continue;
      const json = JSON.stringify(entry);
      if (this.seen.get(entry.id) === json) continue;
      await this.library.recordDownload(json);
      this.seen.set(entry.id, json);
    }
  }
  async remove(id: string) {
    this.removed.add(id);
    try {
      await this.removeNative(id);
      await Promise.allSettled(this.polling ? [this.polling] : []);
      await this.library.removeDownload(id);
      this.seen.delete(id);
    } catch (error) {
      this.removed.delete(id);
      throw error;
    }
  }
}
export const browserDownloads = new BrowserDownloadMonitor();
