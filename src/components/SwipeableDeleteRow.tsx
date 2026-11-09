import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, PanResponder, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import Trash2 from 'lucide-react-native/icons/trash';
import { REMOTE_FILE_SWIPE_ACTION_WIDTH, remoteFileSwipeOffset, shouldClaimRemoteFileSwipe, shouldOpenRemoteFileSwipe } from '../lib/remoteFileSwipeActions';
import { DEFAULT_SPRING_CONFIG } from '../lib/motion';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

export function SwipeableDeleteRow({ children, deleting, disabled, name, onDelete }: { children: (controls: { actionsOpen: boolean; closeActions: () => void }) => ReactNode; deleting: boolean; disabled: boolean; name: string; onDelete: () => void }) {
  const { t } = useTranslation();
  const translateX = useSharedValue(0);
  const openRef = useRef(false);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const [actionsOpen, setActionsOpen] = useState(false);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const actionRevealStyle = useAnimatedStyle(() => ({
    width: Math.max(0, -translateX.value),
  }));

  useEffect(() => () => cancelAnimation(translateX), [translateX]);

  const settle = (open: boolean) => {
    openRef.current = open;
    setActionsOpen(open);
    translateX.value = withSpring(open ? -REMOTE_FILE_SWIPE_ACTION_WIDTH : 0, DEFAULT_SPRING_CONFIG);
  };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_event, gesture) => !disabledRef.current && shouldClaimRemoteFileSwipe(gesture.dx, gesture.dy, openRef.current),
      onPanResponderGrant: () => cancelAnimation(translateX),
      onPanResponderMove: (_event, gesture) => {
        translateX.value = remoteFileSwipeOffset(gesture.dx, openRef.current);
      },
      onPanResponderRelease: (_event, gesture) => {
        settle(shouldOpenRemoteFileSwipe(gesture.dx, gesture.vx, openRef.current));
      },
      onPanResponderTerminate: () => settle(openRef.current),
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;

  const runDelete = () => {
    settle(false);
    onDelete();
  };

  return (
    <View className="relative min-h-[62px] overflow-hidden border-b border-border">
      <Animated.View accessibilityElementsHidden={!actionsOpen} className="absolute inset-y-0 right-0 overflow-hidden" importantForAccessibility={actionsOpen ? 'auto' : 'no-hide-descendants'} style={actionRevealStyle}>
        <Button accessibilityLabel={t('files.deleteEntry', { name })} className="absolute inset-y-0 right-0 h-full w-[84px] flex-col gap-1 rounded-none" disabled={disabled} size="content" variant="destructive" onPress={hapticPress(runDelete)}>
          {deleting ? <ActivityIndicator color="white" size="small" /> : <Icon as={Trash2} className="text-destructive-foreground" size={19} />}
          <Text className="text-[11px] font-semibold">{t('common.delete')}</Text>
        </Button>
      </Animated.View>
      <Animated.View style={animatedStyle} {...panResponder.panHandlers}>
        {children({ actionsOpen, closeActions: () => settle(false) })}
      </Animated.View>
    </View>
  );
}
