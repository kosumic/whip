import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Modal, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { AppNavigationController } from '../hooks/useAppNavigation';
import type { SessionRuntimeController } from '../hooks/useSessionRuntimeManager';
import { useOpenAiVoiceCredentialStatus } from '../hooks/useOpenAiVoiceCredentialStatus';
import { hostDisplayName } from '../lib/hostProfiles';
import { GlobalVoiceControl, type GlobalVoiceApproval } from '../services/globalVoiceControl';
import { voiceSessionManager } from '../services/voiceSessionManager';
import { VoiceChatScreen, type VoiceChatHandle } from './VoiceChatScreen';
import { Button } from './ui/button';
import { Text } from './ui/text';

export interface GlobalVoiceCallHandle { open: () => void }
type Approval = GlobalVoiceApproval & { complete: (approved: boolean) => void };
const NO_AGENT_SEND = () => false;
const MAX_MESSAGE_LENGTH = 4096;

/** App-shell lifetime: navigation never remounts or retargets this call. */
export function GlobalVoiceCall({ ref, navigation, sessions, locked, visible }: {
  ref?: Ref<GlobalVoiceCallHandle>; navigation: AppNavigationController; sessions: SessionRuntimeController; locked: boolean; visible: boolean;
}) {
  const { t } = useTranslation();
  const { bottom, top } = useSafeAreaInsets();
  const credential = useOpenAiVoiceCredentialStatus();
  const [setup, setSetup] = useState(false);
  const [calling, setCalling] = useState(false);
  const [callAttempt, setCallAttempt] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [approval, setApproval] = useState<Approval>();
  const approvalRef = useRef<Approval | undefined>(undefined);
  const voice = useRef<VoiceChatHandle>(null);
  const closeSetup = () => { setSetup(false); };
  const approvalSession = approval ? sessions.presentationSessions.find(item => item.hostId === approval.hostId) : undefined;
  const approvalPane = approvalSession?.snapshot.panes.find(item => item.pane_id === approval?.paneId);
  const approvalAgent = approvalPane?.label || approvalPane?.display_agent || approvalPane?.agent;
  const canStart = credential.ready;
  const start = useCallback(() => {
    if (locked || !canStart) return;
    setCallAttempt(attempt => attempt + 1); setSetup(false); setExpanded(true); setCalling(true);
  }, [locked, canStart]);
  useImperativeHandle(ref, () => ({ open() {
    if (locked) return;
    if (calling && voiceSessionManager.active?.scope.kind === 'Global' && !voiceSessionManager.active.ended) setExpanded(true);
    else if (canStart) start();
    else setSetup(true);
  } }), [calling, locked, canStart, start]);
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
    return () => { control.dispose(); approvalRef.current?.complete(false); };
  }, []);
  useEffect(() => {
    if (locked) { setSetup(false); setComposing(false); approvalRef.current?.complete(false); }
  }, [locked]);
  return <>
    <Modal visible={setup && visible && !locked} animationType="slide" onRequestClose={closeSetup}>
      <View className="flex-1 bg-background" style={{ paddingTop: top, paddingBottom: bottom }}>
        <View className="flex-row items-center justify-between px-5 py-3">
          <Text className="text-xl font-semibold">{t('globalCall.title')}</Text>
          <Button variant="ghost" onPress={closeSetup}><Text>{t('common.close')}</Text></Button>
        </View>
        <ScrollView className="flex-1">
          <Text className="px-5 pb-4 text-sm text-muted-foreground">{t('globalCall.permissions')}</Text>
          <View className="gap-2 px-5 py-3">
            <Text className="text-sm font-medium">{t('openai.title')}</Text>
            {!credential.ready && <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">{t(credential.reason)}</Text>}
            <Text className="text-sm text-muted-foreground">{t('openai.configure')}</Text>
            <Button variant="secondary" onPress={() => { closeSetup(); navigation.selectTab('more'); }}><Text>{t('settings.title')}</Text></Button>
          </View>
        </ScrollView>
        <Button className="mx-5 my-3" disabled={!canStart} onPress={start}>
          <Text>{t('globalCall.start')}</Text>
        </Button>
      </View>
    </Modal>
    {calling && <VoiceChatScreen key={callAttempt} ref={voice} target={{ global: true, label: t('globalCall.title') }} send={NO_AGENT_SEND}
      visible={visible && !locked} expanded={expanded} dockStyle={{ bottom: bottom + 88 }} compactComposer={false}
      onMinimize={() => { setExpanded(false); setComposing(false); approvalRef.current?.complete(false); }} onExpand={() => setExpanded(true)}
      onClose={() => { setCalling(false); setComposing(false); setDraft(''); approvalRef.current?.complete(false); }}
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
        <Text className="text-xl font-semibold">{t('globalCall.title')}</Text>
        <TextInput accessibilityLabel={t('globalCall.message')} className="min-h-32 rounded-xl border border-border p-3 text-foreground" multiline maxLength={MAX_MESSAGE_LENGTH} value={draft} onChangeText={setDraft} />
        <Button disabled={!draft.trim()} onPress={() => { voice.current?.submitted(draft.trim()); setDraft(''); setComposing(false); setExpanded(true); }}><Text>{t('globalCall.send')}</Text></Button>
        <Button variant="secondary" onPress={() => setComposing(false)}><Text>{t('common.cancel')}</Text></Button>
      </View>}
    </VoiceChatScreen>}
  </>;
}
