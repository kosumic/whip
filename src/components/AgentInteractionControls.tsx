import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import type { NativeAgentInteractionPrompt, NativeHostRuntime } from 'react-native-whip-ssh';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Text } from './ui/text';
import { cn } from '../lib/utils';

export interface AgentInteractionTarget {
  native: Pick<NativeHostRuntime, 'agentInteractionPrompt' | 'respondAgentInteraction'>;
  terminalId: string;
  bindingToken: string;
}

const PROMPT_POLL_MS = 1200;
const NAVIGATION_CONTROLS = [
  ['↑', 'up', 'Previous option'], ['↓', 'down', 'Next option'],
  ['←', 'left', 'Previous question'], ['→', 'right', 'Next question'],
  ['Tab', 'tab', 'Next field'], ['Space', 'space', 'Toggle option'],
] as const;

export function AgentInteractionControls({ target, enabled, onOpenTerminal }: {
  target: AgentInteractionTarget;
  enabled: boolean;
  onOpenTerminal?: () => void;
}) {
  const { native, terminalId, bindingToken } = target;
  const [prompt, setPrompt] = useState<NativeAgentInteractionPrompt>();
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string>();
  const [responseError, setResponseError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submittedToken, setSubmittedToken] = useState<string>();
  const generation = useRef(0);
  const promptScroll = useRef<ScrollView>(null);
  const sending = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    setPrompt(undefined);
    setError(undefined);
    setResponseError(undefined);
    setLoaded(false);
    setAnswer('');
    setBusy(false);
    setSubmittedToken(undefined);
    sending.current = false;
    if (!enabled) return;
    const refresh = async () => {
      if (reading || sending.current || current !== generation.current) return;
      reading = true;
      try {
        const next = await native.agentInteractionPrompt(terminalId, bindingToken);
        if (current !== generation.current) return;
        setPrompt(next);
        setError(undefined);
        setLoaded(true);
      } catch (reason) {
        if (current !== generation.current) return;
        setPrompt(undefined);
        setError(String(reason));
      } finally {
        reading = false;
      }
    };
    refreshRef.current = refresh;
    const poll = async () => {
      await refresh();
      if (current === generation.current) timer = setTimeout(() => { void poll(); }, PROMPT_POLL_MS);
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
    const submitting = action === 'enter' || action === 'esc' || action === 'answer';
    sending.current = true;
    setBusy(true);
    setError(undefined);
    setResponseError(undefined);
    // A lost response acknowledgement is ambiguous. Keep this prompt disabled
    // until the native reader supplies a new token, including after errors.
    if (submitting) setSubmittedToken(prompt.token);
    try {
      await native.respondAgentInteraction(terminalId, bindingToken, prompt.token, action, action === 'answer' ? answer : '');
      if (current === generation.current && action === 'answer') setAnswer('');
    } catch (reason) {
      if (current === generation.current) {
        setPrompt(undefined);
        setResponseError(String(reason));
        if (reason && typeof reason === 'object' && 'code' in reason && reason.code === 'InvalidField') {
          setSubmittedToken(undefined);
        }
      }
    } finally {
      if (current === generation.current) {
        sending.current = false;
        setBusy(false);
        void refreshRef.current();
      }
    }
  };

  if (!enabled) return null;
  if (loaded && !prompt && !error && !responseError) return null;
  const displayedError = error || responseError;
  return (
    <View testID="agent-interaction-controls" className="mt-4 gap-3 rounded-lg border border-border bg-background px-3 py-3">
      <View className="flex-row items-center justify-between gap-2">
        <Text accessibilityLiveRegion="polite" className="text-sm font-semibold text-foreground">Needs your input</Text>
        {onOpenTerminal && <Button variant="ghost" size="sm" accessibilityLabel="Answer in Terminal" onPress={onOpenTerminal}><Text className="text-xs">Terminal</Text></Button>}
      </View>
      {prompt ? (
        <>
          <ScrollView ref={promptScroll} className="max-h-64" nestedScrollEnabled onContentSizeChange={() => promptScroll.current?.scrollToEnd({ animated: false })}>
            <Text selectable className="font-mono text-xs leading-5 text-foreground">{prompt.text}</Text>
          </ScrollView>
          {prompt.choices.length > 0 && <View className="gap-2">
            {prompt.choices.map(choice => (
              <Button key={choice.index} variant="outline" disabled={disabled} accessibilityLabel={`Select ${choice.label}`} accessibilityState={{ selected: choice.selected, disabled }} className={cn('h-auto min-h-11 justify-start px-3 py-2', choice.selected && 'border-primary bg-primary/10')} onPress={() => { void respond(`choice:${choice.index}`); }}>
                <Text className="shrink text-sm text-foreground">{choice.selected ? '› ' : ''}{choice.label}</Text>
              </Button>
            ))}
          </View>}
          <View className="flex-row flex-wrap gap-1">
            {NAVIGATION_CONTROLS.map(([label, action, accessibilityLabel]) => (
              <Button key={action} variant="secondary" size="sm" disabled={disabled} accessibilityLabel={accessibilityLabel} onPress={() => { void respond(action); }}><Text className="text-xs">{label}</Text></Button>
            ))}
          </View>
          <View className="flex-row gap-2">
            <Button className="min-h-11 flex-1" disabled={disabled} accessibilityLabel="Confirm agent selection" onPress={() => { void respond('enter'); }}><Text>Confirm selection</Text></Button>
            <Button variant="outline" className="min-h-11" disabled={disabled} accessibilityLabel="Cancel agent prompt" onPress={() => { void respond('esc'); }}><Text>Cancel</Text></Button>
          </View>
          <View className="flex-row items-center gap-2">
            <Input className="flex-1" accessibilityLabel="Answer the agent" placeholder="Type an answer…" value={answer} onChangeText={setAnswer} editable={!disabled} maxLength={4096} returnKeyType="send" onSubmitEditing={() => { if (answer.trim()) void respond('answer'); }} />
            <Button disabled={disabled || !answer.trim()} accessibilityLabel="Send answer to agent" onPress={() => { void respond('answer'); }}><Text>Send</Text></Button>
          </View>
          {(busy || waiting) && <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">{busy ? 'Sending…' : 'Waiting for the agent…'}</Text>}
        </>
      ) : !displayedError ? <ActivityIndicator accessibilityLabel="Reading agent prompt" /> : null}
      {displayedError && <View className="gap-2">
        <Text accessibilityLiveRegion="polite" className="text-xs text-destructive">{displayedError}</Text>
        <Button variant="outline" accessibilityLabel="Refresh agent prompt" onPress={() => { void refreshRef.current(); }}><Text>Refresh prompt</Text></Button>
      </View>}
    </View>
  );
}
