import {
  isLiquidGlassSupported,
  LiquidGlassView,
} from '@callstack/liquid-glass';
import { BlurView } from 'expo-blur';
import { createContext, useContext, useMemo, type ReactNode, type RefObject } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { cn } from '@/src/lib/utils';
import { useTheme } from '@/src/theme';
import { liquidGlassShapeStyle } from './glassShape';

interface GlassContextValue {
  blurTarget: RefObject<View | null>;
  enabled: boolean;
}

const GlassContext = createContext<GlassContextValue | null>(null);

export function GlassProvider({ blurTarget, enabled, children }: GlassContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ blurTarget, enabled }), [blurTarget, enabled]);
  return <GlassContext.Provider value={value}>{children}</GlassContext.Provider>;
}

export function useAppGlassEnabled(): boolean {
  return useContext(GlassContext)?.enabled === true;
}

export function GlassBackdrop({
  intensity = 36,
  shapeClassName,
}: {
  intensity?: number;
  shapeClassName?: string;
}) {
  const glass = useContext(GlassContext);
  const { colors, isDark } = useTheme();
  const enabled = glass?.enabled === true;
  // Native Liquid Glass is the primary surface on supported Apple devices.
  // The app glass preference only controls the legacy blur fallback.
  const renderLiquidGlass = enabled && isLiquidGlassSupported;
  // Android deliberately uses a plain View instead of BlurTargetView at the app
  // root. Native blur captures caused release tab-switch stalls, so Android glass
  // stays translucent-only unless that architecture is revisited and profiled.
  const renderNativeBlur = Platform.OS !== 'android';
  if (!enabled && !renderLiquidGlass) {
    return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]} />;
  }
  return renderLiquidGlass ? (
    <LiquidGlassView
      colorScheme={isDark ? 'dark' : 'light'}
      effect="clear"
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, liquidGlassShapeStyle(shapeClassName)]}
    />
  ) : (
    <>
      {renderNativeBlur ? (
        <BlurView
          pointerEvents="none"
          blurMethod="dimezisBlurViewSdk31Plus"
          blurReductionFactor={2}
          blurTarget={glass?.blurTarget}
          intensity={intensity}
          tint={isDark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: isDark ? 'rgba(20,22,34,0.38)' : 'rgba(255,255,255,0.42)' },
        ]}
      />
    </>
  );
}

export function GlassSurface({
  children,
  className,
  intensity,
  style,
  fallbackClassName,
  ...props
}: React.ComponentProps<typeof View> & { intensity?: number; fallbackClassName?: string }) {
  const glass = useContext(GlassContext);
  const { colors } = useTheme();
  const enabled = glass?.enabled === true;
  return (
    <View
      className={cn('relative overflow-hidden', className, !enabled && fallbackClassName)}
      style={[enabled ? undefined : { borderColor: colors.divider }, style]}
      {...props}>
      {(enabled || fallbackClassName === undefined) && <GlassBackdrop intensity={intensity} shapeClassName={className} />}
      {children}
    </View>
  );
}
