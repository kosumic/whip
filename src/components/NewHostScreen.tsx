import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { ChevronLeft, ChevronRight, Keyboard, ScanLine, X } from 'lucide-react-native';
import { generateKeyPair, getKeyDetails } from 'react-native-whip-ssh';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';
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

export function NewHostScreen({ hosts, onCancel, onManual, onPaired, onAuthenticatePrivateKey, onConfirmUnknownHost, onTrustHost }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const [permission, requestPermission] = useCameraPermissions();
  const [pairingSetupOpen, setPairingSetupOpen] = useState(false);
  const [jumpHostId, setJumpHostId] = useState<string>();
  const [selectedKey, setSelectedKey] = useState<PairingKeySelection | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [verificationCode, setVerificationCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scanHandled = useRef(false);

  const launchScanner = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
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
      setVerificationCode(await publicKeyVerificationCode(publicKey));
      setSelectedKey({
        source: 'generated',
        label: t('pairing.generatedKey'),
        publicKey,
        privateKey: generated.privateKey,
        passphrase: '',
        fingerprint: details.fingerprint,
      });
      scanHandled.current = false;
      setScannerOpen(true);
    } catch (generationError) {
      setError(t('pairing.keyError', { error: String(generationError) }));
    } finally {
      setWorking(false);
    }
  };

  const handleScan = async ({ data }: BarcodeScanningResult) => {
    if (scanHandled.current || !selectedKey) return;
    scanHandled.current = true;
    if (!isWhipPairingCode(data)) {
      scanHandled.current = false;
      setScannerOpen(false);
      Alert.alert(t('pairing.invalidQrTitle'), t('pairing.invalidQrCopy'));
      return;
    }

    setScannerOpen(false);
    setWorking(true);
    setPairing(true);
    setError(null);
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
      setError(t('pairing.pairError', { error: String(pairingError) }));
    } finally {
      setPairing(false);
      setWorking(false);
    }
  };

  if (scannerOpen) {
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
            <IconButton icon={X} accessibilityLabel={t('common.close')} onPress={() => setScannerOpen(false)} />
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

  if (!pairingSetupOpen) {
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
              onPress={hapticPress(() => setPairingSetupOpen(true))}>
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
        left={<IconButton icon={ChevronLeft} accessibilityLabel={t('connection.back')} onPress={() => setPairingSetupOpen(false)} />}
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
