import Clipboard from '@react-native-clipboard/clipboard';
import { encode, toSvg } from '@verevoir/qr';
import Copy from 'lucide-react-native/icons/copy';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SvgXml } from 'react-native-svg';
import { LocalSvg } from 'react-native-svg/css';

import { bundledAsset } from '../lib/bundledAsset';
import { hapticPress } from './app-ui';
import { GlassButton } from './GlassControls';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

const TIP_JAR_DESTINATIONS = [
  {
    token: 'USDC',
    icon: bundledAsset(require('../../assets/brand/usdc.svg')),
    network: 'Base',
    address: '0x5424bcf743D265BA8Ac4ACdE0d0A5DfC187eeB05',
  },
  {
    token: 'USDT',
    icon: bundledAsset(require('../../assets/brand/usdt.svg')),
    network: 'Solana',
    address: '59Nqb3jEvexJV7HAwHJDMrqnipaxhN7VJbJe7C7pz7uV',
  },
] as const;
type TipJarDestination = (typeof TIP_JAR_DESTINATIONS)[number];

export function CryptoTipJarContents() {
  const { t } = useTranslation();
  const [destination, setDestination] = useState<TipJarDestination>(
    TIP_JAR_DESTINATIONS[0],
  );
  const [copyResult, setCopyResult] = useState<'copied' | 'error' | null>(null);
  // Encode only the recipient so wallets can scan it when composing a token send.
  const qr = useMemo(
    () =>
      toSvg(encode(destination.address)[0], {
        style: 'square',
        cornerStyle: 'square',
        color: { background: '#ffffff' },
      }),
    [destination.address],
  );
  const copyAddress = () => {
    try {
      Clipboard.setString(destination.address);
      setCopyResult('copied');
    } catch {
      setCopyResult('error');
    }
  };

  return (
    <>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t('tipJar.selectAsset')}
        className="flex-row gap-2"
      >
        {TIP_JAR_DESTINATIONS.map(option => (
          <GlassButton
            key={option.token}
            accessibilityRole="radio"
            accessibilityLabel={t('tipJar.cryptoAsset', option)}
            accessibilityState={{ checked: destination.token === option.token }}
            className="min-h-16 flex-1 px-2 py-2"
            size="content"
            variant={destination.token === option.token ? 'default' : 'outline'}
            onPress={hapticPress(() => {
              setDestination(option);
              setCopyResult(null);
            })}
          >
            <LocalSvg
              accessible={false}
              asset={option.icon}
              width={32}
              height={32}
            />
            <View className="items-center">
              <Text className="text-sm font-semibold">{option.token}</Text>
              <Text className="text-xs opacity-70">{option.network}</Text>
            </View>
          </GlassButton>
        ))}
      </View>
      <Text className="mt-4 text-base font-semibold">
        {t('tipJar.cryptoAsset', destination)}
      </Text>
      <Text className="mt-2 text-sm leading-5 text-muted-foreground">
        {t('tipJar.cryptoInstructions', destination)}
      </Text>
      <View className="my-4 aspect-square w-full max-w-[240px] self-center overflow-hidden rounded-xl bg-white p-1">
        <SvgXml
          accessibilityLabel={t('tipJar.addressQr')}
          accessibilityRole="image"
          xml={qr}
          width="100%"
          height="100%"
        />
      </View>
      <View className="flex-row items-center gap-2 rounded-2xl border border-border p-3">
        <Text
          selectable
          className="min-w-0 flex-1 text-sm font-medium leading-6"
        >
          {destination.address}
        </Text>
        <GlassButton
          accessibilityLabel={t('tipJar.copyAddress')}
          className="shrink-0 rounded-lg"
          size="icon"
          variant="ghost"
          onPress={hapticPress(copyAddress)}
        >
          <Icon as={Copy} className="text-muted-foreground" size={22} />
        </GlassButton>
      </View>
      {copyResult ? (
        <Text
          accessibilityLiveRegion="polite"
          className={
            copyResult === 'error'
              ? 'mt-3 text-sm leading-5 text-destructive'
              : 'mt-3 text-sm leading-5 text-muted-foreground'
          }
        >
          {t(
            copyResult === 'copied'
              ? 'tipJar.addressCopied'
              : 'tipJar.copyError',
          )}
        </Text>
      ) : null}
    </>
  );
}
