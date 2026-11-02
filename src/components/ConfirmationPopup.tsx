import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import type { LucideIcon } from 'lucide-react-native';
import { Modal, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { cn } from '../lib/utils';
import { useTheme } from '../theme';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  busy?: boolean;
  confirmLabel: string;
  copy: string;
  detail?: string;
  detailIcon?: LucideIcon;
  icon?: LucideIcon;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  visible: boolean;
}

export function ConfirmationPopup({
  busy = false,
  confirmLabel,
  copy,
  detail,
  detailIcon: DetailIcon,
  icon: PromptIcon = TriangleAlert,
  onCancel,
  onConfirm,
  title,
  visible,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const cancel = () => {
    if (!busy) onCancel();
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={cancel}
      statusBarTranslucent
      transparent
      visible={visible}>
      <View className="flex-1 items-center justify-center px-5">
        <Pressable
          accessibilityLabel={t('common.cancel')}
          className="absolute inset-0 bg-black/55"
          disabled={busy}
          onPress={cancel}
        />
        <GlassSurface
          accessibilityViewIsModal
          className="w-full max-w-[380px] rounded-[24px] border border-white/30 p-5 dark:border-white/10">
          <View className="flex-row items-start">
            <View className="size-11 items-center justify-center rounded-full bg-destructive/15">
              <PromptIcon color={colors.error} size={22} />
            </View>
            <View className="min-w-0 flex-1 pl-3">
              <Text className="text-[19px] font-bold leading-6">{title}</Text>
              <Text className="mt-1 text-[13px] leading-[18px] text-muted-foreground">{copy}</Text>
            </View>
          </View>

          {detail ? (
            <View className="mt-5 flex-row items-center rounded-xl border border-border bg-muted/40 px-3.5 py-3">
              {DetailIcon ? <DetailIcon color={colors.textSecondary} size={17} /> : null}
              <Text
                selectable
                className={cn('min-w-0 flex-1 font-mono text-[12px]', DetailIcon && 'ml-2.5')}
                numberOfLines={2}>
                {detail}
              </Text>
            </View>
          ) : null}

          <View className="mt-5 flex-row gap-2.5">
            <Button
              className="h-12 flex-1 rounded-full"
              disabled={busy}
              variant="secondary"
              onPress={hapticPress(cancel)}>
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="h-12 flex-1 rounded-full"
              disabled={busy}
              variant="destructive"
              onPress={hapticPress(onConfirm)}>
              <Text>{confirmLabel}</Text>
            </Button>
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}
