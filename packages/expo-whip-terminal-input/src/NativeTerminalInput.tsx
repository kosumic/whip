import { requireNativeViewManager } from 'expo-modules-core';
import { forwardRef, useImperativeHandle, useRef, type ComponentType, type RefAttributes } from 'react';
import {
  Platform,
  type NativeSyntheticEvent,
  type ViewProps,
} from 'react-native';

export interface NativeTerminalInputEvent {
  binding: string;
  data?: string;
  commandId?: number;
}

export interface NativeTerminalInputProps extends ViewProps {
  binding: string;
  onTerminalInput: (event: NativeSyntheticEvent<NativeTerminalInputEvent>) => void;
  onCommandError?: (error: Error) => void;
}

export interface NativeTerminalInputHandle {
  setEnabled: (enabled: boolean) => void;
  focus: () => void;
  blur: () => void;
  reset: () => void;
  barrier: (binding: string, commandId: number) => void;
  cursorKeys: (application: boolean) => void;
  modifiedInput: (active: boolean) => void;
  kittyKeyboard: (reportAll: boolean) => void;
}

type NativeMethods = {
  [Name in keyof NativeTerminalInputHandle]: (...args: Parameters<NativeTerminalInputHandle[Name]>) => Promise<void>;
};
type NativeProps = Omit<NativeTerminalInputProps, 'onCommandError'>;

const NativeInput: ComponentType<NativeProps & RefAttributes<NativeMethods>> | null = Platform.OS === 'android' || Platform.OS === 'ios'
  ? requireNativeViewManager<NativeProps & RefAttributes<NativeMethods>>('ExpoWhipTerminalInput')
  : null;
const INPUT_STYLE = { position: 'absolute', left: 0, top: 0, width: 1, height: 1 } as const;

export const NativeTerminalInput = forwardRef<NativeTerminalInputHandle, NativeTerminalInputProps>(
  function NativeTerminalInputComponent({ onCommandError, ...props }, forwardedRef) {
    const view = useRef<NativeMethods | null>(null);
    useImperativeHandle(forwardedRef, () => {
      const reportError = (reason: unknown) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        if (onCommandError) onCommandError(error);
        else console.error(error);
      };
      const command = (operation: (input: NativeMethods) => Promise<void>) => {
        const input = view.current;
        if (!input) {
          reportError(new Error('Terminal input view is unavailable'));
          return;
        }
        const execute = async () => {
          try {
            await operation(input);
          } catch (error) {
            reportError(error);
          }
        };
        void execute();
      };
      return {
        setEnabled: enabled => command(input => input.setEnabled(enabled)),
        focus: () => command(input => input.focus()),
        blur: () => command(input => input.blur()),
        reset: () => command(input => input.reset()),
        barrier: (binding, commandId) => command(input => input.barrier(binding, commandId)),
        cursorKeys: application => command(input => input.cursorKeys(application)),
        modifiedInput: active => command(input => input.modifiedInput(active)),
        kittyKeyboard: reportAll => command(input => input.kittyKeyboard(reportAll)),
      };
    }, [onCommandError]);
    return NativeInput ? <NativeInput {...props} ref={view} style={INPUT_STYLE}
      pointerEvents={Platform.OS === 'android' ? 'none' : undefined}
      collapsable={false} accessible={false} /> : null;
  },
);
