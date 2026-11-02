import { ActivityIndicator, Modal, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme';
import { GlassSurface } from './GlassSurface';
import { GitHubMark } from './GitHubMark';
import { Button } from './ui/button';
import { Text } from './ui/text';

export function GithubDiscoveryPopup({ visible, message, busy, onRetry, onClose }: {
  visible: boolean;
  message: string;
  busy: boolean;
  onRetry?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <Modal animationType="fade" transparent statusBarTranslucent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center px-5">
        <Pressable accessibilityLabel={t('common.close')} className="absolute inset-0 bg-black/55" onPress={onClose} />
        <GlassSurface accessibilityViewIsModal className="w-full max-w-[380px] rounded-[24px] border border-white/30 p-5 dark:border-white/10">
          <View className="flex-row items-center gap-3">
            <GitHubMark size={22} />
            <Text className="text-[19px] font-bold">{t('github.discovery.title')}</Text>
          </View>
          <Text selectable accessibilityLiveRegion="polite" className="mt-3 text-[13px] leading-[18px] text-muted-foreground">{message}</Text>
          <View className="mt-5 flex-row justify-end gap-2.5">
            <Button variant="secondary" onPress={onClose}><Text>{t('common.close')}</Text></Button>
            {onRetry && <Button disabled={busy} onPress={onRetry}>
              {busy && <ActivityIndicator size="small" color={colors.text} />}
              <Text>{t('github.discovery.retry')}</Text>
            </Button>}
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}
