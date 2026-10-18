import { NativeModules, Platform } from 'react-native';

import { reportBackgroundFailure } from './backgroundOperations';

interface ComposerFontNativeModule {
  attachInput(tag: number, token: string): Promise<void>;
  detachInput(token: string): Promise<void>;
}

let bindingSequence = 0;

/** Style native text in place, keeping the IME's text and selection intact. */
export function watchComposerFont(tag: number): () => void {
  const native = NativeModules.ComposerFont as ComposerFontNativeModule | undefined;
  if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !native?.attachInput)
    return () => {};

  const token = `${tag}:${++bindingSequence}`;
  reportBackgroundFailure(native.attachInput(tag, token), 'composer-font-attach');
  return () => {
    reportBackgroundFailure(native.detachInput(token), 'composer-font-detach');
  };
}
