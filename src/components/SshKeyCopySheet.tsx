import { Copy, KeyRound } from 'lucide-react-native';
import { Modal, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { cn } from '@/src/lib/utils';
import { appGlassControlStyle, useTheme } from '@/src/theme';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { hapticPress } from './app-ui';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  visible: boolean;
  onClose: () => void;
  onCopyPrivate: () => void | Promise<void>;
  onCopyPublic: () => void | Promise<void>;
}

export function SshKeyCopySheet({ visible, onClose, onCopyPrivate, onCopyPublic }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable accessibilityLabel={t('connection.closeKeyActions')} className="absolute inset-0 bg-black/55" onPress={onClose} />
        <GlassSurface accessibilityViewIsModal className="rounded-t-[28px] border-t border-white/30 px-4 pb-8 pt-5 dark:border-white/10">
          <Text className="px-2 text-lg font-semibold">{t('connection.copySshKey')}</Text>
          <Text className="mb-3 mt-1 px-2 text-[13px] leading-[18px] text-muted-foreground">
            {t('connection.copyWhich')}
          </Text>
          <KeyCopyAction icon={Copy} label={t('connection.copyPrivate')} onPress={onCopyPrivate} />
          <KeyCopyAction icon={KeyRound} label={t('connection.copyPublic')} onPress={onCopyPublic} />
          <Button
            className={cn('mt-2 rounded-full', appGlassEnabled && 'border')}
            style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
            variant={appGlassEnabled ? 'ghost' : 'secondary'}
            onPress={hapticPress(onClose)}>
            <Text>{t('common.cancel')}</Text>
          </Button>
        </GlassSurface>
      </View>
    </Modal>
  );
}

function KeyCopyAction({ icon, label, onPress }: {
  icon: typeof KeyRound;
  label: string;
  onPress: () => void | Promise<void>;
}) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  return (
    <Button
      className={cn('h-14 justify-start rounded-xl px-3', appGlassEnabled && 'border')}
      style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
      variant="ghost"
      onPress={() => {
        const operation = onPress();
        if (operation) reportBackgroundFailure(operation, 'ssh-key-copy');
      }}>
      <Icon as={icon} size={19} />
      <Text className="text-[15px] font-medium">{label}</Text>
    </Button>
  );
}
