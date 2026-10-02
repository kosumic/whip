import { requireNativeViewManager } from 'expo-modules-core';
import type { ViewProps } from 'react-native';
import { useSpinnerFrameRate } from '../hooks/useSpinnerFrameRate';

interface NativeAgentSpinnerViewProps extends ViewProps {
  color: string;
  durationMs: number;
  enabled: boolean;
  framesPerSecond: number;
}

const NativeAgentSpinnerView = requireNativeViewManager<NativeAgentSpinnerViewProps>(
  'WhipNativeSpinner',
  'WhipAgentSpinnerView',
);

export function NativeAgentSpinner({
  color,
  durationMs,
  enabled,
  size,
}: {
  color: string;
  durationMs: number;
  enabled: boolean;
  size: number;
}) {
  const framesPerSecond = useSpinnerFrameRate();
  return (
    <NativeAgentSpinnerView
      color={color}
      durationMs={durationMs}
      enabled={enabled}
      framesPerSecond={framesPerSecond}
      pointerEvents="none"
      style={{ width: size, height: size }}
    />
  );
}
