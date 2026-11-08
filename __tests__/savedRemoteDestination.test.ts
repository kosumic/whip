import { NativeModules } from 'react-native';
import { revealSavedRemoteDestination } from '../src/services/savedRemoteDestination';
import type { SavedRemoteDestination } from '../src/services/remoteFileTransfer';

const reveal = jest.fn();
beforeEach(() => {
  reveal.mockReset().mockResolvedValue(undefined);
  NativeModules.WhipBrowser = { revealSavedDestination: reveal };
});

it.each([
  ['content://provider/tree/opaque/document/child', 'content://provider/tree/opaque'],
  ['file:///picked/saved%20file.txt', 'file:///picked'],
])('passes the saved document and its picked folder to system navigation (%s)', async (entry, directory) => {
  const destination = { entry: { uri: entry }, directory: { uri: directory } } as SavedRemoteDestination;
  await revealSavedRemoteDestination(destination);
  expect(reveal).toHaveBeenCalledWith(entry, directory);
});

it('reports missing native navigation and propagates provider/launch failures', async () => {
  const destination = { entry: { uri: 'file:///saved' }, directory: { uri: 'file:///' } } as SavedRemoteDestination;
  reveal.mockRejectedValueOnce(new Error('Missing file or unavailable file browser'));
  await expect(revealSavedRemoteDestination(destination)).rejects.toThrow('Missing file');
  delete NativeModules.WhipBrowser;
  await expect(revealSavedRemoteDestination(destination)).rejects.toThrow('unavailable');
});
