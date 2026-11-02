import CircleAlert from 'lucide-react-native/icons/circle-alert';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import type { ChatAgent } from '../lib/agentChatSession';
import { useTheme } from '../theme';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Text } from './ui/text';

export interface AgentIdentityWarning {
  agent: ChatAgent;
  message: string;
  title: string;
}

interface Props {
  onClose: () => void;
  warning: AgentIdentityWarning | null;
}

export function AgentIdentityWarningSheet({ onClose, warning }: Props) {
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={warning !== null}>
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel={t('common.close')}
          className="absolute inset-0 bg-black/55"
          onPress={onClose}
        />
        <GlassSurface
          accessibilityViewIsModal
          className="rounded-t-[28px] border-t border-white/30 px-4 pt-5 dark:border-white/10"
          style={{ paddingBottom: Math.max(16, bottom) }}>
          <View className="flex-row items-start px-1">
            <View className="size-11 items-center justify-center rounded-full bg-primary/15">
              <CircleAlert color={colors.primary} size={22} />
            </View>
            <View className="min-w-0 flex-1 pl-3">
              <Text className="text-[19px] font-bold leading-6">{warning?.title}</Text>
              <Text className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
                {warning?.message}
              </Text>
            </View>
          </View>

          <Button className="mt-5 h-12 w-full rounded-full" onPress={hapticPress(onClose)}>
            <Text>{t('common.close')}</Text>
          </Button>
        </GlassSurface>
      </View>
    </Modal>
  );
}
