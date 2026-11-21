import type { ViewProps } from 'react-native';
import { EdgeBackGesture } from './EdgeBackGesture';

export function SessionExitGesture({ children, enabled, onExit, ...viewProps }: ViewProps & {
  enabled: boolean;
  onExit: () => void;
}) {
  return (
    <EdgeBackGesture {...viewProps} enabled={enabled} onBack={onExit} rearmOnBack={false}>
      {children}
    </EdgeBackGesture>
  );
}
