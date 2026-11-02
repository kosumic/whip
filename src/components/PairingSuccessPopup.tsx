import CircleCheckBig from 'lucide-react-native/icons/circle-check-big';
import Server from 'lucide-react-native/icons/server';
import { Modal, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { PairHostResult } from '../lib/sshPairing';
import { useTheme } from '../theme';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Text } from './ui/text';

interface Props {
  onClose: () => void;
  result: PairHostResult | null;
}

export function PairingSuccessPopup({ onClose, result }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const destination = result ? `${result.sshUser}@${result.sshHost}` : '';

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={result !== null}>
      <Pressable
        accessibilityLabel={t(result?.alreadyPresent ? 'pairing.alreadyPairedTitle' : 'pairing.successTitle')}
        accessibilityRole="button"
        className="flex-1 items-center justify-center bg-black/55 px-6"
        onPress={hapticPress(onClose)}>
        <GlassSurface
          accessibilityViewIsModal
          className="w-full max-w-[340px] items-center rounded-[24px] border border-white/30 px-5 py-6 dark:border-white/10">
          <View className="size-14 items-center justify-center rounded-full bg-primary/15">
            <CircleCheckBig color={colors.primary} size={28} />
          </View>
          <Text className="mt-4 text-center text-[19px] font-bold leading-6">
            {t(result?.alreadyPresent ? 'pairing.alreadyPairedTitle' : 'pairing.successTitle')}
          </Text>
          <View className="mt-3 flex-row items-center rounded-full bg-muted/50 px-3.5 py-2.5">
            <Server color={colors.textSecondary} size={15} />
            <Text className="ml-2 min-w-0 font-mono text-[12px]" numberOfLines={1}>
              {destination}
            </Text>
          </View>
        </GlassSurface>
      </Pressable>
    </Modal>
  );
}
