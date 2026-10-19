import { useCallback, useEffect, useRef, type ReactNode, type Ref } from 'react';
import { Maximize2, Mic, Paperclip, Send, Square } from 'lucide-react-native';
import type { ComposerDictationPhase } from 'react-native-whip-ssh/src/composerDictation';
import {
  ActivityIndicator,
  findNodeHandle,
  View,
  type ColorValue,
  type TextInput as TextInputHandle,
} from 'react-native';

import {
  APP_GLASS_BORDER_CLASS_NAME,
  APP_GLASS_FLOATING_CONTROL_CLASS,
  COMPOSER_GLASS_SURFACE_PROPS,
} from '../lib/appGlass';
import { cn } from '../lib/utils';
import { hapticSend } from '../services/interactionFeedback';
import { watchComposerFont } from '../services/composerFont';
import { watchComposerImagePaste } from '../services/composerImagePaste';
import {
  discardClipboardAttachment,
  type ClipboardAttachmentResult,
} from '../services/attachmentPaste';
import { appGlassControlStyle, useTheme } from '../theme';
import { GlassSurface } from './GlassSurface';
import { Button, type ButtonProps } from './ui/button';
import { Input } from './ui/input';

type ComposerInputProps = Omit<React.ComponentProps<typeof Input>, 'defaultValue' | 'value'> & {
  initialValue: string;
  pasteTargetKey?: string;
  onImagePaste?: (attachment: ClipboardAttachmentResult) => void;
  onImagePasteError?: (error: Error) => void;
};

/**
 * Keeps Android's native text value uncontrolled while an IME composition is
 * active. Terminal and agent chat must share this behavior so partial IME
 * results are never replaced by a React render.
 */
export function ComposerInput({
  initialValue,
  ref,
  onLayout,
  pasteTargetKey,
  onImagePaste,
  onImagePasteError,
  ...props
}: ComposerInputProps) {
  const nativeInitialValue = useRef(initialValue).current;
  const input = useRef<TextInputHandle | null>(null);
  const laidOut = useRef(false);
  const fontBinding = useRef<{ tag: number; stop: () => void } | null>(null);
  const binding = useRef<{ tag: number; stop: () => void } | null>(null);
  const callbacks = useRef({ pasteTargetKey, onImagePaste, onImagePasteError });
  callbacks.current = { pasteTargetKey, onImagePaste, onImagePasteError };
  const enabled = Boolean(onImagePaste);
  const connect = useCallback(() => {
    if (!laidOut.current) return;
    const tag = findNodeHandle(input.current);
    if (tag === null) return;
    if (fontBinding.current?.tag !== tag) {
      fontBinding.current?.stop();
      fontBinding.current = { tag, stop: watchComposerFont(tag) };
    }
    if (!enabled || binding.current?.tag === tag) return;
    binding.current?.stop();
    const targetKey = pasteTargetKey;
    binding.current = {
      tag,
      stop: watchComposerImagePaste(
        tag,
        attachment => {
          if (callbacks.current.pasteTargetKey !== targetKey || !callbacks.current.onImagePaste) {
            discardClipboardAttachment(attachment);
            return;
          }
          callbacks.current.onImagePaste(attachment);
        },
        error => {
          if (callbacks.current.pasteTargetKey === targetKey)
            callbacks.current.onImagePasteError?.(error);
        },
      ),
    };
  }, [enabled, pasteTargetKey]);
  useEffect(() => {
    connect();
    return () => {
      fontBinding.current?.stop();
      fontBinding.current = null;
      binding.current?.stop();
      binding.current = null;
    };
  }, [connect]);
  const setInputRef = useCallback((handle: TextInputHandle | null) => {
    input.current = handle;
    if (typeof ref === 'function') ref(handle);
    else if (ref) ref.current = handle;
  }, [ref]);
  return (
    <Input
      {...props}
      ref={setInputRef}
      defaultValue={nativeInitialValue}
      onLayout={event => {
        laidOut.current = true;
        connect();
        onLayout?.(event);
      }}
    />
  );
}

export function ComposerVoiceButton({
  phase,
  iconColor,
  ...props
}: ButtonProps & { phase: ComposerDictationPhase; iconColor: ColorValue }) {
  const waiting = phase === 'preparing' || phase === 'finishing';
  return (
    <Button
      {...props}
      accessibilityState={{ selected: phase === 'listening', busy: waiting, disabled: props.disabled === true }}
    >
      {waiting ? <ActivityIndicator size="small" color={iconColor} />
        : phase === 'listening' ? <Square size={17} color={iconColor} />
        : <Mic size={18} color={iconColor} />}
    </Button>
  );
}

interface MessageComposerProps extends ComposerInputProps {
  actions: {
    actionClassName?: string;
    actionColor: ColorValue;
    attachLabel: string;
    voiceLabel: string;
    voicePhase: ComposerDictationPhase;
    voiceDisabled?: boolean;
    expandLabel: string;
    onAttach: () => void;
    onVoiceInput: () => void;
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
        className={cn('rounded-none border-0 bg-transparent dark:bg-transparent shadow-none', inputClassName)}
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
            'min-w-0 flex-1 overflow-hidden rounded-[38px]',
            APP_GLASS_BORDER_CLASS_NAME,
            surfaceClassName,
          )}
          {...COMPOSER_GLASS_SURFACE_PROPS}
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
        <ComposerVoiceButton
          accessibilityLabel={actions.voiceLabel}
          className={cn(
            'size-10 rounded-full px-0',
            glass
              ? cn('border', APP_GLASS_FLOATING_CONTROL_CLASS)
              : actions.actionClassName,
          )}
          style={actionStyle}
          variant={glass ? 'ghost' : 'secondary'}
          disabled={actions.voiceDisabled}
          onPress={actions.onVoiceInput}
          phase={actions.voicePhase}
          iconColor={actions.voicePhase === 'listening' ? colors.primary : actionColor}
        />
      </View>
    </View>
  );
}
