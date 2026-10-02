import { BlurView } from 'expo-blur';
import { CircleEllipsis, Server, SquareTerminal, type LucideIcon } from 'lucide-react-native';
import { type RefObject } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BOTTOM_NAVIGATION_BASE_HEIGHT, BOTTOM_NAVIGATION_BOTTOM_OFFSET } from '@/src/lib/floatingChrome';
import { colorWithAlpha, useTheme, type ThemeColors } from '@/src/theme';
import type { AppTab } from '@/src/types';
import { hapticPress, HerdrMark } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';

interface Props {
  activeTab: AppTab;
  blurTarget: RefObject<View | null>;
  onSelect: (tab: AppTab) => void;
}

type NavigationItem = {
  tab: AppTab;
  labelKey: string;
} & ({ icon: LucideIcon } | { herdrMark: true });

const items: NavigationItem[] = [
  { tab: 'hosts', labelKey: 'nav.hosts', icon: Server },
  { tab: 'herd', labelKey: 'nav.herd', herdrMark: true },
  { tab: 'terminal', labelKey: 'nav.terminal', icon: SquareTerminal },
  { tab: 'more', labelKey: 'nav.more', icon: CircleEllipsis },
];

export function BottomNavigation({ activeTab, blurTarget, onSelect }: Props) {
  const { colors, isDark } = useTheme();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  // Android BlurViews recaptured the full screen whenever its tab changed,
  // compounding the release transition stall. Keep native blur on iOS only.
  const renderNativeBlur = Platform.OS !== 'android';
  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 z-30 flex-row items-center justify-around bg-transparent px-4"
      style={{ bottom: BOTTOM_NAVIGATION_BOTTOM_OFFSET, height: BOTTOM_NAVIGATION_BASE_HEIGHT + bottom, paddingBottom: bottom }}>
      {items.map(item => {
        const active = item.tab === activeTab;
        return (
          <View className="h-[60px] flex-1 items-center justify-center" key={item.tab}>
            <View
              pointerEvents="none"
              className="absolute h-[60px] w-[60px] rounded-full"
              style={floatingBloomStyle(active, colors)}
            />
            {renderNativeBlur ? (
              <BlurView
                pointerEvents="none"
                blurMethod="dimezisBlurViewSdk31Plus"
                blurReductionFactor={2}
                blurTarget={blurTarget}
                intensity={active ? 34 : 26}
                tint={isDark ? 'systemUltraThinMaterialDark' : 'default'}
                style={[styles.glassSurface, Platform.OS === 'ios' ? styles.glassSurfaceWithoutEdge : floatingGlassEdgeStyle(active, colors)]}
              />
            ) : (
              <View
                pointerEvents="none"
                style={[
                  styles.glassSurface,
                  floatingGlassEdgeStyle(active, colors),
                  floatingGlassFallbackStyle(isDark),
                ]}
              />
            )}
            <Button
              accessibilityLabel={t(item.labelKey)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              className="h-[60px] w-[60px] rounded-full bg-transparent p-0 dark:bg-transparent"
              size="content"
              variant="link"
              onPress={hapticPress(() => onSelect(item.tab))}>
              <View className={active ? 'items-center justify-center opacity-100' : 'items-center justify-center opacity-60'}>
                {'herdrMark' in item
                  ? <HerdrMark size={29} />
                  : <Icon as={item.icon} size={29} color={active ? colors.text : colors.textSecondary} strokeWidth={active ? 2.75 : 2} />}
              </View>
            </Button>
          </View>
        );
      })}
    </View>
  );
}

function floatingGlassEdgeStyle(active: boolean, colors: ThemeColors) {
  const edgeColor = active ? colors.primary : colors.textSecondary;
  return {
    borderColor: colorWithAlpha(edgeColor, active ? 'E0' : '8F'),
  };
}

function floatingGlassFallbackStyle(isDark: boolean) {
  return {
    backgroundColor: isDark ? 'rgba(20,22,34,0.38)' : 'rgba(255,255,255,0.42)',
  } as const;
}

function floatingBloomStyle(active: boolean, colors: ThemeColors) {
  const edgeColor = active ? colors.primary : colors.textSecondary;
  return {
    backgroundColor: 'transparent',
    borderColor: colorWithAlpha(edgeColor, active ? 'B8' : '73'),
    borderWidth: active ? 2 : 1,
    ...(Platform.OS === 'ios'
      ? {
          // iOS does not render the React Native filter blur on this View.
          shadowColor: edgeColor,
          shadowOpacity: active ? 0.72 : 0.32,
          shadowRadius: active ? 10 : 6,
          shadowOffset: { width: 0, height: 0 },
        }
      : { filter: [{ blur: active ? 6 : 4 }] }),
  } as const;
}

const styles = StyleSheet.create({
  glassSurface: {
    position: 'absolute',
    width: 64,
    height: 64,
    opacity: 0.62,
    overflow: 'hidden',
    borderRadius: 32,
    borderWidth: 1,
  },
  // The iOS material surface already has a crisp edge; the separate bloom
  // ring supplies the navigation button outline.
  glassSurfaceWithoutEdge: {
    borderColor: 'transparent',
  },
});
