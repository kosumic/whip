import type { HostRuntimeConnection } from 'react-native-whip-ssh';
import { Camera, Clipboard, FileUp, Image as ImageIcon, Paperclip, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { reportBackgroundFailure } from '../services/backgroundOperations';

import { errorCode } from '../lib/connectionErrors';
import type { AttachmentSource } from '../services/attachmentPaste';
import {
  hasClipboardAttachment,
  pickLocalAttachment,
} from '../services/attachmentPaste';
import type { HerdrClient } from '../services/HerdrClient';
import { useTheme } from '../theme';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  client: HerdrClient;
  visible: boolean;
  onClose: () => void;
  onPaste: (attachment: PastedAttachment) => void;
}

export interface PastedAttachment {
  remotePath: string;
  previewUri: string | null;
  dispose: () => void;
}

interface SelectionOperation {
  cancelled: boolean;
  transferId: string | null;
  runtime: Pick<HostRuntimeConnection, 'cancelTransfer' | 'startAttachmentUpload'>;
}

type UploadState = 'idle' | 'uploading' | 'cancelling';

export function AttachmentPasteSheet({ client, visible, onClose, onPaste }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const safeAreaInsets = useSafeAreaInsets();
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [clipboardAvailable, setClipboardAvailable] = useState(false);
  const activeOperation = useRef<SelectionOperation | null>(null);
  const mounted = useRef(true);

  const cancelActiveOperation = useCallback((close: boolean) => {
    const operation = activeOperation.current;
    if (operation && !operation.cancelled) {
      operation.cancelled = true;
      if (operation.transferId) operation.runtime.cancelTransfer(operation.transferId);
      if (mounted.current) setUploadState('cancelling');
    }
    if (close) onClose();
  }, [onClose]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const operation = activeOperation.current;
      if (operation && !operation.cancelled) {
        operation.cancelled = true;
        if (operation.transferId) operation.runtime.cancelTransfer(operation.transferId);
      }
    };
  }, []);

  useEffect(() => {
    if (!visible) cancelActiveOperation(false);
  }, [cancelActiveOperation, visible]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setClipboardAvailable(false);
    reportBackgroundFailure(
      hasClipboardAttachment().then(value => {
        if (active) setClipboardAvailable(value);
      }),
      'clipboard-attachment-inspection',
    );
    return () => { active = false; };
  }, [visible]);

  const select = async (source: AttachmentSource) => {
    if (activeOperation.current) return;
    const operation: SelectionOperation = {
      cancelled: false,
      transferId: null,
      runtime: client.native,
    };
    activeOperation.current = operation;
    setUploadState('uploading');
    let attachment: Awaited<ReturnType<typeof pickLocalAttachment>> = null;
    try {
      attachment = await pickLocalAttachment(source);
      if (!attachment && source === 'clipboard' && mounted.current
        && activeOperation.current === operation) setClipboardAvailable(false);
      if (!attachment || operation.cancelled || activeOperation.current !== operation) return;
      const transfer = operation.runtime.startAttachmentUpload(attachment.nativePath);
      operation.transferId = transfer.id;
      if (operation.cancelled) operation.runtime.cancelTransfer(transfer.id);
      const result = await transfer.result;
      operation.transferId = null;
      const remotePath = result.remotePath;
      if (!remotePath) throw new Error('Native attachment upload returned no remote path');
      if (operation.cancelled || activeOperation.current !== operation) return;
      activeOperation.current = null;
      if (mounted.current) setUploadState('idle');
      onPaste({
        remotePath,
        previewUri: attachment.previewUri,
        dispose: attachment.dispose,
      });
      attachment = null;
      onClose();
    } catch (reason) {
      operation.transferId = null;
      if (
        !operation.cancelled
        && activeOperation.current === operation
        && errorCode(reason) !== 'TRANSFER_CANCELLED'
      ) {
        Alert.alert(t('attachments.failedTitle'), String(reason));
      }
    } finally {
      attachment?.dispose();
      if (activeOperation.current === operation) {
        activeOperation.current = null;
        if (mounted.current) setUploadState('idle');
      }
    }
  };

  const busy = uploadState !== 'idle';
  const close = () => cancelActiveOperation(true);

  return (
    <Modal
      animationType="fade"
      onRequestClose={close}
      statusBarTranslucent
      transparent
      visible={visible}>
      <View className="flex-1 justify-end bg-black/50">
        <Pressable accessibilityLabel={busy ? t('attachments.cancel') : t('attachments.close')} className="flex-1" onPress={close} />
        <View className="rounded-t-3xl bg-background px-4 pt-3" style={{ paddingBottom: Math.max(16, safeAreaInsets.bottom) }}>
          <View className="mb-2 flex-row items-center">
            <View className="size-10 items-center justify-center rounded-full bg-muted">
              <Paperclip size={18} color={colors.text} />
            </View>
            <View className="min-w-0 flex-1 px-3">
              <Text className="text-[17px] font-bold text-foreground">{t('attachments.title')}</Text>
              <Text className="text-[11px] text-muted-foreground">{t('attachments.copy')}</Text>
            </View>
            <Button accessibilityLabel={busy ? t('attachments.cancel') : t('attachments.close')} className="size-10 rounded-full px-0" variant="ghost" onPress={close}>
              <X size={19} color={colors.text} />
            </Button>
          </View>
          {busy ? (
            <View className="h-44 items-center justify-center gap-3">
              <ActivityIndicator color={colors.primary} />
              <Text className="text-[12px] text-muted-foreground">
                {t(uploadState === 'cancelling' ? 'attachments.cancelling' : 'attachments.uploading')}
              </Text>
              <Button
                accessibilityLabel={t('attachments.cancel')}
                className="mt-1 min-w-40"
                disabled={uploadState === 'cancelling'}
                variant="outline"
                onPress={() => cancelActiveOperation(false)}>
                <Text>{t('attachments.cancel')}</Text>
              </Button>
            </View>
          ) : (
            <View>
              <AttachmentAction icon={<Camera size={19} color={colors.text} />} label={t('attachments.camera')} onPress={() => select('camera')} />
              <AttachmentAction icon={<ImageIcon size={19} color={colors.text} />} label={t('attachments.photo')} onPress={() => select('photo')} />
              <AttachmentAction icon={<FileUp size={19} color={colors.text} />} label={t('attachments.file')} onPress={() => select('file')} />
              {clipboardAvailable && (
                <AttachmentAction icon={<Clipboard size={19} color={colors.text} />} label={t('attachments.clipboard')} onPress={() => select('clipboard')} />
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

function AttachmentAction({ icon, label, onPress }: { icon: ReactNode; label: string; onPress: () => void }) {
  return (
    <Button className="h-12 justify-start gap-3 rounded-none border-t border-border px-2" variant="ghost" onPress={hapticPress(onPress)}>
      <View className="size-8 items-center justify-center">{icon}</View>
      <Text className="text-[13px] font-semibold text-foreground">{label}</Text>
    </Button>
  );
}
