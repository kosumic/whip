import { DeviceEventEmitter, NativeEventEmitter, NativeModules, Platform } from 'react-native';

interface DownloadExecution {
  addListener(event: string): void;
  removeListeners(count: number): void;
  beginDownloadExecution(id: string, name: string): Promise<void>;
  updateDownloadExecution(id: string, status: string, transferred: number, total: number): void;
  endDownloadExecution(id: string): Promise<void>;
  bindDownloadTransfer(id: string, hostId: string, transferId: string): void;
  downloadCancellations(): Promise<string[]>;
  acknowledgeDownloadCancellation(id: string): Promise<void>;
  retainDownloadDestination(uri: string): Promise<string>;
  resolveDownloadDestination(uri: string, permission: string): Promise<string>;
  releaseDownloadDestination(id: string): Promise<void>;
  retainDownloadJobDestination(id: string, uri: string): Promise<string>;
  resolveDownloadJobDestination(id: string, uri: string, permission: string): Promise<string>;
  releaseDownloadJobDestination(id: string): Promise<void>;
}

export const downloadExecution = NativeModules.HerdrBackground as DownloadExecution;
type DownloadEvents = { WhipDownloadExpired: [event: { id: string; cancelled?: boolean }] };
export function subscribeDownloadExpiration(expire: (id: string, cancelled: boolean) => void): () => void {
  const emitter: Pick<NativeEventEmitter<DownloadEvents>, 'addListener'> = Platform.OS === 'ios'
    ? new NativeEventEmitter<DownloadEvents>(downloadExecution) : DeviceEventEmitter;
  const subscription = emitter.addListener(
    'WhipDownloadExpired', ({ id, cancelled }) => expire(id, Boolean(cancelled)),
  );
  return () => subscription.remove();
}
