import {
  DeviceEventEmitter,
  NativeEventEmitter,
  NativeModules,
  Platform,
} from 'react-native';
import type { HostRuntimeConnection } from 'react-native-whip-ssh';

import {
  discardClipboardAttachment,
  stageClipboardAttachment,
  type ClipboardAttachmentResult,
  type LocalAttachment,
} from './attachmentPaste';
import { reportBackgroundFailure } from './backgroundOperations';

const COMPOSER_IMAGE_PASTE_EVENT = 'WhipComposerImagePaste';
let bindingSequence = 0;

interface ComposerPasteNativeModule {
  attachInput(tag: number, token: string): Promise<void>;
  detachInput(token: string): Promise<void>;
  takePasteAttachment(token: string, uri: string): Promise<boolean>;
  addListener(event: string): void;
  removeListeners(count: number): void;
}

interface ComposerImagePasteEvent {
  token: string;
  attachment?: ClipboardAttachmentResult;
  error?: string;
}

export function watchComposerImagePaste(
  tag: number,
  onPaste: (attachment: ClipboardAttachmentResult) => void,
  onError: (error: Error) => void,
): () => void {
  const native = NativeModules.ClipboardAttachment as
    ComposerPasteNativeModule | undefined;
  if (
    (Platform.OS !== 'ios' && Platform.OS !== 'android') ||
    !native?.attachInput
  )
    return () => {};
  const token = `${tag}:${++bindingSequence}`;
  let live = true;
  const emitter =
    Platform.OS === 'ios' ? new NativeEventEmitter(native) : DeviceEventEmitter;
  const subscription = emitter.addListener(
    COMPOSER_IMAGE_PASTE_EVENT,
    (event: ComposerImagePasteEvent) => {
      if (event.token !== token) return;
      if (event.error) {
        if (live) onError(new Error(event.error));
        return;
      }
      const attachment = event.attachment;
      if (!attachment) return;
      reportBackgroundFailure(
        (async () => {
          // Acknowledging ownership prevents native teardown from deleting a file
          // while its upload is being staged. Unclaimed events are cleaned natively.
          if (!(await native.takePasteAttachment(token, attachment.uri)))
            return;
          if (!live) {
            discardClipboardAttachment(attachment);
            return;
          }
          try {
            onPaste(attachment);
          } catch (error) {
            discardClipboardAttachment(attachment);
            onError(error instanceof Error ? error : new Error(String(error)));
          }
        })().catch(error => {
          if (live)
            onError(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }),
        'composer-image-paste',
      );
    },
  );
  reportBackgroundFailure(
    native.attachInput(tag, token).catch(error => {
      if (live)
        onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }),
    'composer-image-paste-attach',
  );
  return () => {
    live = false;
    subscription.remove();
    reportBackgroundFailure(
      native.detachInput(token),
      'composer-image-paste-detach',
    );
  };
}

export interface UploadedComposerAttachment {
  remotePath: string;
  previewUri: string | null;
  dispose: () => void;
}

/** Captures one runtime, so later focus changes cannot reroute an upload. */
export function uploadPastedComposerImage(
  runtime: Pick<
    HostRuntimeConnection,
    'startAttachmentUpload' | 'cancelTransfer'
  >,
  picked: ClipboardAttachmentResult,
): { result: Promise<UploadedComposerAttachment | null>; cancel: () => void } {
  let cancelled = false;
  let transferId: string | null = null;
  const result = (async () => {
    let local: LocalAttachment | null = null;
    try {
      local = await stageClipboardAttachment(picked);
      if (cancelled) return null;
      const transfer = runtime.startAttachmentUpload(local.nativePath);
      transferId = transfer.id;
      const uploaded = await transfer.result;
      transferId = null;
      if (cancelled) return null;
      if (!uploaded.remotePath)
        throw new Error('Native attachment upload returned no remote path');
      const attachment = {
        remotePath: uploaded.remotePath,
        previewUri: local.previewUri,
        dispose: local.dispose,
      };
      local = null;
      return attachment;
    } catch (error) {
      if (cancelled) return null;
      throw error;
    } finally {
      transferId = null;
      local?.dispose();
    }
  })();
  return {
    result,
    cancel: () => {
      cancelled = true;
      if (transferId) runtime.cancelTransfer(transferId);
    },
  };
}
