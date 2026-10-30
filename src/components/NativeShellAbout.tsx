import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { isLiquidGlassSupported } from '@callstack/liquid-glass';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, requireNativeComponent, UIManager, useWindowDimensions, type NativeSyntheticEvent, type ViewProps } from 'react-native';
import { billingDistributionFromExtra } from '../billing/distribution';
import { useAppFontScale } from '../hooks/useAppFontScale';
import { useAppGlassEnabled } from '../lib/glassContext';
import { isUnknownRecord } from '../lib/unknown';
import { useTheme } from '../theme';
import { AboutSection } from './AboutScreen';

const VIEW_NAME = 'WhipNativeShellAbout';
interface NativeProps extends ViewProps {
  environment: string;
  onContentHeight: (event: NativeSyntheticEvent<{ height: number }>) => void;
  onOpenLicenses: () => void;
  onFailure: () => void;
}

export function nativeShellAboutEnabled(extra: unknown, available: boolean): boolean {
  return isUnknownRecord(extra) && extra.nshAboutExperiment === true && available;
}

// Resolve only when the native build contains the experiment. Expo Go and older
// installed binaries keep the original About implementation.
const available = Platform.OS !== 'web' && UIManager.getViewManagerConfig(VIEW_NAME) != null;
const NativeAbout = available ? requireNativeComponent<NativeProps>(VIEW_NAME) : null;

export function NativeShellAbout({ onOpenLicenses }: { onOpenLicenses: () => void }) {
  const [height, setHeight] = useState(90);
  const [failed, setFailed] = useState(false);
  const { i18n, t } = useTranslation();
  const { colors, isDark } = useTheme();
  const glassEnabled = useAppGlassEnabled();
  const { fontScale: systemFontScale } = useWindowDimensions();
  const fontScale = useAppFontScale() * systemFontScale;
  const extra: unknown = Constants.expoConfig?.extra;
  if (!NativeAbout || failed || !nativeShellAboutEnabled(extra, available)) {
    return <AboutSection onOpenLicenses={onOpenLicenses} />;
  }
  const commit = isUnknownRecord(extra) && typeof extra.gitCommit === 'string' && /^[0-9a-f]{7,64}$/i.test(extra.gitCommit)
    ? extra.gitCommit : null;
  const environment = JSON.stringify({
    locale: i18n.resolvedLanguage ?? i18n.language,
    fontScale, colors, isDark, glassEnabled, liquidGlassAvailable: isLiquidGlassSupported, platform: Platform.OS,
    version: Application.nativeApplicationVersion || Constants.expoConfig?.version || t('common.unavailable'),
    commit, channel: billingDistributionFromExtra(extra).channel,
  });
  return <NativeAbout environment={environment} style={{ height }}
    onContentHeight={event => {
      const next = event.nativeEvent.height;
      if (Number.isFinite(next) && next > 0) setHeight(Math.ceil(next));
    }} onOpenLicenses={onOpenLicenses} onFailure={() => setFailed(true)} />;
}
