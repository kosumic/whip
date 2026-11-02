import { useContext, useEffect, useRef, useState, type ComponentProps } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import Mic from 'lucide-react-native/icons/mic';
import MicOff from 'lucide-react-native/icons/mic-off';
import MessageSquare from 'lucide-react-native/icons/message-square';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import SkipForward from 'lucide-react-native/icons/skip-forward';
import X from 'lucide-react-native/icons/x';
import Volume2 from 'lucide-react-native/icons/volume-2';
import Plus from 'lucide-react-native/icons/plus';
import AudioLines from 'lucide-react-native/icons/audio-lines';
import Animated from 'react-native-reanimated';
import type { ChatSpeechTarget } from '../services/chatSpeech';
import { VoiceConversation, type VoiceConversationView } from '../services/voiceConversation';
import { Button } from './ui/button';
import { Text } from './ui/text';
import { GlassPortal } from './GlassSurface';
import { VoiceOrb } from './VoiceOrb';
import { VoiceVadSensitivityContext } from '../lib/voiceVadSensitivity';

const ORB_SIZE = 240;
const FLOATING_ORB_SIZE = 64;
const VOICE_COLORS = { canvas: '#000000', text: '#ffffff', muted: '#a3a3a3', control: '#282828', accent: '#c797fa' };
const INITIAL: VoiceConversationView = { phase: 'starting', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null };
const STATUS = {
  starting: 'voiceChat.starting',
  setup: 'voiceChat.setup', preparing: 'voiceChat.preparing', listening: 'voiceChat.listening',
  finishing: 'voiceChat.finishing', waiting: 'voiceChat.waiting', speaking: 'voiceChat.speaking',
  muted: 'voiceChat.muted', closed: 'voiceChat.closed', error: 'voiceChat.error',
} as const;

interface VoiceChatScreenProps {
  target: ChatSpeechTarget;
  send: (text: string) => boolean;
  visible: boolean;
  expanded: boolean;
  floatingStyle: ComponentProps<typeof Animated.View>['style'];
  onMinimize: () => void;
  onExpand: () => void;
  onClose: () => void;
  onCompose?: () => void;
  onAttach?: () => void;
}

