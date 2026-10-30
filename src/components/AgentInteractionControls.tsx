import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react-native';
import { useEffect, useReducer, useRef } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import type {
  NativeAgentInteractionPrompt,
  NativeHostRuntime,
} from 'react-native-whip-ssh';
import { NativeAgentInteractionKind } from 'react-native-whip-ssh/src/agentInteraction';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';
import { cn } from '../lib/utils';

export interface AgentInteractionTarget {
  native: Pick<
    NativeHostRuntime,
    'agentInteractionPrompt' | 'respondAgentInteraction'
  >;
  terminalId: string;
  bindingToken: string;
}

const PROMPT_POLL_MS = 1200;
const NAVIGATION_CONTROLS = [
  [ArrowUp, 'up', 'Previous option'],
  [ArrowDown, 'down', 'Next option'],
  [ArrowLeft, 'left', 'Previous question'],
  [ArrowRight, 'right', 'Next question'],
  ['Tab', 'tab', 'Next field'],
  ['Space', 'space', 'Toggle option'],
] as const;

interface InteractionState {
  prompt?: NativeAgentInteractionPrompt;
  answer: string;
  error?: string;
  responseError?: string;
  loaded: boolean;
  busy: boolean;
  submittedToken?: string;
  showTerminalControls: boolean;
}

type InteractionAction =
  | { type: 'reset' }
  | { type: 'prompt-loaded'; prompt?: NativeAgentInteractionPrompt }
  | { type: 'prompt-failed'; error: string }
  | { type: 'answer-changed'; answer: string }
  | { type: 'controls-toggled' }
  | { type: 'response-started'; submittedToken?: string }
  | { type: 'answer-sent' }
  | { type: 'response-failed'; error: string; retryable: boolean }
  | { type: 'response-finished' };

const INITIAL_INTERACTION: InteractionState = {
  answer: '', loaded: false, busy: false, showTerminalControls: false,
};

function interactionReducer(state: InteractionState, action: InteractionAction): InteractionState {
  switch (action.type) {
    case 'reset':
      return INITIAL_INTERACTION;
    case 'prompt-loaded':
      return { ...state, prompt: action.prompt, error: undefined, loaded: true };
    case 'prompt-failed':
      return { ...state, prompt: undefined, error: action.error };
    case 'answer-changed':
      return { ...state, answer: action.answer };
    case 'controls-toggled':
      return { ...state, showTerminalControls: !state.showTerminalControls };
    case 'response-started':
      return { ...state, busy: true, error: undefined, responseError: undefined,
        submittedToken: action.submittedToken ?? state.submittedToken };
    case 'answer-sent':
      return { ...state, answer: '' };
    case 'response-failed':
      return { ...state, prompt: undefined, responseError: action.error,
        submittedToken: action.retryable ? undefined : state.submittedToken };
    case 'response-finished':
      return { ...state, busy: false };
  }
}

