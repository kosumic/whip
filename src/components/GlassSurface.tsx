import {
  isLiquidGlassSupported,
  LiquidGlassView,
} from '@callstack/liquid-glass';
import { BlurTargetView, BlurView } from 'expo-blur';
import { Portal } from '@rn-primitives/portal';
import { useContext, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { Platform, StyleSheet, View, type ViewInstance } from 'react-native';

import { cn } from '@/src/lib/utils';
import { GlassContext, type GlassContextValue } from '@/src/lib/glassContext';
import { useTheme } from '@/src/theme';
import { liquidGlassShapeStyle } from './glassShape';

export { useAppGlassEnabled } from '@/src/lib/glassContext';

const GLASS_BLUR_TARGET_STYLE = { flex: 1 } as const;

export function GlassProvider({ blurTarget, enabled, children }: GlassContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ blurTarget, enabled }), [blurTarget, enabled]);
  return <GlassContext.Provider value={value}>{children}</GlassContext.Provider>;
}

export function GlassBlurTarget({ children }: { children: ReactNode }) {
  const blurTarget = useRef<ViewInstance | null>(null);
  const enabled = useContext(GlassContext)?.enabled === true;
  return (
    <GlassProvider blurTarget={blurTarget} enabled={enabled}>
      <BlurTargetView ref={blurTarget} style={GLASS_BLUR_TARGET_STYLE}>
        {children}
      </BlurTargetView>
    </GlassProvider>
  );
}

export function GlassOverlayHost({
  children,
  overlays,
  blurTarget,
}: {
  children: ReactNode;
  overlays?: ReactNode;
  blurTarget?: RefObject<ViewInstance | null>;
}) {
  const localBlurTarget = useRef<ViewInstance | null>(null);
  const target = blurTarget ?? localBlurTarget;
  const enabled = useContext(GlassContext)?.enabled === true;
  return (
    <View style={GLASS_BLUR_TARGET_STYLE}>
      <BlurTargetView ref={target} style={GLASS_BLUR_TARGET_STYLE}>
        {children}
      </BlurTargetView>
      {/* Capture the body without capturing its overlays or changing its own backdrop. */}
      <GlassProvider blurTarget={target} enabled={enabled}>
        {overlays}
      </GlassProvider>
    </View>
  );
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
  blurTarget?: RefObject<ViewInstance | null>;
  effect?: 'glass' | 'blur';
  intensity?: number;
  shapeClassName?: string;
  tintOpacity?: number;
}

export function GlassBackdrop({
  blurTarget,
  effect = 'glass',
  intensity = 36,
  shapeClassName,
  tintOpacity,
}: GlassBackdropProps) {
  const glass = useContext(GlassContext);
  const { colors, isDark } = useTheme();
  const enabled = glass?.enabled === true;
  // Explicit blur surfaces stay frosted even when Liquid Glass is available.
  const renderLiquidGlass = enabled && effect === 'glass' && isLiquidGlassSupported;
  // Screen-wide Android blurs caused tab-switch stalls. Only explicit blur
  // surfaces capture the shared target on Android.
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
          blurTarget={blurTarget ?? glass?.blurTarget}
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
  blurTarget,
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
      {(enabled || fallbackClassName === undefined) && <GlassBackdrop blurTarget={blurTarget} effect={effect} intensity={intensity} shapeClassName={className} tintOpacity={tintOpacity} />}
      {children}
    </View>
  );
}
