import type { BrowserSavedDownload } from './library';
import { BROWSER_DOWNLOAD_STATE } from './downloads';

export function isActiveDownload(entry: BrowserSavedDownload): boolean {
  return (
    entry.state === BROWSER_DOWNLOAD_STATE.active ||
    entry.state === BROWSER_DOWNLOAD_STATE.saving
  );
}

export function downloadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function downloadPresentation(entry: BrowserSavedDownload) {
  const bytes = Number(entry.bytes);
  const total = Number(entry.totalBytes);
  const saving = entry.state === BROWSER_DOWNLOAD_STATE.saving;
  const percent =
    total > 0 ? Math.min(100, Math.floor((bytes * 100) / total)) : null;
  const transferred = `${downloadSize(bytes)}${total > 0 ? ` / ${downloadSize(total)}` : ''}`;
  let status: string;
  switch (entry.state) {
    case BROWSER_DOWNLOAD_STATE.active:
      status = `${percent === null ? 'Downloading' : `${percent}%`} · ${transferred}`;
      break;
    case BROWSER_DOWNLOAD_STATE.saving:
      status = `Saving download · ${transferred}`;
      break;
    case BROWSER_DOWNLOAD_STATE.complete:
      status = `Download complete · ${downloadSize(bytes)}`;
      break;
    case BROWSER_DOWNLOAD_STATE.interrupted:
      status =
        entry.error ||
        'Download interrupted when the app stopped. Download again from the page.';
      break;
    case BROWSER_DOWNLOAD_STATE.cancelled:
      status = 'Cancelled';
      break;
    default:
      status = entry.error || 'Download failed — try again from the page';
  }
  return { status, percent: saving ? null : percent };
}
