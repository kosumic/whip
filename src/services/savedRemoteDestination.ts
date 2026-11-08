import { NativeModules } from 'react-native';
import type { SavedRemoteDestination } from './remoteFileTransfer';

interface NativeDestinationBrowser {
  revealSavedDestination?: (savedUri: string, directoryUri: string) => Promise<void>;
}

/** Uses the system document navigator; never launches a remote path or a copy. */
export async function revealSavedRemoteDestination(destination: SavedRemoteDestination): Promise<void> {
  const browser = NativeModules.WhipBrowser as NativeDestinationBrowser | undefined;
  const reveal = browser?.revealSavedDestination;
  if (!reveal) throw new Error('System file browser is unavailable');
  await reveal(destination.entry.uri, destination.directory.uri);
}
