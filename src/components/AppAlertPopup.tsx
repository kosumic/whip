import CircleAlert from 'lucide-react-native/icons/circle-alert';
import { Modal, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../theme';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Text } from './ui/text';

export interface AppAlertContent {
  message?: string;
  title: string;
}

interface AppAlertPopupProps extends AppAlertContent {
  actionLabel?: string;
  onClose: () => void;
  visible: boolean;
}

export function AppAlertPopup({
  actionLabel,
  message,
  onClose,
  title,
  visible,
}: AppAlertPopupProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const closeLabel = actionLabel || t('common.close');

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View className="flex-1 items-center justify-center px-5">
        <Pressable
          accessibilityLabel={closeLabel}
          className="absolute inset-0 bg-black/55"
          onPress={onClose}
        />
        <GlassSurface
          accessibilityViewIsModal
          className="w-full max-w-[380px] rounded-[24px] border border-white/30 p-5 dark:border-white/10"
        >
          <View className="flex-row items-start">
            <View className="size-11 items-center justify-center rounded-full bg-destructive/15">
              <CircleAlert color={colors.error} size={22} />
            </View>
            <View className="min-w-0 flex-1 pl-3">
              <Text className="text-[19px] font-bold leading-6">{title}</Text>
              {message ? (
                <Text
                  selectable
                  className="mt-1 text-[13px] leading-[18px] text-muted-foreground"
                >
                  {message}
                </Text>
              ) : null}
            </View>
          </View>

          <View className="mt-5 flex-row justify-end">
            <Button
              className="h-12 min-w-32 rounded-full px-6"
              onPress={hapticPress(onClose)}
            >
              <Text>{closeLabel}</Text>
            </Button>
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}
