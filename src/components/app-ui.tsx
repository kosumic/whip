import * as Haptics from 'expo-haptics';
import { RefreshCw, type LucideIcon } from 'lucide-react-native';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  AccessibilityInfo,
  AppState,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { LocalSvg } from 'react-native-svg/css';
import { useTranslation } from 'react-i18next';

import { cn } from '@/src/lib/utils';
import { bundledAsset } from '@/src/lib/bundledAsset';
import {
  agentStatusGlyph,
  statusMotionKind,
  statusTone,
} from '@/src/lib/statusMotion';
import { appGlassControlStyle, colorWithAlpha, useTheme } from '@/src/theme';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from '@/src/services/operationalDiagnostics';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { NativeAgentSpinner } from './NativeAgentSpinner';
import { useDecorativeProgress } from '../hooks/useDecorativeProgress';
import { useSpinnerFrameRate } from '../hooks/useSpinnerFrameRate';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Text } from './ui/text';

const ReducedMotionContext = createContext(false);
const AgentStatusAnimationContext = createContext(true);
const AGENT_SPINNER_ROTATION_MS = 700;

export function ReducedMotionProvider({ children }: { children: ReactNode }) {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(value => {
        if (mounted) setReduceMotion(value);
      })
      .catch(error => {
        recordOperationalDiagnostic('warn', 'Application', 'reduced-motion-preference-read-failed', {
          operation: 'isReduceMotionEnabled',
          fallbackUsed: 'animations-enabled',
          ...operationalErrorDetails(error),
        });
      });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return (
    <ReducedMotionContext.Provider value={reduceMotion}>
      {children}
    </ReducedMotionContext.Provider>
  );
}

export function AgentStatusAnimationProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      setAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  return (
    <AgentStatusAnimationContext.Provider value={enabled && appActive}>
      {children}
    </AgentStatusAnimationContext.Provider>
  );
}

export function WhipMark({
  size,
  accessibilityLabel,
}: {
  size: number;
  accessibilityLabel?: string;
}) {
  return (
    <LocalSvg
      accessibilityLabel={accessibilityLabel}
      accessible={Boolean(accessibilityLabel)}
      asset={bundledAsset(require('../../assets/whip-cyborg-hand-concept.svg'))}
      height={size}
      width={size}
    />
  );
}

