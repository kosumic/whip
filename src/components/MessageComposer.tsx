import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import ArrowUp from 'lucide-react-native/icons/arrow-up';
import AudioLines from 'lucide-react-native/icons/audio-lines';
import Maximize2 from 'lucide-react-native/icons/maximize-2';
import Mic from 'lucide-react-native/icons/mic';
import Plus from 'lucide-react-native/icons/plus';
import Square from 'lucide-react-native/icons/square';
import type { ComposerDictationPhase } from 'react-native-whip-ssh/src/composerDictation';
import {
  ActivityIndicator,
  findNodeHandle,
  View,
  type ColorValue,
  type TextInputInstance,
} from 'react-native';

import {
  APP_GLASS_BORDER_CLASS_NAME,
  COMPOSER_GLASS_SURFACE_PROPS,
} from '../lib/appGlass';
import { useAppFontScale } from '../hooks/useAppFontScale';
import { cn } from '../lib/utils';
import { hapticSend } from '../services/interactionFeedback';
import { watchComposerFont } from '../services/composerFont';
import { watchComposerImagePaste } from '../services/composerImagePaste';
import {
  discardClipboardAttachment,
  type ClipboardAttachmentResult,
} from '../services/attachmentPaste';
import { useTheme } from '../theme';
import { GlassSurface } from './GlassSurface';
import { Button, type ButtonProps } from './ui/button';
import { Input } from './ui/input';

const COMPOSER_LINE_HEIGHT = 24;
const COMPOSER_INPUT_PADDING = 12;
const COMPOSER_MAX_LINES = 7;
const COMPOSER_CONTROL_CLASS = 'size-11 rounded-full px-0';
const COMPOSER_COMPACT_INPUT_LEFT = 54;
const COMPOSER_COMPACT_INPUT_RIGHT = 100;
const COMPOSER_TOOLBAR_HEIGHT = 50;

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
  const input = useRef<TextInputInstance | null>(null);
  const laidOut = useRef(false);
  const fontBinding = useRef<{ tag: number; stop: () => void } | null>(null);
  const binding = useRef<{ tag: number; stop: () => void } | null>(null);
  const callbacks = useRef({ pasteTargetKey, onImagePaste, onImagePasteError });
  callbacks.current = { pasteTargetKey, onImagePaste, onImagePasteError };
  const enabled = Boolean(onImagePaste);
  const connect = useCallback(() => {
    if (!laidOut.current) return;
    const tag = findNodeHandle(input.current);
    if (tag == null) return;
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
  const setInputRef = useCallback((handle: TextInputInstance | null) => {
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
        : <Mic size={22} color={iconColor} />}
    </Button>
  );
}

interface MessageComposerProps extends ComposerInputProps {
  actions: {
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
  inputRef?: Ref<TextInputInstance>;
  surfaceClassName?: string;
  voiceChatLabel?: string;
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
  voiceChatLabel,
  ...inputProps
}: MessageComposerProps) {
  const { colors } = useTheme();
  const fontScale = useAppFontScale();
  const minInputHeight = COMPOSER_LINE_HEIGHT * fontScale + COMPOSER_INPUT_PADDING * 2;
  const maxInputHeight = COMPOSER_LINE_HEIGHT * fontScale * COMPOSER_MAX_LINES
    + COMPOSER_INPUT_PADDING * 2;
  const [contentHeight, setContentHeight] = useState(minInputHeight);
  const [focused, setFocused] = useState(false);
  const hasDraft = inputProps.initialValue.length > 0;
  const expanded = focused || hasDraft;
  const showVoiceChat = Boolean(voiceChatLabel && !hasDraft && !focused && !actions.sendDisabled);
  const actionColor = glass ? colors.text : actions.actionColor;
  const inputHeight = expanded
    ? Math.max(minInputHeight, Math.min(contentHeight, maxInputHeight))
    : minInputHeight;
  const surfaceContent = (
    <>
      {beforeInput}
      {/* Keep the native input parent mounted when focus changes the layout. */}
      <View
        collapsable={false}
        className="min-w-0"
        style={{ paddingTop: expanded ? 0 : 4, paddingBottom: expanded ? COMPOSER_TOOLBAR_HEIGHT : 4 }}
      >
        <Button
          accessibilityLabel={actions.attachLabel}
          className={cn(COMPOSER_CONTROL_CLASS, 'absolute bottom-1.5 left-1.5 z-10')}
          variant="ghost"
          onPress={actions.onAttach}
        >
          <Plus size={26} color={actionColor} />
        </Button>
        <ComposerInput
          {...inputProps}
          ref={inputRef}
          className={cn(
            'rounded-none border-0 bg-transparent px-4 py-3 text-[17px] leading-6 shadow-none dark:bg-transparent',
            inputClassName,
          )}
          style={[inputProps.style, {
            height: inputHeight,
            paddingLeft: expanded ? 16 : COMPOSER_COMPACT_INPUT_LEFT,
            paddingRight: expanded ? 16 : COMPOSER_COMPACT_INPUT_RIGHT,
          }]}
          onContentSizeChange={event => {
            setContentHeight(Math.ceil(event.nativeEvent.contentSize.height));
            inputProps.onContentSizeChange?.(event);
          }}
          onFocus={event => {
            setFocused(true);
            inputProps.onFocus?.(event);
          }}
          onBlur={event => {
            setFocused(false);
            inputProps.onBlur?.(event);
          }}
          scrollEnabled={expanded && contentHeight > maxInputHeight}
        />
        <View collapsable={false} className="absolute bottom-1.5 right-1.5 flex-row items-center justify-end">
          {expanded && (
            <Button
              accessibilityLabel={actions.expandLabel}
              className={COMPOSER_CONTROL_CLASS}
              variant="ghost"
              onPress={actions.onExpand}
            >
              <Maximize2 size={20} color={actionColor} />
            </Button>
          )}
          <ComposerVoiceButton
            accessibilityLabel={actions.voiceLabel}
            className={COMPOSER_CONTROL_CLASS}
            variant="ghost"
            disabled={actions.voiceDisabled}
            onPress={actions.onVoiceInput}
            phase={actions.voicePhase}
            iconColor={actions.voicePhase === 'listening' ? colors.primary : actionColor}
          />
          <Button
            accessibilityLabel={showVoiceChat ? voiceChatLabel : actions.sendLabel}
            className={COMPOSER_CONTROL_CLASS}
            disabled={actions.sendDisabled}
            variant="ghost"
            onPress={showVoiceChat ? undefined : hapticSend(actions.onSend)}
          >
            <View className={cn('size-9 items-center justify-center rounded-full bg-primary', actions.sendClassName)}>
              {actions.sending ? (
                <ActivityIndicator size="small" color={actions.sendColor} />
              ) : showVoiceChat ? (
                <AudioLines size={22} color={actions.sendColor} />
              ) : (
                <ArrowUp size={22} color={actions.sendColor} />
              )}
            </View>
          </Button>
        </View>
      </View>
    </>
  );
  return (
    <View className={cn('min-w-0', className)}>
      {glass ? (
        <GlassSurface
          className={cn(
            'min-w-0 overflow-hidden rounded-[28px]',
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
            'min-w-0 overflow-hidden rounded-[28px] border border-border bg-card',
            surfaceClassName,
          )}
        >
          {surfaceContent}
        </View>
      )}
    </View>
  );
}
