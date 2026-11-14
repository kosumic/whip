import type { ComponentType } from 'react';

/** Load screen code on first render, synchronously so its first frame is complete. */
function deferredScreen<Props extends object>(load: () => ComponentType<Props>) {
  return function DeferredScreen(props: Props) {
    const Screen = load();
    return <Screen {...props} />;
  };
}

export const HerdScreen = deferredScreen(() =>
  (require('./HerdScreen') as typeof import('./HerdScreen')).HerdScreen);
export const LiveSessionView = deferredScreen(() =>
  (require('./LiveSessionView') as typeof import('./LiveSessionView')).LiveSessionView);
export const MoreScreen = deferredScreen(() =>
  (require('./MoreScreen') as typeof import('./MoreScreen')).MoreScreen);
export const ConnectionScreen = deferredScreen(() =>
  (require('./ConnectionScreen') as typeof import('./ConnectionScreen')).ConnectionScreen);
export const GlobalKeychainScreen = deferredScreen(() =>
  (require('./GlobalKeychainScreen') as typeof import('./GlobalKeychainScreen')).GlobalKeychainScreen);
export const KnownHostsScreen = deferredScreen(() =>
  (require('./KnownHostsScreen') as typeof import('./KnownHostsScreen')).KnownHostsScreen);
export const LicensesScreen = deferredScreen(() =>
  (require('./LicensesScreen') as typeof import('./LicensesScreen')).LicensesScreen);
export const NewHostScreen = deferredScreen(() =>
  (require('./NewHostScreen') as typeof import('./NewHostScreen')).NewHostScreen);
export const RemoteFileManager = deferredScreen(() =>
  (require('./RemoteFileManager') as typeof import('./RemoteFileManager')).RemoteFileManager);
export const VoiceChatScreen = deferredScreen(() =>
  (require('./VoiceChatScreen') as typeof import('./VoiceChatScreen')).VoiceChatScreen);
