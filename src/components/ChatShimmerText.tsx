/// <reference lib="es2022.intl" />

import { useMemo } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useDecorativeProgress } from '../hooks/useDecorativeProgress';
import { chatShimmerOpacity } from '../lib/chatWorkingAnimation';
import { useReducedMotion } from './app-ui';
import { Text } from './ui/text';

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : undefined;

function ShimmerLetter({ letter, index, length, periodMs, running, progress, textClassName }: {
  letter: string;
  index: number;
  length: number;
  periodMs: number;
  running: boolean;
  progress: SharedValue<number>;
  textClassName: string;
}) {
  const style = useAnimatedStyle(() => ({
    opacity: running ? chatShimmerOpacity(progress.value * periodMs, index, length) : 1,
  }), [index, length, periodMs, running]);
  return <Animated.View className="shrink-0" style={style}><Text className={textClassName}>{letter}</Text></Animated.View>;
}

export function ChatShimmerText({ text, periodMs, active, textClassName }: {
  text: string;
  periodMs: number;
  active: boolean;
  textClassName: string;
}) {
  const reduceMotion = useReducedMotion();
  const running = active && !reduceMotion;
  const letters = useMemo(() => segmenter
    ? Array.from(segmenter.segment(text), ({ segment }) => segment)
    : Array.from(text), [text]);
  const progress = useDecorativeProgress(running, periodMs, false);
  return (
    <View className="min-w-0 shrink flex-row overflow-hidden" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {letters.map((letter, index) => (
        <ShimmerLetter key={index} letter={letter} index={index} length={letters.length}
          periodMs={periodMs} running={running} progress={progress} textClassName={textClassName} />
      ))}
    </View>
  );
}