export function HerdrMark({ size, accessibilityLabel }: { size: number; accessibilityLabel?: string }) {
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessible={Boolean(accessibilityLabel)}
      style={[styles.herdrMark, { width: size, height: size, borderRadius: size / 4 }]}>
      <Svg width={size} height={size} viewBox="0 0 512 512" preserveAspectRatio="xMidYMid meet">
        <Rect width="512" height="512" fill="#d9dad8" />
        <G fill="#303438" transform="translate(0 512) scale(.1 -.1)" stroke="none">
          <Path d="M2794 3710 c-129 -33 -299 -135 -359 -214 -21 -28 -26 -42 -21 -63 9 -38 154 -178 199 -192 32 -11 41 -9 104 23 171 86 354 70 475 -43 150 -138 150 -379 0 -511 -107 -95 -278 -94 -386 2 l-46 40 -11 -29 c-16 -40 -14 -122 4 -164 60 -144 264 -222 452 -174 360 92 559 494 430 868 -36 103 -81 173 -175 267 -71 72 -100 93 -180 132 -52 26 -127 54 -167 62 -96 21 -230 20 -319 -4z M2183 3695 c-116 -32 -221 -108 -273 -199 -17 -28 -30 -54 -30 -58 0 -4 20 1 45 12 66 28 220 68 294 76 64 7 65 7 137 83 40 41 71 77 69 79 -2 2 -21 8 -42 13 -55 12 -140 10 -200 -6z M2212 3388 c-159 -22 -390 -122 -559 -241 -299 -210 -585 -600 -609 -828 -12 -118 40 -251 125 -318 96 -76 178 -98 426 -116 110 -8 224 -21 254 -29 125 -34 230 -115 272 -211 11 -24 24 -81 30 -127 20 -170 65 -271 166 -374 34 -35 63 -65 63 -67 0 -1 -10 -27 -22 -57 -29 -76 -37 -259 -14 -350 42 -170 158 -318 311 -397 44 -23 98 -46 120 -52 22 -6 45 -14 51 -18 5 -5 15 -48 22 -96 6 -48 14 -92 17 -97 4 -6 415 -10 1131 -10 l1124 0 0 1584 0 1585 -55 -19 c-84 -29 -143 -68 -232 -154 l-83 -78 -54 49 c-111 102 -233 151 -391 160 -113 6 -199 -10 -298 -54 l-60 -27 -26 34 c-37 51 -120 134 -127 128 -3 -4 0 -34 7 -67 17 -89 7 -268 -21 -356 -103 -328 -377 -545 -688 -545 -161 0 -273 41 -373 137 -37 35 -66 75 -85 116 -79 173 -8 407 124 407 44 0 68 -14 117 -66 74 -78 167 -82 238 -9 60 62 72 147 33 231 -42 90 -120 130 -238 122 -50 -4 -85 -14 -131 -37 -89 -45 -122 -52 -176 -40 -92 20 -262 163 -302 253 -11 25 -21 45 -22 45 -1 -1 -30 -6 -65 -11z m-256 -505 c115 -88 129 -102 132 -131 2 -18 -2 -40 -9 -49 -7 -8 -69 -55 -138 -105 -103 -73 -130 -88 -151 -83 -35 8 -51 34 -48 74 3 31 12 42 83 92 44 31 80 61 82 66 1 4 -30 31 -69 58 -39 28 -77 56 -85 63 -18 19 -16 72 4 94 32 35 63 23 199 -79z m528 -88 c23 -24 28 -52 14 -82 l-13 -28 -141 -3 c-130 -2 -142 -1 -158 17 -23 26 -24 66 -1 91 16 18 32 20 151 20 105 0 136 -3 148 -15z" />
        </G>
      </Svg>
    </View>
  );
}

export function hapticPress(handler?: () => void | Promise<void>) {
  return () => {
    reportBackgroundFailure(Haptics.selectionAsync(), 'haptic-feedback');
    const operation = handler?.();
    if (operation) reportBackgroundFailure(operation, 'haptic-press-handler');
  };
}

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  className,
  destructive = false,
  disabled = false,
  selected = false,
}: {
  icon: LucideIcon;
  accessibilityLabel: string;
  onPress: () => void;
  className?: string;
  destructive?: boolean;
  disabled?: boolean;
  selected?: boolean;
}) {
  const { colors } = useTheme();
  const IconComponent = icon;
  return (
    <Button
      accessibilityLabel={accessibilityLabel}
      className={cn('rounded-full', selected && 'bg-primary', className)}
      disabled={disabled}
      size="icon"
      variant="ghost"
      onPress={hapticPress(onPress)}>
      <IconComponent size={21} color={destructive ? colors.error : selected ? colors.onPrimary : colors.text} />
    </Button>
  );
}

export function StatusBadge({ status, label, agentStatus = false, showIndicator = true }: { status: string; label?: string; agentStatus?: boolean; showIndicator?: boolean }) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const { t } = useTranslation();
  const tone = statusTone(status);
  const indicatorColor = { success: colors.working, destructive: colors.error, warning: colors.warning, muted: colors.textTertiary }[tone];
  const textClass = { success: 'text-success', destructive: 'text-destructive', warning: 'text-warning', muted: 'text-muted-foreground' }[tone];
  return (
    <Badge
      variant="secondary"
      className="gap-1.5 px-2.5 py-1"
      style={appGlassEnabled
        ? appGlassControlStyle(false, colors)
        : { borderColor: colors.divider }}>
      {showIndicator && (agentStatus
        ? <AnimatedAgentStatusGlyph status={status} color={indicatorColor} size={12} />
        : <AnimatedStatusIndicator status={status} color={indicatorColor} />)}
      <Text className={cn('text-xs font-semibold capitalize', textClass)}>{label || t(`status.${status}`, { defaultValue: status })}</Text>
    </Badge>
  );
}

