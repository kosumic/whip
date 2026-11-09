import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Alert, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { AppNavigationController } from '../hooks/useAppNavigation';
import type { SessionRuntimeController } from '../hooks/useSessionRuntimeManager';
import { useOpenAiVoiceCredentialStatus } from '../hooks/useOpenAiVoiceCredentialStatus';
import { usePreparedVoiceConnection } from '../hooks/usePreparedVoiceConnection';
import { hostDisplayName } from '../lib/hostProfiles';
import { GlobalVoiceControl, type GlobalVoiceApproval } from '../services/globalVoiceControl';
import { voiceSessionManager } from '../services/voiceSessionManager';
import { canResumeVoiceHistory, type SavedCall } from '../services/voiceHistory';
import type { RealtimeVoiceChatTarget } from '../services/voiceConversation';
import { VoiceChatScreen, type VoiceChatHandle } from './VoiceChatScreen';
import { Button } from './ui/button';
import { Text } from './ui/text';

export interface GlobalVoiceCallHandle { open: () => void; resume: (saved: SavedCall) => void }
type Approval = GlobalVoiceApproval & { complete: (approved: boolean) => void };
const NO_AGENT_SEND = () => false;
const MAX_MESSAGE_LENGTH = 4096;

/** App-shell lifetime: navigation never remounts or retargets this call. */
export function GlobalVoiceCall({ ref, navigation, sessions, locked, visible, onConfigureOpenAi }: {
  ref?: Ref<GlobalVoiceCallHandle>; navigation: AppNavigationController; sessions: SessionRuntimeController; locked: boolean; visible: boolean;
  onConfigureOpenAi: () => void;
}) {
  const { t } = useTranslation();
  const { bottom, top } = useSafeAreaInsets();
  const credential = useOpenAiVoiceCredentialStatus();
  usePreparedVoiceConnection(!locked && credential.ready);
  const [calling, setCalling] = useState(false);
  const [resuming, setResuming] = useState<SavedCall>();
  const [callAttempt, setCallAttempt] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [approval, setApproval] = useState<Approval>();
  const approvalRef = useRef<Approval | undefined>(undefined);
  const controlRef = useRef<GlobalVoiceControl | undefined>(undefined);
  const voice = useRef<VoiceChatHandle>(null);
  const approvalSession = approval ? sessions.presentationSessions.find(item => item.hostId === approval.hostId) : undefined;
  const approvalPane = approvalSession?.snapshot.panes.find(item => item.pane_id === approval?.paneId);
  const approvalAgent = approvalPane?.label || approvalPane?.display_agent || approvalPane?.agent;
  const canStart = credential.ready;
  const start = useCallback((saved?: SavedCall) => {
    if (locked || !canStart) return;
    setResuming(saved);
    setDraft(''); setComposing(false); approvalRef.current?.complete(false);
    setCallAttempt(attempt => attempt + 1); setExpanded(true); setCalling(true);
  }, [locked, canStart]);
  useImperativeHandle(ref, () => ({ open() {
    if (locked) return;
    if (calling && voiceSessionManager.active?.scope.kind === 'Global' && !voiceSessionManager.active.ended) setExpanded(true);
    else if (canStart) start();
    else {
      Alert.alert(t('openai.title'), `${t(credential.reason)}\n\n${t('openai.configure')}`);
      onConfigureOpenAi();
    }
  }, resume(saved) {
    if (locked) { Alert.alert(t('voiceUsage.resume'), t('voiceUsage.resumeLocked')); return; }
    if (!canStart) {
      Alert.alert(t('openai.title'), `${t(credential.reason)}\n\n${t('openai.configure')}`);
      onConfigureOpenAi(); return;
    }
    if (voiceSessionManager.active && !voiceSessionManager.active.ended) {
      Alert.alert(t('voiceUsage.resume'), t('voiceUsage.resumeBusy')); return;
    }
    if (!canResumeVoiceHistory(undefined, saved)) {
      Alert.alert(t('voiceUsage.resume'), t('voiceUsage.transcriptUnavailable')); return;
    }
    if (saved.usage?.scope === 'terminal' && !saved.continuation?.terminalTarget) {
      Alert.alert(t('voiceUsage.resume'), t('voiceUsage.resumeTargetMissing')); return;
    }
    start(saved);
  } }), [calling, locked, canStart, start, credential.reason, onConfigureOpenAi, t]);
  const terminal = resuming?.usage?.scope === 'terminal' ? resuming.continuation?.terminalTarget : undefined;
  const resumePane = terminal?.paneId ? sessions.presentationSessions.find(session => session.id === terminal.runtimeId)?.snapshot.panes.find(pane => pane.pane_id === terminal.paneId && pane.terminal_id === terminal.terminalId) : undefined;
  const callTarget: RealtimeVoiceChatTarget = terminal ? {
    hostId: terminal.runtimeId, tabId: resumePane?.tab_id ?? terminal.terminalId, paneId: terminal.paneId ?? terminal.terminalId,
    label: resumePane?.label || terminal.terminalId, terminal,
  } : { global: true, label: t('globalCall.title') };
  const context = { navigation, sessions, locked, showNavigation: () => {
    approvalRef.current?.complete(false); setComposing(false); setExpanded(false);
  },
    confirm: (request: GlobalVoiceApproval, signal: AbortSignal) => new Promise<boolean>(resolve => {
      if (signal.aborted || approvalRef.current) { resolve(false); return; }
      const complete = (approved: boolean) => {
        signal.removeEventListener('abort', cancel);
        if (approvalRef.current?.complete === complete) { approvalRef.current = undefined; setApproval(undefined); }
        resolve(approved);
      };
      const cancel = () => complete(false);
      const pending = { ...request, complete };
      approvalRef.current = pending;
      setApproval(pending); setExpanded(true);
      signal.addEventListener('abort', cancel, { once: true });
    }),
  };
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => {
    const control = new GlobalVoiceControl(() => contextRef.current);
    controlRef.current = control;
    return () => { controlRef.current = undefined; control.dispose(); approvalRef.current?.complete(false); };
  }, []);
  useEffect(() => {
    if (locked) { controlRef.current?.suspend(); setComposing(false); approvalRef.current?.complete(false); }
  }, [locked]);
  return <>
    {calling && <VoiceChatScreen key={callAttempt} ref={voice} target={callTarget} send={NO_AGENT_SEND}
      resumeCallId={resuming?.id} settingsOverride={resuming ? { provider: 'openai', mode: resuming.usage?.mode === 'live' ? 'Live' : 'Realtime' } : undefined}
      visible={visible && !locked} expanded={expanded} dockStyle={{ bottom: bottom + 88 }} compactComposer={false}
      onMinimize={() => { setExpanded(false); setComposing(false); approvalRef.current?.complete(false); }} onExpand={() => setExpanded(true)}
      onClose={() => { setCalling(false); setResuming(undefined); setComposing(false); setDraft(''); approvalRef.current?.complete(false); }}
      onCompose={() => setComposing(true)}>
      {approval && <View className="absolute inset-0 justify-center bg-black/90 px-6">
        <Text className="text-xl font-semibold text-white">{t('globalCall.confirmTitle')}</Text>
        <Text className="my-3 text-sm text-white">{t('globalCall.confirmTarget', { host: approvalSession ? hostDisplayName(approvalSession.host) : approval.hostId, pane: approvalAgent ? `${approvalAgent} (${approval.paneId})` : approval.paneId })}</Text>
        <ScrollView className="max-h-64"><Text selectable className="text-base text-white">{approval.prompt}</Text></ScrollView>
        <View className="mt-5 flex-row gap-3">
          <Button variant="secondary" onPress={() => approval.complete(false)}><Text>{t('common.cancel')}</Text></Button>
          <Button onPress={() => approval.complete(true)}><Text>{t('globalCall.confirmSend')}</Text></Button>
        </View>
      </View>}
      {composing && !approval && <View className="absolute inset-0 gap-4 bg-background px-5" style={{ paddingTop: top + 20, paddingBottom: bottom + 20 }}>
        <Text className="text-xl font-semibold">{callTarget.label}</Text>
        <TextInput accessibilityLabel={t('globalCall.message')} className="min-h-32 rounded-xl border border-border p-3 text-foreground" multiline maxLength={MAX_MESSAGE_LENGTH} value={draft} onChangeText={setDraft} />
        <Button disabled={!draft.trim()} onPress={() => { voice.current?.submitted(draft.trim()); setDraft(''); setComposing(false); setExpanded(true); }}><Text>{t('globalCall.send')}</Text></Button>
        <Button variant="secondary" onPress={() => setComposing(false)}><Text>{t('common.cancel')}</Text></Button>
      </View>}
    </VoiceChatScreen>}
  </>;
}
