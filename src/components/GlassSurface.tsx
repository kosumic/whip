import {
  isLiquidGlassSupported,
  LiquidGlassView,
} from '@callstack/liquid-glass';
import { BlurView } from 'expo-blur';
import { Portal } from '@rn-primitives/portal';
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

export function GlassPortal({ children, ...props }: React.ComponentProps<typeof Portal>) {
  const glass = useContext(GlassContext);
  // The portal host sits outside GlassProvider, so carry its context with us.
  return (
    <Portal {...props}>
      <GlassContext.Provider value={glass}>{children}</GlassContext.Provider>
    </Portal>
  );
}

interface GlassBackdropProps {
  effect?: 'glass' | 'blur';
  intensity?: number;
  shapeClassName?: string;
  tintOpacity?: number;
}

export function GlassBackdrop({
  effect = 'glass',
  intensity = 36,
  shapeClassName,
  tintOpacity,
}: GlassBackdropProps) {
  const glass = useContext(GlassContext);
  const { colors, isDark } = useTheme();
  const enabled = glass?.enabled === true;
  // Composer inputs use a frosted blur even when Liquid Glass is available.
  const renderLiquidGlass = enabled && effect === 'glass' && isLiquidGlassSupported;
  // Screen-wide Android blurs caused tab-switch stalls. Only explicit blur
  // surfaces (the visible composer) capture the shared target on Android.
  const renderNativeBlur = Platform.OS !== 'android' || effect === 'blur';
  if (!enabled && !renderLiquidGlass) {
    return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]} />;
  }
  const tintStyle = {
    backgroundColor: isDark ? '#141622' : '#FFFFFF',
    opacity: tintOpacity ?? (isDark ? 0.38 : 0.42),
  };
  return renderLiquidGlass ? (
    <>
      <LiquidGlassView
        colorScheme={isDark ? 'dark' : 'light'}
        effect="clear"
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, liquidGlassShapeStyle(shapeClassName)]}
      />
      {tintOpacity !== undefined && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, tintStyle]} />
      )}
    </>
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
        style={[StyleSheet.absoluteFill, tintStyle]}
      />
    </>
  );
}

export function GlassSurface({
  children,
  className,
  effect,
  intensity,
  tintOpacity,
  style,
  fallbackClassName,
  ...props
}: React.ComponentProps<typeof View> & Omit<GlassBackdropProps, 'shapeClassName'> & { fallbackClassName?: string }) {
  const glass = useContext(GlassContext);
  const { colors } = useTheme();
  const enabled = glass?.enabled === true;
  return (
    <View
      className={cn('relative overflow-hidden', className, !enabled && fallbackClassName)}
      style={[enabled ? undefined : { borderColor: colors.divider }, style]}
      {...props}>
      {(enabled || fallbackClassName === undefined) && <GlassBackdrop effect={effect} intensity={intensity} shapeClassName={className} tintOpacity={tintOpacity} />}
      {children}
    </View>
  );
}
