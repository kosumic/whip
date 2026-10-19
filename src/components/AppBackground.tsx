import { Image, StyleSheet, View } from 'react-native';
import { useRef } from 'react';
import { BlurTargetView } from 'expo-blur';

import { useTheme } from '@/src/theme';
import { APP_FROSTED_GLASS_SURFACE_PROPS } from '@/src/lib/appGlass';
import { GlassBackdrop, GlassProvider, useAppGlassEnabled } from './GlassSurface';

interface AppBackgroundProps {
  uri: string | null;
  dimming: number;
}

export function AppBackground({
  uri,
  dimming,
}: AppBackgroundProps) {
  const { colors } = useTheme();

  return (
    <View
      accessibilityElementsHidden
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: colors.canvas }]}
    >
      {uri ? (
        <>
          <Image
            resizeMode="cover"
            source={{ uri }}
            style={StyleSheet.absoluteFill}
          />
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: colors.canvas, opacity: dimming / 100 },
            ]}
          />
        </>
      ) : null}
    </View>
  );
}

export function FrostedAppBackground(props: AppBackgroundProps) {
  const blurTarget = useRef<View | null>(null);
  const enabled = useAppGlassEnabled();
  return (
    <GlassProvider blurTarget={blurTarget} enabled={enabled}>
      <View accessibilityElementsHidden pointerEvents="none" style={StyleSheet.absoluteFill}>
        {/* Capture only wallpaper; the chat and its blur stay outside this target. */}
        <BlurTargetView ref={blurTarget} style={StyleSheet.absoluteFill}>
          <AppBackground {...props} />
        </BlurTargetView>
        <GlassBackdrop {...APP_FROSTED_GLASS_SURFACE_PROPS} />
      </View>
    </GlassProvider>
  );
}