export function AnimatedStatusIndicator({ status, color, size = 7 }: { status: string; color: string; size?: number }) {
  const animationsEnabled = useContext(AgentStatusAnimationContext);
  const { motion, style, reduceMotion } = useStatusMotion(status, true, true, animationsEnabled);
  const bloomStyle = useStatusBloom(status, reduceMotion, animationsEnabled);

  if (motion === 'spin') {
    const iconSize = Math.max(11, size);
    return (
      <Animated.View style={style}>
        <RefreshCw size={iconSize} color={color} />
      </Animated.View>
    );
  }

  if (status === 'idle') {
    return <Animated.View className="rounded-full" style={[{ width: size, height: size, backgroundColor: color }, style]} />;
  }

  const frameSize = size + 8;
  return (
    <View
      className="items-center justify-center overflow-hidden rounded-full"
      style={{ width: frameSize, height: frameSize }}>
      <Animated.View style={[statusBloomStyle(color, size), bloomStyle]} />
      <Animated.View className="rounded-full" style={[{ width: size, height: size, backgroundColor: color }, style]} />
    </View>
  );
}

export function AnimatedAgentStatusGlyph({
  status,
  color,
  size = 18,
}: {
  status: string;
  color: string;
  size?: number;
}) {
  const reduceMotion = useReducedMotion();
  const animationsEnabled = useContext(AgentStatusAnimationContext);
  const spins = status === 'working' || status === 'running';
  const { style } = useStatusMotion(status, false, false, animationsEnabled);
  const glyphBoxSize = size + 4;
  return (
    <Animated.View className="items-center justify-center" style={[{ width: glyphBoxSize, height: glyphBoxSize }, style]}>
      {spins ? (
        <NativeAgentSpinner
          color={color}
          durationMs={AGENT_SPINNER_ROTATION_MS}
          enabled={animationsEnabled && !reduceMotion}
          size={size}
        />
      ) : status === 'blocked' ? (
        <BlockedAgentStatusGlyph color={color} size={size * 1.1} />
      ) : (
        <Text
          className="text-center"
          style={[
            styles.statusGlyphText,
            Platform.OS === 'android' && styles.statusGlyphTextAndroid,
            { color, fontSize: size, lineHeight: glyphBoxSize },
          ]}
        >
          {agentStatusGlyph(status)}
        </Text>
      )}
    </Animated.View>
  );
}

function BlockedAgentStatusGlyph({ color, size }: { color: string; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={10} fill="none" stroke={color} strokeWidth={2.5} />
      <Circle cx={12} cy={12} r={3.5} fill={color} />
    </Svg>
  );
}

export function AgentStatusMedallion({
  accessibilityLabel,
  status,
  color,
  connected = false,
  icon: IconComponent,
  children,
  size = 44,
  glyphSize = 24,
}: {
  accessibilityLabel: string;
  status: string;
  color: string;
  connected?: boolean;
  icon?: LucideIcon;
  children?: ReactNode;
  size?: number;
  glyphSize?: number;
}) {
  const reduceMotion = useReducedMotion();
  const animationsEnabled = useContext(AgentStatusAnimationContext);
  const bloomStyle = useConnectedHostBloom(connected, reduceMotion, animationsEnabled);
  const bloomSize = size + 4;
  const glyph = () => children || (IconComponent
    ? <IconComponent color={color} size={glyphSize} strokeWidth={2.25} />
    : <AnimatedAgentStatusGlyph status={status} color={color} size={glyphSize} />);
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      className="items-center justify-center"
      style={{ width: bloomSize, height: bloomSize }}>
      {connected ? (
        <Animated.View
          pointerEvents="none"
          className="absolute rounded-full"
          style={[statusBloomStyle(color, bloomSize), bloomStyle]}
        />
      ) : null}
      <GlassSurface
        className="items-center justify-center rounded-full border"
        intensity={28}
        style={{
          width: size,
          height: size,
          borderColor: colorWithAlpha(color, '8F'),
        }}>
        {glyph()}
      </GlassSurface>
    </View>
  );
}

