import { Download, ExternalLink } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { APP_FROSTED_GLASS_SURFACE_PROPS } from '../lib/appGlass';
import { HERDR_WEBSITE_URL } from '../lib/herdr';
import { useTheme } from '../theme';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  visible: boolean;
  host: string;
  command: string;
  onClose: () => void;
  onInstall: () => void;
}

export function HerdrInstallPopup({ visible, host, command, onClose, onInstall }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [linkError, setLinkError] = useState<string | null>(null);

  return (
    <Modal animationType="fade" transparent statusBarTranslucent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center px-5 py-12">
        <Pressable accessibilityLabel={t('common.close')} className="absolute inset-0 bg-black/55" onPress={onClose} />
        <GlassSurface
          {...APP_FROSTED_GLASS_SURFACE_PROPS}
          accessibilityViewIsModal
          className="w-full max-w-[440px] rounded-[24px] border border-white/30 p-5 dark:border-white/10"
          style={{ maxHeight: '100%' }}
        >
          <View className="flex-row items-center gap-3">
            <Icon as={Download} size={22} color={colors.primary} />
            <Text className="min-w-0 flex-1 text-[19px] font-bold leading-6">{t('herd.installConfirmTitle')}</Text>
          </View>
          <Text className="mt-2 text-sm text-muted-foreground">{t('herd.installConfirmCopy', { host })}</Text>
          <ScrollView className="mt-4 shrink" contentContainerStyle={{ gap: 12 }}>
            <Text className="text-xs font-semibold text-muted-foreground">{t('herd.installCommand')}</Text>
            <Text selectable className="rounded-xl border border-border bg-muted/40 p-3 font-mono text-xs leading-5">{command}</Text>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t('herd.herdrWebsite')}
              className="min-h-11 flex-row items-center gap-2"
              onPress={hapticPress(() => {
                Linking.openURL(HERDR_WEBSITE_URL).catch(error => setLinkError(String(error)));
              })}
            >
              <Icon as={ExternalLink} size={16} color={colors.primary} />
              <Text className="text-primary underline">{HERDR_WEBSITE_URL}</Text>
            </Pressable>
            {linkError ? <Text className="text-sm text-destructive">{linkError}</Text> : null}
          </ScrollView>
          <View className="mt-5 flex-row gap-2.5">
            <Button className="min-h-12 flex-1 rounded-full" variant="secondary" onPress={hapticPress(onClose)}>
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button className="min-h-12 flex-1 rounded-full" onPress={hapticPress(onInstall)}>
              <Text>{t('herd.installHerdr')}</Text>
            </Button>
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}
