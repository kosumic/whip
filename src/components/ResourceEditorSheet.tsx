import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/src/theme';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  busy?: boolean;
  children: ReactNode;
  context?: string;
  icon: LucideIcon;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  saveLabel?: string;
  title: string;
  visible: boolean;
}

export function ResourceEditorSheet({
  busy = false,
  children,
  context,
  icon: EditorIcon,
  onClose,
  onSave,
  saveLabel,
  title,
  visible,
}: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
      statusBarTranslucent
      transparent
      visible={visible}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-center px-4">
        <Pressable
          accessibilityLabel={t('common.cancel')}
          className="absolute inset-0 bg-black/55"
          disabled={busy}
          onPress={onClose}
        />
        <GlassSurface
          accessibilityViewIsModal
          className="w-full self-center rounded-[28px] border border-white/30 px-4 py-5 dark:border-white/10">
          <View className="flex-row items-center px-1">
            <View className="size-11 items-center justify-center rounded-full bg-primary/15">
              <EditorIcon color={colors.primary} size={22} />
            </View>
            <View className="min-w-0 flex-1 pl-3">
              <Text className="text-[19px] font-bold leading-6">{title}</Text>
              {context ? (
                <Text
                  className="mt-1 font-mono text-[12px] leading-[17px] text-muted-foreground"
                  numberOfLines={1}>
                  {context}
                </Text>
              ) : null}
            </View>
          </View>

          <View className="mt-5 gap-4">{children}</View>

          <View className="mt-6 flex-row gap-2.5">
            <Button
              className="h-12 flex-1 rounded-full"
              disabled={busy}
              variant="secondary"
              onPress={hapticPress(onClose)}>
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="h-12 flex-1 rounded-full"
              disabled={busy}
              onPress={hapticPress(onSave)}>
              {busy ? <ActivityIndicator color={colors.onPrimary} size="small" /> : null}
              <Text>{saveLabel || t('common.save')}</Text>
            </Button>
          </View>
        </GlassSurface>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function ResourceEditorField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View>
      <Text className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">{label}</Text>
      {children}
    </View>
  );
}
