import { useRef, type ReactNode, type Ref } from 'react';
import { Maximize2, Paperclip, Send, X } from 'lucide-react-native';
import {
  ActivityIndicator,
  View,
  type ColorValue,
  type TextInput as TextInputHandle,
} from 'react-native';

import { APP_GLASS_FLOATING_CONTROL_CLASS } from '../lib/appGlass';
import { cn } from '../lib/utils';
import { hapticSend } from '../services/interactionFeedback';
import { appGlassControlStyle, useTheme } from '../theme';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Input } from './ui/input';

type ComposerInputProps = Omit<React.ComponentProps<typeof Input>, 'defaultValue' | 'value'> & {
  initialValue: string;
};

/**
 * Keeps Android's native text value uncontrolled while an IME composition is
 * active. Terminal and agent chat must share this behavior so partial IME
 * results are never replaced by a React render.
 */
export function ComposerInput({ initialValue, ...props }: ComposerInputProps) {
  const nativeInitialValue = useRef(initialValue).current;
  return <Input {...props} defaultValue={nativeInitialValue} />;
}

interface MessageComposerProps extends ComposerInputProps {
  actions: {
    actionClassName?: string;
    actionColor: ColorValue;
    attachLabel: string;
    closeLabel: string;
    expandLabel: string;
    onAttach: () => void;
    onClose: () => void;
    onExpand: () => void;
    onSend: () => boolean;
    sendLabel: string;
    sendClassName?: string;
    sendColor: ColorValue;
    sendDisabled?: boolean;
    sending?: boolean;
  };
  beforeInput?: ReactNode;
  className?: string;
  glass?: boolean;
  inputClassName?: string;
  inputRef?: Ref<TextInputHandle>;
  surfaceClassName?: string;
}

/** Shared composer layout used by terminal and native agent chat. */
export function MessageComposer({
  actions,
  beforeInput,
  className,
  glass = false,
  inputClassName,
  inputRef,
  surfaceClassName,
  ...inputProps
}: MessageComposerProps) {
  const { colors } = useTheme();
  const actionStyle = glass
    ? { borderColor: appGlassControlStyle(false, colors).borderColor }
    : undefined;
  const sendStyle = glass
    ? { borderColor: appGlassControlStyle(true, colors).borderColor }
    : undefined;
  const actionColor = glass ? colors.text : actions.actionColor;
  const sendColor = glass ? colors.primary : actions.sendColor;
  const surfaceContent = (
    <>
      {beforeInput}
      <ComposerInput
        {...inputProps}
        ref={inputRef}
        className={cn('rounded-none border-0 bg-transparent shadow-none', inputClassName)}
      />
    </>
  );
  return (
    <View className={cn('min-w-0 flex-row items-end gap-2', className)}>
      <View className="gap-1.5">
        <Button
          accessibilityLabel={actions.attachLabel}
          className={cn(
            'size-10 rounded-full px-0',
            glass
              ? cn('border', APP_GLASS_FLOATING_CONTROL_CLASS)
              : actions.actionClassName,
          )}
          style={actionStyle}
          variant={glass ? 'ghost' : 'secondary'}
          onPress={actions.onAttach}
        >
          <Paperclip size={18} color={actionColor} />
        </Button>
        <Button
          accessibilityLabel={actions.expandLabel}
          className={cn(
            'size-10 rounded-full px-0',
            glass
              ? cn('border', APP_GLASS_FLOATING_CONTROL_CLASS)
              : actions.actionClassName,
          )}
          style={actionStyle}
          variant={glass ? 'ghost' : 'secondary'}
          onPress={actions.onExpand}
        >
          <Maximize2 size={17} color={actionColor} />
        </Button>
      </View>
      {glass ? (
        <GlassSurface
          className={cn(
            'min-w-0 flex-1 overflow-hidden rounded-[38px] border border-white/30 dark:border-white/10',
            surfaceClassName,
          )}
          intensity={44}
        >
          {surfaceContent}
        </GlassSurface>
      ) : (
        <View
          className={cn(
            'min-w-0 flex-1 overflow-hidden rounded-[38px] border border-border bg-card',
            surfaceClassName,
          )}
        >
          {surfaceContent}
        </View>
      )}
      <View className="gap-1.5">
        <Button
          accessibilityLabel={actions.sendLabel}
          className={cn(
            'size-10 rounded-full px-0',
            glass
              ? cn('border', APP_GLASS_FLOATING_CONTROL_CLASS)
              : actions.sendClassName,
          )}
          disabled={actions.sendDisabled}
          style={sendStyle}
          variant={glass ? 'ghost' : 'default'}
          onPress={hapticSend(actions.onSend)}
        >
          {actions.sending ? (
            <ActivityIndicator size="small" color={sendColor} />
          ) : (
            <Send size={17} color={sendColor} />
          )}
        </Button>
        <Button
          accessibilityLabel={actions.closeLabel}
          className={cn(
            'size-10 rounded-full px-0',
            glass
              ? cn('border', APP_GLASS_FLOATING_CONTROL_CLASS)
              : actions.actionClassName,
          )}
          style={actionStyle}
          variant={glass ? 'ghost' : 'secondary'}
          onPress={actions.onClose}
        >
          <X size={17} color={actionColor} />
        </Button>
      </View>
    </View>
  );
}
