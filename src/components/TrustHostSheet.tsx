import Fingerprint from 'lucide-react-native/icons/fingerprint-pattern';
import Server from 'lucide-react-native/icons/server';
import ShieldCheck from 'lucide-react-native/icons/shield-check';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import type { UnknownHostKeyChallenge } from '../services/knownHosts';
import { useTheme } from '../theme';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  challenge: UnknownHostKeyChallenge | null;
  onCancel: () => void;
  onTrust: () => void;
}

export function TrustHostSheet({ challenge, onCancel, onTrust }: Props) {
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const displayHost = challenge?.port === 22
    ? challenge.host
    : `[${challenge?.host}]:${challenge?.port}`;

  return (
    <Modal
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
      transparent
      visible={challenge !== null}>
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel={t('common.cancel')}
          className="absolute inset-0 bg-black/55"
          onPress={onCancel}
        />
        <GlassSurface
          accessibilityViewIsModal
          className="rounded-t-[28px] border-t border-white/30 px-4 pt-5 dark:border-white/10"
          style={{ paddingBottom: Math.max(16, bottom) }}>
          <View className="flex-row items-start px-1">
            <View className="size-11 items-center justify-center rounded-full bg-primary/15">
              <ShieldCheck color={colors.primary} size={22} />
            </View>
            <View className="min-w-0 flex-1 pl-3">
              <Text className="text-[19px] font-bold leading-6">{t('knownHosts.trustTitle')}</Text>
              <Text className="mt-1 text-[13px] leading-[18px] text-muted-foreground">
                {t('knownHosts.trustCopy', { host: displayHost })}
              </Text>
            </View>
          </View>

          <View className="mt-5 overflow-hidden rounded-xl border border-border bg-muted/40">
            <TrustDetail icon={Server} label={t('knownHosts.hostLabel')} value={displayHost} />
            <TrustDetail
              divided
              icon={ShieldCheck}
              label={t('knownHosts.keyTypeLabel')}
              value={challenge?.keyType || ''}
            />
            <View className="border-t border-border px-3.5 py-3">
              <View className="flex-row items-center gap-2">
                <Fingerprint color={colors.textSecondary} size={16} />
                <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('knownHosts.fingerprintLabel')}
                </Text>
              </View>
              <Text selectable className="mt-2 font-mono text-[12px] leading-5">
                {challenge?.fingerprint || ''}
              </Text>
            </View>
          </View>

          <View className="mt-3 flex-row items-start rounded-xl bg-primary/10 px-3.5 py-3">
            <TriangleAlert color={colors.primary} size={17} />
            <Text className="min-w-0 flex-1 pl-2.5 text-[12px] leading-[17px] text-muted-foreground">
              {t('knownHosts.verifyCopy')}
            </Text>
          </View>

          <View className="mt-5 flex-row gap-2.5">
            <Button className="h-12 flex-1 rounded-full" variant="secondary" onPress={hapticPress(onCancel)}>
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button className="h-12 flex-1 rounded-full" onPress={hapticPress(onTrust)}>
              <Text>{t('knownHosts.trust')}</Text>
            </Button>
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}

function TrustDetail({ divided = false, icon: DetailIcon, label, value }: {
  divided?: boolean;
  icon: typeof Server;
  label: string;
  value: string;
}) {
  const { colors } = useTheme();
  return (
    <View className={`flex-row items-center px-3.5 py-3 ${divided ? 'border-t border-border' : ''}`}>
      <DetailIcon color={colors.textSecondary} size={16} />
      <Text className="ml-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</Text>
      <Text className="ml-3 min-w-0 flex-1 text-right font-mono text-[12px]" numberOfLines={1}>{value}</Text>
    </View>
  );
}
