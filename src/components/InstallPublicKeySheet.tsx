import Clipboard from '@react-native-clipboard/clipboard';
import { ClipboardPaste, KeyRound, ScanLine, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getKeyDetails,
  inspectPublicKey,
  type PublicKeyShare,
} from 'react-native-whip-ssh';

import { BrowserQrScanner } from '../browser/BrowserQrScanner';
import { APP_FROSTED_GLASS_SURFACE_PROPS } from '../lib/appGlass';
import { normalizePrivateKey } from '../lib/privateKey';
import {
  installPublicKeyForHost,
  type PublicKeyInstallationRoute,
} from '../services/publicKeyInstallation';
import { useTheme } from '../theme';
import type { GlobalSshKeyMaterial, HostProfile } from '../types';
import { hapticPress, IconButton } from './app-ui';
import { GlassPortal, GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { GlassButton } from './GlassControls';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props extends PublicKeyInstallationRoute {
  host: HostProfile;
  onClose: () => void;
  onLoadGlobalKeys?: () => Promise<GlobalSshKeyMaterial[] | null>;
}

export function InstallPublicKeySheet({
  host,
  onClose,
  onLoadGlobalKeys,
  ...route
}: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { bottom } = useSafeAreaInsets();
  const appGlassEnabled = useAppGlassEnabled();
  const [key, setKey] = useState<PublicKeyShare | null>(null);
  const [keys, setKeys] = useState<GlobalSshKeyMaterial[] | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'added' | 'already-present' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (!inFlight.current) onClose();
        return true;
      },
    );
    return () => subscription.remove();
  }, [onClose]);

  const chooseKey = (value: string, requireQr = false) => {
    const selected = inspectPublicKey(value, requireQr);
    setKey(selected);
    setKeys(null);
    setResult(null);
    setError(null);
  };
  const readClipboard = async () => {
    try {
      chooseKey(await Clipboard.getString());
    } catch {
      setError(t('publicKeys.invalidKey'));
    }
  };
  const openKeychain = async () => {
    if (!onLoadGlobalKeys) return;
    try {
      const loaded = await onLoadGlobalKeys();
      if (loaded === null) return;
      setKeys(loaded);
      setError(loaded.length ? null : t('keychain.emptyPickerCopy'));
    } catch (reason) {
      setError(String(reason));
    }
  };
  const selectStoredKey = (stored: GlobalSshKeyMaterial) => {
    try {
      chooseKey(
        getKeyDetails(
          normalizePrivateKey(stored.secret),
          stored.passphrase || undefined,
        ).publicKey,
      );
    } catch (reason) {
      setError(String(reason));
    }
  };
  const install = async () => {
    if (!key || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      setResult(await installPublicKeyForHost(host, key.publicKey, route));
    } catch (reason) {
      setError(t('publicKeys.installError', { error: String(reason) }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <GlassPortal name={`public-key-install-${host.id}`}>
      <View className="absolute inset-0 z-50 justify-end">
        <Pressable
          accessibilityLabel={t('common.close')}
          className="absolute inset-0 bg-black/55"
          disabled={busy}
          onPress={onClose}
        />
        <GlassSurface
          {...APP_FROSTED_GLASS_SURFACE_PROPS}
          accessibilityViewIsModal
          className="max-h-[85%] rounded-t-[28px] border-t border-white/30 px-4 pt-5 dark:border-white/10"
          style={{ paddingBottom: Math.max(16, bottom) }}
        >
          <View className="mb-3 flex-row items-center gap-3 px-1">
            <Icon as={KeyRound} size={21} />
            <Text className="min-w-0 flex-1 text-lg font-semibold">
              {t('publicKeys.install')}
            </Text>
            <IconButton
              icon={X}
              disabled={busy}
              accessibilityLabel={t('common.close')}
              onPress={onClose}
            />
          </View>
          <ScrollView contentContainerClassName="gap-4 pb-4">
            <Text className="text-sm leading-5 text-muted-foreground">
              {t('publicKeys.installCopy', {
                user: host.username,
                host: host.host,
              })}
            </Text>
            <View className="gap-1">
              <GlassButton
                disabled={busy || !onLoadGlobalKeys}
                variant="ghost"
                className="justify-start"
                onPress={hapticPress(openKeychain)}
              >
                <Icon as={KeyRound} size={19} />
                <Text>{t('keychain.useGlobal')}</Text>
              </GlassButton>
              <GlassButton
                disabled={busy}
                variant="ghost"
                className="justify-start"
                onPress={hapticPress(readClipboard)}
              >
                <Icon as={ClipboardPaste} size={19} />
                <Text>{t('connection.pasteClipboard')}</Text>
              </GlassButton>
              <GlassButton
                disabled={busy}
                variant="ghost"
                className="justify-start"
                onPress={hapticPress(() => setScannerOpen(true))}
              >
                <Icon as={ScanLine} size={19} />
                <Text>{t('publicKeys.scan')}</Text>
              </GlassButton>
            </View>
            {keys?.map(stored => (
              <GlassButton
                key={stored.id}
                disabled={busy}
                variant="secondary"
                size="content"
                className="items-start rounded-lg p-4"
                onPress={hapticPress(() => selectStoredKey(stored))}
              >
                <Text className="font-semibold">{stored.name}</Text>
                <Text className="mt-1 font-mono text-xs text-muted-foreground">
                  {stored.fingerprint}
                </Text>
              </GlassButton>
            ))}
            {key ? (
              <View className="gap-3 border-t border-border pt-4">
                <Text className="font-semibold">{t('publicKeys.review')}</Text>
                <Text className="text-sm text-muted-foreground">
                  {key.keyType}
                </Text>
                <Text selectable className="font-mono text-xs leading-5">
                  {key.fingerprint}
                </Text>
                <Text
                  selectable
                  className="font-mono text-xs leading-5 text-muted-foreground"
                >
                  {key.publicKey}
                </Text>
                <GlassButton
                  disabled={busy || result !== null}
                  className="rounded-full"
                  onPress={hapticPress(install)}
                >
                  {busy ? (
                    <ActivityIndicator
                      color={
                        appGlassEnabled ? colors.primary : colors.onPrimary
                      }
                    />
                  ) : null}
                  <Text>
                    {t(busy ? 'publicKeys.installing' : 'publicKeys.install')}
                  </Text>
                </GlassButton>
              </View>
            ) : null}
            {result ? (
              <Text
                accessibilityLiveRegion="polite"
                className="text-sm leading-5 text-primary"
              >
                {t(
                  result === 'added'
                    ? 'publicKeys.installed'
                    : 'publicKeys.alreadyPresent',
                )}
              </Text>
            ) : null}
            {error ? (
              <Text
                accessibilityRole="alert"
                className="text-sm leading-5 text-destructive"
              >
                {error}
              </Text>
            ) : null}
          </ScrollView>
        </GlassSurface>
      </View>
      {scannerOpen ? (
        <BrowserQrScanner
          title={t('publicKeys.scan')}
          instruction={t('publicKeys.scanCopy')}
          onClose={() => setScannerOpen(false)}
          onScan={data => {
            try {
              chooseKey(data, true);
            } catch {
              throw new Error(t('publicKeys.invalidQr'));
            }
            setScannerOpen(false);
          }}
        />
      ) : null}
    </GlassPortal>
  );
}
