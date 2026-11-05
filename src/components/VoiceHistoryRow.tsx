import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PanResponder, Pressable, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import X from 'lucide-react-native/icons/x';
import { useTranslation } from 'react-i18next';
import { createSwipeRevealPolicy } from '../lib/swipeReveal';
import { DEFAULT_SPRING_CONFIG } from '../lib/motion';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

const ACTION_WIDTH = 76;
const swipe = createSwipeRevealPolicy(ACTION_WIDTH);

export function VoiceHistoryRow({
  children,
  onOpen,
  onDelete,
  label,
  deleting = false,
}: {
  children: ReactNode;
  onOpen: () => void;
  onDelete: () => void;
  label?: string;
  deleting?: boolean;
}) {
  const { t } = useTranslation();
  const translateX = useSharedValue(0);
  const openRef = useRef(false);
  const [open, setOpen] = useState(false);
  const settle = (next: boolean) => {
    openRef.current = next;
    setOpen(next);
    translateX.value = withSpring(
      next ? -ACTION_WIDTH : 0,
      DEFAULT_SPRING_CONFIG,
    );
  };
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const revealStyle = useAnimatedStyle(() => ({
    width: Math.max(0, -translateX.value),
  }));
  useEffect(() => () => cancelAnimation(translateX), [translateX]);
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_event, gesture) =>
        swipe.shouldClaim(gesture.dx, gesture.dy, openRef.current),
      onPanResponderGrant: () => cancelAnimation(translateX),
      onPanResponderMove: (_event, gesture) => {
        translateX.value = swipe.offset(gesture.dx, openRef.current);
      },
      onPanResponderRelease: (_event, gesture) =>
        settle(swipe.shouldOpen(gesture.dx, gesture.vx, openRef.current)),
      onPanResponderTerminate: () => settle(openRef.current),
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;
  return (
    <View className="relative overflow-hidden border-b border-border">
      <Animated.View
        className="absolute inset-y-0 right-0 overflow-hidden bg-destructive"
        style={revealStyle}
        pointerEvents={open ? 'auto' : 'none'}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('voiceUsage.deleteEntry')}
          disabled={deleting}
          onPress={onDelete}
          className="h-full items-center justify-center gap-1"
          style={{ width: ACTION_WIDTH }}
        >
          <Icon as={X} size={22} className="text-destructive-foreground" />
          <Text className="text-xs text-destructive-foreground">
            {t('common.delete')}
          </Text>
        </Pressable>
      </Animated.View>
      <Animated.View style={animatedStyle} {...pan.panHandlers}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label ?? t('voiceUsage.openTranscript')}
          accessibilityHint={t('voiceUsage.openTranscript')}
          accessibilityActions={[
            { name: 'showDelete', label: t('voiceUsage.deleteEntry') },
          ]}
          onAccessibilityAction={event => {
            if (event.nativeEvent.actionName === 'showDelete') settle(true);
          }}
          disabled={deleting}
          onPress={() => {
            if (openRef.current) settle(false);
            else onOpen();
          }}
          className="gap-1 bg-background py-3"
        >
          {children}
        </Pressable>
      </Animated.View>
    </View>
  );
}
