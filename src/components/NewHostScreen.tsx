import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { ChevronLeft, ChevronRight, ExternalLink, Keyboard, ScanLine, X } from 'lucide-react-native';
import { generateKeyPair, getKeyDetails } from 'react-native-whip-ssh';
import { useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  isWhipPairingCode,
  publicKeyVerificationCode,
  type PairHostResult,
  type PairingKeySelection,
} from '@/src/lib/sshPairing';
import { cn } from '@/src/lib/utils';
import { pairHostWithRoute } from '@/src/services/sshPairing';
import type { UnknownHostKeyChallenge } from '@/src/services/knownHosts';
import { appGlassControlStyle, useTheme } from '@/src/theme';
import type { GlobalSshKeyMaterial, HostProfile } from '@/src/types';
import { hapticPress, IconButton, ScreenHeader, WhipMark } from './app-ui';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { JumpHostSelect } from './JumpHostSelect';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

const WHIPAIR_SOURCE_URL = 'https://github.com/kosumic/whip/tree/main/whipair';

interface Props {
  hosts: HostProfile[];
  onCancel: () => void;
  onManual: () => void;
  onLoadGlobalKeys: () => Promise<GlobalSshKeyMaterial[] | null>;
  onPaired: (result: PairHostResult, key: PairingKeySelection, jumpHostId?: string) => Promise<void>;
  onAuthenticatePrivateKey?: () => Promise<boolean>;
  onConfirmUnknownHost: (challenge: UnknownHostKeyChallenge) => Promise<boolean>;
  onTrustHost: (challenge: UnknownHostKeyChallenge) => Promise<void>;
}

type PairingState =
  | { phase: 'choose' | 'preparing' }
  | { phase: 'setup'; error?: string }
  | { phase: 'scanning' | 'pairing'; key: PairingKeySelection; verificationCode: string };

type PairingAction =
  | { type: 'setup-opened' }
  | { type: 'back' }
  | { type: 'preparing' }
  | { type: 'prepared'; key: PairingKeySelection; verificationCode: string }
  | { type: 'preparation-finished' }
  | { type: 'scanner-closed' }
  | { type: 'pairing-started' }
  | { type: 'failed'; error: string }
  | { type: 'pairing-finished' };

function pairingReducer(state: PairingState, action: PairingAction): PairingState {
  switch (action.type) {
    case 'setup-opened':
    case 'scanner-closed':
      return { phase: 'setup' };
    case 'back':
      return { phase: 'choose' };
    case 'preparing':
      return { phase: 'preparing' };
    case 'prepared':
      return state.phase === 'preparing'
        ? { phase: 'scanning', key: action.key, verificationCode: action.verificationCode } : state;
    case 'preparation-finished':
      return state.phase === 'preparing' ? { phase: 'setup' } : state;
    case 'pairing-started':
      return state.phase === 'scanning' ? { ...state, phase: 'pairing' } : state;
    case 'failed':
      return state.phase === 'choose' ? state : { phase: 'setup', error: action.error };
    case 'pairing-finished':
      return state.phase === 'pairing' ? { phase: 'setup' } : state;
  }
}

