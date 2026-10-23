import { forwardRef, useImperativeHandle, useRef, type ComponentRef } from 'react';
import {
  findNodeHandle,
  Platform,
  requireNativeComponent,
  UIManager,
  type NativeSyntheticEvent,
  type ViewProps,
} from 'react-native';

export interface NativeTerminalInputEvent {
  binding: string;
  data?: string;
  commandId?: number;
}

interface Props extends ViewProps {
  binding: string;
  onTerminalInput: (event: NativeSyntheticEvent<NativeTerminalInputEvent>) => void;
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

const NativeInput = Platform.OS === 'android' || Platform.OS === 'ios'
  ? requireNativeComponent<Props>('WhipTerminalInput')
  : null;
const INPUT_STYLE = { position: 'absolute', left: 0, top: 0, width: 1, height: 1 } as const;

export const NativeTerminalInput = forwardRef<NativeTerminalInputHandle, Props>(
  function NativeTerminalInputComponent(props, forwardedRef) {
    const view = useRef<ComponentRef<NonNullable<typeof NativeInput>> | null>(null);
    useImperativeHandle(forwardedRef, () => {
      const command = (name: string, args: unknown[] = []) => {
        const tag = findNodeHandle(view.current);
        if (tag !== null) UIManager.dispatchViewManagerCommand(tag, name, args);
      };
      return {
        setEnabled: enabled => command('enabled', [enabled]),
        focus: () => command('focus'),
        blur: () => command('blur'),
        reset: () => command('reset'),
        barrier: (binding, commandId) => command('barrier', [binding, commandId]),
        cursorKeys: application => command('cursorKeys', [application]),
        modifiedInput: active => command('modifiedInput', [active]),
        kittyKeyboard: reportAll => command('kittyKeyboard', [reportAll]),
      };
    }, []);
    return NativeInput ? <NativeInput {...props} ref={view} style={INPUT_STYLE}
      pointerEvents={Platform.OS === 'android' ? 'none' : undefined}
      collapsable={false} accessible={false} /> : null;
  },
);
