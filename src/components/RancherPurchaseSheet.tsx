import { useState } from 'react';
import { Check, RefreshCcw, X } from 'lucide-react-native';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import type { WhipEntitlementsController } from '../billing/useWhipEntitlements';
import { bundledAsset } from '../lib/bundledAsset';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

type PurchaseAction = 'purchase' | 'restore';

const TIER_ART = {
  cowboy: bundledAsset(require('../../assets/cowboy.png')),
  rancher: bundledAsset(require('../../assets/rancher.png')),
} as const;

const COWBOY_FEATURE_KEYS = [
  'membership.cowboyFeatureCore',
  'membership.cowboyFeaturePrivate',
  'membership.cowboyFeatureOpenSource',
] as const;

const RANCHER_FEATURE_KEYS = [
  'membership.benefitEverythingCowboy',
  'settings.fullscreenApp',
  'settings.fullscreenTerminal',
  'membership.benefitAppBackgroundSettings',
  'membership.benefitTerminalBackgroundSettings',
  'membership.benefitGlass',
  'membership.benefitRancherAvatar',
] as const;

interface Props {
  entitlements: WhipEntitlementsController;
  onClose: () => void;
  visible: boolean;
}

function TierFeature({ children }: { children: string }) {
  return (
    <View className="flex-row items-start gap-1.5">
      <Icon as={Check} className="mt-0.5 shrink-0 text-primary" size={13} />
      <Text className="min-w-0 flex-1 text-[11px] leading-4 text-muted-foreground">
        {children}
      </Text>
    </View>
  );
}

export function RancherPurchaseSheet({ entitlements, onClose, visible }: Props) {
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const [busy, setBusy] = useState<PurchaseAction | null>(null);
  const rancherPrice = entitlements.localizedLifetimePrice ?? '$29.99';

  const purchase = async () => {
    setBusy('purchase');
    try {
      const result = await entitlements.purchaseRancher();
      if (result !== 'cancelled') onClose();
    } catch (error) {
      Alert.alert(t('membership.errorTitle'), String(error));
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy('restore');
    try {
      await entitlements.restorePurchases();
      onClose();
    } catch (error) {
      Alert.alert(t('membership.errorTitle'), String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={busy === null ? onClose : undefined}
      statusBarTranslucent
      transparent
      visible={visible}>
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel={t('common.close')}
          className="absolute inset-0 bg-black/60"
          disabled={busy !== null}
          onPress={onClose}
        />
        <GlassSurface
          accessibilityViewIsModal
          className="max-h-[92%] rounded-t-[28px] border-t border-white/30 dark:border-white/10"
          style={{ paddingBottom: Math.max(12, bottom) }}>
          <ScrollView
            bounces={false}
            contentContainerClassName="px-4 pb-2 pt-4"
            showsVerticalScrollIndicator={false}>
            <View className="flex-row items-start">
              <View className="size-[72px] overflow-hidden rounded-2xl border border-primary/40 bg-black">
                <Image
                  accessibilityLabel={t('membership.rancherAvatar')}
                  className="size-full"
                  resizeMode="cover"
                  source={TIER_ART.rancher}
                />
              </View>
              <View className="min-w-0 flex-1 pl-3 pt-1">
                <Text className="text-[22px] font-bold leading-7">
                  {t('membership.compareTiers')}
                </Text>
                <Text className="mt-1 text-[13px] leading-[18px] text-muted-foreground">
                  {t('membership.compareTiersCopy')}
                </Text>
              </View>
              <Button
                accessibilityLabel={t('common.close')}
                className="-mr-2 -mt-2 rounded-full"
                disabled={busy !== null}
                onPress={hapticPress(onClose)}
                size="icon"
                variant="ghost">
                <Icon as={X} size={20} />
              </Button>
            </View>

            <View className="mt-5 flex-row items-stretch gap-2.5">
              <View className="min-w-0 flex-1 rounded-2xl border border-border bg-background/70 p-3">
                <Image
                  accessibilityLabel={t('membership.cowboyAvatar')}
                  className="size-12 rounded-xl bg-black"
                  resizeMode="cover"
                  source={TIER_ART.cowboy}
                />
                <Text className="mt-3 text-base font-bold">
                  {t('membership.cowboy')}
                </Text>
                <Text className="mt-0.5 text-lg font-bold">$0</Text>
                <Text className="text-[11px] font-semibold text-muted-foreground">
                  {t('membership.freeForever')}
                </Text>
                <View className="mt-4 gap-2.5">
                  {COWBOY_FEATURE_KEYS.map(key => (
                    <TierFeature key={key}>{t(key)}</TierFeature>
                  ))}
                </View>
              </View>

              <View className="min-w-0 flex-1 rounded-2xl border-2 border-primary bg-primary/10 p-3">
                <Image
                  accessibilityLabel={t('membership.rancherAvatar')}
                  className="size-12 rounded-xl bg-black"
                  resizeMode="cover"
                  source={TIER_ART.rancher}
                />
                <Text className="mt-3 text-base font-bold">
                  {t('membership.rancher')}
                </Text>
                <Text className="mt-0.5 text-lg font-bold text-primary">
                  {rancherPrice}
                </Text>
                <Text className="text-[11px] font-semibold text-primary">
                  {t('membership.oneTimeLifetime')}
                </Text>
                <View className="mt-4 gap-2.5">
                  {RANCHER_FEATURE_KEYS.map(key => (
                    <TierFeature key={key}>{t(key)}</TierFeature>
                  ))}
                </View>
              </View>
            </View>

            <View className="mt-4 rounded-2xl bg-muted/55 px-4 py-3.5">
              <Text className="text-xs font-bold uppercase tracking-wider text-primary">
                {t('membership.developerNoteTitle')}
              </Text>
              <Text className="mt-1.5 text-[13px] leading-[19px] text-muted-foreground">
                {t('membership.developerNote')}
              </Text>
            </View>

            {!entitlements.isLoading && !entitlements.purchasesAvailable ? (
              <Text className="mt-3 text-center text-xs leading-4 text-muted-foreground">
                {t(
                  entitlements.distributionChannel === 'github'
                    ? 'membership.webUnavailable'
                    : 'membership.purchasesUnavailable',
                )}
              </Text>
            ) : null}

            <Button
              accessibilityState={{
                busy: busy === 'purchase',
                disabled:
                  busy !== null ||
                  entitlements.isLoading ||
                  !entitlements.purchasesAvailable,
              }}
              className="mt-4 h-12 w-full rounded-full"
              disabled={
                busy !== null ||
                entitlements.isLoading ||
                !entitlements.purchasesAvailable
              }
              onPress={hapticPress(() => {
                void purchase();
              })}>
              {busy === 'purchase' ? <ActivityIndicator color="currentColor" /> : null}
              <Text>
                {t(
                  entitlements.isTrialActive
                    ? 'membership.keepRancher'
                    : 'membership.unlockRancher',
                )}
              </Text>
            </Button>

            {entitlements.canRestore && !entitlements.hasLifetimeAccess ? (
              <Button
                accessibilityState={{
                  busy: busy === 'restore',
                  disabled: busy !== null,
                }}
                className="mt-1 w-full rounded-full"
                disabled={busy !== null}
                onPress={hapticPress(() => {
                  void restore();
                })}
                variant="ghost">
                {busy === 'restore' ? (
                  <ActivityIndicator color="currentColor" />
                ) : (
                  <Icon as={RefreshCcw} size={16} />
                )}
                <Text>{t('membership.restore')}</Text>
              </Button>
            ) : null}
          </ScrollView>
        </GlassSurface>
      </View>
    </Modal>
  );
}