export function NewHostScreen({ hosts, onCancel, onManual, onPaired, onAuthenticatePrivateKey, onConfirmUnknownHost, onTrustHost }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const [permission, requestPermission] = useCameraPermissions();
  const [state, dispatch] = useReducer(pairingReducer, { phase: 'choose' });
  const [jumpHostId, setJumpHostId] = useState<string>();
  const pairing = state.phase === 'pairing';
  const working = state.phase === 'preparing' || pairing;
  const verificationCode = pairing ? state.verificationCode : null;
  const error = state.phase === 'setup' ? state.error : undefined;
  const scanHandled = useRef(false);
  const preparing = useRef(false);

  const launchScanner = async () => {
    if (working || preparing.current) return;
    preparing.current = true;
    dispatch({ type: 'preparing' });
    try {
      let granted = permission?.granted;
      if (!granted) granted = (await requestPermission()).granted;
      if (!granted) {
        Alert.alert(t('pairing.cameraDeniedTitle'), t('pairing.cameraDeniedCopy'));
        return;
      }

      const generated = generateKeyPair('ed25519', '', 256, 'whip');
      const details = getKeyDetails(generated.privateKey);
      const publicKey = generated.publicKey || details.publicKey;
      const code = await publicKeyVerificationCode(publicKey);
      const key: PairingKeySelection = {
        source: 'generated',
        label: t('pairing.generatedKey'),
        publicKey,
        privateKey: generated.privateKey,
        passphrase: '',
        fingerprint: details.fingerprint,
      };
      scanHandled.current = false;
      dispatch({ type: 'prepared', key, verificationCode: code });
    } catch (generationError) {
      dispatch({ type: 'failed', error: t('pairing.keyError', { error: String(generationError) }) });
    } finally {
      preparing.current = false;
      dispatch({ type: 'preparation-finished' });
    }
  };

  const handleScan = async ({ data }: BarcodeScanningResult) => {
    if (scanHandled.current || state.phase !== 'scanning') return;
    const selectedKey = state.key;
    scanHandled.current = true;
    if (!isWhipPairingCode(data)) {
      scanHandled.current = false;
      dispatch({ type: 'scanner-closed' });
      Alert.alert(t('pairing.invalidQrTitle'), t('pairing.invalidQrCopy'));
      return;
    }

    dispatch({ type: 'pairing-started' });
    try {
      const result = await pairHostWithRoute(data.trim(), selectedKey.publicKey, t('pairing.deviceName'), {
        hosts,
        jumpHostId,
        onAuthenticatePrivateKey,
        onConfirmUnknownHost,
        onTrustHost,
      });
      if (result) await onPaired(result, selectedKey, jumpHostId);
    } catch (pairingError) {
      dispatch({ type: 'failed', error: t('pairing.pairError', { error: String(pairingError) }) });
    } finally {
      dispatch({ type: 'pairing-finished' });
    }
  };

  if (state.phase === 'scanning') {
    return (
      <View className="flex-1 bg-black">
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleScan}
        />
        <View className="flex-1 px-5 pb-10 pt-4">
          <View className="flex-row justify-end">
            <IconButton icon={X} accessibilityLabel={t('common.close')} onPress={() => dispatch({ type: 'scanner-closed' })} />
          </View>
          <View className="flex-1 items-center justify-center">
            <View className="size-64 rounded-[28px] border-2 border-white" />
            <Text className="mt-7 max-w-[300px] text-center text-base font-semibold leading-6 text-white">
              {t('pairing.scanCopy')}
            </Text>
          </View>
        </View>
      </View>
    );
  }

  if (state.phase === 'choose') {
    return (
      <View className="flex-1">
        <ScreenHeader
          title={t('pairing.title')}
          left={<IconButton icon={ChevronLeft} accessibilityLabel={t('connection.back')} onPress={onCancel} />}
        />
        <ScrollView className="flex-1" contentContainerClassName="px-5 pb-8">
          <View className="items-center pb-8 pt-8">
            <WhipMark size={52} />
            <Text className="mt-5 text-center text-2xl font-semibold">{t('pairing.chooseHeading')}</Text>
            <Text className="mt-2 max-w-[330px] text-center text-[15px] leading-[22px] text-muted-foreground">
              {t('pairing.chooseCopy')}
            </Text>
          </View>

          <GlassSurface className="overflow-hidden rounded-xl border border-white/30 dark:border-white/10">
            <Button
              accessibilityHint={t('pairing.scanOptionCopy')}
              accessibilityLabel={t('pairing.scan')}
              className="min-h-[112px] w-full items-center justify-start gap-4 px-4 py-5"
              size="content"
              variant="ghost"
              onPress={hapticPress(() => dispatch({ type: 'setup-opened' }))}>
              <View className="size-11 items-center justify-center rounded-full bg-primary">
                <Icon as={ScanLine} className="text-primary-foreground" size={21} />
              </View>
              <View className="min-w-0 flex-1 items-start">
                <Text className="text-base font-semibold">{t('pairing.scan')}</Text>
                <Text className="mt-1 text-left text-sm leading-5 text-muted-foreground">
                  {t('pairing.scanOptionCopy')}
                </Text>
              </View>
              <Icon as={ChevronRight} className="text-muted-foreground" size={20} />
            </Button>
          </GlassSurface>

          <View className="flex-row items-center gap-3 py-5">
            <View className="h-px flex-1 bg-border" />
            <Text className="text-xs font-semibold tracking-widest text-muted-foreground">{t('pairing.or')}</Text>
            <View className="h-px flex-1 bg-border" />
          </View>

          <GlassSurface className="overflow-hidden rounded-xl border border-white/30 dark:border-white/10">
            <Button
              accessibilityHint={t('pairing.manualCopy')}
              accessibilityLabel={t('pairing.manual')}
              className="min-h-[112px] w-full items-center justify-start gap-4 px-4 py-5"
              size="content"
              variant="ghost"
              onPress={hapticPress(onManual)}>
              <View className="size-11 items-center justify-center rounded-full bg-secondary">
                <Icon as={Keyboard} className="text-secondary-foreground" size={21} />
              </View>
              <View className="min-w-0 flex-1 items-start">
                <Text className="text-base font-semibold">{t('pairing.manual')}</Text>
                <Text className="mt-1 text-left text-sm leading-5 text-muted-foreground">
                  {t('pairing.manualCopy')}
                </Text>
              </View>
              <Icon as={ChevronRight} className="text-muted-foreground" size={20} />
            </Button>
          </GlassSurface>
        </ScrollView>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScreenHeader
        title={t('pairing.scan')}
        left={<IconButton icon={ChevronLeft} accessibilityLabel={t('connection.back')} onPress={() => dispatch({ type: 'back' })} />}
      />
      <ScrollView className="flex-1" contentContainerClassName="px-5 pb-8">
        <View className="items-center pb-7 pt-8">
          <WhipMark size={52} />
          <Text className="mt-5 text-center text-2xl font-semibold">{t('pairing.heading')}</Text>
          <Text className="mt-2 max-w-[330px] text-center text-[15px] leading-[22px] text-muted-foreground">
            {t('pairing.intro')}
          </Text>
        </View>

        <GlassSurface className="mb-6 rounded-xl border border-white/30 px-4 py-3 dark:border-white/10">
          <Text className="text-sm font-semibold">{t('pairing.runOnHost')}</Text>
          <View className="mt-2 gap-2">
            <Text
              selectable
              className={cn('rounded-lg border px-3 py-2 font-mono text-sm', !appGlassEnabled && 'border-border bg-background')}
              style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}>
              {'uvx whipair'}
            </Text>
            <Text
              selectable
              className={cn('rounded-lg border px-3 py-2 font-mono text-sm', !appGlassEnabled && 'border-border bg-background')}
              style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}>
              {'npx whipair'}
            </Text>
          </View>
          <Button
            accessibilityRole="link"
            accessibilityLabel={t('pairing.sourceCode')}
            className="mt-2 justify-start px-0"
            variant="link"
            onPress={hapticPress(() => {
              Linking.openURL(WHIPAIR_SOURCE_URL).catch(reason => {
                Alert.alert(t('about.githubError'), String(reason));
              });
            })}>
            <Icon as={ExternalLink} className="text-primary" size={17} />
            <Text>{t('pairing.sourceCode')}</Text>
          </Button>
        </GlassSurface>

        <JumpHostSelect
          hosts={hosts}
          selectedHostId={jumpHostId}
          disabled={working}
          onSelect={setJumpHostId}
        />

        {error ? <Text accessibilityLiveRegion="polite" className="mt-4 text-sm leading-5 text-destructive">{error}</Text> : null}

        {pairing && verificationCode ? (
          <Text accessibilityLiveRegion="polite" className="mt-6 text-center font-mono text-2xl font-semibold tracking-wider">
            {t('pairing.verify', { code: verificationCode })}
          </Text>
        ) : null}

        <Button className={cn(pairing && verificationCode ? 'mt-4' : 'mt-7', 'h-12 rounded-full')} disabled={working} onPress={hapticPress(launchScanner)}>
          {working ? <ActivityIndicator color={colors.onPrimary} /> : <Icon as={ScanLine} className="text-primary-foreground" size={19} />}
          <Text>{pairing ? t('pairing.waiting') : t('pairing.scan')}</Text>
        </Button>
      </ScrollView>

    </View>
  );
}