/** Owns the call independently of its full-screen or floating presentation. */
export function VoiceChatScreen({ target, send, visible, expanded, floatingStyle, onMinimize, onExpand, onClose, onCompose, onAttach }: VoiceChatScreenProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const vadSensitivity = useContext(VoiceVadSensitivityContext);
  const [view, setView] = useState(INITIAL);
  const conversation = useRef<VoiceConversation | null>(null);
  const callbacks = useRef({ send, onClose, vadSensitivity });
  callbacks.current = { send, onClose, vadSensitivity };
  const { agent, bindingToken, hostId, label, paneId } = target;
  useEffect(() => {
    let mounted = true;
    const session = new VoiceConversation({ agent, bindingToken, hostId, label, paneId }, text => callbacks.current.send(text), next => { if (mounted) setView(next); });
    conversation.current = session;
    session.setVadSensitivity(callbacks.current.vadSensitivity);
    void session.start();
    return () => { mounted = false; void session.close(); conversation.current = null; };
  }, [agent, bindingToken, hostId, label, paneId]);
  useEffect(() => { conversation.current?.setVadSensitivity(vadSensitivity); }, [vadSensitivity]);
  useEffect(() => { if (view.phase === 'closed') callbacks.current.onClose(); }, [view.phase]);
  const close = () => { void conversation.current?.close(); callbacks.current.onClose(); };
  const interactive = ['listening', 'muted', 'waiting', 'speaking'].includes(view.phase);
  const compose = () => { onMinimize(); onCompose?.(); };
  return <>
    {visible && !expanded && <GlassPortal name={`voice-chat-${bindingToken}`}>
      <Animated.View style={[styles.floating, floatingStyle]}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('voiceChat.reopen')} accessibilityHint={t(STATUS[view.phase])} onPress={onExpand} style={styles.floatingTarget}>
          <VoiceOrb view={view} size={FLOATING_ORB_SIZE} />
        </Pressable>
      </Animated.View>
    </GlassPortal>}
    <Modal visible={visible && expanded} animationType="fade" presentationStyle="fullScreen" onRequestClose={onMinimize}>
    <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 28 }]}>
      <View className="flex-row items-center justify-between px-6">
        <Button accessibilityLabel={t('voiceChat.minimize')} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} onPress={onMinimize}><ChevronDown size={20} color={VOICE_COLORS.text} /></Button>
        <Text style={styles.agentLabel}>{target.label}</Text>
        <View className="flex-row gap-2">
          <Button accessibilityLabel={t('voiceChat.transcript')} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} onPress={onMinimize}><MessageSquare size={18} color={VOICE_COLORS.text} /></Button>
          <Button accessibilityLabel={t('voiceChat.speaker')} accessibilityState={{ selected: view.speaker }} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} disabled={!interactive} onPress={() => conversation.current?.toggleSpeaker()}><Volume2 size={19} color={view.speaker ? VOICE_COLORS.accent : VOICE_COLORS.text} /></Button>
        </View>
      </View>
      <View style={styles.orbSpace}>
        <Pressable accessibilityRole="button" accessibilityLabel={view.phase === 'speaking' ? t('voiceChat.skip') : t('voiceChat.finish')} disabled={view.phase !== 'listening' && view.phase !== 'speaking'} onPress={() => { if (view.phase === 'speaking') void conversation.current?.skip(); else conversation.current?.finish(); }} style={styles.orbTarget}>
          <VoiceOrb view={view} size={ORB_SIZE} />
        </Pressable>
      </View>
      <View className="items-center gap-3 px-8 pb-5" style={styles.status}>
        <Text accessibilityLiveRegion="polite" className="text-center text-xs" style={styles.statusText}>{t(STATUS[view.phase])}</Text>
        {(view.phase === 'starting' || view.phase === 'preparing') && <ActivityIndicator color={VOICE_COLORS.accent} />}
        {view.error && <Text accessibilityRole="alert" className="text-center text-sm leading-5" style={styles.statusText}>{view.error}</Text>}
      </View>
      <View className="flex-row items-center gap-2 px-6">
        <View style={styles.composer}>
          {onAttach && <Button accessibilityLabel={t('terminal.attach')} variant="ghost" className="size-11 rounded-full p-0" onPress={() => { onMinimize(); onAttach(); }}><Plus size={20} color={VOICE_COLORS.muted} /></Button>}
          <Pressable accessibilityRole="button" accessibilityLabel={t('voiceChat.compose', { agent: target.label })} onPress={compose} style={styles.composeTarget}><Text numberOfLines={1} style={styles.composeText}>{t('voiceChat.compose', { agent: target.label })}</Text></Pressable>
          <AudioLines size={19} color={VOICE_COLORS.accent} style={styles.composerWave} />
        </View>
        <Button accessibilityLabel={view.muted ? t('voiceChat.unmute') : t('voiceChat.mute')} accessibilityState={{ selected: view.muted }} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} disabled={!interactive} onPress={() => conversation.current?.toggleMuted()}>{view.muted ? <MicOff size={20} color={VOICE_COLORS.text} /> : <Mic size={20} color={VOICE_COLORS.text} />}</Button>
        {view.phase === 'speaking' && <Button accessibilityLabel={t('voiceChat.skip')} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} onPress={() => { void conversation.current?.skip(); }}><SkipForward size={20} color={VOICE_COLORS.text} /></Button>}
        <Button accessibilityLabel={t('voiceChat.end')} variant="ghost" className="size-11 rounded-full p-0" style={styles.hangup} onPress={close}><X size={22} color={VOICE_COLORS.canvas} /></Button>
      </View>
    </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: VOICE_COLORS.canvas },
  control: { backgroundColor: VOICE_COLORS.control },
  hangup: { backgroundColor: VOICE_COLORS.text },
  agentLabel: { flex: 1, marginHorizontal: 12, color: VOICE_COLORS.muted, fontSize: 12 },
  status: { minHeight: 48 },
  statusText: { color: VOICE_COLORS.muted },
  composer: { flex: 1, height: 44, borderRadius: 24, backgroundColor: VOICE_COLORS.control, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  composeTarget: { flex: 1, justifyContent: 'center', minHeight: 44, paddingLeft: 10 },
  composeText: { color: VOICE_COLORS.muted, fontSize: 14 },
  composerWave: { marginHorizontal: 12 },
  orbSpace: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: ORB_SIZE + 32 },
  orbTarget: { width: ORB_SIZE, height: ORB_SIZE, alignItems: 'center', justifyContent: 'center' },
  orb: { overflow: 'hidden' },
  floating: { position: 'absolute', left: 20, right: 20, alignItems: 'center' },
  floatingTarget: { width: FLOATING_ORB_SIZE, height: FLOATING_ORB_SIZE, alignItems: 'center', justifyContent: 'center' },
});
