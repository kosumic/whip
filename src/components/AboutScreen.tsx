import { ChevronDown, ChevronRight, ChevronUp, ExternalLink, Scale, Share2 } from 'lucide-react-native';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { Alert, Linking, Platform, Share, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { LocalSvg } from 'react-native-svg/css';

import terminalFonts from '@/assets/terminal-fonts/manifest.json';
import { bundledAsset } from '@/src/lib/bundledAsset';
import { isUnknownRecord } from '@/src/lib/unknown';
import { HERDR_PROTOCOL_VERSIONS_LABEL } from '@/src/lib/herdrProtocol';
import { hapticPress, HerdrMark, WhipMark } from './app-ui';
import { GlassBackdrop, GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

export const WHIP_RELEASES_URL = 'https://github.com/kosumic/whip';
export const WHIP_REPOSITORY_URL = 'https://github.com/kosumic/whip';
export const HERDR_WEBSITE_URL = 'https://herdr.dev/';
export const X_PROFILE_URL = 'https://x.com/Kosumi1989';
const ABOUT_EXPAND_DURATION = 340;
const ABOUT_COLLAPSE_DURATION = 260;

export function AboutSection({ onOpenLicenses }: { onOpenLicenses: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [contentMounted, setContentMounted] = useState(false);
  const [contentMeasured, setContentMeasured] = useState(false);
  const { t } = useTranslation();
  const fallbackFont = Platform.select({
    ios: terminalFonts.fallback.ios,
    default: terminalFonts.fallback.android,
  });
  const contentHeight = useSharedValue(0);
  const progress = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(progress);
    if (expanded && !contentMeasured) {
      progress.value = 0;
      return;
    }
    progress.value = withTiming(expanded ? 1 : 0, {
      duration: expanded ? ABOUT_EXPAND_DURATION : ABOUT_COLLAPSE_DURATION,
      easing: Easing.inOut(Easing.cubic),
    });
    return () => cancelAnimation(progress);
  }, [contentMeasured, expanded, progress]);

  const collapsibleStyle = useAnimatedStyle(() => ({
    height: contentHeight.value * progress.value,
    opacity: progress.value,
    transform: [{ translateY: -8 * (1 - progress.value) }],
  }));

  const whipVersion = Application.nativeApplicationVersion || Constants.expoConfig?.version || t('common.unavailable');
  const expoExtra: unknown = Constants.expoConfig?.extra;
  const embeddedCommit = isUnknownRecord(expoExtra) ? expoExtra.gitCommit : undefined;
  const fullWhipCommit = typeof embeddedCommit === 'string' && /^[0-9a-f]{7,64}$/i.test(embeddedCommit)
    ? embeddedCommit
    : null;
  const whipCommit = fullWhipCommit?.slice(0, 12) ?? null;
  const openCommit = () => {
    if (!fullWhipCommit) return;

    Linking.openURL(`${WHIP_REPOSITORY_URL}/commit/${fullWhipCommit}`).catch(error => {
      Alert.alert(t('about.commitError'), String(error));
    });
  };
  const openReleases = () => {
    Linking.openURL(WHIP_RELEASES_URL).catch(error => {
      Alert.alert(t('about.githubError'), String(error));
    });
  };
  const shareReleases = () => {
    Share.share({
      title: t('about.shareTitle'),
      message: t('about.shareMessage', { url: WHIP_RELEASES_URL }),
    }).catch(error => {
      Alert.alert(t('about.shareError'), String(error));
    });
  };
  const openHerdrWebsite = () => {
    Linking.openURL(HERDR_WEBSITE_URL).catch(error => {
      Alert.alert(t('about.herdrWebsiteError'), String(error));
    });
  };
  const openXProfile = () => {
    Linking.openURL(X_PROFILE_URL).catch(error => {
      Alert.alert(t('about.xError'), String(error));
    });
  };
  const shareHerdrWebsite = () => {
    Share.share({
      title: t('about.shareHerdrTitle'),
      message: t('about.shareHerdrMessage', { url: HERDR_WEBSITE_URL }),
    }).catch(error => {
      Alert.alert(t('about.shareHerdrError'), String(error));
    });
  };

  return (
    <View className="border-t border-border px-4 py-5">
      <Button
        accessibilityLabel={expanded ? t('about.collapse') : t('about.expand')}
        accessibilityState={{ expanded }}
        className="min-h-[72px] w-full justify-start overflow-hidden rounded-lg border border-white/30 bg-transparent px-4 py-3 dark:border-white/10"
        size="content"
        variant="ghost"
        onPress={hapticPress(() => {
          if (!expanded) setContentMounted(true);
          setExpanded(value => !value);
        })}>
        <GlassBackdrop shapeClassName="rounded-lg" />
        <View className="min-w-0 flex-1">
          <Text className="text-[17px] font-semibold leading-6">{t('about.title')}</Text>
          <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{t('about.copy')}</Text>
        </View>
        <Icon as={expanded ? ChevronUp : ChevronDown} className="text-muted-foreground" size={21} />
      </Button>
      <Animated.View
        accessibilityElementsHidden={!expanded}
        importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
        pointerEvents={expanded ? 'auto' : 'none'}
        className="overflow-hidden"
        style={collapsibleStyle}>
        {contentMounted ? (
          <View
            className="absolute inset-x-0 top-0 pb-6 pt-7"
            onLayout={event => {
              contentHeight.value = event.nativeEvent.layout.height;
              setContentMeasured(true);
            }}>
          <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">{t('about.source')}</Text>
          <View className="flex-row gap-2.5">
            <Button
              accessibilityRole="link"
              className="min-h-[76px] min-w-0 flex-1 justify-start overflow-hidden rounded-lg border border-white/30 bg-transparent px-4 py-4 dark:border-white/10"
              size="content"
              variant="outline"
              onPress={hapticPress(openReleases)}>
              <GlassBackdrop shapeClassName="rounded-lg" />
              <View className="size-11 items-center justify-center rounded-full bg-black">
                <GitHubMark size={22} />
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-[15px] font-semibold leading-5">{t('about.githubRepository')}</Text>
                <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground" numberOfLines={1}>kosumic/whip</Text>
              </View>
              <Icon as={ExternalLink} className="text-muted-foreground" size={19} />
            </Button>
            <Button
              accessibilityLabel={t('about.shareReleases')}
              className="w-14 self-stretch overflow-hidden rounded-lg border border-white/30 bg-transparent px-0 dark:border-white/10"
              size="content"
              variant="outline"
              onPress={hapticPress(shareReleases)}>
              <GlassBackdrop shapeClassName="rounded-lg" />
              <Icon as={Share2} size={21} />
            </Button>
          </View>
          <View className="mt-2.5 flex-row gap-2.5">
            <Button
              accessibilityRole="link"
              className="min-h-[76px] min-w-0 flex-1 justify-start overflow-hidden rounded-lg border border-white/30 bg-transparent px-4 py-4 dark:border-white/10"
              size="content"
              variant="outline"
              onPress={hapticPress(openXProfile)}>
              <GlassBackdrop shapeClassName="rounded-lg" />
              <View className="size-11 items-center justify-center rounded-full bg-black">
                <XMark size={20} />
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-[15px] font-semibold leading-5">X</Text>
                <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground" numberOfLines={1}>@Kosumi1989</Text>
              </View>
              <Icon as={ExternalLink} className="text-muted-foreground" size={19} />
            </Button>
          </View>
          <View className="mt-2.5 flex-row gap-2.5">
            <Button
              accessibilityRole="link"
              className="min-h-[76px] min-w-0 flex-1 justify-start overflow-hidden rounded-lg border border-white/30 bg-transparent px-4 py-4 dark:border-white/10"
              size="content"
              variant="outline"
              onPress={hapticPress(openHerdrWebsite)}>
              <GlassBackdrop shapeClassName="rounded-lg" />
              <HerdrMark size={44} accessibilityLabel={t('about.herdrIcon')} />
              <View className="min-w-0 flex-1">
                <Text className="text-[15px] font-semibold leading-5">{t('about.herdrWebsite')}</Text>
                <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">herdr.dev</Text>
              </View>
              <Icon as={ExternalLink} className="text-muted-foreground" size={19} />
            </Button>
            <Button
              accessibilityLabel={t('about.shareHerdrWebsite')}
              className="w-14 self-stretch overflow-hidden rounded-lg border border-white/30 bg-transparent px-0 dark:border-white/10"
              size="content"
              variant="outline"
              onPress={hapticPress(shareHerdrWebsite)}>
              <GlassBackdrop shapeClassName="rounded-lg" />
              <Icon as={Share2} size={21} />
            </Button>
          </View>

          <View className="mt-9 items-center">
            <WhipMark size={82} accessibilityLabel={t('about.appIcon')} />
            <Text className="mt-4 text-[28px] font-semibold leading-9">Whip</Text>
            <Text className="mt-1 text-center text-sm leading-5 text-muted-foreground">{t('about.tagline')}</Text>
            <Text className="mt-1.5 text-center text-xs leading-[17px] text-muted-foreground/70">{t('common.version', { version: whipVersion })}</Text>
            {whipCommit ? (
              <Button
                accessibilityLabel={t('about.openCommit', { hash: whipCommit })}
                accessibilityRole="link"
                className="mt-0.5 min-h-11 gap-1 px-2"
                size="content"
                variant="link"
                onPress={hapticPress(openCommit)}>
                <Text className="text-center text-xs leading-[17px] underline">{t('about.commit', { hash: whipCommit })}</Text>
                <Icon as={ExternalLink} size={12} />
              </Button>
            ) : null}
          </View>

          <Text className="mb-3 mt-9 px-1 text-sm font-semibold text-muted-foreground">{t('about.legal')}</Text>
          <Button
            accessibilityLabel={t('about.openLicenses')}
            className="min-h-[72px] w-full justify-start overflow-hidden rounded-lg border border-white/30 bg-transparent px-4 py-3 dark:border-white/10"
            size="content"
            variant="ghost"
            onPress={hapticPress(onOpenLicenses)}>
            <GlassBackdrop shapeClassName="rounded-lg" />
            <View className="size-10 items-center justify-center rounded-full bg-primary/10">
              <Icon as={Scale} className="text-primary" size={20} />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-[15px] font-semibold leading-5">{t('licenses.title')}</Text>
              <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{t('about.licensesCopy')}</Text>
            </View>
            <Icon as={ChevronRight} className="text-muted-foreground" size={20} />
          </Button>

          <Text className="mb-3 mt-9 px-1 text-sm font-semibold text-muted-foreground">{t('about.compatibility')}</Text>
          <GlassSurface className="rounded-lg border border-white/30 dark:border-white/10">
            <AboutRow label={t('about.supportedHerdr')} value={t('common.protocol', { version: HERDR_PROTOCOL_VERSIONS_LABEL })} />
          </GlassSurface>
          <Text className="mt-3 px-1 text-xs leading-[18px] text-muted-foreground">
            {t('about.compatibilityCopy', { versions: HERDR_PROTOCOL_VERSIONS_LABEL })}
          </Text>

          <Text className="mb-3 mt-8 px-1 text-sm font-semibold text-muted-foreground">{t('about.terminalFonts')}</Text>
          <GlassSurface className="rounded-lg border border-white/30 dark:border-white/10">
            <AboutRow label={t('about.terminalTextFont')} value={terminalFonts.text.displayName} />
            <AboutRow label={t('about.terminalCjkFont')} value={terminalFonts.cjk.displayName} divided />
            <AboutRow label={t('about.terminalSymbolFont')} value={terminalFonts.symbols.displayName} divided />
            <AboutRow label={t('about.terminalEmojiFont')} value={terminalFonts.emoji.displayName} divided />
            <AboutRow label={t('about.terminalFallbackFont')} value={fallbackFont.displayName} divided />
          </GlassSurface>

          </View>
        ) : null}
      </Animated.View>
    </View>
  );
}

function GitHubMark({ size }: { size: number }) {
  return (
    <LocalSvg
      accessible={false}
      asset={bundledAsset(require('../../assets/brand/github.svg'))}
      height={size}
      width={size}
    />
  );
}

function XMark({ size }: { size: number }) {
  return (
    <LocalSvg
      accessible={false}
      asset={bundledAsset(require('../../assets/brand/x.svg'))}
      height={size}
      width={size}
    />
  );
}

function AboutRow({ label, value, divided = false }: { label: string; value: string; divided?: boolean }) {
  return (
    <View className={divided ? 'min-h-[68px] flex-row items-center border-t border-border px-4 py-3' : 'min-h-[68px] flex-row items-center px-4 py-3'}>
      <Text className="flex-1 text-[15px] font-semibold leading-5">{label}</Text>
      <View className="ml-4 items-end">
        <Text className="text-sm font-medium leading-5">{value}</Text>
      </View>
    </View>
  );
}