export function AgentInteractionControls({
  target,
  enabled,
  onOpenTerminal,
}: {
  target: AgentInteractionTarget;
  enabled: boolean;
  onOpenTerminal?: () => void;
}) {
  const { native, terminalId, bindingToken } = target;
  const [{ prompt, answer, error, responseError, loaded, busy, submittedToken, showTerminalControls }, dispatch] =
    useReducer(interactionReducer, INITIAL_INTERACTION);
  const generation = useRef(0);
  const sending = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    dispatch({ type: 'reset' });
    sending.current = false;
    if (!enabled) return;
    const refresh = async () => {
      if (reading || sending.current || current !== generation.current) return;
      reading = true;
      try {
        const next = await native.agentInteractionPrompt(
          terminalId,
          bindingToken,
        );
        if (current !== generation.current) return;
        dispatch({ type: 'prompt-loaded', prompt: next });
      } catch (reason) {
        if (current !== generation.current) return;
        dispatch({ type: 'prompt-failed', error: String(reason) });
      } finally {
        reading = false;
      }
    };
    refreshRef.current = refresh;
    const poll = async () => {
      await refresh();
      if (current === generation.current)
        timer = setTimeout(() => {
          void poll();
        }, PROMPT_POLL_MS);
    };
    void poll();
    return () => {
      generation.current = current + 1;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [native, terminalId, bindingToken, enabled]);

  const waiting = prompt !== undefined && prompt.token === submittedToken;
  const disabled = busy || waiting;
  const respond = async (action: string) => {
    if (!enabled || !prompt || disabled || sending.current) return;
    const current = generation.current;
    const submitting =
      action === 'open' ||
      action === 'enter' ||
      action === 'esc' ||
      action === 'answer';
    sending.current = true;
    // A lost response acknowledgement is ambiguous. Keep this prompt disabled
    // until the native reader supplies a new token, including after errors.
    dispatch({ type: 'response-started', submittedToken: submitting ? prompt.token : undefined });
    try {
      await native.respondAgentInteraction(
        terminalId,
        bindingToken,
        prompt.token,
        action,
        action === 'answer' ? answer : '',
      );
      if (current === generation.current && action === 'answer') dispatch({ type: 'answer-sent' });
    } catch (reason) {
      if (current === generation.current) {
        dispatch({ type: 'response-failed', error: String(reason), retryable: Boolean(
          reason && typeof reason === 'object' && 'code' in reason && reason.code === 'InvalidField',
        ) });
      }
    } finally {
      if (current === generation.current) {
        sending.current = false;
        dispatch({ type: 'response-finished' });
        void refreshRef.current();
      }
    }
  };

  if (!enabled) return null;
  if (loaded && !prompt && !error && !responseError) return null;
  const displayedError = error || responseError;
  const queued = prompt?.kind === NativeAgentInteractionKind.QueuedQuestion;
  const menu = prompt?.kind === NativeAgentInteractionKind.Menu;
  const showAnswerControls = menu || showTerminalControls;
  return (
    <View
      testID="agent-interaction-controls"
      className="mt-4 gap-3 rounded-lg border border-border bg-background px-4 py-4"
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text
          accessibilityLiveRegion="polite"
          className="text-sm font-semibold text-foreground"
        >
          Needs your input
        </Text>
        {onOpenTerminal && (
          <Button
            variant="ghost"
            size="sm"
            accessibilityLabel="Answer in Terminal"
            onPress={onOpenTerminal}
          >
            <Text className="text-xs">Terminal</Text>
          </Button>
        )}
      </View>
      {prompt ? (
        <>
          <ScrollView className="max-h-40" nestedScrollEnabled>
            <Text selectable className="text-sm leading-6 text-foreground">
              {prompt.summary}
            </Text>
          </ScrollView>
          {queued ? (
            <Button
              className="min-h-11"
              disabled={disabled}
              accessibilityLabel="Open queued agent question"
              onPress={() => {
                void respond('open');
              }}
            >
              <Text>Answer question</Text>
            </Button>
          ) : (
            <>
              {prompt.choices.length > 0 && (
                <View className="gap-2">
                  {prompt.choices.map(choice => (
                    <Button
                      key={choice.index}
                      variant="outline"
                      disabled={disabled}
                      accessibilityLabel={`Select ${choice.label}`}
                      accessibilityState={{
                        selected: choice.selected,
                        disabled,
                      }}
                      className={cn(
                        'h-auto min-h-11 justify-start px-3 py-2',
                        choice.selected && 'border-primary bg-primary/10',
                      )}
                      onPress={() => {
                        void respond(`choice:${choice.index}`);
                      }}
                    >
                      <Text className="shrink text-sm text-foreground">
                        {choice.selected ? '› ' : ''}
                        {choice.label}
                      </Text>
                    </Button>
                  ))}
                </View>
              )}
              {showTerminalControls && (
                <>
                  <ScrollView className="max-h-40" nestedScrollEnabled>
                    <Text
                      selectable
                      className="font-mono text-xs leading-5 text-muted-foreground"
                    >
                      {prompt.text}
                    </Text>
                  </ScrollView>
                  <View className="flex-row flex-wrap gap-1">
                    {NAVIGATION_CONTROLS.map(
                      ([face, action, accessibilityLabel]) => (
                        <Button
                          key={action}
                          variant="secondary"
                          size="sm"
                          disabled={disabled}
                          accessibilityLabel={accessibilityLabel}
                          onPress={() => {
                            void respond(action);
                          }}
                        >
                          {typeof face === 'string' ? (
                            <Text className="text-xs">{face}</Text>
                          ) : (
                            <Icon as={face} size={18} />
                          )}
                        </Button>
                      ),
                    )}
                  </View>
                </>
              )}
              {showAnswerControls && (
                <>
                  <View className="flex-row gap-2">
                    <Button
                      className="min-h-11 flex-1"
                      disabled={disabled}
                      accessibilityLabel="Confirm agent selection"
                      onPress={() => {
                        void respond('enter');
                      }}
                    >
                      <Text>Confirm selection</Text>
                    </Button>
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={disabled}
                      accessibilityLabel="Cancel agent prompt"
                      onPress={() => {
                        void respond('esc');
                      }}
                    >
                      <Text>Cancel</Text>
                    </Button>
                  </View>
                </>
              )}
              {showTerminalControls && (
                <View className="flex-row items-center gap-2">
                  <Input
                    className="flex-1"
                    accessibilityLabel="Answer the agent"
                    placeholder="Type an answer…"
                    value={answer}
                    onChangeText={value => dispatch({ type: 'answer-changed', answer: value })}
                    editable={!disabled}
                    maxLength={4096}
                    returnKeyType="send"
                    onSubmitEditing={() => {
                      if (answer.trim()) void respond('answer');
                    }}
                  />
                  <Button
                    disabled={disabled || !answer.trim()}
                    accessibilityLabel="Send answer to agent"
                    onPress={() => {
                      void respond('answer');
                    }}
                  >
                    <Text>Send</Text>
                  </Button>
                </View>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="self-start px-0"
                accessibilityLabel="Toggle terminal controls"
                accessibilityState={{ expanded: showTerminalControls }}
                onPress={() => {
                  dispatch({ type: 'controls-toggled' });
                }}
              >
                <Text className="text-xs text-muted-foreground">
                  {showTerminalControls
                    ? 'Hide terminal controls'
                    : 'Show terminal controls'}
                </Text>
              </Button>
            </>
          )}
          {(busy || waiting) && (
            <Text
              accessibilityLiveRegion="polite"
              className="text-xs text-muted-foreground"
            >
              {busy ? 'Sending…' : 'Waiting for the agent…'}
            </Text>
          )}
        </>
      ) : !displayedError ? (
        <ActivityIndicator accessibilityLabel="Reading agent prompt" />
      ) : null}
      {displayedError && (
        <View className="gap-2">
          <Text
            accessibilityLiveRegion="polite"
            className="text-xs text-destructive"
          >
            {displayedError}
          </Text>
          <Button
            variant="outline"
            accessibilityLabel="Refresh agent prompt"
            onPress={() => {
              void refreshRef.current();
            }}
          >
            <Text>Refresh prompt</Text>
          </Button>
        </View>
      )}
    </View>
  );
}
