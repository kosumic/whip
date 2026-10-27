import { requireNativeViewManager } from 'expo-modules-core';
import type { ViewProps } from 'react-native';
import { SPINNER_FRAMES_PER_SECOND } from '../hooks/useDecorativeProgress';

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
  return (
    <NativeAgentSpinnerView
      color={color}
      durationMs={durationMs}
      enabled={enabled}
      framesPerSecond={SPINNER_FRAMES_PER_SECOND}
      pointerEvents="none"
      style={{ width: size, height: size }}
    />
  );
}