export function AnimatedEntrance({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(progress);
      progress.value = 1;
      return;
    }
    progress.value = withDelay(delay, withTiming(1, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
    }));
    return () => cancelAnimation(progress);
  }, [delay, progress, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: 8 * (1 - progress.value) }],
  }));

  return (
    <Animated.View
      className={className}
      style={animatedStyle}>
      {children}
    </Animated.View>
  );
}

function useStatusMotion(
  status: string,
  rotateSpinning = true,
  scalePulsing = true,
  animationsEnabled = true,
) {
  const motion = statusMotionKind(status);
  const reduceMotion = useReducedMotion();
  const spinnerFrameRate = useSpinnerFrameRate();
  const progress = useDecorativeProgress(
    animationsEnabled && !reduceMotion && motion !== 'static' && (motion !== 'spin' || rotateSpinning),
    motion === 'spin' ? 900 : 700,
    motion !== 'spin',
    motion === 'spin' ? spinnerFrameRate : undefined,
  );

  const style = useAnimatedStyle(() => {
    if (motion === 'spin' && rotateSpinning) {
      return {
        opacity: 1,
        transform: [{ rotate: `${progress.value * 360}deg` }],
      };
    }
    if (motion === 'pulse') {
      return {
        opacity: 1 - (progress.value * 0.45),
        transform: [{ scale: scalePulsing ? 1 - (progress.value * 0.18) : 1 }],
      };
    }
    return { opacity: 1, transform: [{ scale: 1 }] };
  }, [motion, rotateSpinning, scalePulsing]);
  return { motion, style, reduceMotion };
}

export function useReducedMotion() {
  return useContext(ReducedMotionContext);
}

function useStatusBloom(status: string, reduceMotion: boolean, animationsEnabled: boolean) {
  const breathes = ['done', 'connected', 'active'].includes(status);
  const progress = useDecorativeProgress(animationsEnabled && breathes && !reduceMotion, 1100);

  return useAnimatedStyle(() => {
    if (!animationsEnabled || !breathes || reduceMotion) {
      return { opacity: 0.62, transform: [{ scale: 1 }] };
    }
    return {
      opacity: 0.42 + (progress.value * 0.4),
      transform: [{ scale: 0.78 + (progress.value * 0.3) }],
    };
  }, [animationsEnabled, breathes, reduceMotion]);
}

function useConnectedHostBloom(connected: boolean, reduceMotion: boolean, animationsEnabled: boolean) {
  const progress = useDecorativeProgress(animationsEnabled && connected && !reduceMotion, 1400);

  return useAnimatedStyle(() => ({
    opacity: !animationsEnabled || reduceMotion ? 0.62 : 0.32 + (progress.value * 0.5),
    transform: [{ scale: !animationsEnabled || reduceMotion ? 1 : 0.9 + (progress.value * 0.16) }],
  }), [animationsEnabled, reduceMotion]);
}

function statusBloomStyle(color: string, size: number) {
  return {
    position: 'absolute',
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: colorWithAlpha(color, '38'),
    boxShadow: [
      {
        offsetX: 0,
        offsetY: 0,
        blurRadius: Math.max(3, size * 0.5),
        spreadDistance: 0,
        color: colorWithAlpha(color, 'A3'),
      },
    ],
  } as const;
}

export function ScreenHeader({ title, subtitle, left, right }: { title: string; subtitle?: string; left?: ReactNode; right?: ReactNode }) {
  return (
    <GlassSurface className="min-h-16 flex-row items-center border-b border-white/30 px-4 py-2 dark:border-white/10">
      {left ? <View className="mr-2 min-w-10">{left}</View> : null}
      <View className="min-w-0 flex-1">
        <Text className="text-[17px] font-semibold leading-6" numberOfLines={1}>{title}</Text>
        {subtitle ? <Text className="text-xs leading-4 text-muted-foreground" numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right ? <View className="ml-2 min-w-10 items-end">{right}</View> : null}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  herdrMark: {
    overflow: 'hidden',
  },
  statusGlyphText: {
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  statusGlyphTextAndroid: {
    transform: [{ translateY: -1 }],
  },
});
